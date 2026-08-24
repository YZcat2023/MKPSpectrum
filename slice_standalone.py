#Accept obj files from the main window
import os
import math
import sys
import json
import glob
from collections import defaultdict
import shutil
import zipfile
import time

# 诊断开关：置 True 时把拼线前的散碎原始线段用细红线置顶叠画在成品 PNG 上，
# 用于检查环线求交得到的散线段形态。排查完置回 False 关闭。
__DIAG_RAW_SEGS = False

# 临时排查开关：置 False 时跳过“三角面（coplanar）填充”，只输出墙线环。
# 用于区分“烂面/伸环毛刺”到底来自三角面填充路径，还是墙线/别处。
# 排查完改回 True。
__ENABLE_COPLANAR = True


# ── OBJ / MTL parsing ──────────────────────────────────────────────

def parse_mtl(mtl_path):
    """Parse MTL file, return {material_name: {Kd: (r,g,b), map_Kd: filename, ...}}"""
    materials = {}
    current = None
    with open(mtl_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split()
            if parts[0] == 'newmtl':
                current = parts[1]
                materials[current] = {}
            elif parts[0] == 'Kd' and current:
                materials[current]['Kd'] = tuple(float(x) for x in parts[1:4])
            elif parts[0] == 'map_Kd' and current:
                materials[current]['map_Kd'] = parts[1]
            elif parts[0].lower() == 'mkp_flipy' and current and len(parts) >= 2:
                materials[current]['MKP_flipY'] = parts[1].strip().lower() not in ('0', 'false', 'no')
    return materials


def parse_obj(obj_path):
    """Parse OBJ file.

    Returns:
        vertices: list of (x, y, z)
        uvs:      list of (u, v)
        faces_by_material: {mtl_name: [(vidx_list, uvidx_list_or_None), ...]}
    """
    vertices = []
    uvs = []
    faces_by_material = defaultdict(list)
    current_mtl = None

    with open(obj_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split()
            if parts[0] == 'v':
                vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif parts[0] == 'vt':
                uvs.append((float(parts[1]), float(parts[2])))
            elif parts[0] == 'usemtl':
                current_mtl = parts[1]
            elif parts[0] == 'f':
                v_idxs = []
                uv_idxs = []
                for p in parts[1:]:
                    segs = p.split('/')
                    v_idxs.append(int(segs[0]) - 1)
                    if len(segs) >= 2 and segs[1] != '':
                        uv_idxs.append(int(segs[1]) - 1)
                if not uv_idxs:
                    uv_idxs = None
                # 强制三角化：扇形拆分多边形 (0,1,2), (0,2,3), (0,3,4)...
                if len(v_idxs) >= 3:
                    for i in range(1, len(v_idxs) - 1):
                        tri_v = [v_idxs[0], v_idxs[i], v_idxs[i + 1]]
                        tri_uv = [uv_idxs[0], uv_idxs[i], uv_idxs[i + 1]] if uv_idxs else None
                        if current_mtl:
                            faces_by_material[current_mtl].append((tri_v, tri_uv))

    return vertices, uvs, faces_by_material


# ── Interpolation helpers ──────────────────────────────────────────

def _lerp_2d(a, b, t):
    return ((1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1])


def _lerp_uv(a, b, t):
    if a is None or b is None:
        return None
    return ((1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1])


# ── Triangle / slab intersection (new approach) ────────────────────

def _clip_polygon_to_plane(poly, z_plane, keep_above):
    """用 Sutherland-Hodgman 裁剪 polygon 到 z_plane 水平面。
    poly: [((x,y,z), (u,v)|None), ...]
    keep_above=True  → 保留 z >= z_plane 的部分
    keep_above=False → 保留 z <= z_plane 的部分
    """
    if not poly:
        return []
    result = []
    n = len(poly)
    for i in range(n):
        curr, next_pt = poly[i], poly[(i + 1) % n]
        cz, nz = curr[0][2], next_pt[0][2]
        curr_in = (cz >= z_plane) if keep_above else (cz <= z_plane)
        next_in = (nz >= z_plane) if keep_above else (nz <= z_plane)

        if curr_in:
            result.append(curr)

        if curr_in != next_in:
            if abs(nz - cz) > 1e-12:
                t = (z_plane - cz) / (nz - cz)
                ix = curr[0][0] + t * (next_pt[0][0] - curr[0][0])
                iy = curr[0][1] + t * (next_pt[0][1] - curr[0][1])
                uv = None
                if curr[1] is not None and next_pt[1] is not None:
                    uv = _lerp_uv(curr[1], next_pt[1], t)
                result.append(((ix, iy, z_plane), uv))
    return result


def triangle_slab_clip(v0, v1, v2, uv0, uv1, uv2, z_bottom, z_top):
    """将三角形裁剪到 [z_bottom, z_top] 区间，返回落入部分的 2D 投影。

    Returns:
        polygons: [(poly_2d, poly_uv), ...]  — 3~5 顶点的 2D 多边形
        edges:    [((p1, uv1), (p2, uv2)), ...]  — 多边形边界线段
    """
    zs = [v0[2], v1[2], v2[2]]
    verts = [(v0[0], v0[1], v0[2]), (v1[0], v1[1], v1[2]), (v2[0], v2[1], v2[2])]
    uvs_in = [uv0, uv1, uv2]

    tri_min_z = min(zs)
    tri_max_z = max(zs)

    # 完全在区间外 → 跳过
    if tri_max_z < z_bottom or tri_min_z > z_top:
        return [], []

    # 初始多边形 = 原三角
    poly = [(verts[i], uvs_in[i]) for i in range(3)]

    # 先裁剪上平面（保留下方 z <= z_top）
    poly = _clip_polygon_to_plane(poly, z_top, keep_above=False)
    if not poly:
        return [], []

    # 再裁剪下平面（保留上方 z >= z_bottom）
    poly = _clip_polygon_to_plane(poly, z_bottom, keep_above=True)
    if not poly:
        return [], []

    # 投影到 2D
    poly_2d = [(p[0][0], p[0][1]) for p in poly]
    poly_uv = [p[1] for p in poly] if all(p[1] is not None for p in poly) else None

    # ── 安全校验：宁可丢弃，绝不放行尖刺 ──
    import math as _math
    m = len(poly_2d)
    if m < 3 or m > 5:
        return [], []  # 裁剪结果顶点数异常

    # NaN/Inf 检查
    for x, y in poly_2d:
        if not (_math.isfinite(x) and _math.isfinite(y)):
            return [], []

    # 原始三角形的 2D 投影边长和包围盒
    orig_2d = [(v0[0], v0[1]), (v1[0], v1[1]), (v2[0], v2[1])]
    orig_max_edge = max(
        ((orig_2d[0][0] - orig_2d[1][0]) ** 2 + (orig_2d[0][1] - orig_2d[1][1]) ** 2) ** 0.5,
        ((orig_2d[1][0] - orig_2d[2][0]) ** 2 + (orig_2d[1][1] - orig_2d[2][1]) ** 2) ** 0.5,
        ((orig_2d[2][0] - orig_2d[0][0]) ** 2 + (orig_2d[2][1] - orig_2d[0][1]) ** 2) ** 0.5,
    )
    ox_min = min(v0[0], v1[0], v2[0])
    ox_max = max(v0[0], v1[0], v2[0])
    oy_min = min(v0[1], v1[1], v2[1])
    oy_max = max(v0[1], v1[1], v2[1])

    # 裁剪结果必须在原三角 XY 范围内（允许 5% 浮点容差）
    margin = orig_max_edge * 0.05 + 1e-6
    for x, y in poly_2d:
        if x < ox_min - margin or x > ox_max + margin or y < oy_min - margin or y > oy_max + margin:
            return [], []  # 顶点跑出原三角范围，尖刺

    # 裁剪结果的边不能超过原三角最长边（允许 10% 容差）
    max_edge_allowed = orig_max_edge * 1.1 + 1e-6
    for i in range(m):
        j = (i + 1) % m
        dx = poly_2d[i][0] - poly_2d[j][0]
        dy = poly_2d[i][1] - poly_2d[j][1]
        if (dx * dx + dy * dy) ** 0.5 > max_edge_allowed:
            return [], []  # 某条边异常长，尖刺

    # 生成边界线段（跳过零长度边）
    edges = []
    for i in range(m):
        j = (i + 1) % m
        dx = poly_2d[i][0] - poly_2d[j][0]
        dy = poly_2d[i][1] - poly_2d[j][1]
        if dx * dx + dy * dy < 1e-12:
            continue  # 退化边，跳过
        uvi = poly_uv[i] if poly_uv else None
        uvj = poly_uv[j] if poly_uv else None
        edges.append(((poly_2d[i], uvi), (poly_2d[j], uvj)))

    return [(poly_2d, poly_uv)], edges


# ── Triangle / plane intersection with UV（保留，不受影响）─────────

def triangle_plane_intersection(v0, v1, v2, uv0, uv1, uv2, z_plane,
                                coplanar_tol, seg_eps=1e-9):
    """平面(z_plane)与三角形相交，返回环线线段（墙环）。

    环线只关心“切面 z_plane 真正割到三角形”的边界线段：
      · 严格按 seg_eps 划分顶点在切面上/下/上；
      · 只有真正跨过或落在切面上的三角形才产线段；
    coplanar_tol 仅用于最外层的粗剔除（整块明显远离切面则跳过），
    绝不再用来把“落在层带内但没被切面割到”的三角形硬当成环线段——
    那是共面填充的事，与环线不同源，混入会制造散碎杂线。
    """
    zs = [v0[2], v1[2], v2[2]]
    verts = [v0, v1, v2]
    uvs_in = [uv0, uv1, uv2]

    # 粗剔除：整块明显远离切面（所有顶点都在 coplanar_tol 之外且同侧）→ 无交线
    above_band = [i for i in range(3) if zs[i] > z_plane + coplanar_tol]
    below_band = [i for i in range(3) if zs[i] < z_plane - coplanar_tol]
    if (len(above_band) >= 3 and len(below_band) == 0) or (len(below_band) >= 3 and len(above_band) == 0):
        return [], []

    # 严格分类（只认切面单点 z_plane，容差 seg_eps）
    above = [i for i in range(3) if zs[i] > z_plane + seg_eps]
    below = [i for i in range(3) if zs[i] < z_plane - seg_eps]
    on = [i for i in range(3) if abs(zs[i] - z_plane) <= seg_eps]

    segments = []

    def _interp_edge(i_a, i_b):
        za, zb = zs[i_a], zs[i_b]
        if abs(zb - za) < seg_eps:
            return None
        t = (z_plane - za) / (zb - za)
        pt = _lerp_2d(verts[i_a], verts[i_b], t)
        uv = None
        if uvs_in[i_a] is not None and uvs_in[i_b] is not None:
            uv = _lerp_uv(uvs_in[i_a], uvs_in[i_b], t)
        return (pt, uv)

    if len(on) == 3:
        # 三角形整块躺在切面上：取它三条边当环
        for a, b in [(0, 1), (1, 2), (2, 0)]:
            pta = (verts[a][0], verts[a][1])
            ptb = (verts[b][0], verts[b][1])
            uva = (uvs_in[a][0], uvs_in[a][1]) if uvs_in[a] is not None else None
            uvb = (uvs_in[b][0], uvs_in[b][1]) if uvs_in[b] is not None else None
            segments.append(((pta, uva), (ptb, uvb)))
    elif len(on) == 2:
        pta = (verts[on[0]][0], verts[on[0]][1])
        ptb = (verts[on[1]][0], verts[on[1]][1])
        uva = (uvs_in[on[0]][0], uvs_in[on[0]][1]) if uvs_in[on[0]] is not None else None
        uvb = (uvs_in[on[1]][0], uvs_in[on[1]][1]) if uvs_in[on[1]] is not None else None
        segments.append(((pta, uva), (ptb, uvb)))
    elif len(on) == 1:
        if len(above) == 1 and len(below) == 1:
            a, b = above[0], below[0]
            pta = (verts[on[0]][0], verts[on[0]][1])
            uva = (uvs_in[on[0]][0], uvs_in[on[0]][1]) if uvs_in[on[0]] is not None else None
            r1 = (pta, uva)
            r2 = _interp_edge(a, b)
            if r2:
                segments.append((r1, r2))
    elif len(above) == 1 and len(below) == 2:
        a = above[0]
        r1 = _interp_edge(a, below[0])
        r2 = _interp_edge(a, below[1])
        if r1 and r2:
            segments.append((r1, r2))
    elif len(above) == 2 and len(below) == 1:
        b = below[0]
        r1 = _interp_edge(above[0], b)
        r2 = _interp_edge(above[1], b)
        if r1 and r2:
            segments.append((r1, r2))

    return [], segments


# ── Coordinate mapping ─────────────────────────────────────────────

def world_to_pixel(x, y, scale, center_x, center_y, half_size):
    """Map world (x,y) to pixel coordinates using precomputed transform."""
    px = (x - center_x) * scale + half_size
    py = half_size - (y - center_y) * scale
    return px, py


# ── Texture pre-conversion ────────────────────────────────────────

def _tex_to_rgba(tex_img):
    """Convert PIL Image to (w, h, RGBA_bytes) for O(1) sampling."""
    if tex_img is None:
        return None
    return (tex_img.size[0], tex_img.size[1], tex_img.tobytes())


# ── Texture sampling ───────────────────────────────────────────────

def _tex_parts(tex_data):
    if tex_data is None:
        return None
    if len(tex_data) >= 4:
        return tex_data[0], tex_data[1], tex_data[2], bool(tex_data[3])
    return tex_data[0], tex_data[1], tex_data[2], True


def sample_texture(tex_data, u, v):
    """Sample pre-converted texture at UV coordinates (u, v in [0,1])."""
    if tex_data is None:
        return None
    parts = _tex_parts(tex_data)
    if parts is None:
        return None
    w, h, rgba, flip_y = parts
    tx = int(u * w) % w
    ty = int(((1.0 - v) if flip_y else v) * h) % h
    idx = (ty * w + tx) * 4
    return (rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3])


def fill_textured_triangle(pixels, img_w, img_h, px0, py0, px1, py1, px2, py2,
                           uv0, uv1, uv2, tex_data):
    """Barycentric fill of a triangle with texture sampling into bytearray pixels."""
    if tex_data is None:
        return
    tex_w, tex_h, tex_rgba, flip_y = _tex_parts(tex_data)

    # Bounding box
    min_px = max(0, int(min(px0, px1, px2)))
    max_px = min(img_w - 1, int(max(px0, px1, px2)) + 1)
    min_py = max(0, int(min(py0, py1, py2)))
    max_py = min(img_h - 1, int(max(py0, py1, py2)) + 1)

    # Precompute barycentric denominator (constant across all pixels)
    det = (py1 - py2) * (px0 - px2) + (px2 - px1) * (py0 - py2)
    if abs(det) < 1e-12:
        return
    inv_det = 1.0 / det

    # UV deltas relative to vertex 2
    du0 = uv0[0] - uv2[0]
    du1 = uv1[0] - uv2[0]
    dv0 = uv0[1] - uv2[1]
    dv1 = uv1[1] - uv2[1]

    # Barycentric edge-function constants (only depend on x2, y2)
    e0_const = py1 - py2   # d(w0)/dx  (times det)
    e1_const = py2 - py0   # d(w1)/dx  (times det)
    e0_yconst = px2 - px1  # d(w0)/dy  (times det)
    e1_yconst = px0 - px2  # d(w1)/dy  (times det)

    for y in range(min_py, max_py + 1):
        py = y + 0.5
        dy = py - py2

        # w0, w1 at x = min_px
        px_start = min_px + 0.5
        w0 = (e0_const * (px_start - px2) + e0_yconst * dy) * inv_det
        w1 = (e1_const * (px_start - px2) + e1_yconst * dy) * inv_det

        # Increment per x step
        w0_step = e0_const * inv_det
        w1_step = e1_const * inv_det

        dst_row_base = y * img_w

        for x in range(min_px, max_px + 1):
            w2 = 1.0 - w0 - w1
            if w0 >= -1e-6 and w1 >= -1e-6 and w2 >= -1e-6:
                u = w0 * du0 + w1 * du1 + uv2[0]
                v = w0 * dv0 + w1 * dv1 + uv2[1]

                tx = int(u * tex_w) % tex_w
                ty = int(((1.0 - v) if flip_y else v) * tex_h) % tex_h
                src_idx = (ty * tex_w + tx) * 4

                dst_idx = (dst_row_base + x) * 4
                pixels[dst_idx] = tex_rgba[src_idx]
                pixels[dst_idx + 1] = tex_rgba[src_idx + 1]
                pixels[dst_idx + 2] = tex_rgba[src_idx + 2]
                pixels[dst_idx + 3] = tex_rgba[src_idx + 3]

            w0 += w0_step
            w1 += w1_step


def _build_polylines(segments, tol=3.0):
    """把打散的线段连接成连续折线。segments: [(p1, uv1, p2, uv2), ...]。"""
    if not segments:
        return []

    used = [False] * len(segments)
    polylines = []

    def _dist_sq(a, b):
        dx = a[0] - b[0]
        dy = a[1] - b[1]
        return dx * dx + dy * dy

    def find_next(seg_idx, from_end):
        """从线段的一端找相邻线段（使用浮点容差）。"""
        p1, uv1, p2, uv2 = segments[seg_idx]
        target = p2 if from_end else p1
        tol_sq = tol * tol

        best_idx = None
        best_is_start = None
        best_dist = float('inf')

        for i, (s1, suv1, s2, suv2) in enumerate(segments):
            if i == seg_idx or used[i]:
                continue
            # 检查 s1 或 s2 是否与 target 接近
            d1 = _dist_sq(target, s1)
            d2 = _dist_sq(target, s2)
            if d1 < tol_sq and d1 < best_dist:
                best_dist = d1
                best_idx = i
                best_is_start = True  # 从 s1 连接，所以下一段从 s2 继续
            if d2 < tol_sq and d2 < best_dist:
                best_dist = d2
                best_idx = i
                best_is_start = False  # 从 s2 连接，所以下一段从 s1 继续

        return best_idx, best_is_start

    for i in range(len(segments)):
        if used[i]:
            continue
        # 构建一条折线
        poly = [segments[i]]  # [(p1, uv1, p2, uv2), ...]
        used[i] = True
        # 向前扩展
        cur_idx, cur_is_start = i, False  # 从当前线段终点开始向前
        while True:
            nxt_idx, nxt_is_start = find_next(cur_idx, cur_is_start)
            if nxt_idx is None:
                break
            used[nxt_idx] = True
            poly.append(segments[nxt_idx])
            cur_idx = nxt_idx
            cur_is_start = nxt_is_start  # nxt_is_start=True表示匹配在s1，应从s2(s2是'end')继续
        # 向后扩展（从起点反向）
        cur_idx, cur_is_start = i, True
        front_parts = []
        while True:
            nxt_idx, nxt_is_start = find_next(cur_idx, cur_is_start)
            if nxt_idx is None:
                break
            used[nxt_idx] = True
            front_parts.insert(0, segments[nxt_idx])
            cur_idx = nxt_idx
            cur_is_start = nxt_is_start
        poly = front_parts + poly
        polylines.append(poly)

    return polylines


def _draw_polyline_quads(pixels, img_w, img_h, poly, tex_data, half_width=7.0):
    """绘制折线梯形条带：每段根据前后方向计算法向偏移，端点斜切（miter join）。

    poly: [(p1, uv1, p2, uv2), ...]，线段已经按顺序连接
    """
    if not tex_data or not poly:
        return
    tex_w, tex_h, tex_rgba, _flip_y = _tex_parts(tex_data)

    def _dot(a, b):
        return a[0] * b[0] + a[1] * b[1]

    def _perp(v):
        return (-v[1], v[0])

    def _norm(v):
        d = math.hypot(v[0], v[1])
        return (v[0] / d, v[1] / d) if d > 0 else (0, 0)

    def _add(a, b):
        return (a[0] + b[0], a[1] + b[1])

    def _sub(a, b):
        return (a[0] - b[0], a[1] - b[1])

    def _mul(s, v):
        return (s * v[0], s * v[1])

    # 计算每段的切线方向
    tangents = []
    for p1, uv1, p2, uv2 in poly:
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        tangents.append(_norm((dx, dy)))

    for idx, (p1, uv1, p2, uv2) in enumerate(poly):
        # 当前段切线
        t0 = tangents[idx]
        # 法向（向两侧扩展的方向）
        n0 = _perp(t0)

        # 起点和终点的法向偏移量（miter join，限制最大长度为 2*hw 防止尖角过长）
        _MITER_LIMIT = 2.0  # 最大允许 miter 长度倍数

        def _miter_offset(t_prev, t_curr, hw):
            """计算 miter join 的偏移向量，超过限制则退化为 bevel。"""
            n_prev = _perp(t_prev)
            n_curr = _perp(t_curr)
            bisector = _add(n_prev, n_curr)
            bisector_len_sq = bisector[0]**2 + bisector[1]**2
            if bisector_len_sq < 1e-12:
                return _mul(hw, n_curr)  # 180度，直接用当前法向
            bisector = _norm(bisector)
            cos_half = _dot(bisector, n_curr)
            if abs(cos_half) > 0.01:
                miter_len = hw / cos_half
                if miter_len > _MITER_LIMIT * hw:
                    # 退化为 bevel：直接用当前法向，不产生尖角
                    return _mul(hw, n_curr)
                return _mul(miter_len, bisector)
            return _mul(hw, n_curr)

        # 起点
        if idx == 0:
            n_start = _mul(half_width, n0)
        else:
            n_start = _miter_offset(tangents[idx - 1], t0, half_width)

        # 终点
        if idx == len(poly) - 1:
            n_end = _mul(half_width, n0)
        else:
            n_end = _miter_offset(tangents[idx + 1], t0, half_width)

        # 四个角点（梯形）
        # n_start/n_end 已经是偏移向量（含长度），直接加减
        # 注意：不再沿切线延长，因为3D图连接保证端点精确重合
        a = _add(p1, n_start)   # 起点外侧
        b = _sub(p1, n_start)   # 起点内侧
        c = _add(p2, n_end)     # 终点外侧
        d = _sub(p2, n_end)     # 终点内侧

        # 用两个三角形填充梯形；V 轴解释由每个材质的 MKP_flipY 元数据决定。
        has_uv = uv1 is not None and uv2 is not None
        if has_uv:
            fill_textured_triangle(pixels, img_w, img_h,
                                   a[0], a[1], b[0], b[1], d[0], d[1],
                                   uv1, uv1, uv2, tex_data)
            fill_textured_triangle(pixels, img_w, img_h,
                                   a[0], a[1], d[0], d[1], c[0], c[1],
                                   uv1, uv2, uv2, tex_data)
        else:
            # 无 UV，采样端点颜色
            col = sample_texture(tex_data, uv1[0], uv1[1]) if uv1 else None
            if col is None and uv2:
                col = sample_texture(tex_data, uv2[0], uv2[1])
            if col:
                cr, cg, cb, ca = col
                _fill_flat_triangle(pixels, img_w, img_h, a, b, d, cr, cg, cb, ca)
                _fill_flat_triangle(pixels, img_w, img_h, a, d, c, cr, cg, cb, ca)


def _draw_mixed_polyline_quads(pixels, img_w, img_h, poly_world, w2p, textures, half_width=7.0):
    """全局拼线后的跨材质绘制：每段用自己的贴图，分段绘制但共享 miter 几何。

    poly_world: [((p1, uv1), (p2, uv2), mtl_name), ...] 世界坐标线段，已按几何顺序连好
    w2p: world→pixel 函数
    textures: {mtl_name: tex_data}
    """
    if not poly_world:
        return
    # 预先转像素并缓存每段的 tex
    segs_px = []
    for (p1, uv1), (p2, uv2), mtl_name in poly_world:
        tex = textures.get(mtl_name)
        if tex is None:
            tex = None
        px1 = w2p(p1[0], p1[1])
        px2 = w2p(p2[0], p2[1])
        segs_px.append((px1, uv1, px2, uv2, tex, mtl_name))

    def _dot(a, b):
        return a[0] * b[0] + a[1] * b[1]

    def _perp(v):
        return (-v[1], v[0])

    def _norm(v):
        d = math.hypot(v[0], v[1])
        return (v[0] / d, v[1] / d) if d > 0 else (0, 0)

    def _add(a, b):
        return (a[0] + b[0], a[1] + b[1])

    def _sub(a, b):
        return (a[0] - b[0], a[1] - b[1])

    def _mul(s, v):
        return (s * v[0], s * v[1])

    tangents = []
    for px1, _uv1, px2, _uv2, _tex, _mtl in segs_px:
        dx = px2[0] - px1[0]
        dy = px2[1] - px1[1]
        tangents.append(_norm((dx, dy)))

    _MITER_LIMIT = 2.0
    for idx, (px1, uv1, px2, uv2, tex_data, _mtl) in enumerate(segs_px):
        t0 = tangents[idx]
        n0 = _perp(t0)

        def _miter_offset(t_prev, t_curr, hw):
            n_prev = _perp(t_prev)
            n_curr = _perp(t_curr)
            bisector = _add(n_prev, n_curr)
            bisector_len_sq = bisector[0] ** 2 + bisector[1] ** 2
            if bisector_len_sq < 1e-12:
                return _mul(hw, n_curr)
            bisector = _norm(bisector)
            cos_half = _dot(bisector, n_curr)
            if abs(cos_half) > 0.01:
                miter_len = hw / cos_half
                if miter_len > _MITER_LIMIT * hw:
                    return _mul(hw, n_curr)
                return _mul(miter_len, bisector)
            return _mul(hw, n_curr)

        if idx == 0:
            n_start = _mul(half_width, n0)
        else:
            n_start = _miter_offset(tangents[idx - 1], t0, half_width)
        if idx == len(segs_px) - 1:
            n_end = _mul(half_width, n0)
        else:
            n_end = _miter_offset(tangents[idx + 1], t0, half_width)

        a = _add(px1, n_start)
        b = _sub(px1, n_start)
        c = _add(px2, n_end)
        d = _sub(px2, n_end)

        has_uv = uv1 is not None and uv2 is not None
        if has_uv and tex_data is not None:
            # 有贴图且以纹理采样绘制：V 轴解释由每个材质的 MKP_flipY 元数据决定。
            fill_textured_triangle(pixels, img_w, img_h,
                                   a[0], a[1], b[0], b[1], d[0], d[1],
                                   uv1, uv1, uv2, tex_data)
            fill_textured_triangle(pixels, img_w, img_h,
                                   a[0], a[1], d[0], d[1], c[0], c[1],
                                   uv1, uv2, uv2, tex_data)
        else:
            # 无贴图（corner_plane 等）：整段用纯色回退绘制，闭环不会被丢弃
            _fill_flat_triangle(pixels, img_w, img_h, a, b, d, 0, 0, 0, 255)
            _fill_flat_triangle(pixels, img_w, img_h, a, d, c, 0, 0, 0, 255)


def _fill_textured_triangle_no_vflip(pixels, img_w, img_h, px0, py0, px1, py1, px2, py2,
                                     uv0, uv1, uv2, tex_data):
    """Barycentric fill of a triangle with texture sampling - NO V-FLIP for segments."""
    if tex_data is None:
        return
    tex_w, tex_h, tex_rgba, _flip_y = _tex_parts(tex_data)

    # Bounding box
    min_px = max(0, int(min(px0, px1, px2)))
    max_px = min(img_w - 1, int(max(px0, px1, px2)) + 1)
    min_py = max(0, int(min(py0, py1, py2)))
    max_py = min(img_h - 1, int(max(py0, py1, py2)) + 1)

    # Precompute barycentric denominator
    det = (py1 - py2) * (px0 - px2) + (px2 - px1) * (py0 - py2)
    if abs(det) < 1e-12:
        return
    inv_det = 1.0 / det

    # UV deltas relative to vertex 2
    du0 = uv0[0] - uv2[0]
    du1 = uv1[0] - uv2[0]
    dv0 = uv0[1] - uv2[1]
    dv1 = uv1[1] - uv2[1]

    # Barycentric edge-function constants
    e0_const = py1 - py2
    e1_const = py2 - py0
    e0_yconst = px2 - px1
    e1_yconst = px0 - px2

    for y in range(min_py, max_py + 1):
        py = y + 0.5
        dy = py - py2

        px_start = min_px + 0.5
        w0 = (e0_const * (px_start - px2) + e0_yconst * dy) * inv_det
        w1 = (e1_const * (px_start - px2) + e1_yconst * dy) * inv_det

        w0_step = e0_const * inv_det
        w1_step = e1_const * inv_det

        dst_row_base = y * img_w

        for x in range(min_px, max_px + 1):
            w2 = 1.0 - w0 - w1
            if w0 >= -1e-6 and w1 >= -1e-6 and w2 >= -1e-6:
                u = w0 * du0 + w1 * du1 + uv2[0]
                v = w0 * dv0 + w1 * dv1 + uv2[1]

                tx = int(u * tex_w) % tex_w
                ty = int(v * tex_h) % tex_h  # 无 1.0 - v 翻转
                src_idx = (ty * tex_w + tx) * 4

                dst_idx = (dst_row_base + x) * 4
                pixels[dst_idx] = tex_rgba[src_idx]
                pixels[dst_idx + 1] = tex_rgba[src_idx + 1]
                pixels[dst_idx + 2] = tex_rgba[src_idx + 2]
                pixels[dst_idx + 3] = tex_rgba[src_idx + 3]

            w0 += w0_step
            w1 += w1_step


def _fill_flat_triangle(pixels, img_w, img_h, a, b, c, r, g, b_val, a_val):
    """填充纯色三角形（无纹理，用于无 UV 回退）。"""
    # 简单扫描线填充
    min_y = max(0, int(min(a[1], b[1], c[1])))
    max_y = min(img_h - 1, int(max(a[1], b[1], c[1])))
    for y in range(min_y, max_y + 1):
        min_x = img_w
        max_x = -1
        # 检查三条边与扫描线的交点
        for p1, p2 in [(a, b), (b, c), (c, a)]:
            if (p1[1] <= y < p2[1]) or (p2[1] <= y < p1[1]):
                if p2[1] != p1[1]:
                    x_int = p1[0] + (y - p1[1]) * (p2[0] - p1[0]) / (p2[1] - p1[1])
                    min_x = min(min_x, int(x_int))
                    max_x = max(max_x, int(x_int))
        for x in range(max(0, min_x), min(img_w, max_x + 1)):
            idx = (y * img_w + x) * 4
            pixels[idx] = r
            pixels[idx + 1] = g
            pixels[idx + 2] = b_val
            pixels[idx + 3] = a_val


def _point_in_polygon(px, py, poly):
    """射线法点是否在多边形内。poly: [(x,y),...] 世界坐标像素坐标皆可。"""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def fill_projected_mask(pixels, img_w, img_h, w2p,
                        tri_px, tri_uv, tex_data,
                        mask_poly_px):
    """三角面的 coplanar 填充：先正交俯视投影整张三角形到最终分辨率，
    再用截面蒙版多边形把投影图“按区域取块”拷入 pixels。

    B = 只选蒙版多边形内部的像素，原样拷入，不再做第二次贴图插值。
    这样填出来的就是该层真正应覆盖的截面，绝无 fan 扇出越界或 UV 飘出贴图。

    tri_px: [(px,py),...] 三角形 3 顶点在最终像素坐标系的正交投影
    tri_uv: [(u,v),...] 对应 UV
    tex_data: 贴图
    mask_poly_px: 截面蒙版多边形（像素坐标），在其内部取块
    """
    if tex_data is None or len(tri_px) != 3:
        return
    # 三角形像素包围盒（投影图只需建这一块）
    xs = [p[0] for p in tri_px]
    ys = [p[1] for p in tri_px]
    x0 = max(0, int(min(xs))); x1 = min(img_w - 1, int(max(xs)) + 1)
    y0 = max(0, int(min(ys))); y1 = min(img_h - 1, int(max(ys)) + 1)
    if x0 > x1 or y0 > y1:
        return
    bw = x1 - x0 + 1
    bh = y1 - y0 + 1
    if bw <= 0 or bh <= 0:
        return

    # 1) 用一次 barycentric 填充生成整张三角形投影图（正交、最终分辨率）
    #    （把局部 bbox 平移到局部原点，填充结果再拷回）
    #    贴图采样用 fill_textured_triangle：OBJ 保留原 UV 与原贴图像素，
    #    V 轴解释由每个材质的 MKP_flipY 元数据决定，避免格式转换造成错位。
    proj = bytearray(b'\x00\x00\x00\x00') * (bw * bh * 4)
    lpx0 = tri_px[0][0] - x0; lpy0 = tri_px[0][1] - y0
    lpx1 = tri_px[1][0] - x0; lpy1 = tri_px[1][1] - y0
    lpx2 = tri_px[2][0] - x0; lpy2 = tri_px[2][1] - y0
    fill_textured_triangle(proj, bw, bh, lpx0, lpy0, lpx1, lpy1, lpx2, lpy2,
                           tri_uv[0], tri_uv[1], tri_uv[2], tex_data)

    # 2) 蒙版取块：只把蒙版多边形内部的像素，从投影图拷到层 pixels
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if not _point_in_polygon(x, y, mask_poly_px):
                continue
            lx = x - x0; ly = y - y0
            sidx = (ly * bw + lx) * 4
            so = proj[sidx:sidx + 4]
            if so[3] == 0:
                continue  # 三角形投影图透明区不填
            didx = (y * img_w + x) * 4
            pixels[didx] = so[0]
            pixels[didx + 1] = so[1]
            pixels[didx + 2] = so[2]
            pixels[didx + 3] = so[3]


# ── Multiprocessing worker (module-level for pickle / spawn) ───────

_worker_all_faces = None
_worker_vertices = None
_worker_uvs = None
_worker_textures = None
_worker_output_dir = None
_worker_face_z_bounds = None


def _worker_init(all_faces, vertices, uvs, textures, output_dir, face_z_bounds=None):
    """每个 worker 进程启动时调用一次，设置共享数据。"""
    global _worker_all_faces, _worker_vertices, _worker_uvs, _worker_textures, _worker_output_dir, _worker_face_z_bounds
    _worker_all_faces = all_faces
    _worker_vertices = vertices
    _worker_uvs = uvs
    _worker_textures = textures
    _worker_output_dir = output_dir
    _worker_face_z_bounds = face_z_bounds

def _process_single_layer(args):
    """在 worker 进程中处理单层切片并保存 PNG。

    Args 元组: (layer_idx, z_center, img_size, layer_height, coplanar_tol,
                  scale, center_x, center_y, half_size, line_width)
    返回: (layer_idx, coplanar_count, seg_count)
    """
    from PIL import Image
    (layer_idx, z_center,
     img_size, layer_height, coplanar_tol,
     scale, center_x, center_y, half_size,
     line_width) = args

    all_faces = _worker_all_faces
    vertices = _worker_vertices
    uvs = _worker_uvs
    textures = _worker_textures
    output_dir = _worker_output_dir
    face_z_bounds = _worker_face_z_bounds

    # 本层 slab 区间
    z_bottom = z_center - layer_height / 2.0
    z_top = z_center + layer_height / 2.0

    def _w2p(x, y):
        return ((x - center_x) * scale + half_size,
                half_size - (y - center_y) * scale)

    all_coplanar = []       # (poly_2d, poly_uv, mtl_name)
    all_segments = []

    for idx, (v_idxs, uv_idxs, mtl_name) in enumerate(all_faces):
        if len(v_idxs) != 3:
            continue
        # z 区间快速剔除：只剔除“z 范围完全不可能碰到本层切面 z_center”的三角形。
        # 注意这里必须针对切面单点 z_center 判断（含 coplanar_tol 宽裕），
        # 而不是整层 slab 区间——否则层间 slab 缝隙会整圈误杀三角形，造成环缺失。
        if face_z_bounds is not None:
            fz_min, fz_max = face_z_bounds[idx]
            if fz_min is not None and (fz_max < z_center - coplanar_tol or fz_min > z_center + coplanar_tol):
                continue
        v0, v1, v2 = vertices[v_idxs[0]], vertices[v_idxs[1]], vertices[v_idxs[2]]
        uv0 = uvs[uv_idxs[0]] if uv_idxs and uv_idxs[0] < len(uvs) else None
        uv1 = uvs[uv_idxs[1]] if uv_idxs and uv_idxs[1] < len(uvs) else None
        uv2 = uvs[uv_idxs[2]] if uv_idxs and uv_idxs[2] < len(uvs) else None

        # ── 墙（已有路径）：平面相交 → 边界线段 ──
        _, segs = triangle_plane_intersection(
            v0, v1, v2, uv0, uv1, uv2, z_center, coplanar_tol)

        for (p1, uv_out1), (p2, uv_out2) in segs:
            all_segments.append(((p1, uv_out1), (p2, uv_out2), mtl_name))

        # ── 顶面/截面填充（独立路径）：slab 裁剪 → 取窗口内所有落下的多边形 ──
        # triangle_slab_clip 已把三角形裁剪到本层窗口，返回的多边形既含：
        #  · 整块落在窗口内的原生三角形（= 原三角）；
        #  · 被窗口切出来的更小四边形/多边形截面。
        # 二者都是该层真实应覆盖的区域，都必须填充。原先只收“原生面”导致所有
        # 被切出的截面四边形被丢弃，层内部镂空成毛刺/越界。这里全部收下。
        # 同时带上原三角形（正交投影本体）的像素点与 UV，供投影图+蒙版取块填充。
        polygons, _ = triangle_slab_clip(
            v0, v1, v2, uv0, uv1, uv2, z_bottom, z_top)
        for poly_2d, poly_uv in polygons:
            mask_px = [_w2p(p[0], p[1]) for p in poly_2d]
            tri_px = [_w2p(v[0], v[1]) for v in (v0, v1, v2)]
            tri_uv = (uv0, uv1, uv2)
            all_coplanar.append((mask_px, tri_px, tri_uv, mtl_name))

    pixels = bytearray(b'\x00\x00\x00\x00') * (img_size * img_size)  # 透明背景

    # ── 全局连通图：跨材质拼线，修复同一闭环被多 tex_*_mat 切散的缺口 ──
    # 相邻三角形共享边 → 切片交点完全相同 → 用 rounded 3D 坐标精确匹配
    # 全部网格段都进入同一张图（不按有无贴图过滤），保证闭环在材质缝处完整闭合。
    from collections import defaultdict as _dd

    def _pt3d_key(pt):
        """3D 交点的精确 key（浮点取整 6 位），用于匹配共享边的交点。"""
        return (round(pt[0], 6), round(pt[1], 6))

    segs_world = []
    for (p1, uv1), (p2, uv2), mtl_name in all_segments:
        segs_world.append(((p1, uv1), (p2, uv2), mtl_name))

    # 诊断：把拼线前的散碎线段（segs_world）用细红线置顶叠画，检查散线段长什么样。
    # 仅 __DIAG_RAW_SEGS 开启时启用。

    if segs_world:
        graph = _dd(list)
        # 拼线时，导出的 OBJ 顶点常带 toFixed(6) 舍入、或共享边被重复写出，
        # 独立插值得到的交点可能与 round(x,6) 的 key 差一点点而连不上、环断裂。
        # 这里在精确 key 之外，按模型尺度的容差做“就近端点”二次匹配，
        # 保证微小浮点差也能把环闭合，同时不把真正分开的内外环错误连到一起。
        # 容差取约半个像素对应的世界距离：既能吸住舍入误差，又小于墙厚（内外环不串）。
        _snap_tol = 0.5 / scale if scale > 0 else 1.0
        _snap_tol = max(_snap_tol, 1e-5)
        for idx, ((p1, uv1), (p2, uv2), _mtl) in enumerate(segs_world):
            graph[_pt3d_key(p1)].append((idx, 0))
            graph[_pt3d_key(p2)].append((idx, 1))

        def _seg_dir(s1, s2):
            """单位方向向量 (dx,dy)。"""
            dx = s2[0] - s1[0]; dy = s2[1] - s1[1]
            d = (dx * dx + dy * dy) ** 0.5
            return (dx / d, dy / d) if d > 0 else (0.0, 0.0)

        def _find_next(cur_p, cur_key, used, exclude_idx, in_dir=None):
            """求最流线的下一段：在候选里选“方向延续最顺”（转向角最小）的那条。

            in_dir: 当前前进方向 (dx,dy)（单位向量）。为 None 表示第一段，退化为就近。
            优先用精确 key 的候选；若同一 key 有多个候选，取让折线角度变化最小的；
            找不到再在 snap 容差内就近 + 方向择优。
            """
            def _turn_cost(o, c):
                """o: 上一前进方向(单位)，c: 待选分段的单位方向 -> 转向角（值越小越顺）。"""
                if o is None:
                    return 0.0
                dot = o[0] * c[0] + o[1] * c[1]
                dot = max(-1.0, min(1.0, dot))
                # 1 - dot：dot 越大越顺（同向 dot=1 -> cost 0；反向 -1 -> cost 2）
                return 1.0 - dot

            def _pick(cands):
                """从候选 (ni, ep, dir) 里选转向角最小者；并列则就近。返回 (ni, ep)。"""
                best = None
                best_cost = None
                best_d = None
                cx, cy = cur_p[0], cur_p[1]
                for ni, ep, dvec in cands:
                    cost = _turn_cost(in_dir, dvec)
                    # 终点到当前点的距离（就近参考）
                    (s1, su1), (s2, su2), _m = segs_world[ni]
                    ep_px = s1 if ep == 0 else s2
                    dist = (ep_px[0] - cx) ** 2 + (ep_px[1] - cy) ** 2
                    if (best_cost is None
                            or cost < best_cost - 1e-12
                            or (abs(cost - best_cost) <= 1e-12 and dist < (best_d or float('inf')))):
                        best = (ni, ep)
                        best_cost = cost
                        best_d = dist
                return best

            # 1) 精确 key 候选
            cand = []
            for ni, ep in graph.get(cur_key, []):
                if used[ni]:
                    continue
                (s1, su1), (s2, su2), _m = segs_world[ni]
                dvec = _seg_dir(s1, s2) if ep == 0 else _seg_dir(s2, s1)
                cand.append((ni, ep, dvec))
            if cand:
                return _pick(cand)

            # 2) snap 容差内就近 + 方向择优
            cand = []
            cx, cy = cur_p[0], cur_p[1]
            for ni, ((s1, su1), (s2, su2), _m) in enumerate(segs_world):
                if ni == exclude_idx or used[ni]:
                    continue
                d1 = (s1[0] - cx) ** 2 + (s1[1] - cy) ** 2
                if d1 <= _snap_tol * _snap_tol:
                    cand.append((ni, 0, _seg_dir(s1, s2)))
                d2 = (s2[0] - cx) ** 2 + (s2[1] - cy) ** 2
                if d2 <= _snap_tol * _snap_tol:
                    cand.append((ni, 1, _seg_dir(s2, s1)))
            if cand:
                return _pick(cand)
            return None

        used = [False] * len(segs_world)
        # 收集全部拼好的折线，最后按总长度降序统一绘制（长的置信度高、置顶画）。
        _all_polys = []

        for start_idx in range(len(segs_world)):
            if used[start_idx]:
                continue
            used[start_idx] = True

            (p1_3d, uv1), (p2_3d, uv2), mtl0 = segs_world[start_idx]
            poly_world = [((p1_3d, uv1), (p2_3d, uv2), mtl0)]

            # 从终点向前走（保持最流线：上一段方向作为择优参考）
            cur_key = _pt3d_key(p2_3d)
            in_dir = _seg_dir(p1_3d, p2_3d)
            while True:
                nxt = _find_next(p2_3d, cur_key, used, -1, in_dir)
                if nxt is None:
                    break
                ni, ep = nxt
                used[ni] = True
                (s1, su1), (s2, su2), smtl = segs_world[ni]
                if ep == 0:
                    poly_world.append(((s1, su1), (s2, su2), smtl))
                    cur_key = _pt3d_key(s2)
                    in_dir = _seg_dir(s1, s2)
                else:
                    poly_world.append(((s2, su2), (s1, su1), smtl))
                    cur_key = _pt3d_key(s1)
                    in_dir = _seg_dir(s2, s1)

            # 从起点反向走
            cur_key = _pt3d_key(p1_3d)
            front = []
            in_dir_rev = _seg_dir(p2_3d, p1_3d)
            while True:
                nxt = _find_next(p1_3d, cur_key, used, -1, in_dir_rev)
                if nxt is None:
                    break
                ni, ep = nxt
                used[ni] = True
                (s1, su1), (s2, su2), smtl = segs_world[ni]
                if ep == 0:
                    front.insert(0, ((s2, su2), (s1, su1), smtl))
                    cur_key = _pt3d_key(s2)
                    in_dir_rev = _seg_dir(s2, s1)
                else:
                    front.insert(0, ((s1, su1), (s2, su2), smtl))
                    cur_key = _pt3d_key(s1)
                    in_dir_rev = _seg_dir(s1, s2)

            poly_world = front + poly_world
            _all_polys.append(poly_world)

        # 按总长度降序统一绘制：最长的（置信度最高）最后画、置顶；短的画在底下。
        def _poly_len(poly):
            total = 0.0
            for (p1, uv1), (p2, uv2), _mtl in poly:
                dx = p2[0] - p1[0]; dy = p2[1] - p1[1]
                total += (dx * dx + dy * dy) ** 0.5
            return total

        _all_polys.sort(key=_poly_len)
        for poly_world in _all_polys:
            _draw_mixed_polyline_quads(pixels, img_size, img_size, poly_world, _w2p, textures, half_width=line_width / 2.0)

    # 三角面绘制（叠在线段上方，填充内部区域）
    # 投影图始终用原三角形完整 3 顶点 UV 生成（俯视正交投影），蒙版只决定“掏哪块”；
    # UV 不因切割改变 —— 保留所有三角形完整投影，仅掏窗口内要保留的区域。
    # __ENABLE_COPLANAR=False 时临时跳过，便于排查烂面是否来自此路径。
    if __ENABLE_COPLANAR:
        for mask_px, tri_px, tri_uv, mtl_name in all_coplanar:
            tex = textures.get(mtl_name)
            if tri_uv is not None and all(u is not None for u in tri_uv) and tex is not None:
                fill_projected_mask(pixels, img_size, img_size, _w2p,
                                    tri_px, tri_uv, tex, mask_px)
            else:
                # 无贴图或无 UV：用蒙版多边形纯色回退填充，缺处不会出现透明空洞
                nv = len(mask_px)
                for i in range(1, nv - 1):
                    _fill_flat_triangle(pixels, img_size, img_size,
                                        mask_px[0], mask_px[i], mask_px[i + 1], 0, 0, 0, 255)

    # 置顶细红线：把拼线前的散碎线段（segs_world）逐条画在最上层（覆盖一切），
    # 看散线段长什么样——每条独立从端点连到端点。
    # 只在 __DIAG_RAW_SEGS=True 时启用。
    if __DIAG_RAW_SEGS:
        _diag_hw = 0.5  # 细线半宽
        for (p1, uv1), (p2, uv2), _mtl in segs_world:
            a = _w2p(p1[0], p1[1])
            b = _w2p(p2[0], p2[1])
            _fill_flat_triangle(pixels, img_size, img_size,
                                (a[0] - _diag_hw, a[1] - _diag_hw),
                                (a[0] + _diag_hw, a[1] + _diag_hw),
                                (a[0] + _diag_hw, a[1] - _diag_hw), 255, 0, 0, 255)
            _fill_flat_triangle(pixels, img_size, img_size,
                                (b[0] - _diag_hw, b[1] - _diag_hw),
                                (b[0] + _diag_hw, b[1] + _diag_hw),
                                (b[0] + _diag_hw, b[1] - _diag_hw), 255, 0, 0, 255)
            _fill_flat_triangle(pixels, img_size, img_size,
                                (a[0], a[1] - _diag_hw), (b[0], b[1] - _diag_hw),
                                (b[0], b[1] + _diag_hw), 255, 0, 0, 255)
            _fill_flat_triangle(pixels, img_size, img_size,
                                (a[0], a[1] - _diag_hw), (a[0], a[1] + _diag_hw),
                                (b[0], b[1] + _diag_hw), 255, 0, 0, 255)

    # Worker 直接保存 PNG，避免把 64MB 像素数据传回主线程
    filename = f"layer_{layer_idx:04d}.png"
    filepath = os.path.join(output_dir, filename)
    img = Image.frombytes('RGBA', (img_size, img_size), bytes(pixels))
    img.save(filepath, compress_level=1)

    return layer_idx, len(all_coplanar), len(all_segments)


def _strip_worker_init(output_dir_ref, strip_temp_dir_ref, img_size_ref, bed_size_ref, motion_params_ref=None):
    """每个条带 worker 进程启动时设置共享路径参数。"""
    global _strip_output_dir, _strip_temp_dir, _strip_img_size, _strip_bed_size, _strip_motion_params
    _strip_output_dir = output_dir_ref
    _strip_temp_dir = strip_temp_dir_ref
    _strip_img_size = img_size_ref
    _strip_bed_size = bed_size_ref
    _strip_motion_params = motion_params_ref


_strip_output_dir = None
_strip_temp_dir = None
_strip_img_size = None
_strip_bed_size = None
_strip_motion_params = None


def _process_single_strip(args):
    """在 worker 进程中处理单层条带切割 + MBD 转换。"""
    import numpy as np
    from PIL import Image
    from strip_processor import process_layer_from_array
    import os as _os
    (layer_name,) = args
    filepath = _os.path.join(_strip_output_dir, f"{layer_name}.png")
    arr = np.array(Image.open(filepath).convert('RGBA'))
    # 创建层 MBD 输出目录
    layer_mbd_dir = _os.path.join(_strip_temp_dir, layer_name)
    _os.makedirs(layer_mbd_dir, exist_ok=True)
    r = process_layer_from_array(
        arr, layer_name, _strip_img_size, _strip_bed_size,
        output_zip_dir=_strip_temp_dir,
        motion_params=_strip_motion_params,
        block_output_dir=layer_mbd_dir,
    )
    return layer_name, r


class SliceCancelledError(RuntimeError):
    """由外部取消文件触发的优雅取消异常，供上层捕获后正常退出（exit 0）。"""
    pass


def _is_cancel_requested(cancel_flag_path=None):
    """检查是否请求取消：优先用内存 flag（如 CLI/Headless 传入的 Event），再检查取消文件。"""
    if cancel_flag_path is None:
        cancel_flag_path = os.path.join(os.path.expanduser('~/Documents/MKPSpectrum'), 'slice_cancel.flag')
    # 内存 flag（若调用方传了可调用对象）
    # 实际由 _cancel_check 回调判断，这里只做文件检查的兜底
    try:
        if os.path.exists(cancel_flag_path):
            return True
    except Exception:
        pass
    return False


# ── Core slice logic (called both from CLI and in-process) ─────────

def run_slice(obj_path, output_dir, layer_height=0.2, resolution=4000,
              do_strip=False, bed_size=270.0, strip_output=None,
              progress_callback=None, log_callback=None,
              motion_params=None, zip_dir=None,
              cancel_flag_path=None, should_cancel=None):
    """Execute a full texture slicing pipeline. Can be called in-process.

    Parameters
    ----------
    obj_path : str
        Path to input OBJ file.
    output_dir : str
        Directory to write PNG layer images.
    layer_height : float
        Layer height in mm.
    resolution : int
        Output image size in pixels (square).
    do_strip : bool
        Run strip/gcode generation after slicing.
    bed_size : float
        Print bed size in mm (only used when do_strip=True).
    strip_output : str | None
        Base directory for Segment output (defaults to parent of output_dir).
    progress_callback : callable | None
        Called with (msg_type, data_dict).  msg_type ∈ {'log','progress','done','strip_done'}.
    log_callback : callable | None
        Called with (message_string) for log output.

    Returns
    -------
    dict with keys: success, num_layers, png_count, strip_done (optional fields).
    Raises
    ------
    SliceCancelledError
        当 should_cancel()/cancel_flag_path 指示已取消时抛出，调用方应捕获后优雅退出（exit 0）。
    """
    import multiprocessing
    from PIL import Image

    # 统一的取消检测：优先用 should_cancel 回调，其次检查取消文件
    if cancel_flag_path is None:
        cancel_flag_path = os.path.join(os.path.expanduser('~/Documents/MKPSpectrum'), 'slice_cancel.flag')

    def _cancelled():
        try:
            if should_cancel is not None and should_cancel():
                return True
        except Exception:
            pass
        try:
            if os.path.exists(cancel_flag_path):
                return True
        except Exception:
            pass
        return False

    def _check_cancel_or_raise(msg="已取消"):
        if _cancelled():
            raise SliceCancelledError(msg)

    def _log(msg):
        if log_callback:
            log_callback(msg)
        if progress_callback:
            progress_callback('log', {'message': msg})

    def _progress(current, total):
        if progress_callback:
            progress_callback('progress', {'current': current, 'total': total})

    def _done(count):
        if progress_callback:
            progress_callback('done', {'count': count})

    def _strip_done(layers, blocks, zip_p, gcode_lines):
        if progress_callback:
            progress_callback('strip_done', {
                'layers': layers,
                'total_blocks': blocks,
                'zip_path': zip_p,
                'gcode_lines_all': gcode_lines,
            })

    img_size = resolution

    os.makedirs(output_dir, exist_ok=True)

    # Clean up entire output directory from previous runs
    for old in glob.glob(os.path.join(output_dir, "*")):
        try:
            if os.path.isfile(old):
                os.remove(old)
            elif os.path.isdir(old):
                shutil.rmtree(old)
        except Exception:
            pass

    # 自动读取喷墨 XY 偏移配置（如果调用方未提供则补充）
    if motion_params is None:
        motion_params = {}
    try:
        from pathlib import Path as _Path
        import urllib.request as _ureq
        _config_dir = _Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
        _cfg_path = _config_dir / 'MKP standard.json'
        if not _cfg_path.exists():
            _config_dir.mkdir(parents=True, exist_ok=True)
            _url = 'https://gitee.com/Jhmodel/mkpspectrum/raw/master/CONF/MKP%20standard.json'
            print('[Config] MKP standard.json 不存在，正在从 Gitee 自动下载...')
            try:
                _ureq.urlretrieve(_url, str(_cfg_path))
                print(f'[Config] 下载成功: {_cfg_path}')
            except Exception as _e:
                print(f'[Config] 自动下载失败: {_e}')
        if _cfg_path.exists():
            with open(_cfg_path, 'r', encoding='utf-8') as _cf:
                _cfg = json.load(_cf)
            _ij = _cfg.get('inkjet', {})
            _offset = _ij.get('offset', {})
            if 'offset_x' not in motion_params:
                motion_params['offset_x'] = float(_offset.get('x', 0))
            if 'offset_y' not in motion_params:
                motion_params['offset_y'] = float(_offset.get('y', 0))
            if 'print_speed' not in motion_params:
                motion_params['print_speed'] = float(_ij.get('speed', 20))
            if 'inkjet_density' not in motion_params:
                motion_params['inkjet_density'] = int(float(_ij.get('density', 0.5)) * 100)
            # CMY 色调调节（仅当调用方未提供时从 JSON 读取）
            if 'cmy_c' not in motion_params:
                _cmy = _ij.get('cmy', {})
                motion_params['cmy_c'] = float(_cmy.get('c', 1.0))
                motion_params['cmy_m'] = float(_cmy.get('m', 1.0))
                motion_params['cmy_y'] = float(_cmy.get('y', 1.0))
                motion_params['cmy_saturation'] = float(_cmy.get('saturation', 0.0))
                motion_params['cmy_brightness'] = float(_cmy.get('brightness', 0.0))
            if 'contrast' not in motion_params:
                motion_params['contrast'] = float(_ij.get('contrast', 1.0))
    except Exception:
        pass

    # Parse OBJ + MTL
    obj_dir = os.path.dirname(obj_path)
    vertices, uvs, faces_by_material = parse_obj(obj_path)

    mtl_path = os.path.join(obj_dir, "model.mtl")
    materials = parse_mtl(mtl_path) if os.path.exists(mtl_path) else {}

    # Load textures (pre-convert to flat RGBA bytes for O(1) sampling)
    textures = {}
    for mtl_name, props in materials.items():
        if 'map_Kd' in props:
            tex_path = os.path.join(obj_dir, props['map_Kd'])
            if os.path.exists(tex_path):
                tex_img = Image.open(tex_path).convert('RGBA')
                flip_y = bool(props.get('MKP_flipY', True))
                _log(f"Loaded texture: {props['map_Kd']} ({tex_img.size}) flipY={flip_y}")
                textures[mtl_name] = (*_tex_to_rgba(tex_img), flip_y)
                tex_img.close()
            else:
                _log(f"WARNING: texture not found: {tex_path}")
                textures[mtl_name] = None
        else:
            textures[mtl_name] = None

    # Flatten faces: each face is (vidxs, uvidxs, mtl_name)
    # 全量几何参与切片（不再按有无贴图过滤）。
    # 真正省交点成本的是“只对落在本层 z 区间内的三角形求交”，
    # 而不是“按有无贴图把整块几何扔掉”。贴图只是绘制手段，不是几何是否存在的判据；
    # 一旦按贴图过滤掉无贴图实体（腿的侧面），闭环就会沿材质缝整段缺失。
    # 这里保留全部分面，同时预计算每个三角形的 z 范围，方便每层快速剔除。
    all_faces = []
    for mtl_name, faces in faces_by_material.items():
        for v_idxs, uv_idxs in faces:
            all_faces.append((v_idxs, uv_idxs, mtl_name))

    # 预计算每个三角形的 z 范围（与 all_faces 同序），用于每层 z 区间快速剔除
    face_z_bounds = []
    for v_idxs, uv_idxs, mtl_name in all_faces:
        if len(v_idxs) == 3:
            zs = [vertices[i][2] for i in v_idxs]
            face_z_bounds.append((min(zs), max(zs)))
        else:
            face_z_bounds.append((None, None))

    _log(f"Faces: {len(all_faces)} (全量几何参与切片，不按贴图过滤；三角 z 区间已预计算)")

    # Model bounds — use ALL vertices (including corner-plane markers)
    # so the canvas matches the actual print-bed size.
    min_x = min(v[0] for v in vertices)
    max_x = max(v[0] for v in vertices)
    min_y = min(v[1] for v in vertices)
    max_y = max(v[1] for v in vertices)
    min_z = min(v[2] for v in vertices)
    max_z = max(v[2] for v in vertices)

    _log(f"Model bounds: X=[{min_x:.3f}, {max_x:.3f}]  Y=[{min_y:.3f}, {max_y:.3f}]  Z=[{min_z:.3f}, {max_z:.3f}]")

    num_layers = math.ceil((max_z - min_z) / layer_height)
    _log(f"Total layers: {num_layers} @ {layer_height}mm")

    # Image settings — line_width 按分辨率等比缩放，基准: 4000 → 12px
    line_width = max(2, int(img_size * 12 / 4000))
    coplanar_tol = layer_height * 1.5  # 增大容差，确保顶面/底面被判定为共面

    # Precompute world→pixel transform constants (avoids recomputing per vertex)
    scale_x = img_size / (max_x - min_x) if max_x > min_x else 1.0
    scale_y = img_size / (max_y - min_y) if max_y > min_y else 1.0
    scale = min(scale_x, scale_y)
    center_x = (min_x + max_x) / 2.0
    center_y = (min_y + max_y) / 2.0
    half_size = img_size / 2.0

    def _w2p(x, y):
        """Fast world-to-pixel using precomputed constants."""
        return ((x - center_x) * scale + half_size,
                half_size - (y - center_y) * scale)

    # ---- 产线式流水：分批切片 + 随产随转（有界背压，避免 32GB 堆满）----
    strip_results = []
    layer_names = []
    # 预先准备 strip 目录（do_strip 时需要）
    if do_strip:
        strip_base = strip_output or os.path.dirname(output_dir)
        if not strip_base:
            strip_base = output_dir
        segment_dir = os.path.join(strip_base, 'Segment')
        strip_zip_dir = os.path.join(segment_dir, 'zip')
        strip_temp_dir = os.path.join(segment_dir, '_temp')
        for d in [strip_zip_dir, strip_temp_dir]:
            if os.path.exists(d):
                shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d, exist_ok=True)
        _log(f"Strip output: {segment_dir}")

    # Z 平面与任务参数（切片与条带共用）
    if num_layers == 1:
        z_centers = [min_z]
    else:
        z_step = (max_z - min_z) / (num_layers - 1) if num_layers > 1 else 0
        z_centers = [min_z + i * z_step for i in range(num_layers)]

    layer_args = [
        (layer_idx,
         z_centers[layer_idx],
         img_size, layer_height, coplanar_tol,
         scale, center_x, center_y, half_size,
         line_width)
        for layer_idx in range(num_layers)
    ]

    result = {
        'success': True,
        'num_layers': num_layers,
        'png_count': num_layers,
    }

    if not do_strip:
        num_workers = min(multiprocessing.cpu_count(), len(layer_args))
        _log(f"启动 {num_workers} 个 worker 进程并行切片 {num_layers} 层，首次启动需导入模块，请稍候...")
        _progress(0, num_layers)
        _check_cancel_or_raise("切片已取消")
        with multiprocessing.Pool(
            processes=num_workers,
            initializer=_worker_init,
            initargs=(all_faces, vertices, uvs, textures, output_dir, face_z_bounds)
        ) as pool:
            try:
                for completed, (layer_idx, coplanar_count, seg_count) in enumerate(
                    pool.imap_unordered(_process_single_layer, layer_args), 1
                ):
                    _check_cancel_or_raise("切片已取消")
                    filename = f"layer_{layer_idx:04d}.png"
                    _progress(completed, num_layers)
                    if completed % 10 == 0:
                        time.sleep(0.005)
                    if completed % 5 == 0 and _cancelled():
                        raise SliceCancelledError("切片已取消")
                    if completed % 20 == 0 or completed <= 3 or completed >= num_layers - 2:
                        z_center = min_z + layer_idx * layer_height + layer_height / 2.0
                        _log(f"  Layer {layer_idx:04d}  z={z_center:.3f}  coplanar={coplanar_count:2d}  segs={seg_count:2d}  -> {filename}")
            except SliceCancelledError:
                _log("检测到取消，正在终止切片 Pool...")
                try:
                    pool.terminate()
                except Exception:
                    pass
                try:
                    pool.join()
                except Exception:
                    pass
                raise
        _log(f"\nDone. {num_layers} PNGs saved to: {output_dir}")
        _done(num_layers)
    else:
        # 流水线：切片与条带/MBD 重叠执行，strip 紧跟切片完成即提交，避免全量堆积
        total_cores = multiprocessing.cpu_count() or 4
        # 产线配比：切片与条带共享 CPU，留 1 核给 GUI；切片偏重可略多
        # MBD 转换本身会启动 Node/WASM 计算，条带进程不能按剩余 CPU
        # 无限扩张，否则每个进程内部的 MBD 线程会造成严重过度并发。
        # 保留少量切片并行，同时把条带/MBD 侧限制在最多 2 个进程。
        slice_workers = max(1, min(total_cores - 1, len(layer_args), max(2, (total_cores * 2) // 3)))
        strip_workers = max(1, min(2, total_cores - slice_workers))
        max_pending_strip = max(8, strip_workers * 3)
        _log(f"流水线模式: 切片 {slice_workers} 产线 + 条带 {strip_workers} 产线，背压阈值 {max_pending_strip} 层，首启需导入模块请稍候...")
        _progress(0, num_layers)
        import collections as _collections
        pending_strip = _collections.deque()
        completed_slice = 0
        completed_strip = 0

        def _drain_strip(blocking=False):
            nonlocal completed_strip
            drained = 0
            if blocking:
                if pending_strip:
                    ar, lname = pending_strip.popleft()
                    try:
                        _, r = ar.get(timeout=3600)
                        strip_results.append(r)
                        layer_names.append(lname)
                        completed_strip += 1
                        if completed_strip % 5 == 0 or completed_strip <= 2:
                            _log(f"  Strip {completed_strip}/{num_layers}  {lname}: {r['strip_count']} strips, {r['total_blocks']} blocks")
                        drained = 1
                    except Exception as e:
                        import traceback as _tb
                        _log(f"条带处理异常 {lname}: {e}\n{_tb.format_exc()}")
            else:
                while pending_strip and pending_strip[0][0].ready():
                    ar, lname = pending_strip.popleft()
                    try:
                        _, r = ar.get(timeout=30)
                        strip_results.append(r)
                        layer_names.append(lname)
                        completed_strip += 1
                        if completed_strip % 5 == 0 or completed_strip <= 2:
                            _log(f"  Strip {completed_strip}/{num_layers}  {lname}: {r['strip_count']} strips, {r['total_blocks']} blocks")
                        drained += 1
                    except Exception as e:
                        import traceback as _tb
                        _log(f"条带处理异常 {lname}: {e}\n{_tb.format_exc()}")
            return drained

        _check_cancel_or_raise("切片已取消")
        try:
            with multiprocessing.Pool(
                processes=slice_workers,
                initializer=_worker_init,
                initargs=(all_faces, vertices, uvs, textures, output_dir, face_z_bounds)
            ) as slice_pool, multiprocessing.Pool(
                processes=strip_workers,
                initializer=_strip_worker_init,
                initargs=(output_dir, strip_temp_dir, img_size, bed_size, motion_params)
            ) as strip_pool:
                slice_iter = slice_pool.imap_unordered(_process_single_layer, layer_args)
                for layer_idx, coplanar_count, seg_count in slice_iter:
                    _check_cancel_or_raise("切片已取消")
                    completed_slice += 1
                    filename = f"layer_{layer_idx:04d}.png"
                    layer_name = f"layer_{layer_idx:04d}"
                    _progress(completed_slice, num_layers)
                    if completed_slice % 10 == 0:
                        time.sleep(0.005)
                    if completed_slice % 20 == 0 or completed_slice <= 3 or completed_slice >= num_layers - 2:
                        z_center = min_z + layer_idx * layer_height + layer_height / 2.0
                        _log(f"  Layer {layer_idx:04d}  z={z_center:.3f}  coplanar={coplanar_count:2d}  segs={seg_count:2d}  -> {filename}")
                    ar = strip_pool.apply_async(_process_single_strip, ((layer_name,),))
                    pending_strip.append((ar, layer_name))
                    _drain_strip(blocking=False)
                    while len(pending_strip) >= max_pending_strip:
                        _drain_strip(blocking=True)
                        _drain_strip(blocking=False)
                    if completed_slice % 5 == 0 and _cancelled():
                        raise SliceCancelledError("切片已取消")
                _check_cancel_or_raise("切片已取消")
                _log(f"切片完成 {completed_slice}/{num_layers}，等待剩余 {len(pending_strip)} 层条带/MBD 完成...")
                while pending_strip:
                    _check_cancel_or_raise("切片已取消")
                    _drain_strip(blocking=True)
                    _drain_strip(blocking=False)
        except SliceCancelledError:
            _log("检测到取消，正在终止流水线 Pool...")
            try:
                slice_pool.terminate()  # type: ignore[possiblyUnbound]
            except Exception:
                pass
            try:
                strip_pool.terminate()  # type: ignore[possiblyUnbound]
            except Exception:
                pass
            try:
                slice_pool.join()  # type: ignore[possiblyUnbound]
            except Exception:
                pass
            try:
                strip_pool.join()  # type: ignore[possiblyUnbound]
            except Exception:
                pass
            try:
                from strip_processor import shutdown_mbd_procs
                shutdown_mbd_procs()
            except Exception:
                pass
            raise
        except Exception as e:
            _log(f"流水线异常: {e}")
            import traceback
            _log(traceback.format_exc())
        _log(f"\nDone. {num_layers} PNGs saved to: {output_dir} | Strip done: {len(strip_results)} layers")
        _done(num_layers)

    # ---- 条带切割收尾：强制 MBD 转换 + 打包 _temp.zip ----
    if do_strip and strip_results:
        # imap_unordered 返回顺序不确定，按 layer_name 排序保证 layer_0000 在首位
        strip_results.sort(key=lambda r: r['layer_name'])
        total_blocks = sum(r['total_blocks'] for r in strip_results)
        gcode_lines_all = [r['gcode_lines'] for r in strip_results]
        _log(f"\nStrip done: {len(strip_results)} layers, {total_blocks} blocks")

        # MBD 转换已在条带切割中完成（每层 worker 处理后自动关闭其 MBD 进程）
        try:
            from strip_processor import shutdown_mbd_procs
            shutdown_mbd_procs()
            _log("MBD 常驻进程已关闭")
        except Exception:
            pass

        # 打包 _temp.zip（若 zip_dir 指定则放在那里，否则放 output_dir）
        _zip_target = zip_dir if zip_dir else output_dir
        zip_path = os.path.join(_zip_target, '_temp.zip')
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(strip_temp_dir):
                for fn in files:
                    fp = os.path.join(root, fn)
                    arcname = os.path.relpath(fp, strip_temp_dir)
                    zf.write(fp, arcname)
        _log(f"已打包: {zip_path}")

        _strip_done(len(strip_results), total_blocks, zip_path, gcode_lines_all)
        result['strip_done'] = {
            'layers': len(strip_results),
            'total_blocks': total_blocks,
            'zip_path': zip_path,
            'gcode_lines_all': gcode_lines_all,
        }

    # ── 内存清理：显式释放大型数据结构，避免 RAM 残留 ──
    import gc as _gc

    # 清除多进程 worker 全局引用
    global _worker_all_faces, _worker_vertices, _worker_uvs, _worker_textures, _worker_output_dir, _worker_face_z_bounds
    _worker_all_faces = None
    _worker_vertices = None
    _worker_uvs = None
    _worker_textures = None
    _worker_output_dir = None
    _worker_face_z_bounds = None

    # 清除条带 worker 全局引用
    global _strip_output_dir, _strip_temp_dir, _strip_img_size, _strip_bed_size, _strip_motion_params
    _strip_output_dir = None
    _strip_temp_dir = None
    _strip_img_size = None
    _strip_bed_size = None
    _strip_motion_params = None

    # 清除本地大型变量（vertices/uvs/textures/all_faces/layer_args 始终存在）
    del vertices, uvs, textures, all_faces, face_z_bounds, layer_args
    if do_strip:
        del strip_results
        # gcode_lines_all 仅在 strip_results 非空时定义
        try:
            del gcode_lines_all
        except NameError:
            pass

    _gc.collect()

    return result


# ── CLI entry point ────────────────────────────────────────────────

def main():
    import argparse

    parser = argparse.ArgumentParser(description='MKPSpectrum 纹理切片工具（独立模式）')
    parser.add_argument('--obj', required=True, help='输入 OBJ 文件路径')
    parser.add_argument('--output', required=True, help='输出目录')
    parser.add_argument('--layer_height', type=float, default=0.2, help='层高 (mm)')
    parser.add_argument('--resolution', type=int, default=4000, help='输出图片分辨率 (像素)')
    parser.add_argument('--progress', action='store_true', help='以 JSON 行格式输出进度到 stdout')
    parser.add_argument('--strip', action='store_true',
                        help='切片完成后直接在内存中进行条带切割（跳过 PNG 回读）')
    parser.add_argument('--bed_size', type=float, default=270.0,
                        help='打印床尺寸 (mm)，--strip 时用于坐标换算')
    parser.add_argument('--strip_output',
                        help='条带输出基础目录（默认为 --output 的上级目录，Segment/ 将创建在其下）')
    args = parser.parse_args()

    progress_mode = args.progress

    # Build callbacks for progress mode
    _logged = set()  # avoid duplicate log lines

    def _on_progress(msg_type, data):
        if msg_type == 'log':
            print(f"[slice] {data['message']}", file=sys.stderr if progress_mode else sys.stdout)
        elif msg_type == 'progress':
            if progress_mode:
                sys.stdout.write(json.dumps(data) + '\n')
                sys.stdout.flush()
        elif msg_type == 'done':
            if progress_mode:
                sys.stdout.write(json.dumps(data) + '\n')
                sys.stdout.flush()
        elif msg_type == 'strip_done':
            if progress_mode:
                sys.stdout.write(json.dumps(data) + '\n')
                sys.stdout.flush()

    def _on_log(msg):
        if progress_mode:
            print(msg, file=sys.stderr)
        else:
            print(msg)

    # 读取喷墨 XY 偏移配置
    _motion_params = {}
    try:
        from pathlib import Path as _Path
        import urllib.request as _ureq
        _config_dir = _Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
        _cfg_path = _config_dir / 'MKP standard.json'
        if not _cfg_path.exists():
            _config_dir.mkdir(parents=True, exist_ok=True)
            _url = 'https://gitee.com/Jhmodel/mkpspectrum/raw/master/CONF/MKP%20standard.json'
            print('[Config] MKP standard.json 不存在，正在从 Gitee 自动下载...')
            try:
                _ureq.urlretrieve(_url, str(_cfg_path))
                print(f'[Config] 下载成功: {_cfg_path}')
            except Exception as _e:
                print(f'[Config] 自动下载失败: {_e}')
        if _cfg_path.exists():
            with open(_cfg_path, 'r', encoding='utf-8') as _cf:
                _cfg = json.load(_cf)
            _ij = _cfg.get('inkjet', {})
            _offset = _ij.get('offset', {})
            _motion_params['offset_x'] = float(_offset.get('x', 0))
            _motion_params['offset_y'] = float(_offset.get('y', 0))
            _motion_params['print_speed'] = float(_ij.get('speed', 20))
            _motion_params['inkjet_density'] = int(float(_ij.get('density', 0.5)) * 100)
    except Exception:
        pass

    run_slice(
        obj_path=args.obj,
        output_dir=args.output,
        layer_height=args.layer_height,
        resolution=args.resolution,
        do_strip=args.strip,
        bed_size=args.bed_size,
        strip_output=args.strip_output,
        progress_callback=_on_progress,
        log_callback=_on_log,
        motion_params=_motion_params if _motion_params else None,
    )


if __name__ == "__main__":
    main()
