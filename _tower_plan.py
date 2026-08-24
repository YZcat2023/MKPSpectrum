# -*- coding: utf-8 -*-
"""
_tower_plan.py — 擦嘴塔规划器（移植自 OrcaSlicer WipeTower2.cpp）

镜像 Orca 的规划层（WipeTower2::plan_toolchange / set_toolchange / plan_tower）：
把「换刀事件流」变成一个具体参数、逐层深度、块布局的 TowerPlan。

与 Orca 的关键差异：Orca 是完整切片器，从体积 + 多挤出冲洗表算 purge 量；
我们是后处理已有 GCode，因此：
  - 换刀事件序列由 scan_toolchange_events() 从源 GCode 采集；
  - 每个换刀的 wipe_volume 由 scan_wipe_volume() 从源 GCode 中已有的塔段(CP TOOLCHANGE WIPE)
    推算，源 GCode 无塔时退化为 wipe_tower_minimal_purge（等效 filament_minimal_purge_on_wipe_tower）。
其余几何/深度/坐标公式照抄 Orca 常量与逻辑，单位统一 mm/s。

本模块输出 TowerPlan（纯数据），供 _tower_writer.py 出码。
"""

import math
import re
from dataclasses import dataclass, field


# ============================================================
# Orca 常量（WipeTower2.hpp / WipeTower2.cpp 移植）
# ============================================================
WIDTH_TO_NOZZLE_RATIO = 1.25           # Width_To_Nozzle_Ratio
# nozzle-change 挤出一行的线宽映射（WipeTower2 依赖 nozzle_change_perimeter_width 类表）
NOZZLE_CHANGE_WIDTH_MAP = {
    0.2: 0.5,
    0.4: 1.0,
    0.6: 1.2,
    0.8: 1.4,
}
# 塔高 -> 最小深度 映射表（WipeTower.cpp:1588 min_depth_per_height，线性插值）
MIN_DEPTH_PER_HEIGHT = [
    (5.0, 5.0),
    (100.0, 20.0),
    (250.0, 40.0),
    (350.0, 60.0),
]
WT_EPSILON = 1e-3
M_PI_4 = math.pi / 4.0
FILAMENT_DIAMETER = 1.75
FILAMENT_RADIUS_AREA = math.pi * (FILAMENT_DIAMETER / 2.0) ** 2   # 耗材截面积 mm^2


# ============================================================
# 数据结构（对齐 plan 中的描述）
# ============================================================
@dataclass
class ToolchangeEvent:
    """一个换刀事件（规划层用）"""
    layer: int                    # 层号（true_layer_seq）
    z: float                      # 该层打印 Z
    old_tool: int                 # 旧工具头
    new_tool: int                 # 新工具头
    wipe_volume: float            # 该次换刀的清洗体积 (mm^3)
    depth: float = 0.0            # 由规划器回填的该换刀需求深度 (mm)
    is_first_layer: bool = False


@dataclass
class TowerBlock:
    """一个块：同一粘附类别连续占用的竖向区域"""
    category: int
    depth: float = 0.0
    min_y: float = 0.0
    max_y: float = 0.0


@dataclass
class LayerDepth:
    """单层塔的深度分配"""
    layer: int
    z: float
    depth: float
    is_first: bool
    tool_changes: list = field(default_factory=list)   # [ToolchangeEvent]
    wall_depth: float = 0.0                            # 外墙占的深度


@dataclass
class TowerPlan:
    """整座塔的规划结果（纯几何/参数，不含 GCode）"""
    tower_x: float
    tower_y: float
    tower_width: float
    rotation_angle: float            # degree
    nozzle_diameter: float
    layer_height: float
    first_layer_height: float
    perimeter_width: float           # = nozzle * 1.25
    max_purge_speed: float           # mm/s
    infill_speed: float              # mm/s
    perimeter_speed: float           # mm/s
    travel_speed: float              # mm/s
    first_layer_speed: float         # mm/s
    height: float                    # 塔总高（= 最后一层 z + 层高）
    depth: float                     # 塔总深度 (mm)
    num_tool_changes: int = 0
    no_sparse_layers: bool = False
    extra_flow: float = 1.0
    extra_spacing_wipe: float = 1.0
    blocks: list = field(default_factory=list)                 # [TowerBlock]
    layers: list = field(default_factory=list)                 # [LayerDepth]，按层升序
    use_gap_wall: bool = False
    use_wait_temp: bool = False
    use_fillet: bool = False
    adhesiveness: dict = field(default_factory=dict)           # tool -> 粘附类别

    def usable_width(self):
        """清洗盒/墙内净宽 = tower_width - 3 * perimeter_width（WipeTower2::set_toolchange）"""
        return self.tower_width - 3.0 * self.perimeter_width

    def cleaning_width(self):
        """外墙内侧清洗盒宽 = tower_width - 2 * perimeter_width"""
        return self.tower_width - 2.0 * self.perimeter_width


# ============================================================
# 基础换算（WipeTower2.hpp / WipeTower.cpp 原样）
# ============================================================
def volume_to_length(volume, line_width, layer_height):
    """把挤出体积 -> 挤出线长"""
    return max(0.0, volume / (layer_height * (line_width - layer_height * (1.0 - M_PI_4))))


def length_to_volume(length, line_width, layer_height):
    """把挤出线长 -> 挤出体积"""
    return max(0.0, length * (layer_height * (line_width - layer_height * (1.0 - M_PI_4))))


def nozzle_change_perimeter_width(nozzle_diameter):
    """换嘴挤出宽度映射（WipeTower2 / WipeTower.cpp:26）"""
    if nozzle_diameter in NOZZLE_CHANGE_WIDTH_MAP:
        return NOZZLE_CHANGE_WIDTH_MAP[nozzle_diameter]
    return 2.0 * WIDTH_TO_NOZZLE_RATIO * nozzle_diameter


def get_limit_depth_by_height(height):
    """塔高 -> 最小深度，映射表线性插值（WipeTower.cpp:1592 get_limit_depth_by_height）"""
    if height <= MIN_DEPTH_PER_HEIGHT[0][0]:
        return MIN_DEPTH_PER_HEIGHT[0][1]
    if height >= MIN_DEPTH_PER_HEIGHT[-1][0]:
        return MIN_DEPTH_PER_HEIGHT[-1][1]
    for (h1, d1), (h2, d2) in zip(MIN_DEPTH_PER_HEIGHT, MIN_DEPTH_PER_HEIGHT[1:]):
        if h1 <= height <= h2:
            return d1 + (d2 - d1) * (height - h1) / (h2 - h1)
    return MIN_DEPTH_PER_HEIGHT[-1][1]


def get_auto_brim_by_height(height):
    """高度 -> 自动 brim 宽度（WipeTower.cpp:1628 get_auto_brim_by_height）"""
    return height / 100.0 * 8.0 if height < 100.0 else 8.0


# ============================================================
# 换刀事件扫描（源 GCode）
# ============================================================
_COMMENT_TOOL_RE = re.compile(r";\s*Change Tool\d+\s*->\s*Tool(\d+)", re.IGNORECASE)
_MAIN_T_RE = re.compile(r"^T(\d+)$")


def scan_toolchange_events(source_lines):
    """扫描源 GCode，采集每层换刀事件。

    返回 (events: [ToolchangeEvent], layers: dict layer->z)
    从跨行的 '; Change ToolN -> ToolM' 与 'T<n>' 更新活动工具头。
    同一层内工具变化即登记一个换刀事件；首层初始化也登记。
    """
    events = []
    layers = {}
    current_tool = 0
    current_layer = 0
    current_z = 0.0
    layer_tools_seen = set()

    for line in source_lines:
        stripped = line.strip()

        # 层号 / Z / 活动工具头
        if stripped.startswith(';Z:') or stripped.startswith('; Z:'):
            m = re.search(r'[\d.]+', stripped)
            if m:
                current_z = float(m.group())
        if 'CURRENT_LAYER' in stripped:
            m = re.search(r'CURRENT_LAYER\s*=\s*(\d+)', stripped)
            if m:
                current_layer = int(m.group(1))
        tm = _MAIN_T_RE.match(stripped)
        tc_match = _COMMENT_TOOL_RE.match(stripped)
        if tc_match:
            new_tool = int(tc_match.group(1))
            # 注释先行（true_layer_seq# 后），在这里登记换刀
            if current_layer not in layer_tools_seen:
                layer_tools_seen.add(current_layer)
                events.append(ToolchangeEvent(current_layer, current_z, current_tool, new_tool, 0.0,
                                              is_first_layer=(current_layer == 0)))
            else:
                events.append(ToolchangeEvent(current_layer, current_z, current_tool, new_tool, 0.0))
            current_tool = new_tool
            continue
        if tm:
            # 换刀宏可能无注释，直接 T 切换，同样登记一次
            new_tool = int(tm.group(1))
            if current_tool != new_tool:
                if current_layer not in layer_tools_seen:
                    layer_tools_seen.add(current_layer)
                events.append(ToolchangeEvent(current_layer, current_z, current_tool, new_tool, 0.0,
                                              is_first_layer=(current_layer == 0)))
                current_tool = new_tool

        if stripped == ';AFTER_LAYER_CHANGE':
            layers[current_layer] = current_z

    return events, layers


def scan_wipe_volume(gcode_path, source_lines):
    """从源 GCode 已有塔段(CP TOOLCHANGE WIPE)推算单个换刀的清洗体积。

    遍历所有 CP TOOLCHANGE WIPE 块，累计 E 增量（=挤出的耗材长度），
    除以耗材截面积(=filament_area) 得 挤出线体积(mm^3)；
    再除以有清洗的换刀块数摊平为「单个换刀的清洗体积」。
    源 GCode 无塔段时返回 None，由调用方用最小值补偿。
    """
    in_wipe = False
    blocks = []          # 每块累计的 E 长度
    total_e_inc = 0.0
    last_e = None
    for line in source_lines:
        s = line.strip()
        if s == '; CP TOOLCHANGE WIPE':
            if in_wipe and total_e_inc > 1e-6:
                blocks.append(total_e_inc)     # 上一块收尾
            in_wipe = True
            total_e_inc = 0.0
            last_e = None
            continue
        if s in (';WIPE_TOWER_END', '; CP TOOLCHANGE END', '; WIPE_TOWER_END'):
            if in_wipe and total_e_inc > 1e-6:
                blocks.append(total_e_inc)
            in_wipe = False
            total_e_inc = 0.0
            last_e = None
            continue
        if not in_wipe:
            continue
        em = re.search(r'\bE\s*([\+\-]?\d+\.?\d*)', s)
        if em and s.startswith(('G1', 'G0')):
            e = float(em.group(1))
            if last_e is not None and e >= last_e:
                total_e_inc += e - last_e
            last_e = e

    if not blocks:
        return None
    # 全部块累加 E 长度 -> 耗材体积 -> 所有换刀的总挤出线体积
    total_filament_len = sum(blocks)
    total_line_volume = total_filament_len * FILAMENT_RADIUS_AREA
    # 摊平到每个换刀
    per_toolchange = total_line_volume / len(blocks)
    # 上限：与 350mm 高->60mm 深 的塔深表匹配，防止极端 E 撑爆塔
    per_toolchange = min(per_toolchange, 60.0)
    return per_toolchange


# ============================================================
# 深度计算（WipeTower2::set_toolchange / get_wipe_depth）
# ============================================================
def compute_toolchange_depth(plan, ev, first_layer_plan, fil_params):
    """计算单个换刀事件的需求深度（ramming_depth + wiping_depth）。

    fil_params: 耗材参数（本项目单设一组 MK 常量），含
        dict(ramming_speed, ramming_line_width_multiplicator,
             ramming_step_multiplicator, is_soluble, adhesion_category,
             turret_parking_retraction, loading_speed, retract_length, retract_speed)
    """
    width = plan.usable_width()                       # tower_width - 3*perimeter_width
    layer_h = plan.first_layer_height if ev.is_first_layer else plan.layer_height
    old_p = fil_params[ev.old_tool]

    # ramming 长度（多工具 ramming）。Orca 用 multitool_ramming_time * 平均流速；
    # 本项目后处理源 GCode 不带耗材流速数组，用固定 ramming_speed 均值等价。
    ram_vol_rate = math.fsum(old_p.get('ramming_speed', [0.0]))
    multitool_ramming_time = old_p.get('multitool_ramming_time', 0.15)
    length_to_extrude_ram = volume_to_length(
        multitool_ramming_time * ram_vol_rate,
        plan.perimeter_width * old_p.get('ramming_line_width_multiplicator', 1.0),
        layer_h)

    # Orca 只在 toolchange_Unload 实际 ram 时预留 ramming 深度
    do_ramming = old_p.get('ramming_enabled', True)
    if do_ramming:
        ramming_depth = (int(length_to_extrude_ram / width) + 1) * (
            plan.perimeter_width
            * old_p.get('ramming_line_width_multiplicator', 1.0)
            * old_p.get('ramming_step_multiplicator', 2.0)
            * plan.extra_spacing_ramming)
    else:
        ramming_depth = 0.0

    # first_wipe_line 骑在最后一条 partially-used ramming 行上
    boundary_wipe_start = False
    if do_ramming and not boundary_wipe_start:
        frac = length_to_extrude_ram / width
        first_wipe_line = -(width * (frac - int(frac)) - width)
    else:
        first_wipe_line = 0.0
    first_wipe_volume = length_to_volume(first_wipe_line,
                                         plan.perimeter_width * plan.extra_flow, layer_h)

    plan_spacing = plan.extra_flow if first_layer_plan else plan.extra_spacing_wipe
    wiping_depth = get_wipe_depth(ev.wipe_volume - first_wipe_volume, layer_h,
                                  plan.perimeter_width, plan.extra_flow, plan_spacing, width)

    return ramming_depth + wiping_depth


def get_wipe_depth(volume, layer_height, perimeter_width, extra_flow, extra_spacing, width):
    """WipeTower2::get_wipe_depth（WipeTower2.cpp:2195）"""
    length_to_extrude = volume_to_length(volume, perimeter_width, layer_height) / extra_flow
    length_to_extrude = max(length_to_extrude, 0.0)
    return (int(length_to_extrude / width) + 1) * perimeter_width * extra_spacing


# ============================================================
# 塔整体规划驱动
# ============================================================
DEFAULT_FIL_PARAMS = None


def build_filament_params(nozzle_diameter):
    """构建每个工具的耗材参数（单组 MK 默认，供规划/出码共用）。"""
    global DEFAULT_FIL_PARAMS
    p = {
        'ramming_speed': [25.0, 25.0, 25.0, 25.0, 25.0, 25.0, 25.0],
        'ramming_line_width_multiplicator': 0.5,
        'ramming_step_multiplicator': 2.0,
        'ramming_enabled': True,
        'multitool_ramming_time': 0.15,
        'is_soluble': False,
        'adhesion_category': 0,
        'turret_parking_retraction': [0.0, 0.0],
        'loading_speed': 35.0,
        'loading_speed_start': 35.0,
        'retract_length': 0.8,
        'retract_speed': 30.0,
        'tower_ironing_area': 0.0,
        'last_ramming_speed': 25.0,
        'unloading_speed_start': 20.0,
        'unloading_speed': 20.0,
        'filament_change_length': [10.0],
    }
    if DEFAULT_FIL_PARAMS is None:
        DEFAULT_FIL_PARAMS = p
    return p


def plan_tower(config):
    """顶层规划。config 集中来自 GCodeGenerator 的当前参数。

    config 字段（由 _tower_plan 无关，调用方保证）：
        tower_x, tower_y, tower_width, rotation_angle, nozzle_diameter,
        layer_height, first_layer_height, max_purge_speed,
        infill_speed, perimeter_speed, travel_speed,
        wipe_volume (float | None), events: [ToolchangeEvent],
        total_layers_height (float), use_gap_wall, use_wait_temp
    返回 TowerPlan。
    """
    nozzle_d = config['nozzle_diameter']
    perimeter = WIDTH_TO_NOZZLE_RATIO * nozzle_d
    tower_width = config.get('tower_width', 20.0)

    # 高度 -> 最小深度（决定塔能否太细）
    height = config['total_height']
    min_depth = get_limit_depth_by_height(height)

    events = config['events']
    if not events:
        return None

    extra_flow = config.get('extra_flow', 1.0)
    extra_spacing_wipe = config.get('extra_spacing_wipe', 1.0)
    extra_spacing_ramming = config.get('extra_spacing_ramming', 1.0)
    wipe_volume = config.get('wipe_volume')

    # 单块式塔（我们按单块简化 —— 全塔同粘附类别），先算每层深度
    layers_depth = {}   # layer -> depth
    per_layer_events = {}
    first_layer_idx = None
    for ev in events:
        per_layer_events.setdefault(ev.layer, []).append(ev)
        if ev.is_first_layer:
            first_layer_idx = ev.layer

    fil_params = {t: build_filament_params(nozzle_d) for t in range(4)}
    for layer, evs in per_layer_events.items():
        d = 0.0
        for ev in evs:
            if ev.wipe_volume <= 0 and wipe_volume:
                ev.wipe_volume = wipe_volume
            first_plan = (layer == first_layer_idx)
            ed = compute_toolchange_depth(
                _TmpCtx(plan_shape=None, width=tower_width, perimeter_width=perimeter,
                        first_layer_height=config['first_layer_height'],
                        layer_height=config['layer_height'],
                        extra_flow=extra_flow, extra_spacing_wipe=extra_spacing_wipe,
                        extra_spacing_ramming=extra_spacing_ramming),
                ev, first_plan, fil_params)
            ev.depth = ed           # 记录每个换刀的单独需求深度（出码时定位清洗盒）
            d += ed
        layers_depth[layer] = d

    if not layers_depth:
        return None

    # 深度沿层向下传播（WipeTower2::plan_tower）：下一层不能小于上一层
    # （保证塔在负方向堆叠不悬空）
    sorted_layers = sorted(per_layer_events.keys())
    # Orca 是自顶向下传播（深度向下 = Z 向下），这里 z 增大用自底向上取 max
    downward_max = 0.0
    for lyr in sorted_layers:  # z 从低到高
        downward_max = max(downward_max, layers_depth[lyr])
        layers_depth[lyr] = max(layers_depth[lyr], downward_max)
    # 再自顶向下取一次（防止高层突然变窄）
    total_depth = max(layers_depth.values())
    for lyr in sorted_layers:
        layers_depth[lyr] = max(layers_depth[lyr], 0.3)   # 至少一条线宽

    # 官方肋墙：WipeTower2::generate() 在 depth 定型后算 rib 几何
    # 本项目用 mm 域简化：对角线 + 参数化 rib 宽/长 + 随高度递减的外伸
    rib_wall = bool(config.get('use_rib_wall', False))
    rib_width = float(config.get('rib_width', 8.0))
    extra_rib_length = float(config.get('extra_rib_length', 0.0))
    # rib_width 不超过塔边长一半（官方 clamp，保证筋与填充相连）
    if rib_wall:
        rib_width = min(rib_width, min(tower_width, max(min_depth, total_depth)) / 2.0)
    raw_depth = max(min_depth, total_depth)
    # rib 模式下强制方塔（官方：width = ceil(sqrt(depth*width), perimeter)），深度/宽度重算
    if rib_wall:
        import math as _m
        aligned_w = _m.ceil(math.sqrt(raw_depth * tower_width) / perimeter) * perimeter if perimeter > 1e-9 else tower_width
        tower_width = aligned_w
        # 方塔后再取 max_depth 语义：此时 depth 与 width 已方化，raw_depth 即 max_depth
        max_depth = raw_depth
        # rib 长：若塔深小于高度稳定性最小值，则用 min_depth*sqrt(2) 保底（WipeTower2:2450）
        rib_length = max(math.hypot(tower_width, max_depth), 0.0)
        if max_depth + 1e-3 < min_depth:
            rib_length = max(rib_length, min_depth * math.sqrt(2.0))
        rib_length += extra_rib_length
        rib_length = max(math.hypot(tower_width, max_depth), rib_length)
    else:
        rib_length = math.hypot(tower_width, raw_depth) + extra_rib_length
        rib_length = max(math.hypot(tower_width, raw_depth), rib_length)

    plan = TowerPlan(
        tower_x=config['tower_x'], tower_y=config['tower_y'],
        tower_width=tower_width, rotation_angle=config.get('rotation_angle', 0.0),
        nozzle_diameter=nozzle_d, layer_height=config['layer_height'],
        first_layer_height=config['first_layer_height'],
        perimeter_width=perimeter,
        max_purge_speed=config.get('max_purge_speed', 90.0),
        infill_speed=config.get('infill_speed', 300.0),
        perimeter_speed=config.get('perimeter_speed', 200.0),
        travel_speed=config.get('travel_speed', 500.0),
        first_layer_speed=config.get('first_layer_speed', 25.0),
        num_tool_changes=len(events),
        no_sparse_layers=config.get('no_sparse_layers', False),
        height=config['total_height'],
        depth=raw_depth,
        extra_flow=extra_flow, extra_spacing_wipe=extra_spacing_wipe,
        use_gap_wall=config.get('use_gap_wall', False),
        use_wait_temp=config.get('use_wait_temp', False),
        use_fillet=config.get('use_fillet', False),
    )
    # 补 extra_spacing_ramming（TowerPlan 未声明该字段，经 setattr 附加同值）
    plan.extra_spacing_ramming = extra_spacing_ramming
    plan.relative_e = bool(config.get('relative_e', False))
    plan.brim_width = float(config.get('brim_width', 3.0))
    plan.brim_width_real = 0.0
    # 肋墙几何参数（供 _tower_writer 的 rib_section/generate_rib_polygon 使用）
    plan.use_rib_wall = rib_wall
    plan.rib_width = rib_width
    plan.rib_length = rib_length
    plan.extra_rib_length = extra_rib_length
    plan.y_shift = 0.0
    plan.rib_offset = (0.0, 0.0)
    if rib_wall:
        try:
            from _tower_writer import Box, generate_rib_polygon
            wt_box = Box(0.0, 0.0, plan.tower_width, plan.depth + plan.perimeter_width)
            rib_poly = generate_rib_polygon(
                wt_box,
                plan.rib_length,
                plan.rib_width,
                config['layer_z'].get(first_layer_idx, config.get('first_layer_height', 0.0)),
                plan.height,
                y_shift=0.0,
                fillet_wall=plan.use_fillet,
                layer_height=plan.layer_height,
                first_layer_height=plan.first_layer_height,
            )
            if rib_poly:
                min_x = min(p[0] for p in rib_poly)
                min_y = min(p[1] for p in rib_poly)
                plan.rib_offset = (-min_x, -min_y)
        except Exception:
            plan.rib_offset = (0.0, 0.0)

    # 组装逐层数据
    for lyr in sorted_layers:
        plan.layers.append(LayerDepth(
            layer=lyr,
            z=config['layer_z'].get(lyr, 0.0),
            depth=layers_depth[lyr],
            is_first=(lyr == first_layer_idx),
            tool_changes=per_layer_events[lyr],
        ))

    # 单块
    plan.blocks.append(TowerBlock(category=0, depth=plan.depth,
                                  min_y=0.0, max_y=plan.depth))
    return plan


class _TmpCtx:
    """轻量上下文，复用 compute_toolchange_depth 的字段访问接口。"""
    def __init__(self, **kw):
        self.__dict__.update(kw)

    @property
    def extra_spacing_ramming(self):
        return self.__dict__.get('extra_spacing_ramming', 1.0)

    def usable_width(self):
        return self.width - 3.0 * self.perimeter_width
