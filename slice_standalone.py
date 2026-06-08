#Accept obj files from the main window
import os
import math
import sys
import json
import glob
from collections import defaultdict
from PIL import Image, ImageDraw
import shutil
import zipfile


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
                if current_mtl:
                    faces_by_material[current_mtl].append((v_idxs, uv_idxs))

    return vertices, uvs, faces_by_material


# ── Interpolation helpers ──────────────────────────────────────────

def _lerp_2d(a, b, t):
    return ((1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1])


def _lerp_uv(a, b, t):
    if a is None or b is None:
        return None
    return ((1 - t) * a[0] + t * a[1], (1 - t) * a[1] + t * b[1])


# ── Triangle / plane intersection with UV ──────────────────────────

def triangle_plane_intersection(v0, v1, v2, uv0, uv1, uv2, z_plane,
                                coplanar_tol, seg_eps=1e-9):
    """Intersect a triangle (with optional UV) against horizontal plane at z_plane.

    Returns:
        coplanar: [(poly_2d, poly_uv_or_None), ...]
        segments: [((x1,y1,uv_or_None), (x2,y2,uv_or_None)), ...]
    """
    zs = [v0[2], v1[2], v2[2]]
    verts = [v0, v1, v2]
    uvs_in = [uv0, uv1, uv2]

    # Coplanar check (all vertices near plane)
    if all(abs(zi - z_plane) <= coplanar_tol for zi in zs):
        poly_2d = [(v[0], v[1]) for v in verts]
        poly_uv = [(u[0], u[1]) for u in uvs_in] if all(u is not None for u in uvs_in) else None
        return [(poly_2d, poly_uv)], []

    above = [i for i in range(3) if zs[i] > z_plane + seg_eps]
    below = [i for i in range(3) if zs[i] < z_plane - seg_eps]
    on = [i for i in range(3) if abs(zs[i] - z_plane) <= seg_eps]

    segments = []
    coplanar = []

    def _interp_edge(i_a, i_b):
        """Interpolate position and UV along edge (i_a, i_b) at z_plane."""
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
        poly_2d = [(verts[i][0], verts[i][1]) for i in range(3)]
        poly_uv = [(uvs_in[i][0], uvs_in[i][1]) for i in range(3)] if all(u is not None for u in uvs_in) else None
        coplanar.append((poly_2d, poly_uv))
    elif len(on) == 2:
        pt_a = (verts[on[0]][0], verts[on[0]][1])
        pt_b = (verts[on[1]][0], verts[on[1]][1])
        uv_a = (uvs_in[on[0]][0], uvs_in[on[0]][1]) if uvs_in[on[0]] is not None else None
        uv_b = (uvs_in[on[1]][0], uvs_in[on[1]][1]) if uvs_in[on[1]] is not None else None
        segments.append(((pt_a, uv_a), (pt_b, uv_b)))
    elif len(on) == 1:
        if len(above) == 1 and len(below) == 1:
            a, b = above[0], below[0]
            r1 = _interp_edge(on[0], a)
            r2 = _interp_edge(on[0], b)
            if r1 and r2:
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

    return coplanar, segments


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

def sample_texture(tex_data, u, v):
    """Sample pre-converted texture at UV coordinates (u, v in [0,1])."""
    if tex_data is None:
        return None
    w, h, rgba = tex_data
    tx = int(u * w) % w
    ty = int((1.0 - v) * h) % h  # OBJ UV: v=0 is bottom, PIL: y=0 is top
    idx = (ty * w + tx) * 4
    return (rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3])


def fill_textured_triangle(pixels, img_w, img_h, px0, py0, px1, py1, px2, py2,
                           uv0, uv1, uv2, tex_data):
    """Barycentric fill of a triangle with texture sampling into bytearray pixels."""
    if tex_data is None:
        return
    tex_w, tex_h, tex_rgba = tex_data

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
            if w0 >= -1e-9 and w1 >= -1e-9 and w2 >= -1e-9:
                u = w0 * du0 + w1 * du1 + uv2[0]
                v = w0 * dv0 + w1 * dv1 + uv2[1]

                tx = int(u * tex_w) % tex_w
                ty = int((1.0 - v) * tex_h) % tex_h
                src_idx = (ty * tex_w + tx) * 4

                dst_idx = (dst_row_base + x) * 4
                pixels[dst_idx] = tex_rgba[src_idx]
                pixels[dst_idx + 1] = tex_rgba[src_idx + 1]
                pixels[dst_idx + 2] = tex_rgba[src_idx + 2]
                pixels[dst_idx + 3] = tex_rgba[src_idx + 3]

            w0 += w0_step
            w1 += w1_step


def draw_textured_segment(pixels, img_w, img_h, p1, uv1, p2, uv2, tex_data, width=2):
    """Draw a colored line segment using UV-interpolated texture samples into bytearray."""
    if tex_data is None:
        return
    tex_w, tex_h, tex_rgba = tex_data

    x1, y1 = int(p1[0]), int(p1[1])
    x2, y2 = int(p2[0]), int(p2[1])
    dx = abs(x2 - x1)
    dy = abs(y2 - y1)
    sx = 1 if x1 < x2 else -1
    sy = 1 if y1 < y2 else -1
    err = dx - dy
    total_dist = math.sqrt(dx * dx + dy * dy) or 1

    # Precompute line-width offset grid
    hw = width // 2
    hw2 = (width + 1) // 2
    offsets = [(wx, wy) for wy in range(-hw, hw2) for wx in range(-hw, hw2)]

    # UV deltas for interpolation along the segment
    has_uv = uv1 is not None and uv2 is not None
    if has_uv:
        du = uv2[0] - uv1[0]
        dv = uv2[1] - uv1[1]
    else:
        # Sample endpoints once for flat color
        fallback_col = None
        if uv1 is not None:
            s = sample_texture(tex_data, uv1[0], uv1[1])
            if s is not None:
                fallback_col = s
        if fallback_col is None and uv2 is not None:
            s = sample_texture(tex_data, uv2[0], uv2[1])
            if s is not None:
                fallback_col = s
        if fallback_col is None:
            return

    cx, cy = x1, y1
    step = 0
    while True:
        # Get color at current point
        if has_uv:
            t = step / total_dist
            u = uv1[0] + t * du
            v = uv1[1] + t * dv
            tx = int(u * tex_w) % tex_w
            ty = int((1.0 - v) * tex_h) % tex_h
            src_idx = (ty * tex_w + tx) * 4
            cr = tex_rgba[src_idx]
            cg = tex_rgba[src_idx + 1]
            cb = tex_rgba[src_idx + 2]
            ca = tex_rgba[src_idx + 3]
        else:
            cr, cg, cb, ca = fallback_col

        for wx, wy in offsets:
            px, py = cx + wx, cy + wy
            if 0 <= px < img_w and 0 <= py < img_h:
                dst_idx = (py * img_w + px) * 4
                pixels[dst_idx] = cr
                pixels[dst_idx + 1] = cg
                pixels[dst_idx + 2] = cb
                pixels[dst_idx + 3] = ca

        if cx == x2 and cy == y2:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            cx += sx
        if e2 < dx:
            err += dx
            cy += sy
        step += 1


# ── Core slice logic (called both from CLI and in-process) ─────────

def run_slice(obj_path, output_dir, layer_height=0.2, resolution=4000,
              do_strip=False, bed_size=270.0, strip_output=None,
              progress_callback=None, log_callback=None):
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
    """
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

    def _strip_done(layers, blocks, zip_p, gcode_d):
        if progress_callback:
            progress_callback('strip_done', {
                'layers': layers,
                'total_blocks': blocks,
                'zip_path': zip_p,
                'gcode_dir': gcode_d,
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
                _log(f"Loaded texture: {props['map_Kd']} ({tex_img.size})")
                textures[mtl_name] = _tex_to_rgba(tex_img)
                tex_img.close()
            else:
                _log(f"WARNING: texture not found: {tex_path}")
                textures[mtl_name] = None
        else:
            textures[mtl_name] = None

    # Flatten faces: each face is (vidxs, uvidxs, mtl_name)
    all_faces = []
    for mtl_name, faces in faces_by_material.items():
        for v_idxs, uv_idxs in faces:
            all_faces.append((v_idxs, uv_idxs, mtl_name))

    # Skip faces from materials without texture (e.g. corner_plane_mat).
    # They only produce blank white pixels — not worth the intersection cost.
    before = len(all_faces)
    all_faces = [(vi, ui, m) for vi, ui, m in all_faces
                 if m in textures and textures[m] is not None]
    _log(f"Faces: {before} total → {len(all_faces)} textured (skipped {before - len(all_faces)} blank)")

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

    # Image settings — scale with resolution so 1024 → padding=40, width=2
    padding = int(img_size * 40 / 1024)
    line_width = max(1, int(img_size * 2 / 1024))
    coplanar_tol = layer_height

    # Precompute world→pixel transform constants (avoids recomputing per vertex)
    scale_x = (img_size - 2 * padding) / (max_x - min_x) if max_x > min_x else 1.0
    scale_y = (img_size - 2 * padding) / (max_y - min_y) if max_y > min_y else 1.0
    scale = min(scale_x, scale_y)
    center_x = (min_x + max_x) / 2.0
    center_y = (min_y + max_y) / 2.0
    half_size = img_size / 2.0

    def _w2p(x, y):
        """Fast world-to-pixel using precomputed constants."""
        return ((x - center_x) * scale + half_size,
                half_size - (y - center_y) * scale)

    # ---- 条带切割设置（流水线：切完一层立即入队，工作线程异步处理）----
    strip_results = []
    if do_strip:
        import numpy as np
        from strip_processor import process_layer_from_array
        import threading
        from queue import Queue

        strip_base = strip_output or os.path.dirname(output_dir)
        if not strip_base:
            strip_base = output_dir
        segment_dir = os.path.join(strip_base, 'Segment')
        strip_gcode_dir = os.path.join(segment_dir, 'gcode')
        strip_zip_dir = os.path.join(segment_dir, 'zip')
        strip_temp_dir = os.path.join(segment_dir, '_temp')
        for d in [strip_gcode_dir, strip_zip_dir, strip_temp_dir]:
            if os.path.exists(d):
                shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d, exist_ok=True)
        _log(f"Strip output: {segment_dir}")

        strip_queue = Queue(maxsize=2)

        def _strip_worker():
            while True:
                item = strip_queue.get()
                if item is None:       # 哨兵：停止信号
                    break
                layer_name, pixel_bytes, bsize = item
                try:
                    arr = np.frombuffer(pixel_bytes, dtype=np.uint8).reshape(
                        img_size, img_size, 4)
                    r = process_layer_from_array(
                        arr, layer_name, img_size, bsize,
                        output_zip_dir=strip_temp_dir,
                        gcode_dir=strip_gcode_dir,
                    )
                    strip_results.append(r)
                except Exception as e:
                    _log(f"Strip error for {layer_name}: {e}")

        strip_thread = threading.Thread(target=_strip_worker, daemon=True)
        strip_thread.start()

    for layer_idx in range(num_layers):
        z_center = min_z + layer_idx * layer_height + layer_height / 2.0

        all_coplanar = []   # [(poly_2d, poly_uv, mtl_name), ...]
        all_segments = []   # [((pt, uv), (pt, uv), mtl_name), ...]

        for v_idxs, uv_idxs, mtl_name in all_faces:
            if len(v_idxs) < 3:
                continue
            v0, v1, v2 = vertices[v_idxs[0]], vertices[v_idxs[1]], vertices[v_idxs[2]]
            uv0 = uvs[uv_idxs[0]] if uv_idxs and uv_idxs[0] < len(uvs) else None
            uv1 = uvs[uv_idxs[1]] if uv_idxs and uv_idxs[1] < len(uvs) else None
            uv2 = uvs[uv_idxs[2]] if uv_idxs and uv_idxs[2] < len(uvs) else None

            coplanar, segs = triangle_plane_intersection(
                v0, v1, v2, uv0, uv1, uv2, z_center, coplanar_tol)

            for poly_2d, poly_uv in coplanar:
                all_coplanar.append((poly_2d, poly_uv, mtl_name))
            for (p1, uv_out1), (p2, uv_out2) in segs:
                all_segments.append(((p1, uv_out1), (p2, uv_out2), mtl_name))

        # Use bytearray — 64 MB for 4000×4000 instead of ~900 MB with tuple list
        pixels = bytearray(b'\xff\xff\xff\xff') * (img_size * img_size)

        # Draw coplanar textured triangles
        for poly_2d, poly_uv, mtl_name in all_coplanar:
            tex = textures.get(mtl_name)
            if tex is None or poly_uv is None:
                continue
            px = [_w2p(p[0], p[1]) for p in poly_2d]
            fill_textured_triangle(pixels, img_size, img_size,
                                   px[0][0], px[0][1],
                                   px[1][0], px[1][1],
                                   px[2][0], px[2][1],
                                   poly_uv[0], poly_uv[1], poly_uv[2],
                                   tex)

        # Draw textured segments
        for (p1, uv1), (p2, uv2), mtl_name in all_segments:
            tex = textures.get(mtl_name)
            if tex is None:
                continue
            px1 = _w2p(p1[0], p1[1])
            px2 = _w2p(p2[0], p2[1])
            draw_textured_segment(pixels, img_size, img_size,
                                  px1, uv1, px2, uv2, tex, width=line_width)

        # Save image — frombytes is ~10× faster than new+putdata
        img = Image.frombytes('RGBA', (img_size, img_size), bytes(pixels))
        filename = f"layer_{layer_idx:04d}.png"
        filepath = os.path.join(output_dir, filename)
        img.save(filepath)

        # 条带切割（异步流水线：入队后主线程立即切下一层）
        if do_strip:
            strip_queue.put((
                f"layer_{layer_idx:04d}",
                bytes(pixels),
                bed_size,
            ))

        # 每 5 层或首尾输出一次进度
        if layer_idx % 5 == 0 or layer_idx == num_layers - 1:
            _progress(layer_idx + 1, num_layers)

        if layer_idx % 20 == 0 or layer_idx < 3 or layer_idx >= num_layers - 3:
            _log(f"  Layer {layer_idx:04d}  z={z_center:.3f}  coplanar={len(all_coplanar):2d}  segs={len(all_segments):2d}  -> {filename}")

    _log(f"\nDone. {num_layers} PNGs saved to: {output_dir}")
    _done(num_layers)

    result = {
        'success': True,
        'num_layers': num_layers,
        'png_count': num_layers,
    }

    # ---- 等待条带工作线程完成 ----
    if do_strip:
        strip_queue.put(None)   # 发送停止信号
        strip_thread.join()

    # ---- 条带切割收尾：打包 ZIP ----
    if do_strip and strip_results:
        zip_path = os.path.join(strip_zip_dir, 'segments.zip')
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(strip_temp_dir):
                for fname in files:
                    full_path = os.path.join(root, fname)
                    arcname = os.path.relpath(full_path, strip_temp_dir)
                    zf.write(full_path, arcname)
        shutil.rmtree(strip_temp_dir, ignore_errors=True)

        total_blocks = sum(r['total_blocks'] for r in strip_results)
        _log(f"\nStrip done: {len(strip_results)} layers, {total_blocks} blocks")
        _log(f"  ZIP:  {zip_path}")
        _log(f"  G-code: {strip_gcode_dir}")

        _strip_done(len(strip_results), total_blocks, zip_path, strip_gcode_dir)
        result['strip_done'] = {
            'layers': len(strip_results),
            'total_blocks': total_blocks,
            'zip_path': zip_path,
            'gcode_dir': strip_gcode_dir,
        }

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
    )


if __name__ == "__main__":
    main()