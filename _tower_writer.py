# -*- coding: utf-8 -*-
"""
_tower_writer.py — 擦嘴塔出码器（移植自 OrcaSlicer WipeTower2.cpp 的 Writer 状态机）

镜像 WipeTowerWriter2 + toolchange_Wipe / toolchange_Change / finish_layer(外墙)：
按 TowerPlan 逐层生成塔的 GCode，坐标为「塔局部坐标」(塔左下角为原点，Y 向上)。

与主流程衔接：
  - 输入：TowerPlan(来自 _tower_plan.plan_tower) + 本层 toolchange 事件
  - 输出：一段 GCode 行列表（局部坐标），由 GCodeGenerator.process_gcode 做 R(rot)*pt+(tx,ty)
    平移注入 + 桥接换刀宏(SM_PRINT_PREEXTRUDE_FILAMENT) + Z 校正 + 进/出塔 retract。

F 值统一 mm/s -> mm/min (×60)，抽取成单点常量以规避免单位 bug（Orca 项目坑）。
"""

import math

try:
    from shapely.geometry import Polygon, LineString
except ImportError:
    Polygon = None
    LineString = None

MMS2MMIN = 60.0
EPSILON = 1e-3
WT_EPSILON = 1e-3
BRIDGING = 10.0                 # m_bridging（WipeTower2::m_bridging，桥接线间距）
M_PI = math.pi
FILAMENT_DIAMETER = 1.75
FILAMENT_AREA = math.pi * (FILAMENT_DIAMETER / 2.0) ** 2


def _fmt(v):
    """GCode 数字格式化，去掉多余尾零。"""
    r = round(float(v), 4)
    return ('%g' % r)


def line_extrusion_flow(line_width, layer_height, flow_multiplier=1.0):
    """单线挤出流量：每走 1mm 应前进的耗材长度(mm)。

    Orca: m_extrusion_flow = layer_height*(width - layer_height*(1-π/4))/filament_area()。
    """
    if layer_height <= 0:
        return flow_multiplier * line_width / FILAMENT_AREA
    cross_section = layer_height * (line_width - layer_height * (1.0 - M_PI / 4.0))
    return flow_multiplier * cross_section / FILAMENT_AREA


class Box:
    """塔内矩形清洗盒（局部坐标，Y 向上）。ld/lu/rd/ru 四角。"""
    def __init__(self, ld_x, ld_y, width, height):
        self.ld = (ld_x, ld_y)          # left-down
        self.lu = (ld_x, ld_y + height)  # left-up
        self.rd = (ld_x + width, ld_y)   # right-down
        self.ru = (ld_x + width, ld_y + height)  # right-up


class WipeTowerWriter:
    """塔 GCode 状态机。所有 move 都先 recorded，errase 时输出。

    注意：坐标均为塔局部（原点=塔左下角）；外层注入时做 R(rot)*pt+(tx,ty)。
    """
    def __init__(self, plan, tool_params=None, wall_type='rect'):
        self.plan = plan
        self.lines = []                      # 输出的 GCode 行（不含换行）
        self.x = 0.0
        self.y = 0.0
        self.z = 0.0
        self.feedrate = 0.0
        self.current_tool = 0
        self.left_to_right = False           # m_left_to_right
        self.depth_traversed = 0.0           # m_depth_traversed
        self.y_shift = 0.0
        self.extrusion_flow = 1.0
        self.e = 0.0                     # 相对 E 累计（外部 G92 E0 后从 0 起算）
        self.tool_params = tool_params or {}
        self.wall_type = wall_type

    # ---- 基础输出（决定坐标单位与格式） ----
    def _emit(self, s):
        self.lines.append(s)
        return self

    def append_line(self, s):
        """追加任意一行到缓冲。"""
        self.lines.append(s)
        return self

    def emit_xy(self, x, y, travel=True):
        """输出一条 X/Y 移动（不改变当前位置跟踪语义外的其它状态）。"""
        self.x, self.y = float(x), float(y)
        if travel:
            self._emit('G1 X{0} Y{1}'.format(_fmt(self.x), _fmt(self.y)))
        else:
            self._emit('G1 X{0} Y{1}'.format(_fmt(self.x), _fmt(self.y)))
        return self

    def _set_feedrate(self, f_mms):
        f = f_mms * MMS2MMIN
        if abs(f - self.feedrate) > 0.01:
            self.feedrate = f
            self._emit('G1 F{:.0f}'.format(f))
        return self

    def set_extrusion_flow(self, flow):
        self.extrusion_flow = flow
        return self

    def set_z(self, z):
        self.z = z
        return self

    def set_initial_position(self, pos, tower_width, tower_depth, internal_rotation=0.0):
        self.x, self.y = float(pos[0]), float(pos[1])
        return self

    # ---- 定位/移动 ----
    def travel(self, x, y):
        to = (float(x), float(y))
        if self.x != to[0] or self.y != to[1]:
            self.x, self.y = to
            # 旅行移动用 travel_speed
            self._set_feedrate(self.plan.travel_speed)
            self._emit('G1 X{0} Y{1}'.format(_fmt(to[0]), _fmt(to[1])))
        return self

    # ---- 挤出 ----
    def extrude(self, x, y):
        to = (float(x), float(y))
        dist = math.hypot(to[0] - self.x, to[1] - self.y)
        self.x, self.y = to
        # Orca 的 writer.extrude 用 extrusion_flow*距离 累加 E（相对当前段），
        # 对齐外部 G92 E0 语义（注入时在塔内容前输出 G92 E0）。
        if dist > 1e-6:
            e_inc = dist * self.extrusion_flow
            self.e += e_inc
            out_e = e_inc if bool(getattr(self.plan, 'relative_e', False)) else self.e
            self._emit('G1 X{0} Y{1} E{2}'.format(_fmt(to[0]), _fmt(to[1]), _fmt(out_e)))
        else:
            self._emit('G1 X{0} Y{1}'.format(_fmt(to[0]), _fmt(to[1])))
        return self

    def retract(self, length, speed_mms):
        self._emit('G1 E-{0} F{1:.0f}'.format(_fmt(length), speed_mms * MMS2MMIN))
        return self

    def set_wipe_feedrate(self, mms):
        """总是写入一行 F（wipe 速度阶梯需要逐步变化，不做去重）。"""
        self.feedrate = mms * MMS2MMIN
        self._emit('G1 F{:.0f}'.format(mms * MMS2MMIN))
        return self

    def collect(self):
        """取出并清空已缓冲的 GCode 行。"""
        out = self.lines
        self.lines = []
        return out

    def unretract(self, length, speed_mms):
        self._emit('G1 E{0} F{1:.0f}'.format(_fmt(length), speed_mms * MMS2MMIN))
        return self

    # ---- 旋转后的塔局部坐标（parking 用，绕塔中心旋转 internal_rotation） ----
    def rotated(self, pt):
        """把塔局部点转 writer 旋转系（internal_rotation 通常为 0，直接返回）。"""
        x, y = pt
        a = math.radians(0.0)   # m_internal_rotation 在 BBL/常规为 0
        return (x * math.cos(a) - y * math.sin(a) + self.plan.tower_width / 2.0,
                x * math.sin(a) + y * math.cos(a) + (self.y_shift - self.plan.depth / 2.0))

    def pos(self):
        return (self.x, self.y)


def generate_toolchange_wipe(plan, ev, fil_params, is_first_layer, fill_box, depth_consumed):
    """生成一次换刀的清洗网格（WipeTower2::toolchange_Wipe 移植）。

    depth_consumed: 该换刀在块内已消耗的深度（用于定位清洗盒）
    返回本段 GCode 行 + 该换刀消耗的深度。
    """
    w = WipeTowerWriter(plan)
    w.current_tool = ev.old_tool
    w.depth_traversed = depth_consumed

    perimeter = plan.perimeter_width
    extra_flow = plan.extra_flow
    spacing_wipe = plan.extra_spacing_wipe
    lh = plan.first_layer_height if is_first_layer else plan.layer_height

    w.set_extrusion_flow(line_extrusion_flow(perimeter, lh, extra_flow))
    line_width = perimeter   # wipe_line_width 简化为 perimeter

    # 目标速度（WipeTower2:1875）
    if is_first_layer or (plan.num_tool_changes <= 1 and plan.no_sparse_layers):
        target_speed = plan.first_layer_speed
    else:
        target_speed = min(plan.max_purge_speed, plan.infill_speed)
    wipe_speed = 0.33 * target_speed

    # 清洗盒：宽=cleaning_width，从当前深度带向上
    clr_w = plan.cleaning_width()
    xl = perimeter
    xr = xl + clr_w
    depth_band = ev.depth
    box_bottom = depth_consumed
    box_top = depth_consumed + depth_band

    x_to_wipe = _plan_module_vol2len(ev.wipe_volume, perimeter, lh) / extra_flow
    dy = spacing_wipe * perimeter          # wipe_row_spacing

    w.append_line('; CP TOOLCHANGE WIPE')
    w.append_line(';WIDTH:{}'.format(_fmt(perimeter)))

    # 若距边缘 < 2.5*line_width，先跳到下一行（Orca toolchange_Wipe:1853）
    if (w.left_to_right and (xr - w.x) < 2.5 * line_width) or \
       (not w.left_to_right and (w.x - xl) < 2.5 * line_width):
        w.travel((xr - line_width) if w.left_to_right else (xl + line_width), w.y + dy)
        w.left_to_right = not w.left_to_right

    # 首行定位到盒起始
    w.x, w.y = (xl, box_bottom) if w.left_to_right else (xr, box_bottom)
    w.set_wipe_feedrate(plan.travel_speed)
    w.emit_xy(w.x, w.y)
    w.set_wipe_feedrate(wipe_speed)

    i = 0
    while True:
        if i != 0:
            # 速度阶梯（WipeTower2:1887-1890）
            ts = target_speed
            if wipe_speed < 0.34 * ts:
                wipe_speed = 0.375 * ts
            elif wipe_speed < 0.377 * ts:
                wipe_speed = 0.458 * ts
            elif wipe_speed < 0.46 * ts:
                wipe_speed = 0.875 * ts
            else:
                wipe_speed = min(ts, wipe_speed + 50.0)  # +50mm/min
            w.set_wipe_feedrate(wipe_speed)

        # 横向一行（带 1.5*line_width 过冲，Orca toolchange_Wipe:1885）
        x_start = w.x
        if w.left_to_right:
            tx = xr - (0.0 if i % 4 == 0 else 1.5 * line_width)
        else:
            tx = xl + (0.0 if i % 4 == 1 else 1.5 * line_width)
        w.extrude(tx, w.y)
        # 已挤出距离抵扣需求（Orca: x_to_wipe -= |traversed_x|）
        x_to_wipe -= abs(w.x - x_start)

        # 下一行放不下则结束
        if w.y + EPSILON > box_top - 0.5 * line_width:
            break

        # 已挤出体积达到需求则提前 break（fill_box 时填满整个盒）
        if not fill_box and x_to_wipe < EPSILON:
            nx = (xl + 1.5 * line_width) if w.left_to_right else (xr - 1.5 * line_width)
            w.emit_xy(nx, w.y, travel=True)
            break

        # 步进到下一行（Orca: extrude(x + 1.5*line_width 方向偏移, y + dy)）
        step = 1.5 * line_width
        nx = w.x + (i % 4 == 0) * (-step) + (i % 4 == 1) * (step)
        w.x = nx
        w.y += dy
        w.extrude(nx, w.y)
        w.left_to_right = not w.left_to_right
        i += 1

    # 出塔 wipe_path（Orca toolchange_Wipe:1943-1952）
    w.set_wipe_feedrate(plan.travel_speed)
    w.emit_xy(0 if not w.left_to_right else xr, w.y, travel=True)
    w.append_line('; WIPE_TOWER_END')
    return w.collect(), box_top - box_bottom


def rounding_polygon_polygon(polygon, rounding=2.0, angle_tol_deg=30.0, arc_fit_size=20):
    """多边形圆角（移植自 WipeTower.cpp:106 rounding_polygon 与 WipeTower2.cpp:106）。

    输入 polygon 为 [(x,y),...] 闭合多边形（mm 域），每个锐角/直角尖角代之以
    半径 rounding 的圆弧细分（arc_fit_size 点），钝角保留原点。逻辑与官方
    scaled 域完全一致，仅把 scaled/unscaled 去掉，直接在 mm 上运算。
    """
    if len(polygon) < 3:
        return list(polygon)
    res = []
    mod = len(polygon)
    cos_angle_tol = abs(math.cos(math.radians(angle_tol_deg)))
    for i in range(mod):
        ax, ay = polygon[(i - 1 + mod) % mod]
        bx, by = polygon[i]
        cx, cy = polygon[(i + 1) % mod]
        ab_len = math.hypot(bx - ax, by - ay)
        bc_len = math.hypot(cx - bx, cy - by)
        if ab_len < 1e-9 or bc_len < 1e-9:
            res.append((bx, by))
            continue
        ab = ((bx - ax) / ab_len, (by - ay) / ab_len)
        bc = ((cx - bx) / bc_len, (cy - by) / bc_len)
        cosangle = ab[0] * bc[0] + ab[1] * bc[1]
        cosangle = max(-1.0, min(1.0, cosangle))
        is_ccw = (ab[0] * bc[1] - ab[1] * bc[0]) > 0
        if abs(cosangle) < cos_angle_tol:
            real = min(rounding, ab_len / 2.1, bc_len / 2.1)
            left = (bx - ab[0] * real, by - ab[1] * real)
            right = (bx + bc[0] * real, by + bc[1] * real)
            half_angle = math.acos(cosangle) / 2.0
            if abs(math.sin(half_angle)) < 1e-9:
                res.append((bx, by))
                continue
            dir_vec = (right[0] - left[0], right[1] - left[1])
            dlen = math.hypot(dir_vec[0], dir_vec[1])
            if dlen < 1e-9:
                res.append(left)
                res.append(right)
                continue
            dir_n = (dir_vec[0] / dlen, dir_vec[1] / dlen)
            perp = (-dir_n[1], dir_n[0])
            if not is_ccw:
                perp = (-perp[0], -perp[1])
            dis = real / math.sin(half_angle)
            center = (bx + perp[0] * dis, by + perp[1] * dis)
            radius = math.hypot(left[0] - center[0], left[1] - center[1])
            start_theta = math.atan2(left[1] - center[1], left[0] - center[0])
            end_theta = math.atan2(right[1] - center[1], right[0] - center[0])
            # 规范到 CCW/CW 方向
            delta = end_theta - start_theta
            # 将 delta 绕到 (-pi, pi] 再根据方向取
            while delta <= -math.pi:
                delta += 2 * math.pi
            while delta > math.pi:
                delta -= 2 * math.pi
            if is_ccw:
                if delta < 0:
                    delta += 2 * math.pi
                angle = delta
            else:
                if delta > 0:
                    delta -= 2 * math.pi
                angle = delta
            n = arc_fit_size
            for j in range(n):
                cur = start_theta + (j / n) * angle
                px = center[0] + radius * math.cos(cur)
                py = center[1] + radius * math.sin(cur)
                res.append((px, py))
            res.append(right)
        else:
            res.append((bx, by))
    # 去重相邻重合点
    dedup = []
    for p in res:
        if not dedup or math.hypot(p[0] - dedup[-1][0], p[1] - dedup[-1][1]) > 1e-6:
            dedup.append(p)
    return dedup


def rounding_polygon(width, depth, rounding=2.0, arc_fit_size=20):
    """圆角矩形多边形（矩形特例，保留供回退；内部转调多边形版）。

    为兼容旧调用 rounding_polygon(width, depth)，先构造矩形再走
    rounding_polygon_polygon，使矩形圆角与官方 rounding_rectangle 语义一致。
    """
    w, d = float(width), float(depth)
    rounding = min(rounding, w / 2.0, d / 2.0)
    rect = [(0.0, 0.0), (w, 0.0), (w, d), (0.0, d)]
    # 官方 rounding_rectangle 以角点为圆心直接画 90 度弧；这里用通用多边形
    # 圆角在矩形上效果一致（差异仅在极小 rounding 下弧细分略有不同）。
    return rounding_polygon_polygon(rect, rounding=rounding, arc_fit_size=arc_fit_size)


def offset_polygon_away_from_center(poly, distance):
    """Offset a closed polygon by a constant normal distance.

    Orca uses Clipper's polygon offset here. Shapely's buffer operation has
    the same geometric meaning and, unlike radial vertex scaling, preserves
    uniform brim spacing around both convex and concave parts of the rib wall.
    """
    if not poly or abs(distance) < 1e-9:
        return list(poly or [])
    if Polygon is None:
        raise RuntimeError('生成等距擦嘴塔 brim 需要 shapely')
    shape = Polygon(poly)
    if not shape.is_valid:
        shape = shape.buffer(0)
    expanded = shape.buffer(float(distance), quad_segs=8, join_style='round')
    if expanded.is_empty:
        return []
    if expanded.geom_type == 'MultiPolygon':
        expanded = max(expanded.geoms, key=lambda geom: geom.area)
    return [(float(x), float(y)) for x, y in list(expanded.exterior.coords)[:-1]]


def rib_section(width, depth, rib_length, rib_width, fillet_wall=True):
    """斜肋截面多边形（移植自 WipeTower.cpp:1685 rib_section）。

    几何：矩形 width×depth 的四角各伸一条对角筋，筋宽 rib_width、筋总长
    rib_length（沿对角线度量），收尾可选 rounding_polygon 圆角。
    16 点围成（四角各 4 点），mm 域直接运算，无 scaled。
    与官方 scaled 逻辑逐行对应，仅去掉 scaled/unscaled。
    """
    w = float(rib_width) / 2.0
    diag = math.hypot(width, depth)
    l = (float(rib_length) - diag) / 2.0
    # 对角方向及法向
    diag_len = diag if diag > 1e-9 else 1.0
    diag_dir1 = (width / diag_len, depth / diag_len)
    diag_dir1_perp = (-diag_dir1[1], diag_dir1[0])
    diag_dir2 = (-width / diag_len, depth / diag_len)
    diag_dir2_perp = (-diag_dir2[1], diag_dir2[0])
    theta = math.atan(width / depth) if depth > 1e-9 else math.pi / 2
    costheta = math.cos(theta)
    sintheta = math.sin(theta)
    if abs(costheta) < 1e-9:
        costheta = 1e-9
    if abs(sintheta) < 1e-9:
        sintheta = 1e-9
    p = [(0.0, 0.0), (width, 0.0), (width, depth), (0.0, depth)]
    res = [None] * 16
    res[0] = (p[0][0], p[0][1] + w / sintheta)
    res[1] = (p[0][0] - diag_dir1[0] * l + diag_dir1_perp[0] * w,
              p[0][1] - diag_dir1[1] * l + diag_dir1_perp[1] * w)
    res[2] = (p[0][0] - diag_dir1[0] * l - diag_dir1_perp[0] * w,
              p[0][1] - diag_dir1[1] * l - diag_dir1_perp[1] * w)
    res[3] = (p[0][0] + w / costheta, p[0][1])
    res[4] = (p[1][0] - w / costheta, p[1][1])
    res[5] = (p[1][0] - diag_dir2[0] * l + diag_dir2_perp[0] * w,
              p[1][1] - diag_dir2[1] * l + diag_dir2_perp[1] * w)
    res[6] = (p[1][0] - diag_dir2[0] * l - diag_dir2_perp[0] * w,
              p[1][1] - diag_dir2[1] * l - diag_dir2_perp[1] * w)
    res[7] = (p[1][0], p[1][1] + w / sintheta)
    res[8] = (p[2][0], p[2][1] - w / sintheta)
    res[9] = (p[2][0] + diag_dir1[0] * l - diag_dir1_perp[0] * w,
              p[2][1] + diag_dir1[1] * l - diag_dir1_perp[1] * w)
    res[10] = (p[2][0] + diag_dir1[0] * l + diag_dir1_perp[0] * w,
               p[2][1] + diag_dir1[1] * l + diag_dir1_perp[1] * w)
    res[11] = (p[2][0] - w / costheta, p[2][1])
    res[12] = (p[3][0] + w / costheta, p[3][1])
    res[13] = (p[3][0] + diag_dir2[0] * l - diag_dir2_perp[0] * w,
               p[3][1] + diag_dir2[1] * l - diag_dir2_perp[1] * w)
    res[14] = (p[3][0] + diag_dir2[0] * l + diag_dir2_perp[0] * w,
               p[3][1] + diag_dir2[1] * l + diag_dir2_perp[1] * w)
    res[15] = (p[3][0], p[3][1] - w / sintheta)
    # 去重（官方 remove_duplicate_points）
    dedup = []
    for pt in res:
        if not dedup or math.hypot(pt[0] - dedup[-1][0], pt[1] - dedup[-1][1]) > 1e-7:
            dedup.append(pt)
    res = dedup
    if fillet_wall:
        res = rounding_polygon_polygon(res, rounding=2.0)
    return res


def generate_rib_polygon(wt_box, rib_length, rib_width, cur_z, total_height,
                         y_shift=0.0, fillet_wall=True, layer_height=None,
                         first_layer_height=None, shrink_t=None):
    """WipeTower2::generate_rib_polygon 移植（mm 域简化）。

    wt_box: Box(0,0,width,height) 局部矩形；
    rib_length/rib_width 为规划期算好的总量；
    cur_z/total_height 用于随高度递减对角外伸（官方 get_current_layer_rib_len）。
    y_shift 保持 0（本项目无多级偏移）。
    返回 16 点左右的肋墙多边形（已含底矩形并集效果，与官方 p_1_2.front() 一致，
    这里直接用 rib_section 的 16 点解析式等价，无需 Clipper union）。
    """
    width = wt_box.ru[0] - wt_box.ld[0]
    depth = wt_box.ru[1] - wt_box.ld[1]
    diag = math.hypot(width, depth)
    # 随高度递减的外伸（官方 get_current_layer_rib_len）
    def _cur_len(cur_h, max_h, max_len):
        # Distribute rib shrink uniformly from the first layer to the
        # penultimate layer. The final layer keeps the penultimate footprint.
        if shrink_t is not None:
            return (1.0 - max(0.0, min(1.0, float(shrink_t)))) * max_len
        layer_h = float(layer_height or 0.0)
        first_z = float(first_layer_height or layer_h)
        # total_height is last-layer Z plus one layer height, so the
        # penultimate layer is total_height - 2 * layer_height.
        shrink_end = max(first_z, float(max_h) - 2.0 * layer_h)
        span = shrink_end - first_z
        if span <= 1e-9:
            return 0.0 if cur_h >= shrink_end else max_len
        t = max(0.0, min(1.0, (float(cur_h) - first_z) / span))
        return (1.0 - t) * max_len
    diagonal_extra = max(0.0, float(rib_length) - diag) / 2.0
    # 按当前层高度缩放外伸
    diagonal_extra = _cur_len(cur_z, total_height, diagonal_extra)
    # 等效总长 = diag + 2*diagonal_extra
    eff_rib_length = diag + 2.0 * diagonal_extra
    poly = rib_section(width, depth, eff_rib_length, rib_width, fillet_wall=fillet_wall)
    # y_shift 平移（官方 line.translate(-y_shift)，rib_section 原点已在 0,0，整体平移即可）
    if abs(y_shift) > 1e-9:
        poly = [(x, y - y_shift) for (x, y) in poly]
    return poly


def generate_support_rib_wall(plan, wt_box, feedrate, first_layer, rib_wall=True, extrude_perimeter=True, current_z=None):
    """WipeTower2::generate_support_rib_wall 移植（mm 域，writer-less 版）。

    返回 (wall_polygon: [(x,y)], wall_polyline: [(x,y)] 闭合)。
    writer 出码由调用方用 WipeTowerWriter 逐点 extrude，本函数只产几何，
    以便在 _tower_writer 与 GCodeGenerator 之间保持与官方一致的 pure geometry。
    若 rib_wall 为 False 则退化为矩形墙。
    """
    rib_width = getattr(plan, 'rib_width', 8.0)
    rib_length = getattr(plan, 'rib_length', 0.0) or 0.0
    total_h = getattr(plan, 'height', 10.0) or 10.0
    # 当前层 Z 必须由调用方传入；Orca 按当前层高度逐层收短 rib。
    cur_z = float(current_z) if current_z is not None else 0.0
    if current_z is None and getattr(plan, 'layers', None):
        try:
            cur_z = plan.layers[0].z if first_layer else plan.layers[-1].z
        except Exception:
            cur_z = 0.0
    y_shift = getattr(plan, 'y_shift', 0.0) or 0.0
    shrink_t = None
    if current_z is not None and getattr(plan, 'layers', None):
        rows = plan.layers
        idx = min(range(len(rows)), key=lambda i: abs(float(rows[i].z) - cur_z))
        penultimate = max(0, len(rows) - 2)
        shrink_t = min(1.0, idx / penultimate) if penultimate else 1.0
    use_fillet = getattr(plan, 'use_fillet', False)
    if rib_wall:
        wall_polygon = generate_rib_polygon(
            wt_box, rib_length, rib_width, cur_z, total_h,
            y_shift=y_shift, fillet_wall=use_fillet,
            layer_height=getattr(plan, 'layer_height', None),
            first_layer_height=getattr(plan, 'first_layer_height', None),
            shrink_t=shrink_t)
        # 官方 fillet 后还会与底矩形做 union，这里 rib_section 已含底矩形，额外并集仅为
        # fillet 收缩时补回矩形边，mm 域下用简单并集近似：若 fillet 导致外轮廓内缩，补回矩形四角
        if use_fillet:
            rect = [wt_box.ld, wt_box.rd, wt_box.ru, wt_box.lu]
            # 轻量近似：若 wall_polygon 未覆盖矩形角点，追加矩形（不做精确 Clipper，亦可满足外墙闭合）
            # 实际 rib_section 已保证覆盖，跳过精确 union。
            pass
    else:
        wall_polygon = [wt_box.ld, wt_box.rd, wt_box.ru, wt_box.lu]
        if use_fillet:
            # 矩形墙在官方 fillet 分支中 rectangle_wall do nothing，这里保持矩形
            pass
    if not extrude_perimeter:
        return wall_polygon
    # 转 polyline（闭合）
    polyline = list(wall_polygon) + [wall_polygon[0]]
    return wall_polygon, polyline


def generate_finish_layer_infill(plan, layer_depth, is_first_layer, toolchange_depth_consumed=0.0):
    """生成层内稀疏/实心填充（WipeTower2::finish_layer 的 infill 部分，CP EMPTY GRID）。

    清洗盒(wipe)下方的块空区需要稀疏填充作为上部材料的支撑：
      - 首层或邻近可溶料/需实心：solid infill（稀疏因子 1.0，线接外圈）
      - 否则：逆 U + 稀疏往返桥接线（m_bridging）
    使用 '; CP EMPTY GRID START/END' 标记（与项目既有标记词汇一致）。
    返回 GCode 行；无空区则返回空列表。
    """
    perimeter = plan.perimeter_width
    lh = plan.first_layer_height if is_first_layer else plan.layer_height
    dy_fill = plan.depth - (toolchange_depth_consumed + 0.0)

    # 没有可填充的空区
    fill_depth = plan.depth - toolchange_depth_consumed - perimeter
    if fill_depth <= perimeter - WT_EPSILON:
        return []

    w = WipeTowerWriter(plan)
    w.set_extrusion_flow(line_extrusion_flow(perimeter, lh, 1.0))

    feedrate = plan.first_layer_speed if is_first_layer else min(plan.max_purge_speed, plan.infill_speed)
    # 填充区域：从 toolchange_depth_consumed 到 plan.depth（外墙内侧）
    box_ld_x = perimeter
    box_ru_y = plan.depth - perimeter
    box_rd_y = perimeter
    fill_box = Box(perimeter, toolchange_depth_consumed + perimeter,
                   plan.cleaning_width(), plan.depth - toolchange_depth_consumed - 2 * perimeter)

    # The rectangular cleaning box is only the nominal purge area. On rib
    # layers its usable boundary is the current, Z-dependent rib footprint.
    # Clip bridge lines to that footprint so their ends do not pierce the wall.
    usable_rib = None
    if bool(getattr(plan, 'use_rib_wall', False)) and layer_depth is not None:
        try:
            wall_poly = generate_support_rib_wall(
                plan, Box(0.0, 0.0, plan.tower_width, plan.depth + perimeter),
                feedrate, is_first_layer, rib_wall=True,
                extrude_perimeter=False, current_z=layer_depth.z)
            if Polygon is not None and len(wall_poly) >= 3:
                usable_rib = Polygon(wall_poly).buffer(-0.5 * perimeter)
                if usable_rib.is_empty:
                    usable_rib = None
        except Exception:
            usable_rib = None

    def _vertical_span(x, y_low, y_high):
        if usable_rib is None or LineString is None:
            return y_low, y_high
        hit = usable_rib.intersection(LineString([(x, y_low), (x, y_high)]))
        pieces = []
        geoms = getattr(hit, 'geoms', (hit,))
        for geom in geoms:
            if getattr(geom, 'geom_type', '') == 'LineString' and len(geom.coords) >= 2:
                ys = [float(pt[1]) for pt in geom.coords]
                pieces.append((min(ys), max(ys)))
        if not pieces:
            return None
        return max(pieces, key=lambda span: span[1] - span[0])

    w.append_line(';--------------------')
    w.append_line('; CP EMPTY GRID START')
    w.append_line(';WIDTH:{}'.format(_fmt(perimeter)))

    # inner perimeter of the sparse section（贴着空区底，先画一条内框）
    if fill_box.ru[1] - fill_box.rd[1] > perimeter - WT_EPSILON:
        w.set_wipe_feedrate(feedrate)
        w.emit_xy(fill_box.ld[0], fill_box.ld[1], travel=True)
        # 画内框：ld -> rd -> ru -> lu
        w.extrude(fill_box.rd[0], fill_box.rd[1])
        w.extrude(fill_box.ru[0], fill_box.ru[1])
        w.extrude(fill_box.lu[0], fill_box.lu[1])
        w.extrude(fill_box.ld[0], fill_box.ld[1])

    # 稀疏填充（首层实心，非首层用 BRIDGING 桥接）
    left = fill_box.lu[0] + 2 * perimeter
    right = fill_box.ru[0] - 2 * perimeter
    dy = fill_box.lu[1] - fill_box.ld[1] - perimeter
    if dy > perimeter:
        w.set_wipe_feedrate(feedrate)
        if is_first_layer:
            # 首层实心：每条线独立空驶到起点，保证严格平行且不产生斜向挤出连接。
            left = fill_box.lu[0] - perimeter
            right = fill_box.ru[0] + perimeter
            y = fill_box.ld[1] + perimeter
            n = max(1, int(dy / perimeter))
            spacing_y = (dy - perimeter) / (n - 1) if n > 1 else 0.0
            for i in range(n):
                x_start = left if (i % 2 == 0) else right
                x_end = right if (i % 2 == 0) else left
                w.travel(x_start, y)
                w.extrude(x_end, y)
                y += spacing_y
        else:
            w.emit_xy(fill_box.ld[0] + 2 * perimeter, fill_box.ld[1], travel=True)
            n = 1 + int((right - left) / BRIDGING)
            dx = (right - left) / n if n > 0 else 0.0
            for i in range(1, n + 1):
                x = left + dx * i
                span = _vertical_span(x, fill_box.rd[1], fill_box.ru[1])
                if span is None:
                    continue
                low, high = span
                y = high if (i % 2) else low
                w.emit_xy(x, w.y, travel=True)
                w.extrude(x, y)

    w.append_line('; CP EMPTY GRID END')
    w.append_line(';------------------')
    return w.collect()


def generate_no_toolchange_cross(plan, is_first_layer):
    """Print a centered cross to catch ooze after inkjet on no-change layers."""
    w = WipeTowerWriter(plan)
    perimeter = plan.perimeter_width
    lh = plan.first_layer_height if is_first_layer else plan.layer_height
    w.set_extrusion_flow(line_extrusion_flow(perimeter, lh, plan.extra_flow))
    w.set_wipe_feedrate(plan.first_layer_speed if is_first_layer else
                        min(plan.max_purge_speed, plan.infill_speed))

    margin = 2.0 * perimeter
    x0 = margin
    x1 = plan.tower_width - margin
    y0 = margin
    y1 = plan.depth - margin
    if x1 <= x0 or y1 <= y0:
        return []
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0

    w.append_line('; CP NO-TOOLCHANGE NOZZLE CLEAN')
    w.append_line(';WIDTH:{}'.format(_fmt(perimeter)))
    w.travel(x0, cy)
    w.extrude(x1, cy)
    w.travel(cx, y0)
    w.extrude(cx, y1)
    w.append_line('; CP NO-TOOLCHANGE NOZZLE CLEAN END')
    return w.collect()


def generate_finish_layer_wall(plan, layer_depth, is_first_layer):
    """生成层外墙（WipeTower2::finish_layer 的外墙部分）。

    官方三态：rectangle / rib（斜肋，带波浪感）/ cone。
    本项目默认 rib（对齐 PrintConfig wtwRib），rib 时走 rib_section 16点
    斜肋多边形 + rounding_polygon 圆角；非 rib 时为矩形墙。
    外墙围绕整个塔深度轮廓挤出（E 随段长累计）。
    """
    w = WipeTowerWriter(plan)
    perimeter = plan.perimeter_width
    lh = plan.first_layer_height if is_first_layer else plan.layer_height
    w.set_extrusion_flow(line_extrusion_flow(perimeter, lh, 1.0))

    wt_box = Box(0.0, 0.0, plan.tower_width, plan.depth + perimeter)

    w.append_line('; WIPE_TOWER_BRIM_START')
    w.append_line(';WIDTH:{}'.format(_fmt(perimeter)))
    feedrate = plan.first_layer_speed if is_first_layer else min(plan.max_purge_speed, plan.perimeter_speed)
    w.set_wipe_feedrate(feedrate)

    use_rib = bool(getattr(plan, 'use_rib_wall', False))
    wall_polygon = []
    if use_rib:
        # 官方斜肋外墙（WipeTower::rib_section + rounding_polygon）
        current_z = (getattr(layer_depth, 'z', None) if layer_depth is not None else None)
        wall_polygon, polyline = generate_support_rib_wall(
            plan, wt_box, feedrate, is_first_layer,
            rib_wall=True, extrude_perimeter=True, current_z=current_z)
        if polyline:
            w.travel(polyline[0][0], polyline[0][1])
            for (cx, cy) in polyline[1:]:
                w.extrude(cx, cy)
        if is_first_layer:
            _append_first_layer_brim(w, plan, wall_polygon, lh)
        w.append_line('; WIPE_TOWER_BRIM_END')
        return w.collect()

    if getattr(plan, 'use_fillet', False) and not is_first_layer:
        corner = rounding_polygon(plan.tower_width, plan.depth + perimeter, 2.0)
        if corner:
            wall_polygon = list(corner)
            w.travel(corner[0][0], corner[0][1])
            for (cx, cy) in corner[1:]:
                w.extrude(cx, cy)
            w.extrude(corner[0][0], corner[0][1])
            if is_first_layer:
                _append_first_layer_brim(w, plan, wall_polygon, lh)
            w.append_line('; WIPE_TOWER_BRIM_END')
            return w.collect()

    corners = [wt_box.ld, (wt_box.rd[0], wt_box.rd[1]),
               (wt_box.ru[0], wt_box.ru[1]), wt_box.lu]
    wall_polygon = list(corners)
    w.travel(corners[0][0], corners[0][1])
    for (cx, cy) in corners[1:]:
        w.extrude(cx, cy)
    w.extrude(wt_box.ld[0], wt_box.ld[1])
    if is_first_layer:
        _append_first_layer_brim(w, plan, wall_polygon, lh)
    w.append_line('; WIPE_TOWER_BRIM_END')
    return w.collect()


def _append_first_layer_brim(w, plan, wall_polygon, layer_height):
    """Append a compact first-layer brim around the rib-supported footprint."""
    if not wall_polygon:
        return
    brim_width = float(getattr(plan, 'brim_width', 0.0) or 0.0)
    if brim_width < 0:
        height = float(getattr(plan, 'height', 0.0) or 0.0)
        brim_width = height / 100.0 * 8.0 if height < 100.0 else 8.0
    spacing = plan.perimeter_width - layer_height * (1.0 - M_PI / 4.0)
    if brim_width <= 0 or spacing <= 1e-6:
        return
    # The configured value is the actual brim width, as in Orca. Do not
    # subtract the rib extension: the brim must retain all configured loops.
    loops_num = max(1, int((brim_width + spacing / 2.0) / spacing))
    if loops_num <= 0:
        return
    w.append_line('; WIPE_TOWER_BRIM_LOOPS')
    w.append_line(';WIDTH:{}'.format(_fmt(plan.perimeter_width)))
    base_poly = list(wall_polygon)
    for loop_index in range(loops_num):
        poly = offset_polygon_away_from_center(base_poly, spacing * (loop_index + 1))
        if len(poly) < 2:
            continue
        # Start near the current point, just like Orca uses closest_point_index.
        cp = min(range(len(poly)), key=lambda i: math.hypot(poly[i][0] - w.x, poly[i][1] - w.y))
        w.travel(poly[cp][0], poly[cp][1])
        i = (cp + 1) % len(poly)
        while True:
            w.extrude(poly[i][0], poly[i][1])
            if i == cp:
                break
            i = (i + 1) % len(poly)
    plan.brim_width_real = loops_num * spacing


def generate_parking_moves(plan, wait_for_temp, bed_min, bed_max, current_x_tag=0.0):
    """出塔加热等待前，把喷头停到塔侧面（WipeTower2::toolchange_Change 的 wait_beside_tower）。

    移植 park 点选择：近侧 → 床沿二分回退 → 远侧 → 原地等待；随后同步回塔入口。
    本函数输出塔局部坐标（由外层平移），M109 就地等待。
    bed_min/bed_max : 床矩形左下角/右上角（床坐标，用于 contains 判定）。
    返回 GCode 行（局部坐标），无合法 park 点则返回 M109 等待行。
    """
    w = WipeTowerWriter(plan)
    perimeter = plan.perimeter_width
    gap, min_gap = 2.0, 0.5

    tower_bed_x = plan.tower_x
    tower_bed_y = plan.tower_y
    a = math.radians(getattr(plan, 'rotation_angle', 0.0))
    ca, sa = math.cos(a), math.sin(a)

    def to_bed(local_pt):
        lx, ly = local_pt
        if a:
            bx = ca * lx - sa * ly + tower_bed_x
            by = sa * lx + ca * ly + tower_bed_y
        else:
            bx = lx + tower_bed_x
            by = ly + tower_bed_y
        return bx, by

    def on_bed(local_pt):
        bx, by = to_bed(local_pt)
        return (bed_min[0] <= bx <= bed_max[0]) and (bed_min[1] <= by <= bed_max[1])

    # 塔包络（矩形 + 每侧 gap）
    min_x = -gap
    max_x = plan.tower_width + gap

    # 用塔入口 X（清洗盒起笔 x = perimeter）判断左右
    entry_x = perimeter
    on_left = entry_x < plan.tower_width / 2.0
    near_x = min_x - gap if on_left else max_x + gap
    far_x = max_x + gap if on_left else min_x - gap

    have_park = on_bed((near_x, perimeter))
    park_x = near_x
    if not have_park:
        limit_x = min_x - min_gap if on_left else max_x + min_gap
        if on_bed((limit_x, perimeter)):
            on, off = limit_x, near_x
            for _ in range(8):   # 二分回退
                mid = 0.5 * (on + off)
                if on_bed((mid, perimeter)):
                    on = mid
                else:
                    off = mid
            park_x, have_park = on, True
    if not have_park and on_bed((far_x, perimeter)):
        park_x, have_park = far_x, True

    if have_park:
        w.set_wipe_feedrate(plan.travel_speed)
        w.emit_xy(park_x, perimeter, travel=True)
    # 就地等待温度
    w.append_line('M109 S{:.0f} ;_WAIT_FOR_TEMP_ON_WIPE_TOWER'.format(wait_for_temp))
    # 同步回塔入口（防止自定义换刀 gcode 改位）
    w.set_wipe_feedrate(plan.travel_speed)
    w.emit_xy(entry_x, perimeter, travel=True)
    return w.collect()


def _plan_module_vol2len(volume, line_width, layer_height):
    """注：为避免循环 import，本地实现 volume_to_length。"""
    if layer_height <= 0:
        return 0.0
    return max(0.0, volume / (layer_height * (line_width - layer_height * (1.0 - math.pi / 4.0))))
