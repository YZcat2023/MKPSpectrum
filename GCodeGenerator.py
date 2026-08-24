# coding=utf-8
"""
GCodeGenerator - 后处理 GCode 生成器
功能：
  1. 读取切片生成的 GCode 文件，提取空驶速度/加速度/层高等切片参数
  2. 在每层 AFTER_LAYER_CHANGE 后插入：取喷墨头宏 → 纹理切片 GCODE → 放回喷墨头宏
  3. 在每层 AFTER_LAYER_CHANGE 后插入擦嘴塔（参考 cankao.py 的塔生成逻辑）
  4. 结合喷墨速度预测总打印时长

用法：
  GCodeGenerator.exe --Gcode <GCode文件路径> [--Inkjet <纹理GCODE路径>] [--Output <输出路径>] [--InkjetSpeed <喷墨速度>] [--Extract]
  
  --Extract  仅提取切片参数而不进行后处理，输出 JSON 到 stdout

参数传递方式与 cankao.py 一致（argparse）
"""

import argparse
import json
import math
import os
import re
import sys
import time

# 擦嘴塔规划器与出码器（移植自 OrcaSlicer WipeTower2）
from _tower_plan import (
    plan_tower, scan_toolchange_events, scan_wipe_volume, ToolchangeEvent,
    WIDTH_TO_NOZZLE_RATIO,
)
from _tower_writer import (
    generate_toolchange_wipe, generate_no_toolchange_cross, generate_finish_layer_wall,
    generate_finish_layer_infill,
)

# 硬编码波浪塔模板（由 _gen_templates.py 从 test1.gcode 一次性生成）
from _tower_templates import (
    _TEMPLATE_TOWER_ORIGIN_X, _TEMPLATE_TOWER_ORIGIN_Y,
    _TEMPLATE_TOWER_BRIM_HEIGHT_Y, _TEMPLATE_TOWER_BRIM_WIDTH_X,
    WAVE_BRIM_ALL_LAYERS, WAVE_BRIM_FIRST_LAYER,
)

# ============================================================
# 配置文件自动下载
# ============================================================
_CONFIG_URL = 'https://gitee.com/Jhmodel/mkpspectrum/raw/master/CONF/MKP%20standard.json'

def _ensure_config_downloaded():
    """检查 MKP standard.json 是否存在，不存在则从 Gitee 自动下载"""
    config_path = os.path.join(
        os.path.expanduser('~'), 'Documents', 'MKPSpectrum', 'Printsetting', 'MKP standard.json'
    )
    if os.path.exists(config_path):
        return config_path
    import urllib.request
    print('[Config] MKP standard.json 不存在，正在从 Gitee 自动下载...')
    try:
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        urllib.request.urlretrieve(_CONFIG_URL, config_path)
        print(f'[Config] 下载成功: {config_path}')
    except Exception as e:
        print(f'[Config] 自动下载失败: {e}')
        print('[Config] 将使用默认值继续运行')
    return config_path


# ============================================================
# 参数配置
# ============================================================
class Params:
    # 擦嘴塔参数
    Wiper_x = 20
    Wiper_y = 175
    Tower_Extrude_Ratio = 1.0
    WipeTower_Print_Speed = 9600
    Switch_Tower_Type = 2
    Debug_Mode = False
    # —— 擦嘴塔（Orca WipeTower2 移植）新增参数 ——
    Tower_Width = 20.0            # 塔宽 (mm)
    Tower_Rotation_Angle = 0.0    # 塔旋转角 (deg)，绕塔左下角
    Minimal_Purge_Volume = 30.0   # 源 GCode 无塔段时的最小清洗体积 (mm^3)
    # 官方肋墙参数（对齐 PrintConfig.cpp wipe_tower_* 默认值）
    WipeTower_WallType = 'rib'      # rectangle | cone | rib，默认 rib
    WipeTower_RibWidth = 8.0        # mm，默认 8（范围 0-300）
    WipeTower_ExtraRibLength = 0.0  # mm，默认 0（可负，范围 -∞..300）
    WipeTower_FilletWall = True     # 是否圆角，默认 True

    # 喷墨头参数
    Retract_Length = 0.8

    # 后处理替换宏名
    GRAB_INKJET_MACRO = "GRAB_INKJET_HEAD"
    RELEASE_INKJET_MACRO = "RELEASE_INKJET_HEAD"

    # 层高相关
    First_Layer_Height = 0.25
    Typical_Layer_Height = 0.2
    Nozzle_Diameter = 0.4

    # 墨水层 GCODE 查找依据
    Inkjet_Layer_Marker = ";LAYER:"

    # 波浪塔模板文件路径
    Wave_Tower_Template = None

    # MKPColorPLA 着色薄层参数
    Color_Layer_Thickness = 0.04       # 着色薄层厚度(mm)，可传参覆盖
    MKPColor_Flow_Ratio = 0.6          # MKPColorPLA 挤出乘数（从gcode注释读取后覆盖）
    MKPColor_Nozzle_Temp = 250         # MKPColorPLA 喷嘴温度
    MKPColor_Tool_Index = 0            # MKPColorPLA 工具头编号


# ============================================================
# 擦嘴塔位置 —— 从 MKP standard.json 读取左下角 X,Y
# ============================================================
_tower_pos_cache = None

def _parse_scalar_config_value(raw):
    """Parse a slicer config scalar while tolerating units and percent suffixes."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    text = text.split(',', 1)[0].strip()
    text = text.rstrip('%').strip()
    m = re.match(r'([\+\-]?\d+(?:\.\d+)?)', text)
    if not m:
        return None
    return float(m.group(1))


def _parse_bool_config_value(raw):
    val = _parse_scalar_config_value(raw)
    if val is not None:
        return bool(val)
    return str(raw).strip().lower() in ('true', 'yes', 'on')


def _scan_gcode_config(source_lines):
    """Read the trailing Orca/Snapmaker CONFIG_BLOCK style comments.

    Duplicate keys are expected in Orca-derived files; the last value wins.
    """
    config = {}
    for line in source_lines:
        stripped = line.strip()
        m = re.match(r';\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$', stripped)
        if m:
            config[m.group(1)] = m.group(2).strip()
    return config


def _tower_config_from_source(source_lines, params=None):
    """Return wipe tower settings, preferring the source G-code comments.

    The frontend JSON remains the fallback, because older generated G-code may
    not carry wipe_tower_x/y in its footer.
    """
    cfg = _scan_gcode_config(source_lines)
    fallback_x, fallback_y = load_tower_position()
    tower_x = _parse_scalar_config_value(cfg.get('wipe_tower_x'))
    tower_y = _parse_scalar_config_value(cfg.get('wipe_tower_y'))
    if tower_x is None:
        tower_x = fallback_x
    if tower_y is None:
        tower_y = fallback_y

    tower_width = _parse_scalar_config_value(cfg.get('prime_tower_width'))
    if tower_width is None:
        tower_width = _parse_scalar_config_value(cfg.get('wipe_tower_width'))
    if tower_width is None:
        tower_width = params.get('prime_tower_width') if params else None
    if tower_width is None:
        tower_width = params.get('wipe_tower_width') if params else None
    if tower_width is None:
        tower_width = float(getattr(Params, 'Tower_Width', None) or 20.0)

    rotation = _parse_scalar_config_value(cfg.get('wipe_tower_rotation_angle'))
    if rotation is None:
        rotation = params.get('wipe_tower_rotation_angle') if params else None
    if rotation is None:
        rotation = float(getattr(Params, 'Tower_Rotation_Angle', None) or 0.0)

    wall_type = (cfg.get('wipe_tower_wall_type') or
                 (params.get('wipe_tower_wall_type') if params else None) or
                 getattr(Params, 'WipeTower_WallType', 'rib') or 'rib')
    rib_width = _parse_scalar_config_value(cfg.get('wipe_tower_rib_width'))
    if rib_width is None:
        rib_width = params.get('wipe_tower_rib_width') if params else None
    if rib_width is None:
        rib_width = float(getattr(Params, 'WipeTower_RibWidth', 8.0) or 8.0)

    extra_rib = _parse_scalar_config_value(cfg.get('wipe_tower_extra_rib_length'))
    if extra_rib is None:
        extra_rib = params.get('wipe_tower_extra_rib_length') if params else None
    if extra_rib is None:
        extra_rib = float(getattr(Params, 'WipeTower_ExtraRibLength', 0.0) or 0.0)

    extra_flow = _parse_scalar_config_value(cfg.get('wipe_tower_extra_flow'))
    if extra_flow is None:
        extra_flow = params.get('wipe_tower_extra_flow') if params else None
    extra_flow = (extra_flow / 100.0) if extra_flow else 1.0

    extra_spacing = _parse_scalar_config_value(cfg.get('wipe_tower_extra_spacing'))
    if extra_spacing is None:
        extra_spacing = params.get('wipe_tower_extra_spacing') if params else None
    extra_spacing = (extra_spacing / 100.0) if extra_spacing else 1.0

    no_sparse = cfg.get('wipe_tower_no_sparse_layers')
    if no_sparse is None and params:
        no_sparse = params.get('wipe_tower_no_sparse_layers')

    purge_speed = _parse_scalar_config_value(cfg.get('wipe_tower_max_purge_speed'))
    if purge_speed is None and params:
        purge_speed = params.get('wipe_tower_max_purge_speed')
    brim_width = _parse_scalar_config_value(cfg.get('prime_tower_brim_width'))
    if brim_width is None and params:
        brim_width = params.get('prime_tower_brim_width')
    minimal_purge = _parse_scalar_config_value(cfg.get('filament_minimal_purge_on_wipe_tower'))
    if minimal_purge is None and params:
        minimal_purge = (params.get('filament_minimal_purge_on_wipe_tower') or
                         params.get('minimal_purge_on_wipe_tower'))

    return {
        'tower_x': float(tower_x),
        'tower_y': float(tower_y),
        'tower_width': float(tower_width),
        'rotation_angle': float(rotation),
        'wall_type': str(wall_type).strip().lower(),
        'rib_width': float(rib_width),
        'extra_rib_length': float(extra_rib),
        'extra_flow': float(extra_flow),
        'extra_spacing_wipe': float(extra_spacing),
        'no_sparse_layers': _parse_bool_config_value(no_sparse) if no_sparse is not None else False,
        'max_purge_speed': float(purge_speed) if purge_speed else 90.0,
        'brim_width': float(brim_width) if brim_width is not None else 3.0,
        'minimal_purge_on_wipe_tower': minimal_purge,
    }


def load_tower_position():
    """从喷墨配置文件读取擦嘴塔左下角坐标。读不到则默认 (10, 220)。结果缓存。"""
    global _tower_pos_cache
    if _tower_pos_cache is not None:
        return _tower_pos_cache
    import json as _json
    config_path = _ensure_config_downloaded()
    tower_x, tower_y = 10.0, 220.0
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as _f:
                cfg = _json.load(_f)
            wt = cfg.get('wipe_tower', {})
            tower_x = float(wt.get('x', tower_x))
            tower_y = float(wt.get('y', tower_y))
        except Exception:
            pass
    print('[WaveTower] 擦嘴塔左下角位置: ({:.1f}, {:.1f})'.format(tower_x, tower_y))
    _tower_pos_cache = (tower_x, tower_y)
    return _tower_pos_cache


# ============================================================
# 喷墨头取出/放回宏 —— 从 MKP standard.json 读取 grab_macro/release_macro
# ============================================================
_grab_release_cache = None

def load_grab_release_macros():
    """从喷墨配置文件读取喷墨头取出/放回宏。读不到则默认 ('GRAB_INKJET_HEAD', 'RELEASE_INKJET_HEAD')。"""
    global _grab_release_cache
    if _grab_release_cache is not None:
        return _grab_release_cache
    import json as _json
    config_path = _ensure_config_downloaded()
    grab, release = 'GRAB_INKJET_HEAD', 'RELEASE_INKJET_HEAD'
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as _f:
                cfg = _json.load(_f)
            ij = cfg.get('inkjet', {})
            grab = ij.get('grab_macro', grab) or grab
            release = ij.get('release_macro', release) or release
        except Exception:
            pass
    print('[ColorOverlay] 取出宏: {}'.format(grab.replace(chr(10), '; ')))
    print('[ColorOverlay] 放回宏: {}'.format(release.replace(chr(10), '; ')))
    _grab_release_cache = (grab, release)
    return _grab_release_cache


# ============================================================
# 喷嘴直径 & 层高读取 —— 用于 E 值缩放
# ============================================================
def read_input_nozzle_diameter(gcode_path):
    """
    从 gcode 头部读取 nozzle_diameter，并通过扫描 ; Change Tool 命令确定
    实际使用的喷嘴。规则：
      - nozzle_diameter = a,b,c,d  对应 T0,T1,T2,T3
      - 扫描 gcode 中实际使用的 T 编号，取对应口径
      - 多个不同口径 → 取最大者
      - 默认 0.4
    """
    nd_list = [0.4, 0.4, 0.4, 0.4]
    used_tools = set()
    try:
        with open(gcode_path, 'r', encoding='utf-8') as f:
            for line in f:
                # 头部: ; nozzle_diameter = 0.4,0.4,0.4,0.4
                m = re.match(r';\s*nozzle_diameter\s*=\s*([\d\.,\s]+)', line.strip())
                if m:
                    vals = [float(x.strip()) for x in m.group(1).split(',') if x.strip()]
                    if len(vals) == 4:
                        nd_list = vals
                # 换刀: ; Change ToolX -> ToolY (layer N)
                cm = re.match(r';\s*Change\s+Tool\d+\s*->\s*Tool(\d+)', line.strip())
                if cm:
                    used_tools.add(int(cm.group(1)))
                # 头部结束就停
                if line.strip().startswith(';') and any(kw in line for kw in ('filament_type', 'filament used')):
                    pass  # 继续读头部
                if re.match(r'^(G90|G21|M82|M83|M107|G28|T\d)', line.strip()) and used_tools:
                    break  # 已进入 gcode 主体
                if len(used_tools) >= 4:
                    break  # 4个都用到了
    except Exception:
        pass

    if not used_tools:
        nd = nd_list[0]  # 只有 T0 默认
    else:
        used_diameters = [nd_list[t] for t in sorted(used_tools)]
        nd = max(used_diameters)

    print('[WaveTower] 喷嘴口径: {} (使用工具: {})'.format(nd, sorted(used_tools)))
    return nd


def read_input_layer_height(gcode_path):
    """
    从 gcode 中读取层高。取前 5 条 ;HEIGHT: 注释的众数。
    默认 0.2。
    """
    heights = []
    try:
        with open(gcode_path, 'r', encoding='utf-8') as f:
            for line in f:
                m = re.match(r';HEIGHT:\s*([\d\.]+)', line.strip())
                if m:
                    heights.append(float(m.group(1)))
                    if len(heights) >= 10:
                        break
    except Exception:
        pass

    from collections import Counter
    if heights:
        cnt = Counter(heights)
        lh = cnt.most_common(1)[0][0]
    else:
        lh = 0.2
    print('[WaveTower] 用户层高: {} (样本: {})'.format(lh, heights[:5]))
    return lh


def read_input_first_layer_height(gcode_path):
    """从 gcode 注释 ; first_layer_height = X 读取首层层高。默认 0.25。"""
    try:
        with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                m = re.match(r';\s*first_layer_height\s*=\s*([\d.]+)', line.strip())
                if m:
                    return float(m.group(1))
    except Exception:
        pass
    return 0.25


def extract_mkp_color_params(gcode_path):
    """
    从 G-code 尾部配置区读取 MKPColorPLA 的工具头参数。
    查找 filament_settings_id 中包含 'MKPColorPLA' 的槽位，读取对应的：
      - tool_index:        工具头编号 (0-3)
      - nozzle_temp:       喷嘴温度 (°C)
      - flow_ratio:        挤出乘数 (filament_flow_ratio)
      - inner_wall_flow:   内墙挤出乘数 (inner_wall_flow_ratio)

    返回 dict，若未找到则返回 None。
    """
    result = {
        'tool_index': 0,
        'nozzle_temp': 250,
        'flow_ratio': 0.6,
        'inner_wall_flow': 1.0,
    }
    mkp_index = -1
    nozzle_temps = [210, 230, 220, 220]
    flow_ratios = [1.0, 0.95, 0.98, 0.98]

    try:
        with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except Exception:
        return result

    # 查找 MKPColorPLA 在 filament_settings_id 中的索引
    m = re.search(r';\s*filament_settings_id\s*=\s*(.+)', content)
    if m:
        ids_str = m.group(1)
        # 分号分隔，可能带引号
        parts = re.split(r'\s*;\s*', ids_str)
        for i, p in enumerate(parts):
            p_clean = p.strip().strip('"')
            if 'MKPColorPLA' in p_clean:
                mkp_index = i
                print('[ColorOverlay] 找到 MKPColorPLA: filament index {} ({})'.format(i, p_clean))
                break

    if mkp_index < 0:
        print('[ColorOverlay] 警告: 未找到 MKPColorPLA，使用默认参数 T0')
        return result

    # 读取 nozzle_temperature
    m = re.search(r';\s*nozzle_temperature\s*=\s*([\d,]+)', content)
    if m:
        temps = [int(x.strip()) for x in m.group(1).split(',')]
        if len(temps) > mkp_index:
            nozzle_temps = temps

    # 读取 filament_flow_ratio
    m = re.search(r';\s*filament_flow_ratio\s*=\s*([\d\.,]+)', content)
    if m:
        ratios = [float(x.strip()) for x in m.group(1).split(',')]
        if len(ratios) > mkp_index:
            flow_ratios = ratios

    # 读取 inner_wall_flow_ratio
    inner_wall_flow = 1.0
    m = re.search(r';\s*inner_wall_flow_ratio\s*=\s*([\d.]+)', content)
    if m:
        inner_wall_flow = float(m.group(1))

    result['tool_index'] = mkp_index
    result['nozzle_temp'] = nozzle_temps[mkp_index]
    result['flow_ratio'] = flow_ratios[mkp_index]
    result['inner_wall_flow'] = inner_wall_flow

    print('[ColorOverlay] MKPColorPLA 参数: T{} 温度={}°C flow_ratio={} inner_wall_flow={}'.format(
        mkp_index, result['nozzle_temp'], result['flow_ratio'], inner_wall_flow))

    return result


def get_e_scale(target_gcode_path, params=None, first_layer_height=None, layer_height=None):
    """
    计算 E 缩放因子。区分首层和常规层。
    模板: 喷嘴=0.4, 首层层高=0.1, 常规层高=0.1 (fulltest.gcode)
    E 正比于层高，正比于喷嘴面积（D²）。

    返回 (first_layer_scale, regular_scale)
    """
    TEMPLATE_NOZZLE = 0.4
    TEMPLATE_FIRST_LH = 0.1
    TEMPLATE_REGULAR_LH = 0.1

    nd = read_input_nozzle_diameter(target_gcode_path)

    if first_layer_height is None:
        first_lh = read_input_first_layer_height(target_gcode_path)
    else:
        first_lh = first_layer_height
    if layer_height is None:
        regular_lh = read_input_layer_height(target_gcode_path)
    else:
        regular_lh = layer_height

    nd_area_ratio = (nd * nd) / (TEMPLATE_NOZZLE * TEMPLATE_NOZZLE)
    scale_first = (first_lh / TEMPLATE_FIRST_LH) * nd_area_ratio
    scale_regular = (regular_lh / TEMPLATE_REGULAR_LH) * nd_area_ratio

    print('[WaveTower] 目标: 首层层高={:.2f} 常规层高={:.2f} 喷嘴={:.2f}'.format(
        first_lh, regular_lh, nd))
    print('[WaveTower] E缩放: 首层={:.4f}  常规={:.4f} (nd2比={:.4f})'.format(
        scale_first, scale_regular, nd_area_ratio))
    return scale_first, scale_regular


def _scale_e_in_lines(lines, scale):
    """将 lines 中所有 G1 的 E 值乘以 scale。prime/retract (E±1.5) 不缩放。"""
    if abs(scale - 1.0) < 0.001:
        return lines
    result = []
    for line in lines:
        m = re.search(r'\bE\s*([\+\-]?\d+\.?\d*)', line)
        if m:
            old_e = float(m.group(1))
            # 不缩放 prime/retract (±1.5)
            if abs(abs(old_e) - 1.5) < 0.01:
                result.append(line)
                continue
            new_e = old_e * scale
            line = re.sub(r'\bE\s*[\+\-]?(?:\d+\.?\d*|\.\d+)', 'E{:.5f}'.format(new_e), line)
        result.append(line)
    return result


def get_template_tower_origin():
    """
    返回模板塔的包围盒左下角 (min_x, min_y)。
    数据已硬编码在 _tower_templates.py 中（从 test1.gcode 第一个 BRIM 段预计算）。
    用于计算偏移量，使生成的塔平移到用户指定的位置。
    """
    min_x = _TEMPLATE_TOWER_ORIGIN_X
    min_y = _TEMPLATE_TOWER_ORIGIN_Y
    return min_x, min_y


def _offset_brim_coordinates(brim_lines, dx, dy):
    """对 BRIM 行中的 X/Y 坐标施加平移 (dx, dy)"""
    result = []
    for line in brim_lines:
        if re.match(r'^\s*G[01]\s', line):
            new_line = line
            new_line = re.sub(
                r'\bX\s*([\+\-]?(?:\d+\.?\d*|\.\d+))',
                lambda m: 'X' + _fmt_offset(m.group(1), dx),
                new_line
            )
            new_line = re.sub(
                r'\bY\s*([\+\-]?(?:\d+\.?\d*|\.\d+))',
                lambda m: 'Y' + _fmt_offset(m.group(1), dy),
                new_line
            )
            result.append(new_line)
        else:
            result.append(line)
    return result


def _fmt_offset(val_str, offset):
    """格式化带偏移的坐标值"""
    v = float(val_str) + offset
    if v == int(v):
        return str(int(v))
    return '{:.3f}'.format(v)


def _transform_tower_lines(lines, tower_x, tower_y, rotation_angle=0.0, local_offset=(0.0, 0.0)):
    """把塔局部坐标 GCode（原点=塔左下角）变换到床坐标。

    公式（对齐 Orca append_tcr 两层变换的最外层）：
        bed = R(rotation) * (local + local_offset) + (tower_x, tower_y)
    仅改写 G1/G0 的 X/Y 段；无 X/Y 的行（纯速度/E 设置）原样保留。
    rotation_angle 为度，绕塔左下角旋转（与 wipe_tower_position 左下角语义一致）。
    """
    ox, oy = local_offset or (0.0, 0.0)

    if rotation_angle:
        a = math.radians(rotation_angle)
        ca, sa = math.cos(a), math.sin(a)

        def _xf(x, y):
            return ca * x - sa * y, sa * x + ca * y
    else:
        def _xf(x, y):
            return x, y

    def _num(m):
        return float(m.group(1))

    out = []
    for line in lines:
        if not re.match(r'^\s*G[01]\s', line):
            out.append(line)
            continue
        mx = re.search(r'\bX\s*([\+\-]?(?:\d+\.?\d*|\.\d+))', line)
        my = re.search(r'\bY\s*([\+\-]?(?:\d+\.?\d*|\.\d+))', line)
        if mx is None and my is None:
            out.append(line)
            continue
        lx = _num(mx) if mx else 0.0
        ly = _num(my) if my else 0.0
        bx, by = _xf(lx + ox, ly + oy)
        bx += tower_x
        by += tower_y
        # 重建该行：改写 X/Y
        new_line = line
        if mx:
            new_line = re.sub(
                r'\bX\s*([\+\-]?(?:\d+\.?\d*|\.\d+))',
                lambda m: 'X' + _fmt_bed(bx), new_line, count=1)
        if my:
            new_line = re.sub(
                r'\bY\s*([\+\-]?(?:\d+\.?\d*|\.\d+))',
                lambda m: 'Y' + _fmt_bed(by), new_line, count=1)
        out.append(new_line)
    return out


def _fmt_bed(v):
    r = round(float(v), 4)
    if r == int(r):
        return str(int(r))
    return ('%g' % r)


def _build_tower_plan(gcode_path, source_lines, params, tool_temps, filament_types):
    """在 process_gcode 顶部一次性构建擦嘴塔规划。

    输入已读取的源 GCode 与切片参数，输出 TowerPlan 或 None（无可规划换刀事件）。
    """
    try:
        layer_height = params.get('layer_height', 0.2) if params else 0.2
        first_layer_height = params.get('first_layer_height', 0.25) if params else 0.25
        nozzle_diameter = read_input_nozzle_diameter(gcode_path)
        tower_cfg = _tower_config_from_source(source_lines, params)
        tower_x, tower_y = tower_cfg['tower_x'], tower_cfg['tower_y']

        # wipe_volume 优先从源 GCode 已有塔段推算；无塔则用最小清洗体积补偿
        wipe_volume = scan_wipe_volume(gcode_path, source_lines)
        if wipe_volume is None:
            # 等效 filament_minimal_purge_on_wipe_tower（默认给 30mm^3）
            wipe_volume = tower_cfg.get('minimal_purge_on_wipe_tower')
            if wipe_volume is None:
                wipe_volume = params.get('minimal_purge_on_wipe_tower', 30.0) if params else 30.0

        events, layer_z = scan_toolchange_events(source_lines)
        if not events:
            # 强制擦嘴塔：即使无换刀事件也每层出塔（用最小清洗体积的参数化矩形塔兜底）
            print('[TowerPlan] 源 GCode 无换刀事件，启用强制擦嘴塔（每层出塔）')
            total_layers = int(params.get('total_layers', 0) or 0) if params else 0
            if total_layers <= 0:
                total_layers = len(layer_z) if layer_z else 0
            if total_layers <= 0:
                total_layers = sum(1 for _l in source_lines if _l.strip() == ';AFTER_LAYER_CHANGE')
            if total_layers <= 0:
                total_layers = 1
            # 补齐 layer_z（按首层+层高推算，确保与 process_gcode 的 true_layer_seq 对齐）
            for _lyr in range(total_layers):
                if _lyr not in layer_z:
                    layer_z[_lyr] = first_layer_height + _lyr * layer_height
            # 为每层合成一次 0->0 换刀事件（用最小清洗体积驱动深度计算）
            _forced_wv = float(wipe_volume) if wipe_volume is not None else 30.0
            events = [ToolchangeEvent(_lyr, layer_z[_lyr], 0, 0, _forced_wv,
                                      is_first_layer=(_lyr == 0))
                      for _lyr in range(total_layers)]

        # 塔总高：最后一层事件 z + 层高（近似）
        max_z = max((ev.z for ev in events), default=layer_height)
        total_height = max(max_z + layer_height, first_layer_height)

        cfg = {
            'tower_x': tower_x, 'tower_y': tower_y,
            'tower_width': tower_cfg['tower_width'],
            'rotation_angle': tower_cfg['rotation_angle'],
            'nozzle_diameter': nozzle_diameter,
            'layer_height': layer_height,
            'first_layer_height': first_layer_height,
            'max_purge_speed': tower_cfg['max_purge_speed'],
            'infill_speed': params.get('inner_wall_speed', 300.0) if params else 300.0,
            'perimeter_speed': params.get('outer_wall_speed', 200.0) if params else 200.0,
            'travel_speed': params.get('travel_speed', 500.0) if params else 500.0,
            'first_layer_speed': params.get('initial_layer_speed', 25.0) if params else 25.0,
            'wipe_volume': wipe_volume,
            'events': events,
            'total_height': total_height,
            'layer_z': layer_z,
            'extra_flow': tower_cfg['extra_flow'],
            'extra_spacing_wipe': tower_cfg['extra_spacing_wipe'],
            'no_sparse_layers': tower_cfg['no_sparse_layers'],
            # 官方肋墙参数（从源 GCode wipe_tower_* 注释优先读取）
            'use_rib_wall': (tower_cfg['wall_type'] == 'rib'),
            'rib_width': tower_cfg['rib_width'],
            'extra_rib_length': tower_cfg['extra_rib_length'],
            'use_fillet': bool(getattr(Params, 'WipeTower_FilletWall', True)),
            'relative_e': bool(params.get('use_relative_e_distances', 0)) if params else False,
            'brim_width': tower_cfg['brim_width'],
        }
        plan = plan_tower(cfg)
        if plan is not None:
            print('[TowerPlan] 已规划擦嘴塔: 高={:.1f}mm 宽={:.1f}mm 深={:.1f}mm {}层换刀'.format(
                plan.height, plan.tower_width, plan.depth, len(events)))
        return plan
    except Exception as e:
        import traceback
        print('[TowerPlan] 擦嘴塔规划失败: {}'.format(e))
        traceback.print_exc()
        return None


# ============================================================
# GCode 参数提取 —— 从切片 gcode 中读取空驶速度/加速度/层高等关键参数
# ============================================================
def extract_gcode_params(gcode_path):
    """
    从切片生成的 GCode 文件中提取关键打印参数：
      - layer_height:        常规层高 (mm)
      - first_layer_height:  首层层高 (mm)
      - total_layers:        总层数
      - travel_speed:        空驶速度 (mm/s)，从 G1 旅行移动的 F 值推算
      - travel_accel:        空驶加速度 (mm/s^2)，从 SET_VELOCITY_LIMIT 中提取
      - inner_wall_speed:    内壁打印速度 (mm/s)
      - outer_wall_speed:    外壁打印速度 (mm/s)
      - total_print_distance: 估算总空驶距离 (mm)
      - total_e_distance:    总挤出距离 (mm)
    """
    params = {
        'layer_height': 0,
        'first_layer_height': 0,
        'total_layers': 0,
        'travel_speed': 0,         # 0 表示未从 footer 读到，之后用 G1 回退
        'travel_accel': 0,         # 同上
        'inner_wall_speed': 300,
        'outer_wall_speed': 200,
        'total_print_distance': 0,
        'total_travel_distance': 0,
        'total_e_distance': 0,
        'slicer_type': 'unknown',
        'wipe_tower_max_purge_speed': 0,
        'wipe_tower_width': 0,
        'prime_tower_width': 0,
        'prime_tower_brim_width': 0,
        'filament_minimal_purge_on_wipe_tower': 0,
        'wipe_tower_rotation_angle': 0,
        'wipe_tower_wall_type': '',
        'wipe_tower_rib_width': 0,
        'wipe_tower_extra_rib_length': 0,
        'wipe_tower_extra_flow': 0,
        'wipe_tower_extra_spacing': 0,
        'wipe_tower_no_sparse_layers': 0,
        'use_relative_e_distances': 0,
    }

    with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()

    # --- 遍历每一行提取参数 ---
    # 统计旅行移动 (F>=30000 的高速 G1 视为空驶)
    travel_f_min = 15000  # F值大于此视为空驶
    travel_f_values = []   # 收集所有旅行 F 值
    
    # 统计 SET_VELOCITY_LIMIT 中伴随旅行出现的加速度值
    travel_accel_values = []
    last_accel = 0
    total_x_movement = 0
    total_y_movement = 0
    total_e = 0
    total_travel_x = 0
    total_travel_y = 0
    last_x = None
    last_y = None
    last_e = 0
    current_f = 0       # 继承的当前进给速度

    for line in content.split('\n'):
        stripped = line.strip()

        # --- 从 header/footer 注释中读取参数 ---
        m = re.match(r';\s*layer_height\s*=\s*([\d.]+)', stripped)
        if m:
            params['layer_height'] = float(m.group(1))
        m = re.match(r';\s*first_layer_height\s*=\s*([\d.]+)', stripped)
        if m:
            params['first_layer_height'] = float(m.group(1))
        m = re.match(r';\s*travel_speed\s*=\s*([\d.]+)', stripped)
        if m:
            params['travel_speed'] = float(m.group(1))
        m = re.match(r';\s*travel_acceleration\s*=\s*([\d.]+)', stripped)
        if m:
            params['travel_accel'] = float(m.group(1))
        m = re.match(r';\s*outer_wall_speed\s*=\s*([\d.]+)', stripped)
        if m:
            params['outer_wall_speed'] = float(m.group(1))
        m = re.match(r';\s*inner_wall_speed\s*=\s*([\d.]+)', stripped)
        if m:
            params['inner_wall_speed'] = float(m.group(1))
        m = re.match(r';\s*wipe_tower_max_purge_speed\s*=\s*([\d.]+)', stripped)
        if m:
            params['wipe_tower_max_purge_speed'] = float(m.group(1))
        m = re.match(r';\s*wipe_tower_width\s*=\s*([\d.]+)', stripped)
        if m:
            params['wipe_tower_width'] = float(m.group(1))
        m = re.match(r';\s*prime_tower_width\s*=\s*([\d.]+)', stripped)
        if m:
            params['prime_tower_width'] = float(m.group(1))
        m = re.match(r';\s*prime_tower_brim_width\s*=\s*([\+\-]?\d+\.?\d*)', stripped)
        if m:
            params['prime_tower_brim_width'] = float(m.group(1))
        m = re.match(r';\s*filament_minimal_purge_on_wipe_tower\s*=\s*([\d.]+)', stripped)
        if m:
            params['filament_minimal_purge_on_wipe_tower'] = float(m.group(1))
        m = re.match(r';\s*wipe_tower_rotation_angle\s*=\s*([\+\-]?\d+\.?\d*)', stripped)
        if m:
            params['wipe_tower_rotation_angle'] = float(m.group(1))
        m = re.match(r';\s*wipe_tower_wall_type\s*=\s*(\S+)', stripped)
        if m:
            params['wipe_tower_wall_type'] = m.group(1).strip()
        m = re.match(r';\s*wipe_tower_rib_width\s*=\s*([\d.]+)', stripped)
        if m:
            params['wipe_tower_rib_width'] = float(m.group(1))
        m = re.match(r';\s*wipe_tower_extra_rib_length\s*=\s*([\+\-]?\d+\.?\d*)', stripped)
        if m:
            params['wipe_tower_extra_rib_length'] = float(m.group(1))
        m = re.match(r';\s*wipe_tower_extra_flow\s*=\s*([\d.]+)', stripped)
        if m:
            params['wipe_tower_extra_flow'] = float(m.group(1))
        m = re.match(r';\s*wipe_tower_extra_spacing\s*=\s*([\d.]+)', stripped)
        if m:
            params['wipe_tower_extra_spacing'] = float(m.group(1))
        m = re.match(r';\s*wipe_tower_no_sparse_layers\s*=\s*([01]|true|false)', stripped, re.IGNORECASE)
        if m:
            params['wipe_tower_no_sparse_layers'] = 1 if m.group(1).lower() in ('1', 'true') else 0
        m = re.match(r';\s*use_relative_e_distances\s*=\s*([01]|true|false)', stripped, re.IGNORECASE)
        if m:
            params['use_relative_e_distances'] = 1 if m.group(1).lower() in ('1', 'true') else 0
        if stripped == 'M83' or stripped.startswith('M83 '):
            params['use_relative_e_distances'] = 1
        elif stripped == 'M82' or stripped.startswith('M82 '):
            params['use_relative_e_distances'] = 0

        # ; total layer number: 135
        m = re.match(r';\s*total layer number\s*:?\s*(\d+)', stripped, re.IGNORECASE)
        if m:
            params['total_layers'] = int(m.group(1))

        # --- 从 gcode 命令中提取 ---
        if stripped == ';AFTER_LAYER_CHANGE':
            params['total_layers'] = max(params['total_layers'], 1)

        # 提取 SET_VELOCITY_LIMIT 中的加速度
        if 'SET_VELOCITY_LIMIT' in stripped:
            m = re.search(r'ACCEL=(\d+)', stripped)
            if m:
                last_accel = int(m.group(1))
            continue

        # 处理 G1/G0 移动
        if stripped.startswith('G1 ') or stripped.startswith('G0 '):
            x_val, y_val, e_val, f_val = None, None, None, None
            m = re.search(r'\bX\s*([\+\-]?\d+\.?\d*)', stripped)
            if m: x_val = float(m.group(1))
            m = re.search(r'\bY\s*([\+\-]?\d+\.?\d*)', stripped)
            if m: y_val = float(m.group(1))
            m = re.search(r'\bE\s*([\+\-]?\d+\.?\d*)', stripped)
            if m: e_val = float(m.group(1))
            m = re.search(r'\bF\s*(\d+)', stripped)
            if m:
                f_val = int(m.group(1))
                current_f = f_val

            # 纯 F 设置行（如 "G1 F30000"），只更新速度
            if x_val is None and y_val is None and e_val is None:
                continue

            # 累计 E（绝对挤出模式下 delta_e > 0 为正向挤出）
            if e_val is not None:
                delta_e = e_val - last_e
                if delta_e > 0:
                    total_e += delta_e
                last_e = e_val

            # 累计移动距离
            if x_val is not None:
                if last_x is None:
                    last_x = x_val
                    last_y = y_val if y_val is not None else x_val
                    continue
                dx = x_val - last_x
                dy = (y_val - last_y) if (y_val is not None and last_y is not None) else 0
                if abs(dx) < 500 and abs(dy) < 500:
                    dist = abs(dx) + abs(dy)
                    use_f = f_val if f_val else current_f
                    if use_f >= travel_f_min:
                        total_travel_x += abs(dx)
                        total_travel_y += abs(dy)
                        travel_f_values.append(use_f)
                        if last_accel >= 5000:
                            travel_accel_values.append(last_accel)
                    else:
                        total_x_movement += abs(dx)
                        total_y_movement += abs(dy)
                last_x = x_val
                if y_val is not None:
                    last_y = y_val

    # --- 计算统计值 ---
    params['total_e_distance'] = round(total_e, 1)
    params['total_travel_distance'] = round(total_travel_x + total_travel_y, 1)
    params['total_print_distance'] = round(total_x_movement + total_y_movement, 1)

    # 空驶速度 —— 优先取 footer 注释的权威值；若未读到则用 G1 移动中 F 的众数
    if not params['travel_speed'] and travel_f_values:
        from collections import Counter
        f_counter = Counter(travel_f_values)
        most_common_f = f_counter.most_common(1)[0][0]
        params['travel_speed'] = round(most_common_f / 60.0)  # mm/min → mm/s

    # 空驶加速度 —— 优先取 footer 注释的权威值；若未读到则用 G1 统计
    if not params['travel_accel'] and travel_accel_values:
        from collections import Counter
        accel_counter = Counter(travel_accel_values)
        most_common_accel = accel_counter.most_common(1)[0][0]
        params['travel_accel'] = most_common_accel

    # 若 footer 仍未提供，使用硬回退
    if not params['layer_height']:
        params['layer_height'] = 0.2
    if not params['first_layer_height']:
        params['first_layer_height'] = params['layer_height'] * 1.25
    if not params['travel_speed']:
        params['travel_speed'] = 500
    if not params['travel_accel']:
        params['travel_accel'] = 10000

    return params


def estimate_print_time(params, inkjet_speed=None):
    """
    基于提取的切片参数和喷墨速度估算总打印时长（秒）。
    inkjet_speed: 喷墨头打印速度 (mm/s), 来自前端喷墨参数设置
    返回 dict: { fdm_time_s, inkjet_time_s, total_time_s, total_time_str }
    """
    # FDM 打印时间估算
    # 打印移动时间 = print_distance / print_speed
    avg_print_speed = (params['inner_wall_speed'] + params['outer_wall_speed']) / 2.0
    fdm_print_time = params['total_print_distance'] / max(avg_print_speed, 1)
    
    # 空驶移动时间 = travel_distance / travel_speed
    fdm_travel_time = params['total_travel_distance'] / max(params['travel_speed'], 1)
    
    # 加减速时间加入 ~5% 开销
    fdm_time = (fdm_print_time + fdm_travel_time) * 1.05

    # 喷墨时间估算
    inkjet_time = 0
    if inkjet_speed and inkjet_speed > 0 and params['total_layers'] > 0:
        # 假设每层喷墨范围约等于模型打印距离（粗略估算）
        # 实际应由纹理切片输出决定，此处用每层近似行程
        inkjet_time = params['total_print_distance'] / inkjet_speed

    total_time = fdm_time + inkjet_time

    # 格式化成 HH:MM:SS
    hours = int(total_time // 3600)
    minutes = int((total_time % 3600) // 60)
    seconds = int(total_time % 60)

    return {
        'fdm_time_s': round(fdm_time, 1),
        'inkjet_time_s': round(inkjet_time, 1),
        'total_time_s': round(total_time, 1),
        'total_time_str': '{}:{:02d}:{:02d}'.format(hours, minutes, seconds),
        'total_layers': params['total_layers'],
    }


def params_to_json(params, est):
    """将参数和时长估算序列化为 JSON 字符串"""
    output = {
        'layer_height': params['layer_height'],
        'first_layer_height': params['first_layer_height'],
        'total_layers': params['total_layers'],
        'travel_speed': params['travel_speed'],
        'travel_accel': params['travel_accel'],
        'inner_wall_speed': params['inner_wall_speed'],
        'outer_wall_speed': params['outer_wall_speed'],
        'total_print_distance': params.get('total_print_distance', 0),
        'total_travel_distance': params.get('total_travel_distance', 0),
        'total_e_distance': params.get('total_e_distance', 0),
        'estimated_time': est['total_time_str'],
        'estimated_time_s': est['total_time_s'],
        'fdm_time_s': est['fdm_time_s'],
        'inkjet_time_s': est['inkjet_time_s'],
    }
    return json.dumps(output, ensure_ascii=False)


# ============================================================
# 擦嘴塔 GCode 模板（来自 cankao.py）
# ============================================================
TEMP_WIPING_GCODE = """
;Tower_Layer_Gcode
EXTRUDER_REFILL
G1 X20 Y10.19
NOZZLE_HEIGHT_ADJUST
G1 F9600
G1 X20 Y20 E.25658
G1 X29.81 Y20 E.25658
G1 E-.21 F5400
;WIPE_START
G1 F9600
G1 X28.81 Y20 E-.09
;WIPE_END
G1 X23.71 Y25.679 F30000
G1 X20 Y29.81
G1 E.3 F5400
G1 F9600
G1 X20 Y20 E.25658
G1 X10.19 Y20 E.25658
G1 E-.21 F5400
;WIPE_START
G1 F9600
G1 X11.19 Y20 E-.09
;WIPE_END
G1 X17.943 Y23.556 F30000
G1 X29.8 Y29.8
G1 X29.8 Y29.398
G1 E.3 F5400
G1 F9600
;START_HERE
G1 X10.602 Y29.398 E.60441
G1 X10.602 Y10.602 E.60441
G1 X29.398 Y10.602 E.60441
G1 X29.398 Y29.338 E.60248
G1 X29.79 Y29.79
G1 X10.21 Y29.79 E.58322
G1 X10.21 Y10.21 E.58322
G1 X29.79 Y10.21 E.58322
G1 X29.79 Y29.73 E.58143
;END_HERE
G92 E0
G1 E-.21 F5400
;WIPE_START
G1 F9600
G1 X28.8 Y29.762 E-.1
;WIPE_END
EXTRUDER_RETRACT
G1 X28.7 Y29.76
TOWER_ZP_ST
;Tower_Layer_Gcode Finished
"""


# ============================================================
# 擦嘴塔（Wipe Tower）后处理 —— 检测、延长、生成
# ============================================================

def detect_wipe_tower(gcode_path):
    """
    倒序扫描 GCode，找到最后一层 TYPE:Prime tower，提取其内容作为模板。
    同时统计已有塔覆盖层数，用于跳过已存在塔层。

    返回 result dict（字段见下方）。
    """
    with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
        lines = f.readlines()
    
    result = {
        'exists': False,
        'brim_layers': 0,
        'last_brim_z': 0.0,
        'last_brim_layer': 0,
        'last_brim_lines': [],
        'total_layers': 0,
        'layer_height': 0.2,
        'first_layer_height': 0.25,
        'max_z': 0.0,
        'brim_sections': [],
    }
    
    # 第一遍：正向扫描收集基础参数
    current_z = 0.0
    layer_num = 0
    for line in lines:
        s = line.strip()
        if 'total layer number' in s:
            nums = re.findall(r'\d+', s)
            if nums:
                result['total_layers'] = int(nums[0])
        if 'max_z_height' in s:
            nums = re.findall(r'[\d.]+', s)
            if nums:
                result['max_z'] = float(nums[0])
        if s.startswith(';Z:') or s.startswith('; Z:'):
            m = re.search(r'[\d.]+', s)
            if m:
                current_z = float(m.group())
                layer_num += 1
        if s.startswith(';HEIGHT:') or s.startswith('; HEIGHT:'):
            m = re.search(r'[\d.]+', s)
            if m:
                h = float(m.group())
                if h > 0.01:
                    if layer_num <= 1:
                        result['first_layer_height'] = h
                    else:
                        result['layer_height'] = h
    
    # 第二遍：倒序找最后一层 TYPE:Prime tower，并统计所有 Prime tower 层
    last_tower_start = -1
    last_tower_z = 0.0
    last_tower_layer = 0
    tower_layer_set = set()  # 避免重复计数
    current_z_rev = 0.0
    layer_num_rev = 0
    
    # 先正向扫一次收集 Z 映射
    z_at_line = {}
    layer_at_line = {}
    cz = 0.0
    ln = 0
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith(';Z:') or s.startswith('; Z:'):
            m = re.search(r'[\d.]+', s)
            if m:
                cz = float(m.group())
                ln += 1
        z_at_line[i] = cz
        layer_at_line[i] = ln
    
    for i in range(len(lines) - 1, -1, -1):
        s = lines[i].strip()
        if s == ';TYPE:Prime tower':
            # 记录这一层
            z = z_at_line.get(i, 0.0)
            lay = layer_at_line.get(i, 0)
            key = '{:.3f}'.format(z)
            if key not in tower_layer_set:
                tower_layer_set.add(key)
            if last_tower_start < 0:
                last_tower_start = i
                last_tower_z = z
                last_tower_layer = lay
    
    if last_tower_start < 0:
        # 无 TYPE:Prime tower，回退到 WIPE_TOWER_BRIM 检测
        for i in range(len(lines) - 1, -1, -1):
            if 'WIPE_TOWER_BRIM_START' in lines[i]:
                z = z_at_line.get(i, 0.0)
                lay = layer_at_line.get(i, 0)
                last_tower_start = i
                last_tower_z = z
                last_tower_layer = lay
                break
    
    if last_tower_start < 0:
        # 完全没有擦嘴塔
        return result
    
    result['exists'] = True
    result['brim_layers'] = len(tower_layer_set) if tower_layer_set else 1
    result['last_brim_z'] = last_tower_z
    result['last_brim_layer'] = last_tower_layer
    
    # 收集所有 BRIM 段的起止行号
    in_brim = False
    brim_start = -1
    for i, line in enumerate(lines):
        s = line.strip()
        if 'WIPE_TOWER_BRIM_START' in s:
            in_brim = True
            brim_start = i
        elif 'WIPE_TOWER_BRIM_END' in s and in_brim:
            result['brim_sections'].append({
                'start_line': brim_start,
                'end_line': i,
            })
            in_brim = False
    
    # 提取最后一层塔的全部内容：从 TYPE:Prime tower 或 BRIM_START 到层结束
    extract_start = last_tower_start
    # 如果启始于 BRIM_START，往前找到 TYPE:Prime tower
    if 'WIPE_TOWER_BRIM_START' in lines[last_tower_start]:
        for j in range(last_tower_start, -1, -1):
            if lines[j].strip() == ';TYPE:Prime tower':
                extract_start = j
                break
    
    # 提取到下一个 ;Z: 或文件末尾
    extract_end = len(lines)
    for j in range(extract_start, len(lines)):
        s = lines[j].strip()
        if (s.startswith(';Z:') or s.startswith('; Z:')) and j > extract_start + 10:
            extract_end = j
            break
    
    extracted = lines[extract_start:extract_end]
    result['last_brim_lines'] = extracted
    
    result['last_tower_line'] = extract_start
    
    print('[DetectTower] 倒序找到塔: 起始行{} Z={:.3f} 层#{}, 模板{}行, 共{}个Prime tower层'.format(
        extract_start + 1, last_tower_z, last_tower_layer,
        len(extracted), len(tower_layer_set) if tower_layer_set else 1))
    
    return result


# ---- 波浪塔 BRIM 模板缓存 ----
def load_wave_tower_brims(template_path=None):
    """
    返回每层完整波浪塔 GCode 模板。
    数据已硬编码在 _tower_templates.py 中，不再依赖外部 test1.gcode。

    返回 (all_layers, first_layer)：
        all_layers:  list of list of str，每层完整波浪塔 GCode 行
        first_layer: list of str，第一层（层数不够时的回退模板）
    """
    # 深拷贝防止外部修改（list of str 只需 shallow copy per layer）
    all_layers = [list(layer) for layer in WAVE_BRIM_ALL_LAYERS]
    first_layer = list(WAVE_BRIM_FIRST_LAYER) if WAVE_BRIM_FIRST_LAYER else []

    # 修补首层模板（Z=0.25 的简单方框）：E 排布错位
    if all_layers:
        first = all_layers[0]
        type_start = -1
        type_end = len(first)
        for i, line in enumerate(first):
            if line.strip() == ';TYPE:Prime tower':
                type_start = i + 2  # 跳过 ;TYPE:Prime tower 和 ;WIDTH:0.5
            if type_start >= 0 and line.strip() in (';--------------------', '; CP EMPTY GRID START'):
                type_end = i
                break

        if type_start >= 0:
            g1_lines = []
            for i in range(type_start, type_end):
                if first[i].startswith('G1') and ('X' in first[i] or 'Y' in first[i]):
                    g1_lines.append(i)

            if len(g1_lines) >= 4:
                travel_pairs = [
                    (g1_lines[0], g1_lines[-3]),
                    (g1_lines[1], g1_lines[-2]),
                ]
                for src, dst in travel_pairs:
                    e_match = re.search(r'\bE\s*([\+\-]?\d+\.?\d*)', first[src])
                    if e_match and 'E' in first[src]:
                        stolen_e = e_match.group(1)
                        first[src] = re.sub(r'\bE\s*[\+\-]?\d+\.?\d*', '', first[src]).rstrip()
                        if 'F' not in first[src]:
                            first[src] = first[src].rstrip() + ' F5400'
                        if 'E' not in first[dst]:
                            first[dst] = first[dst].rstrip() + ' E' + stolen_e

    return all_layers, first_layer


# ---- 方框 Prime tower + CP EMPTY GRID 模板 ----
# ---- 方框+EMPTY_GRID 硬编码模板（已废弃） ----
# _SQUARE_TOWER_TEMPLATE = [
#     ';TYPE:Prime tower',
#     ';WIDTH:0.5',
#     'G1  X65.767 Y220.846   F5400',
#     'G1  X48.267  E0.6651',
#     'G1  Y203.946  E0.6423',
#     'G1  X65.767  E0.6651',
#     'G1  Y220.846 E0.6423',
#     'G1  X64.767',
#     ';--------------------',
#     '; CP EMPTY GRID START',
#     '; layer #9',
#     'G1  Y203.946  E0.6423',
#     'G1  X57.017',
#     'G1  Y220.846  E0.6423',
#     'G1  X49.267',
#     'G1  Y203.946  E0.6423',
#     '; CP EMPTY GRID END',
# ]

# 预计算模板方框中心点（已废弃）
# _SQUARE_TEMPLATE_CENTROID = None


# （已废弃）方框中心计算，不再使用
# def _compute_line_centroid(lines):
#     """从 GCode 行中追踪 X/Y 状态并计算所有 G1 点的包围盒中心坐标。返回 (cx, cy)。
#     
#     使用包围盒中心而非点平均，避免路径点分布不均导致中心偏移。
#     """
#     xs, ys = [], []
#     cur_x, cur_y = None, None
#     for line in lines:
#         s = line.strip()
#         if s.startswith('G1 ') or s.startswith('G0 '):
#             xm = re.search(r'\bX\s*([\+\-]?\d+\.?\d*)', s)
#             ym = re.search(r'\bY\s*([\+\-]?\d+\.?\d*)', s)
#             if xm: cur_x = float(xm.group(1))
#             if ym: cur_y = float(ym.group(1))
#             if cur_x is not None: xs.append(cur_x)
#             if cur_y is not None: ys.append(cur_y)
#     if not xs:
#         return 0.0, 0.0
#     return (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0


# （已废弃）BRIM中心计算，不再使用
# def _compute_brim_centroid(lines):
#     """从 GCode 行中提取 WIPE_TOWER_BRIM 区域的包围盒中心。返回 (cx, cy)。
#     如果没找到 BRIM 标记，回退到整段包围盒中心。
#     """
#     xs, ys = [], []
#     cur_x, cur_y = None, None
#     in_brim = False
#     for line in lines:
#         s = line.strip()
#         if 'WIPE_TOWER_BRIM_START' in s:
#             in_brim = True
#             continue
#         if 'WIPE_TOWER_BRIM_END' in s:
#             break
#         if not in_brim:
#             continue
#         if s.startswith('G1 ') or s.startswith('G0 '):
#             xm = re.search(r'\bX\s*([\+\-]?\d+\.?\d*)', s)
#             ym = re.search(r'\bY\s*([\+\-]?\d+\.?\d*)', s)
#             if xm: cur_x = float(xm.group(1))
#             if ym: cur_y = float(ym.group(1))
#             if cur_x is not None: xs.append(cur_x)
#             if cur_y is not None: ys.append(cur_y)
#     if not xs:
#         # 回退：使用整段包围盒
#         return _compute_line_centroid(lines)
#     return (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0


# （已废弃）方框模板拆分，不再使用
# def _split_square_template(sq_template):
#     """将方框模板拆分为 (square_box_lines, empty_grid_lines)。
#     square_box: ;TYPE:Prime tower + rect walls + 分隔符
#     empty_grid: ; CP EMPTY GRID START ... ; CP EMPTY GRID END
#     如果模板中没有 EMPTY_GRID，则 empty_grid 为空。
#     """
#     empty_start = -1
#     empty_end = -1
#     for i, l in enumerate(sq_template):
#         s = l.strip()
#         if 'CP EMPTY GRID START' in s:
#             empty_start = i
#         elif 'CP EMPTY GRID END' in s:
#             empty_end = i
#             break
#     if empty_start < 0 or empty_end < 0:
#         return list(sq_template), []
#     square_box = sq_template[:empty_start]
#     empty_grid = sq_template[empty_start:empty_end + 1]
#     return square_box, empty_grid


def _extract_empty_grid_from_brim(brim_content):
    """从波浪 BRIM 内容中提取 EMPTY_GRID 段，返回 (cleaned, empty_grid)。
    cleaned 中不含 EMPTY_GRID 标记和其中的 GCode。
    如果 brim 中没有 EMPTY_GRID，则 empty_grid 为空，cleaned 为原内容。
    """
    empty_start = -1
    empty_end = -1
    for i, l in enumerate(brim_content):
        s = l.strip()
        if 'CP EMPTY GRID START' in s:
            empty_start = i
        elif 'CP EMPTY GRID END' in s:
            empty_end = i
            break
    if empty_start < 0 or empty_end < 0:
        return list(brim_content), []
    empty_grid = brim_content[empty_start:empty_end + 1]
    cleaned = brim_content[:empty_start] + brim_content[empty_end + 1:]
    return cleaned, empty_grid


def _detain_g1_e_in_text(macro_text):
    """扫描宏文本（可能包含多行）中的 G1 E 行，扣留 E 值。
    返回 (clean_text, detained_e_total)。
    G1 行中的 E{speed} 被 strip，其他内容保持不变。
    """
    lines = macro_text.split('\n')
    detained = 0.0
    clean_lines = []
    for line in lines:
        s = line.strip()
        m = re.match(r'^(G1\s+.*?)\bE\s*([\+\-]?\d+\.?\d*)(.*)', s, re.IGNORECASE)
        if m:
            detained += float(m.group(2))
            clean = (m.group(1) + m.group(3)).strip()
            clean_lines.append(clean)
        else:
            clean_lines.append(line)
    return '\n'.join(clean_lines), detained


def _first_g1_point(lines):
    """追踪 lines 中第一个有 X 和 Y 的 G1 点，返回 (x, y)。
    逐行追踪 X/Y 状态，直到两个坐标都有值。
    """
    cx, cy = None, None
    for line in lines:
        s = line.strip()
        if not (s.startswith('G1 ') or s.startswith('G0 ')):
            continue
        xm = re.search(r'\bX\s*([\+\-]?\d+\.?\d*)', s)
        ym = re.search(r'\bY\s*([\+\-]?\d+\.?\d*)', s)
        if xm: cx = float(xm.group(1))
        if ym: cy = float(ym.group(1))
        if cx is not None and cy is not None:
            return cx, cy
    return cx, cy


def _prepend_travel_and_prime(segment_lines, travel_speed=30000, prime_val=1.5, prime_speed=1800):
    """给一段 GCode（如 EMPTY_GRID）前置 travel 到起点 + prime。
    自动计算第一个 G1 点的 XY 坐标，添加 G0 travel 移动到该点，再加 prime。
    返回新的行列表。
    """
    if not segment_lines:
        return []
    x, y = _first_g1_point(segment_lines)
    result = []
    if x is not None and y is not None:
        result.append('G1 X{:.3f} Y{:.3f} F{}  ; travel to segment start'.format(x, y, travel_speed))
    elif x is not None:
        result.append('G1 X{:.3f} F{}  ; travel to segment start'.format(x, travel_speed))
    elif y is not None:
        result.append('G1 Y{:.3f} F{}  ; travel to segment start'.format(y, travel_speed))
    result.append('G1 E{} F{}  ; prime segment_unretract'.format(prime_val, prime_speed))
    result.extend(segment_lines)
    return result


# （已废弃）方框模板中心点，不再使用
# def get_square_template_centroid():
#     """返回硬编码方框模板的中心点（只算一次）。"""
#     global _SQUARE_TEMPLATE_CENTROID
#     if _SQUARE_TEMPLATE_CENTROID is None:
#         _SQUARE_TEMPLATE_CENTROID = _compute_line_centroid(_SQUARE_TOWER_TEMPLATE)
#     return _SQUARE_TEMPLATE_CENTROID


# （已废弃）加载方框模板，不再使用
# def load_square_prime_tower(template_path=None):
#     """
#     返回方框 TYPE:Prime tower + CP EMPTY GRID 模板。
#     数据已硬编码在源码中，不再依赖外部 test1.gcode。
#     template_path 参数保留以兼容旧调用方，实际忽略。
# 
#     返回 template_lines: list of str
#     """
#     # 直接返回硬编码模板（浅拷贝以防外部修改）
#     return list(_SQUARE_TOWER_TEMPLATE)


def extend_wipe_tower(gcode_path, output_path=None, wipe_speed=90,
                      default_layer_height=None, default_first_layer_height=None,
                      color_thickness=0.03):
    """
    延长擦嘴塔的外圈墙体，使其和打印零件等高。
    
    策略：
      1. 检测现有擦嘴塔，找到最后一层 BRIM
      2. 提取最后一层 BRIM 的外圈墙体 GCode
      3. 在每个后续层的 EMPTY_GRID 后面，插入该层的外圈墙体
      4. 不需要模拟换料，只复制外圈墙体的几何路径
    
    参数:
        gcode_path:  输入 GCode 文件路径
        output_path: 输出文件路径（默认原名 + _tower_extended）
    
    返回:
        输出文件路径
    """
    if not output_path:
        base, ext = os.path.splitext(gcode_path)
        output_path = base + '_tower_extended' + ext
    
    # 检测擦嘴塔
    tower_info = detect_wipe_tower(gcode_path)
    
    if not tower_info['exists']:
        print('[TowerExtend] 未检测到擦嘴塔，将从示范文件生成.')
        return _generate_tower_from_template(gcode_path, output_path, tower_info, wipe_speed=wipe_speed,
            override_layer_height=default_layer_height,
            override_first_layer_height=default_first_layer_height,
            color_thickness=color_thickness)
    
    print('[TowerExtend] 检测到擦嘴塔: {} 层 BRIM, 最后 BRIM Z={:.3f} (物理层{})'.format(
        tower_info['brim_layers'],
        tower_info['last_brim_z'],
        tower_info['last_brim_layer']))
    
    # 读取原始 gcode
    with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
        lines = f.readlines()
    
    # 倒序找到最后一个 ;TYPE:Prime tower（实际内容的塔，不是末尾 tool change stub）
    # stub 判断：后面 100 行内有 PRINT_END 且无 WIPE_TOWER_BRIM / CP EMPTY GRID
    last_tower_line = -1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip() == ';TYPE:Prime tower':
            has_print_end = False
            has_real_tower = False
            for j in range(i, min(i + 100, len(lines))):
                s = lines[j].strip()
                if 'PRINT_END' in s:
                    has_print_end = True
                    break
            for j in range(i, min(i + 100, len(lines))):
                s = lines[j].strip()
                if 'WIPE_TOWER_BRIM' in s or 'CP EMPTY GRID' in s:
                    has_real_tower = True
                    break
            if has_print_end and not has_real_tower:
                continue  # stub，跳过
            last_tower_line = i
            break
    
    if last_tower_line < 0:
        # 全是 stub，取最后一个
        for i in range(len(lines) - 1, -1, -1):
            if lines[i].strip() == ';TYPE:Prime tower':
                last_tower_line = i
                break
    
    # 提取最后一个塔的 Z
    last_tower_z = 0.0
    for i in range(last_tower_line, -1, -1):
        s = lines[i].strip()
        if s.startswith(';Z:') or s.startswith('; Z:'):
            m = re.search(r'[\d.]+', s)
            if m:
                last_tower_z = float(m.group())
                break
    
    # 提取最后一层完整的 TYPE:Prime tower 内容
    # 停止在下一个 ;Z:、; printing object（模型特征开始）、或非 Prime tower 的 ;TYPE: 处
    last_tower_content_start = last_tower_line
    last_tower_content_end = len(lines)
    for i in range(last_tower_line + 1, len(lines)):
        s = lines[i].strip()
        if (s.startswith(';Z:') or s.startswith('; Z:')) and i > last_tower_line + 5:
            last_tower_content_end = i
            break
        if ';MKPColor' in s:
            last_tower_content_end = i
            break
        if '; printing object' in s:
            last_tower_content_end = i
            break
        m = re.match(r';TYPE:\s*(.+)', s)
        if m and m.group(1).strip() != 'Prime tower' and m.group(1).strip() != 'Sparse infill':
            # 塔内可能有 Sparse infill 或 Internal solid infill（EMPTY_GRID），放过它们
            # 但遇到真实模型特征（Inner wall, Outer wall 等）则停止
            real_model_types = {'Inner wall', 'Outer wall', 'Bottom surface',
                               'Top surface', 'Support interface', 'Gap fill',
                               'Overhang wall', 'Skirt', 'Brim'}
            if m.group(1).strip() in real_model_types:
                last_tower_content_end = i
                break
    
    tower_template = [l.rstrip('\n') for l in lines[last_tower_content_start:last_tower_content_end]]
    
    print('[TowerExtend] 最后一层塔位于行{} Z={:.3f}, 模板{}行'.format(
        last_tower_line + 1, last_tower_z, len(tower_template)))
    
    # ---- 方框计算（已废弃） ----
    # target_brim_cx, target_brim_cy = _compute_brim_centroid(tower_template)
    # templ_cx, templ_cy = get_square_template_centroid()
    # square_dx = target_brim_cx - templ_cx
    # square_dy = target_brim_cy - templ_cy
    # square_template = load_square_prime_tower()
    # offset_square = _offset_brim_coordinates(square_template, square_dx, square_dy)
    # offset_square_box, offset_empty_grid = _split_square_template(offset_square)
    
    # 从目标塔模板中提取 EMPTY_GRID（如有）
    tower_wave_wall, tower_empty_grid = _extract_empty_grid_from_brim(tower_template)
    
    # 预生成 CP TOOLCHANGE WIPE 擦拭线
    # 优先从原始 gcode 解析既有 wipe block，保留原始 Y 坐标后二等分
    src_groups, src_y, src_lf, src_ln, src_rn, src_rf = _parse_wipe_groups_from_gcode(lines)
    if src_groups:
        print('[TowerExtend] 从原始 gcode 解析到 {} 组 wipe (起始Y={:.3f}), 进行二等分'.format(
            len(src_groups), src_y))
        cp_wipe_a, cp_wipe_b = _generate_cp_wipe_lines(
            0, 0,  # tower_x/y 在 source 模式下不使用
            source_wipe_groups=src_groups, source_start_y=src_y,
            source_x_lf=src_lf, source_x_ln=src_ln,
            source_x_rn=src_rn, source_x_rf=src_rf,
            wipe_speed=wipe_speed)
    else:
        tx, ty = load_tower_position()
        print('[TowerExtend] 未找到原始 wipe block，从配置位置 ({:.1f},{:.1f}) 生成'.format(tx, ty))
        cp_wipe_a, cp_wipe_b = _generate_cp_wipe_lines(tx, ty, wipe_speed=wipe_speed)

    # print('[TowerExtend] 目标BRIM中心=({:.2f},{:.2f}) 模板方框中心=({:.2f},{:.2f}) 方框偏移=({:.2f},{:.2f})'.format(
    #     target_brim_cx, target_brim_cy, templ_cx, templ_cy, square_dx, square_dy))
    
    # 扫描文件：在最后塔层之后，每个 ;Z: 后面插入模板
    output_lines = []
    i = 0
    extensions_added = 0
    active_tool = 0  # 追踪工具头
    
    while i < len(lines):
        line = lines[i]
        output_lines.append(line.rstrip('\n'))
        
        stripped = line.strip()
        
        # 追踪工具头切换
        tm = re.match(r'^T(\d+)$', stripped)
        if tm:
            active_tool = int(tm.group(1))
        tc_match = re.match(r';\s*Change\s+Tool\d+\s*->\s*Tool(\d+)', stripped)
        if tc_match:
            active_tool = int(tc_match.group(1))
        
        # 在最后塔层之后的每个层变更处插入塔模板
        if i > last_tower_line and (stripped.startswith(';Z:') or stripped.startswith('; Z:')):
            # 确认这包含一个有效的 Z 值（不是空行）
            m = re.search(r'[\d.]+', stripped)
            if m:
                insert_z = float(m.group())
                output_lines.append('')
                output_lines.append(';=== REPEATED TOWER LAYER (Z={:.2f}) ==='.format(insert_z))
                # 打印顺序: CP TOOLCHANGE WIPE → EMPTY_GRID → 波浪外墙
                # CP TOOLCHANGE WIPE 擦拭线（根据当前材料选对应的一半）
                cp_wipe = cp_wipe_a if active_tool % 2 == 0 else cp_wipe_b
                if cp_wipe:
                    output_lines.append('G92 E0')
                    output_lines.extend(cp_wipe)
                # EMPTY_GRID
                if tower_empty_grid:
                    output_lines.extend(_prepend_travel_and_prime(tower_empty_grid))
                # 波浪外墙（目标塔原有内容，去掉 EMPTY_GRID 的部分）
                output_lines.append('; WIPE_TOWER_BRIM_START')
                output_lines.append('G1 F{}'.format(wipe_speed * 60))
                for wl in tower_wave_wall:
                    output_lines.append(wl)
                output_lines.append('; WIPE_TOWER_BRIM_END')
                output_lines.append('G1 E-1.5 F1800 ; retract')
                output_lines.append('G92 E0')
                output_lines.append(';=== REPEATED TOWER LAYER END ===')
                output_lines.append('')
                extensions_added += 1
        
        i += 1
    
    print('[TowerExtend] 共插入了 {} 个重复塔层 (Z > {:.3f})'.format(extensions_added, last_tower_z))
    
    # 清除所有 ;WIPE_START ... ;WIPE_END 块（含其前的 G1 E- 回抽行）
    clean_output = []
    i = 0
    while i < len(output_lines):
        s = output_lines[i].strip()
        if s == ';WIPE_START':
            # 若前一条是 G1 E- 回抽，也一起删除
            if clean_output and clean_output[-1].strip().startswith('G1 E-'):
                clean_output.pop()
            # 跳过直到 ;WIPE_END
            i += 1
            while i < len(output_lines) and output_lines[i].strip() != ';WIPE_END':
                i += 1
            i += 1  # 跳过 ;WIPE_END
            continue
        clean_output.append(output_lines[i])
        i += 1
    output_lines = clean_output

    # 写入输出
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(output_lines))
    
    print('[TowerExtend] 输出文件: {}'.format(output_path))
    return output_path


def _generate_tower_from_template(gcode_path, output_path, tower_info, wipe_speed=90,
                                  override_layer_height=None, override_first_layer_height=None,
                                  color_thickness=0.03):
    """
    当 gcode 中不存在擦嘴塔时，从硬编码模板生成完整的擦嘴塔。
    
    参数:
        gcode_path:   输入 GCode 文件路径
        output_path:  输出文件路径
        tower_info:   detect_wipe_tower 的返回结果
    """
    # 使用硬编码的波浪 BRIM 层（不再读 test1.gcode）
    brim_layer_gcodes = [list(layer) for layer in WAVE_BRIM_ALL_LAYERS]
    if not brim_layer_gcodes:
        print('[TowerExtend] 无波浪塔模板数据, 无法生成')
        return gcode_path
    
    total_layers = tower_info['total_layers']
    # 层高：优先使用外部传入的原始值（如来自原始 GCode footer），
    # 避免被着色薄层修改后的 ;HEIGHT: 污染
    layer_height = override_layer_height if override_layer_height is not None else tower_info['layer_height']
    first_layer_height = override_first_layer_height if override_first_layer_height is not None else tower_info['first_layer_height']
    
    # 从目标 gcode 无法获取的，用模板默认值（首层0.25，常规0.2）
    if total_layers == 0:
        print('[TowerExtend] 无法获取总层数, 无法生成塔')
        return gcode_path
    if layer_height == 0:
        layer_height = 0.2
    if first_layer_height == 0:
        first_layer_height = 0.25
    
    print('[TowerExtend] 将生成 {} 层塔 (Z: {:.2f} ~ {:.2f})'.format(
        total_layers, first_layer_height,
        first_layer_height + (total_layers - 1) * layer_height))
    
    # 读取工具温度和耗材类型（用于换料前导段）
    tool_temps = _extract_tool_temps(gcode_path)
    filament_types = _extract_filament_types(gcode_path)
    
    # 构建输出：在每层 AFTER_LAYER_CHANGE 之后插入塔
    # 读取目标文件
    with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
        target_lines = f.readlines()
    
    # 计算波浪墙偏移（X/Y 均居中包裹 cpwipe）
    tmpl_ox, tmpl_oy = get_template_tower_origin()
    target_tx, target_ty = load_tower_position()
    # X 居中：cpwipe 中心 = target_tx + 15.5，模板中心 = tmpl_ox + 宽度/2
    _tmpl_cx = tmpl_ox + _TEMPLATE_TOWER_BRIM_WIDTH_X / 2
    _cpwipe_cx = target_tx + 15.5
    brim_dx = _cpwipe_cx - _tmpl_cx
    # Y 居中：让 BRIM 居中包裹 cpwipe（cpwipe 从 target_ty 向下延伸 20mm）
    _tmpl_cy = tmpl_oy + _TEMPLATE_TOWER_BRIM_HEIGHT_Y / 2
    _cpwipe_cy = target_ty - 10
    brim_dy = _cpwipe_cy - _tmpl_cy
    
    # 方框（已废弃）
    # sq_template = load_square_prime_tower()
    # sq_offset = _offset_brim_coordinates(sq_template, brim_dx, brim_dy)
    # sq_box, sq_empty = _split_square_template(sq_offset)
    
    # E 缩放（传入原始层高，避免被着色薄层的 ;HEIGHT: 污染）
    e_scale_first, e_scale_regular = get_e_scale(gcode_path,
        first_layer_height=first_layer_height, layer_height=layer_height)
    
    # 预生成 CP TOOLCHANGE WIPE 擦拭线
    cp_wipe_a, cp_wipe_b = _generate_cp_wipe_lines(target_tx, target_ty, wipe_speed=wipe_speed)
    
    output_lines = []
    current_z = 0.0
    layer_num = 0
    tower_layer_idx = 0
    active_tool = 0  # 追踪工具头
    
    for i, line in enumerate(target_lines):
        output_lines.append(line.rstrip('\n'))
        stripped = line.strip()
        
        # 追踪 Z
        if stripped.startswith(';Z:') or stripped.startswith('; Z:'):
            m = re.search(r'[\d.]+', stripped)
            if m:
                current_z = float(m.group())
                layer_num += 1

        # 追踪工具头切换
        tm = re.match(r'^T(\d+)$', stripped)
        if tm:
            active_tool = int(tm.group(1))
        tc_match = re.match(r';\s*Change\s+Tool\d+\s*->\s*Tool(\d+)', stripped)
        if tc_match:
            active_tool = int(tc_match.group(1))
        
        # 在 AFTER_LAYER_CHANGE 后插入塔
        if stripped == ';AFTER_LAYER_CHANGE':
            # 选择 BRIM 模板层：优先用最后一层，前面用对应的层
            if tower_layer_idx < len(brim_layer_gcodes):
                brim_gcode = brim_layer_gcodes[tower_layer_idx]
            else:
                brim_gcode = brim_layer_gcodes[-1]
            
            tower_z = first_layer_height + tower_layer_idx * layer_height
            if tower_layer_idx == 0:
                tower_z = first_layer_height
            
            # E 缩放 + 坐标偏移
            lh_scale = e_scale_first if tower_layer_idx == 0 else e_scale_regular
            offset_brim = _offset_brim_coordinates(brim_gcode, brim_dx, brim_dy)
            scaled_brim = _scale_e_in_lines(offset_brim, lh_scale)
            # scaled_sq_box = _scale_e_in_lines(sq_box, lh_scale)  # 方框（已废弃）
            # scaled_sq_empty = _scale_e_in_lines(sq_empty, lh_scale)  # 方框（已废弃）
            
            # 拆分 brim 中的 EMPTY_GRID
            wave_wall, brim_empty = _extract_empty_grid_from_brim(scaled_brim)
            
            output_lines.append('')
            output_lines.append(';=== GENERATED TOWER LAYER {} (Z={:.3f}) ==='.format(
                tower_layer_idx + 1, tower_z))
            
            # 换料前导段（对齐官方 demo）
            preamble = _generate_wipe_toolchange_preamble(
                target_tx, target_ty, tower_z,
                active_tool, active_tool,
                filament_types, tool_temps, tower_layer_idx + 1,
                wipe_speed=wipe_speed)
            output_lines.extend(preamble)
            # 塔层高注释（使用标准层高，确保预览正确）
            output_lines.append(';HEIGHT:{:.3f}'.format(layer_height))
            
            # 打印顺序: CP TOOLCHANGE WIPE → EMPTY_GRID → 波浪外墙
            # CP TOOLCHANGE WIPE 擦拭线（根据当前材料选对应的一半）
            cp_wipe = cp_wipe_a if active_tool % 2 == 0 else cp_wipe_b
            if cp_wipe:
                output_lines.append('G92 E0')
                output_lines.extend(cp_wipe)
            # EMPTY_GRID
            if brim_empty:
                output_lines.extend(_prepend_travel_and_prime(brim_empty))
            # 波浪外墙
            output_lines.append('G92 E0')
            output_lines.append('; WIPE_TOWER_BRIM_START')
            output_lines.append('G1 F{}'.format(wipe_speed * 60))
            for wl in wave_wall:
                output_lines.append(wl)
            output_lines.append('; WIPE_TOWER_BRIM_END')
            output_lines.append('G1 E-1.5 F1800 ; retract')
            output_lines.append('G92 E0')
            output_lines.append(';=== GENERATED TOWER LAYER {} END ==='.format(tower_layer_idx + 1))
            # 塔层 HEIGHT 为名义层高，结束后的常规内容需恢复有效层高
            output_lines.append(';HEIGHT:{:.3f}'.format(layer_height - color_thickness))
            output_lines.append('')
            
            tower_layer_idx += 1
    
    print('[TowerExtend] 共生成 {} 层塔'.format(tower_layer_idx))
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(output_lines))
    
    print('[TowerExtend] 输出文件: {}'.format(output_path))
    return output_path


# ============================================================
# 工具函数
# ============================================================
def num_strip(s):
    """从字符串中提取数字（int 或 float）"""
    s = s.strip()
    # 匹配科学记数法和普通浮点数
    m = re.search(r'[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?', s)
    if m:
        val = m.group()
        return float(val) if '.' in val or 'e' in val.lower() else int(val)
    return None


def process_gcode_offset(gcommand, x_offset, y_offset, z_offset, mode):
    """
    对 GCode 命令进行坐标偏移和挤出量处理
    参考 cankao.py Process_GCode_Offset
    mode: 'tower' - 塔模式，应用塔挤出比例和 Z 偏移
    """
    # 去掉已有的 F 值避免重复
    cmd = re.sub(r'\s+F\s*\d+', '', gcommand).strip()
    
    def apply_offsets(m):
        axis = m.group(1)
        val = float(m.group(2))
        if axis == 'X':
            val += x_offset
            return 'X' + format_value(val)
        elif axis == 'Y':
            val += y_offset
            return 'Y' + format_value(val)
        elif axis == 'Z':
            val += z_offset
            return 'Z' + format_value(val)
        elif axis == 'E':
            if mode == 'tower':
                val *= Params.Tower_Extrude_Ratio
            return 'E' + format_value(val)
        return m.group(0)
    
    def format_value(v):
        """保留合适精度"""
        if abs(v - round(v, 3)) < 0.0001:
            return '{:.3f}'.format(v)
        return '{:.6f}'.format(v)
    
    result = re.sub(r'([XYZE])([+-]?\d*\.?\d+)', apply_offsets, cmd)
    return result


def build_tower_layer_output(wiping_gcode_lines, tower_x, tower_y, curr_z_height):
    """
    根据塔模板生成一层的塔 GCode
    参考 cankao.py 中 AFTER_LAYER_CHANGE 的塔输出逻辑
    """
    output = []
    x_off = tower_x - 5  # 偏移使塔中心对齐 Wiper_x, Wiper_y（塔模板中心在 X=20, Y=20）
    y_off = tower_y - 5
    
    for line in wiping_gcode_lines:
        line = line.strip()
        if not line:
            continue
            
        if line.startswith('G1 F9600'):
            # 替换为实际塔速度
            output.append('G1 F{}'.format(Params.WipeTower_Print_Speed))
        elif line == 'TOWER_ZP_ST':
            # 跳过占位符
            continue
        elif line == 'NOZZLE_HEIGHT_ADJUST':
            output.append('G1 Z{:.3f}'.format(curr_z_height))
        elif line == 'EXTRUDER_REFILL':
            output.append('G92 E0')
            output.append('G1 E{:.5f}'.format(Params.Retract_Length))
            output.append('G92 E0')
        elif line == 'EXTRUDER_RETRACT':
            output.append('G92 E0')
            ret = Params.Retract_Length - 0.31
            if ret < 0:
                ret = 0
            output.append('G1 E-{:.5f}'.format(ret))
            output.append('G92 E0')
        elif line.startswith('G1') or line.startswith('G0'):
            output.append(process_gcode_offset(line, x_off, y_off, 0, 'tower'))
        else:
            output.append(line)
    
    return output


# ============================================================
# 纹理 GCODE 分层解析
# ============================================================
def load_inkjet_layers(inkjet_path):
    """
    读取纹理切片产生的 GCODE 文件，按层分割
    返回 dict: {layer_num: [gcode_lines]}
    图层索引匹配规则：
      ;LAYER:N  表示第 N 层（从 1 开始）
    """
    if not inkjet_path or not os.path.exists(inkjet_path):
        return {}
    
    with open(inkjet_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    layers = {}
    # 按 ;LAYER: 分割
    parts = re.split(r'(;LAYER:\s*\d+)', content)
    
    current_layer = 0
    for part in parts:
        part = part.strip()
        if not part:
            continue
        m = re.match(r';LAYER:\s*(\d+)', part)
        if m:
            current_layer = int(m.group(1))
            layers.setdefault(current_layer, [])
        elif current_layer > 0:
            lines = part.split('\n')
            for line in lines:
                line = line.strip()
                if line and not line.startswith(';'):
                    layers[current_layer].append(line)
    
    return layers


def _expand_macro(macro_text, current_z):
    """将宏文本中的特殊标记替换为实际 GCode：
    ZUPADJUST      → G1 Z{current_z + 62.9}  （抬起取喷墨头）
    ZDOWNADJUST    → G1 Z{current_z}         （降到当前层高）
    ZRESTOREADJUST → G1 Z{current_z + 3}     （恢复到当前层+3）
    """
    tokens = {
        'ZUPADJUST': 'G1 Z{:.3f} F2000'.format(current_z + 62),
        'ZDOWNADJUST': 'G1 Z{:.3f} F2000'.format(current_z),
        'ZRESTOREADJUST': 'G1 Z{:.3f} F2000'.format(current_z + 3),
    }
    result = macro_text
    for token, replacement in tokens.items():
        result = result.replace(token, replacement)
    return result


# ============================================================
# 主处理逻辑
# ============================================================

def _extract_tool_temps(gcode_path):
    """从 G-code 头部读取 nozzle_temperature = a,b,c,d，返回 list。默认 [250,230,220,220]"""
    defaults = [250.0, 230.0, 220.0, 220.0]
    try:
        with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                m = re.match(r';\s*nozzle_temperature\s*=\s*([\d\.,\s]+)', line.strip())
                if m:
                    vals = [float(x.strip()) for x in m.group(1).split(',') if x.strip()]
                    if len(vals) >= 2:
                        return vals
    except Exception:
        pass
    return defaults


def _parse_wipe_groups_from_gcode(lines, start_index=0):
    """从 GCode 行列表中解析第一个 CP TOOLCHANGE WIPE 块，提取 wipe groups。

    返回 (groups, start_y, x_lf, x_ln, x_rn, x_rf)
      - groups: [[line, line, line, line], ...]  每4条G1为一组
      - start_y: prime 中的起始 Y 坐标
      - x_lf/x_ln/x_rn/x_rf: 从第一组推断的 X 边界值

    若未找到有效的 wipe block，返回 (None, None, None, None, None, None)。
    """
    # 找到 ; CP TOOLCHANGE WIPE 起始行
    wipe_start = -1
    for i in range(start_index, len(lines)):
        if lines[i].strip() == '; CP TOOLCHANGE WIPE':
            wipe_start = i
            break
    if wipe_start < 0:
        return None, None, None, None, None, None

    # 提取 wipe block 内所有 G1 行（跳过 M73 等杂行），直到 footer
    g1_lines = []
    start_y = None
    for i in range(wipe_start + 1, len(lines)):
        s = lines[i].strip()
        # footer 行：G1 X... F7200（无 E）
        if 'F7200' in s.upper() and s.upper().startswith('G1') and 'E' not in s:
            break
        if s.startswith('G1'):
            g1_lines.append(s)
            # 从第二条 G1（prime 第二行）提取起始 Y
            if start_y is None and len(g1_lines) == 2:
                m = re.search(r'Y\s*([\d.]+)', s)
                if m:
                    start_y = float(m.group(1))

    if len(g1_lines) < 6 or start_y is None:
        return None, None, None, None, None, None

    # 去除 prime 前两行，剩余的 G1 按 4 行一组切分
    body_lines = g1_lines[2:]
    groups = []
    for gi in range(0, len(body_lines) - 3, 4):
        groups.append(body_lines[gi:gi + 4])

    if not groups:
        return None, None, None, None, None, None

    # 从第一二组收集所有 X 值，排序后识别 x_lf/x_ln/x_rn/x_rf
    def _extract_x(line):
        m = re.search(r'X\s*([\d.]+)', line)
        return float(m.group(1)) if m else None

    all_x = sorted(set(
        x for g in groups[:2] for line in g
        if (x := _extract_x(line)) is not None
    ))
    if len(all_x) >= 3:
        x_lf = all_x[0]    # 最小 = left far (13.25)
        x_ln = all_x[1]    # 次小 = left near (14.0)
        x_rn = all_x[-2]   # 次大 = right near (37.0)
        x_rf = all_x[-1]   # 最大 = right far (37.75)
    elif len(all_x) == 2:
        x_lf, x_ln = all_x[0], all_x[1]
        x_rn, x_rf = x_ln + 23.0, x_ln + 23.75
    else:
        x_lf = x_ln = 0
        x_rn, x_rf = 23.0, 23.75

    return groups, start_y, x_lf, x_ln, x_rn, x_rf


def _group_end_y(g):
    """从一个 group (4 行 GCode) 的最后一行提取终点 Y。"""
    for line in reversed(g):
        m = re.search(r'Y\s*([\d.]+)', line)
        if m:
            return float(m.group(1))
    return None


def _extract_filament_types(gcode_path):
    """从 G-code 头部读取 filament_type = a,b,c,d，返回 list of str。默认 4x PLA。"""
    defaults = ['PLA', 'PLA', 'PLA', 'PLA']
    try:
        with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                m = re.match(r';\s*filament_type\s*=\s*([\w,]+)', line.strip())
                if m:
                    vals = [x.strip().upper() for x in m.group(1).split(',') if x.strip()]
                    if vals:
                        return vals
    except Exception:
        pass
    return defaults


def _generate_wipe_toolchange_preamble(tower_x, tower_y, current_z,
                                       old_tool, new_tool,
                                       filament_types, tool_temps, layer_num,
                                       wipe_speed=90):
    """生成完整擦嘴塔换料前导段，对齐官方 demo 结构。
    返回 list of str（不含末尾换行）。
    """
    from datetime import datetime as _dt
    _ds = _dt.now().strftime('%Y%m%d')
    out = []

    old_fil = filament_types[old_tool] if old_tool < len(filament_types) else 'PLA'
    new_fil = filament_types[new_tool] if new_tool < len(filament_types) else 'PLA'
    old_temp = tool_temps[old_tool] if old_tool < len(tool_temps) else 210
    new_temp = tool_temps[new_tool] if new_tool < len(tool_temps) else 210

    purge_speed = wipe_speed * 60  # mm/s -> mm/min

    # 坐标（对齐 demo 偏移量）
    unload_x = tower_x + 3.75
    unload_y = tower_y - 4.65
    purge_x = tower_x + 8.86
    purge_up_y = tower_y - 3.9
    post_tc_x = tower_x + 8.86
    post_tc_y = tower_y - 4.4
    wipe_start_y = tower_y - 10.0

    out.append('')
    out.append(';TYPE:Prime tower')
    out.append(';WIDTH:0.5')
    out.append(';--------------------')

    if old_tool == new_tool:
        out.append('; WIPE_TOWER_START')
        out.append('M220 B')
        out.append('M220 S100')
        out.append('G1 F21000')
        out.append('G90')
        out.append('G1  X{:.3f} Y{:.3f}'.format(post_tc_x, post_tc_y))
        out.append('G1 Z{:.3f} F30000'.format(current_z))
        out.append('G4 S0')
        return out

    out.append('; CP TOOLCHANGE START')
    out.append('; toolchange #{}'.format(layer_num))
    out.append('; material : {} -> {}'.format(old_fil, new_fil))
    out.append(';--------------------')
    out.append('; WIPE_TOWER_START')
    out.append('M220 B')
    out.append('M220 S100')

    # CP TOOLCHANGE UNLOAD
    out.append('; CP TOOLCHANGE UNLOAD')
    out.append(';WIDTH:1')
    out.append('G1  X{:.3f} Y{:.3f}  F30000'.format(unload_x, unload_y))
    out.append('SET_PRESSURE_ADVANCE ADVANCE=0.0200')
    out.append('G1 F{}'.format(purge_speed))
    out.append('G1  X{:.3f}  E0.2079'.format(purge_x))
    out.append(';WIDTH:0.5')
    out.append('G1  Y{:.3f}  F2400'.format(purge_up_y))
    out.append('G4 S0')
    out.append('G1 E-10 F1800')

    # 冷却旧喷嘴
    out.append('M104 S80 T{} ; set nozzle temperature ;cooldown'.format(old_tool))

    # 工具切换
    out.append(';===== date: {}====================='.format(_ds))
    out.append('; Change Tool{} -> Tool{} (layer {})'.format(old_tool, new_tool, layer_num))
    out.append('G91')
    out.append('G1 Z1.5')
    out.append('G90')
    out.append('G1 F21000')
    out.append('')
    out.append('; {}'.format(new_tool))
    out.append('M109 S{} T{}'.format(int(new_temp), new_tool))
    out.append('M400')
    out.append('M106 S255')
    out.append('M106 P2 S178')
    out.append('T{}'.format(new_tool))
    out.append('SM_PRINT_PREEXTRUDE_FILAMENT INDEX={}'.format(new_tool))
    out.append('G90')
    out.append('G1  X{:.3f} Y{:.3f}'.format(post_tc_x, post_tc_y))
    out.append('G1 Z{:.3f} F30000'.format(current_z))
    out.append('G4 S0')
    out.append('M106 P2 S178')
    out.append('M106 S255')
    out.append('M104 S{} T{} ; set nozzle temperature'.format(int(new_temp), new_tool))

    return out


def _generate_cp_wipe_lines(tower_x, tower_y, wipe_len_mm=20.0, y_step_mm=0.5,
                            source_wipe_groups=None, source_start_y=None,
                            source_x_lf=None, source_x_ln=None,
                            source_x_rn=None, source_x_rf=None,
                            wipe_speed=90):
    """生成 CP TOOLCHANGE WIPE 擦拭线（zigzag 水平线，4线一组）。

    模仿 Bambu/Orca 的 ; CP TOOLCHANGE WIPE 模式：
    Group A: L→R overshoot right → diagonal R edge → R→L → Y step down
    Group B: L→R → Y step down → R→L overshoot left → diagonal L edge

    公平二等分：在原始 wipe Y 区间内部按中点切分，
    上半区 → half_a，下半区 → half_b，两半都不超出原始范围。
    各半自带 prime 定位到正确的起始 Y。

    参数：
        tower_x, tower_y: 擦嘴塔左下角坐标（source 模式下不使用）
        wipe_len_mm:      擦拭 Y 方向总长度 (mm)
        y_step_mm:        单步步进 (mm)，默认 0.5，每组 = 2*y_step_mm
    返回 (wipe_half_a, wipe_half_b): 公平二等分的擦拭线，分别用于不同材料。
        若传入 source_wipe_groups，则直接使用解析好的 groups（Y 坐标保持原始值）。
    """
    # ── 确定 groups 和坐标参数 ──
    if source_wipe_groups is not None:
        groups = source_wipe_groups
        y_start = source_start_y
        x_lf, x_ln, x_rn, x_rf = source_x_lf, source_x_ln, source_x_rn, source_x_rf
    else:
        x_lf = tower_x + 3.25   # left far
        x_ln = tower_x + 4.00   # left near
        x_rn = tower_x + 27.00  # right near
        x_rf = tower_x + 27.75  # right far
        y_start = tower_y
        group_y = 2.0 * y_step_mm  # 每组覆盖的 Y 距离

        # ── 构建所有 group ──
        groups = []  # list of [4 gcode lines]
        y = y_start
        remaining = wipe_len_mm
        group_type = 0  # 0=Group A, 1=Group B, 交替

        while remaining >= group_y - 0.001:
            group = []
            y1 = y - y_step_mm
            y2 = y - group_y

            if group_type == 0:
                group.append('G1 X{:.3f} E0.4725'.format(x_rf))
                group.append('G1 X{:.3f} Y{:.3f} E0.0179'.format(x_rn, y1))
                group.append('G1 X{:.3f} E0.4576'.format(x_ln))
                group.append('G1 Y{:.3f} E0.0099'.format(y2))
            else:
                group.append('G1 X{:.3f} E0.4576'.format(x_rn))
                group.append('G1 Y{:.3f} E0.0099'.format(y1))
                group.append('G1 X{:.3f} E0.4725'.format(x_lf))
                group.append('G1 X{:.3f} Y{:.3f} E0.0179'.format(x_ln, y2))

            groups.append(group)
            y = y2
            remaining -= group_y
            group_type = 1 - group_type

    if not groups:
        return [], []

    # ── 计算整个 wipe 的 Y 终点，确定中点 ──
    y_end = _group_end_y(groups[-1])
    if y_end is None:
        y_end = y_start - len(groups) * 1.0
    y_mid = (y_start + y_end) / 2.0

    # ── 按 Y 中点二等分：上半区 Y >= y_mid，下半区 Y < y_mid ──
    groups_a = []
    groups_b = []
    for g in groups:
        ey = _group_end_y(g)
        if ey is not None and ey < y_mid:
            groups_b.append(g)
        else:
            groups_a.append(g)

    # half_a 起始 Y = y_start
    # half_b 起始 Y = groups_b 第一个 group 的起始 Y
    if groups_b:
        # 从首个 group 的第1行推断起始Y（group 覆盖两个 0.5mm 步进，起始Y = endY + 1.0）
        b_start_y = _group_end_y(groups_b[0])
        if b_start_y is not None:
            b_start_y = b_start_y + 1.0
        else:
            b_start_y = y_mid
    else:
        b_start_y = y_mid

    # ── 构建 header/footer ──
    header = ['; CP TOOLCHANGE WIPE', ';WIDTH:0.5']
    footer = [
        'G1 X{:.3f} F30000'.format(x_rn),
        ';WIDTH:0.5',
        '; WIPE_TOWER_END',
        'M220 R',
        'G4 S0',
        'G92 E0',
        '; CP TOOLCHANGE END',
    ]

    def _make_half(grps, start_y):
        """构建一个 self-contained 半区 wipe block：
        header → travel(无E) → prime(有E) → groups → footer"""
        result = list(header)
        # 空驶到起始位（无挤出）
        result.append('G1 X{:.3f} Y{:.3f} F30000'.format(x_lf, start_y))
        # 限速擦嘴塔打印速度
        result.append('G1 F{}'.format(wipe_speed * 60))
        # prime: 预挤出 + 定位
        result.append('G1 X{:.3f} E0.3758'.format(x_lf))
        result.append('G1 X{:.3f} Y{:.3f} E0.0179'.format(x_ln, start_y))
        for g in grps:
            result.extend(g)
        result.extend(footer)
        return result

    half_a = _make_half(groups_a, y_start) if groups_a else []
    half_b = _make_half(groups_b, b_start_y) if groups_b else []

    return half_a, half_b


# ============================================================
# 多工具 WIPE 重分配：当擦嘴塔 + ≥3 工具时，将 wipe 等分为 N 份
# ============================================================
def _redistribute_multi_tool_wipes(lines, wipe_speed=90):
    """
    后处理 wipe 线：当检测到擦嘴塔 + ≥3 种工具时，
    将每个 CP TOOLCHANGE WIPE 块按工具数等分，
    每个工具头换头后使用自己的 1/N 部分。

    返回: (modified_lines, was_redistributed)
    """
    # 1. 检测擦嘴塔
    has_tower = any('WIPE_TOWER_BRIM_START' in l for l in lines)
    if not has_tower:
        return lines, False

    # 2. 统计使用的工具数量
    tools_used = set()
    for l in lines:
        m = re.match(r'^T(\d+)$', l.strip())
        if m:
            tools_used.add(int(m.group(1)))
        m = re.match(r';\s*Change\s+Tool\d+\s*->\s*Tool(\d+)', l.strip())
        if m:
            tools_used.add(int(m.group(1)))

    if len(tools_used) < 3:
        return lines, False

    num_tools = len(tools_used)
    print('[WipeRedist] 检测到 {} 个工具 + 擦嘴塔，将 WIPE 等分为 {} 份'.format(num_tools, num_tools))

    # 3. 解析第一个完整 CP TOOLCHANGE WIPE 的全部 groups
    src_groups, src_y, src_lf, src_ln, src_rn, src_rf = _parse_wipe_groups_from_gcode(lines)
    if not src_groups:
        print('[WipeRedist] 无法解析 WIPE groups，跳过重分配')
        return lines, False

    # 4. 计算 Y 范围，等分为 N 份
    y_end = _group_end_y(src_groups[-1])
    if y_end is None:
        y_end = src_y - len(src_groups) * 1.0
    y_range = src_y - y_end
    part_range = y_range / num_tools

    # 按 group 终点 Y 分配到 N 个部分
    parts = [[] for _ in range(num_tools)]
    for g in src_groups:
        ey = _group_end_y(g)
        if ey is None:
            continue
        # ey 从大往小: ey >= src_y - (i+1)*part_range -> part i
        part_idx = min(int((src_y - ey) / part_range), num_tools - 1)
        parts[part_idx].append(g)

    print('[WipeRedist] WIPE groups: 共 {} 组, 分配到 {} 份 = {}'.format(
        len(src_groups), num_tools, [len(p) for p in parts]))

    # 5. 为每个 part 构建独立的 wipe block
    header = ['; CP TOOLCHANGE WIPE', ';WIDTH:0.5']
    footer = [
        'G1 X{:.3f} F30000'.format(src_rn if src_rn else 0),
        ';WIDTH:0.5',
        '; WIPE_TOWER_END',
        'M220 R',
        'G4 S0',
        'G92 E0',
        '; CP TOOLCHANGE END',
    ]

    def _make_part(grps, start_y):
        if not grps:
            return []
        result = list(header)
        result.append('G1 X{:.3f} Y{:.3f} F30000'.format(src_lf, start_y))
        result.append('G1 F{}'.format(wipe_speed * 60))
        result.append('G1 X{:.3f} E0.3758'.format(src_lf))
        result.append('G1 X{:.3f} Y{:.3f} E0.0179'.format(src_ln, start_y))
        for g in grps:
            result.extend(g)
        result.extend(footer)
        return result

    # 计算每个 part 的起始 Y
    part_start_y = []
    for p in parts:
        if p:
            ey = _group_end_y(p[0])
            part_start_y.append(ey + 1.0 if ey is not None else src_y)
        else:
            part_start_y.append(src_y)

    wipe_parts = [_make_part(parts[i], part_start_y[i]) for i in range(num_tools)]

    # 工具排序映射: Tool index -> part index
    sorted_tools = sorted(tools_used)
    tool_to_part = {t: i for i, t in enumerate(sorted_tools)}
    print('[WipeRedist] 工具->分区映射: {}'.format(tool_to_part))

    # 6. 辅助：从 wipe 前找到目标工具
    def _find_dest_tool_before_wipe(wipe_idx):
        for j in range(wipe_idx - 1, max(wipe_idx - 50, -1), -1):
            s2 = lines[j].strip()
            m2 = re.match(r';\s*Change\s+Tool\d+\s*->\s*Tool(\d+)', s2)
            if m2:
                return int(m2.group(1))
            m2 = re.match(r'^T(\d+)$', s2)
            if m2:
                return int(m2.group(1))
        return 0

    # 7. 遍历 gcode，替换所有 CP TOOLCHANGE WIPE 块，并在 RESUME_TOOL 后插入 wipe
    output = []
    i = 0
    replacements = 0

    while i < len(lines):
        s = lines[i].strip()

        if s.startswith('; RESUME_TOOL Tool'):
            output.append(lines[i].rstrip('\n'))
            m = re.match(r';\s*RESUME_TOOL\s+Tool(\d+)', s)
            if m:
                resumed_tool = int(m.group(1))
                part_idx = tool_to_part.get(resumed_tool, resumed_tool % num_tools)
                if wipe_parts[part_idx]:
                    output.extend(wipe_parts[part_idx])
            i += 1
            continue

        if s == '; CP TOOLCHANGE WIPE':
            dest_tool = _find_dest_tool_before_wipe(i)
            part_idx = tool_to_part.get(dest_tool, dest_tool % num_tools)

            # 跳过整个 wipe block 直到 ; CP TOOLCHANGE END
            wipe_end = -1
            for j in range(i, min(i + 300, len(lines))):
                if lines[j].strip() == '; CP TOOLCHANGE END':
                    wipe_end = j
                    break

            if wipe_parts[part_idx]:
                output.extend(wipe_parts[part_idx])
                replacements += 1

            i = wipe_end + 1 if wipe_end >= 0 else i + 1
            continue

        output.append(lines[i].rstrip('\n'))
        i += 1

    print('[WipeRedist] 共替换 {} 个 WIPE 块'.format(replacements))
    return output, True


def process_gcode(gcode_path, inkjet_path=None, output_path=None, params=None, est=None,
                   grab_macro=None, release_macro=None, inkjet_layers=None,
                   inkjet_speed=None, mbrush_ip=None, debug_mode=False,
                   repeat_count=1, dry_time=3,
                   fake_inkjet=False):
    """
    主处理函数：
      1. 读取 GCode
      2. 每层 AFTER_LAYER_CHANGE 后插入：取喷墨头 → 墨水 GCODE → 放回喷墨头 → 擦嘴塔
      3. 输出新的 GCode

    擦嘴塔逻辑（波浪花纹，始终启用）：
      - 若输入 gcode 已有 BRIM 塔 → 检测最后一层，复用其 BRIM 逐层堆叠到等高
      - 若输入 gcode 无 BRIM 塔 → 从 test1.gcode 学习模板并逐层生成

    参数：
        inkjet_path:   墨水层 GCode 文件路径（兼容旧调用）
        inkjet_layers: 墨水层 dict {layer_num: [gcode_lines]}（优先于 inkjet_path）
        debug_mode:     输出到 _debug 子目录
    """
    if not output_path:
        base, ext = os.path.splitext(gcode_path)
        output_path = base + '_output' + ext

    # Debug 模式：输出到 _debug 子目录
    if debug_mode:
        src_dir = os.path.dirname(os.path.abspath(gcode_path))
        debug_dir = os.path.join(src_dir, '_debug')
        os.makedirs(debug_dir, exist_ok=True)
        output_path = os.path.join(debug_dir, os.path.basename(output_path))
        print('[GCodeGenerator] DEBUG 模式: 输出到 {}'.format(output_path))
    
    if params is None:
        params = extract_gcode_params(gcode_path)
    if est is None:
        est = estimate_print_time(params)

    # 读取取出/放回宏（优先传参，其次从 JSON 配置）
    _cfg_grab, _cfg_release = load_grab_release_macros()
    if grab_macro is None:
        grab_macro = _cfg_grab
    if release_macro is None:
        release_macro = _cfg_release

    print('[GCodeGenerator] 读取源文件: {}'.format(gcode_path))
    with open(gcode_path, 'r', encoding='utf-8') as f:
        source_lines = f.readlines()

    # 擦嘴塔规划（Orca WipeTower2 移植）：一次性构建整塔深度/块布局
    tower_plan = _build_tower_plan(gcode_path, source_lines, params,
                                   _extract_tool_temps(gcode_path),
                                   _extract_filament_types(gcode_path))
    
    # 加载纹理墨水层 GCODE（优先用 inkjet_layers dict，其次从文件读）
    if inkjet_layers is not None:
        print('[GCodeGenerator] 使用内存中的墨水层数据 ({} 层)'.format(len(inkjet_layers)))
    elif inkjet_path:
        print('[GCodeGenerator] 加载纹理墨水层: {}'.format(inkjet_path))
        inkjet_layers = load_inkjet_layers(inkjet_path)
    elif fake_inkjet:
        print('[GCodeGenerator] DEBUG: 伪造墨水层数据')
        fake_key_count = params.get('total_layers', 100) * 2  # 足够多
        inkjet_layers = {i: ['; FAKE INKJET LAYER'] for i in range(fake_key_count)}
    else:
        print('[GCodeGenerator] 无墨水层数据')
        inkjet_layers = {}
    
    # ============================================================
    # 波浪塔预处理：检测输入 gcode 是否已有 BRIM 塔
    #   有 → 取最后一层 BRIM 作为模板
    #   无 → 从 test1.gcode 学习完整 BRIM 模板集
    #   并计算坐标偏移使塔位置与配置一致
    # ============================================================
    tower_info = detect_wipe_tower(gcode_path)
    wave_brims = []       # 全体 BRIM 模板（无塔时需要）
    last_brim_lines = []  # 最后一层 BRIM（有塔时复用）
    brim_offset_dx = 0.0  # BRIM 坐标 X 偏移
    brim_offset_dy = 0.0  # BRIM 坐标 Y 偏移
    # square_offset_dx = 0.0  # 方框坐标 X 偏移（已废弃）
    # square_offset_dy = 0.0  # 方框坐标 Y 偏移（已废弃）
    # square_tower = []     # 方框+EMPTY_GRID 模板（已废弃）
    
    # 读取源 GCode 中的塔配置（fallback 到前端 JSON）
    source_tower_cfg = _tower_config_from_source(source_lines, params)
    config_tower_x = source_tower_cfg['tower_x']
    config_tower_y = source_tower_cfg['tower_y']
    config_tower_width = source_tower_cfg['tower_width']
    config_tower_rotation = source_tower_cfg['rotation_angle']
    print('[WaveTower] 使用擦嘴塔参数: x={:.3f}, y={:.3f}, width={:.3f}, rot={:.3f}, wall={}'.format(
        config_tower_x, config_tower_y, config_tower_width,
        config_tower_rotation, source_tower_cfg['wall_type']))
    
    # 读取擦嘴塔最大 purge 速度
    _wipe_speed = source_tower_cfg['max_purge_speed']

    # 读取工具温度和耗材类型（用于换料前导段）
    tool_temps = _extract_tool_temps(gcode_path)
    filament_types = _extract_filament_types(gcode_path)

    # 预生成 CP TOOLCHANGE WIPE 擦拭线（优先从原始 gcode 解析，保留真实 Y 后二等分）
    src_g, src_y, src_lf, src_ln, src_rn, src_rf = _parse_wipe_groups_from_gcode(source_lines)
    if src_g:
        cp_wipe_a, cp_wipe_b = _generate_cp_wipe_lines(
            0, 0,
            source_wipe_groups=src_g, source_start_y=src_y,
            source_x_lf=src_lf, source_x_ln=src_ln,
            source_x_rn=src_rn, source_x_rf=src_rf,
            wipe_speed=_wipe_speed)
    else:
        cp_wipe_a, cp_wipe_b = _generate_cp_wipe_lines(config_tower_x, config_tower_y, wipe_speed=_wipe_speed)

    # 追踪当前活跃的工具头（用于材料切换时的擦拭拆分）
    active_tool = 0

    if tower_info['exists']:
        # 已有塔：提取最后一层 BRIM（去掉 START/END 标记）
        for line in tower_info['last_brim_lines']:
            s = line.strip()
            if 'WIPE_TOWER_BRIM_START' not in s and 'WIPE_TOWER_BRIM_END' not in s:
                last_brim_lines.append(line.rstrip('\n'))
        print('[WaveTower] 检测到已有 BRIM 塔: {} 层, 最后 Z={:.3f}, 最后一层 BRIM {} 行'.format(
            tower_info['brim_layers'], tower_info['last_brim_z'], len(last_brim_lines)))
        # 方框已废弃
        # square_tower = load_square_prime_tower()
        # if last_brim_lines:
        #     target_cx, target_cy = _compute_line_centroid(last_brim_lines)
        #     tmpl_cx, tmpl_cy = get_square_template_centroid()
        #     square_offset_dx = target_cx - tmpl_cx
        #     square_offset_dy = target_cy - tmpl_cy
        #     print('[WaveTower] 方框中心点对齐: ...')
    else:
        # 无塔：从模板学习
        wave_brims, _ = load_wave_tower_brims()
        if not wave_brims:
            print('[WaveTower] 错误: 无法加载波浪塔模板，跳过擦嘴塔生成')
        else:
            # 计算偏移：X/Y 均居中包裹 cpwipe
            tmpl_x, tmpl_y = get_template_tower_origin()
            # X 居中：cpwipe 中心 = config_tower_x + 15.5，模板中心 = tmpl_x + 宽度/2
            _tmpl_cx = tmpl_x + _TEMPLATE_TOWER_BRIM_WIDTH_X / 2
            _cpwipe_cx = config_tower_x + 15.5
            brim_offset_dx = _cpwipe_cx - _tmpl_cx
            # Y 居中：让 BRIM 居中包裹 cpwipe（cpwipe 从 config_tower_y 向下延伸 20mm）
            _tmpl_cy = tmpl_y + _TEMPLATE_TOWER_BRIM_HEIGHT_Y / 2
            _cpwipe_cy = config_tower_y - 10
            brim_offset_dy = _cpwipe_cy - _tmpl_cy
            # 方框（已废弃）
            # square_offset_dx = brim_offset_dx
            # square_offset_dy = brim_offset_dy
            print('[WaveTower] 从模板学习到 {} 层 BRIM，偏移 ({:+.1f}, {:+.1f})'.format(
                len(wave_brims), brim_offset_dx, brim_offset_dy))
        # 方框已废弃
        # square_tower = load_square_prime_tower()
    
    # 从已提取的切片参数中读取层高（由 extract_gcode_params 从 GCode 注释 ; layer_height / ; first_layer_height 提取）
    _layer_height = params.get('layer_height', 0.2) if params else 0.2
    _first_layer_height = params.get('first_layer_height', 0.25) if params else 0.25

    # E 缩放因子：模板 (0.4喷嘴, 0.25层高) → 目标 (实际喷嘴, 实际层高)
    e_scale_first, e_scale_regular = get_e_scale(gcode_path, params)
    
    # 状态跟踪
    current_layer = 0
    current_z = 0.0
    total_layer_count = 0
    typical_height = _layer_height
    tower_layer_count = 0
    curr_max_tower_height = _first_layer_height
    first_inkjet = True  # 首次喷墨前需要冲洗喷嘴
    true_layer_seq = -1  # 抓取喷墨头计数（从 0000 开始，拿一次递增一次）
    last_fan_s = None     # 监察原 G-code 的 M106 S 值
    last_fan_p2_s = None  # 监察原 G-code 的 M106 P2 S 值
    
    output_lines = []
    pending_coating_lines = []  # 涂布内容延迟到模型打印完成后再插入
    _print_end_seen = False  # PRINT_END 后所有行已截留输出，跳过后续迭代
    
    for idx, line in enumerate(source_lines):
        if _print_end_seen:
            continue
        stripped = line.strip()
        
        # 检测总层数（从 header 中提取）
        if stripped.startswith('; total layer number:') or stripped.startswith('; total layer number :'):
            nums = re.findall(r'\d+', stripped)
            if nums:
                total_layer_count = int(nums[0])
        
        # 检测 Z 高度
        if stripped.startswith(';Z:') or stripped.startswith('; Z:'):
            m = re.search(r'[\d.]+', stripped)
            if m:
                current_z = float(m.group())
        
        # 检测层号（从 SET_PRINT_STATS_INFO CURRENT_LAYER 提取）
        # 兼容 OrcaSlicer（分两行）和 Snapmaker Orca（TOTAL_LAYER + CURRENT_LAYER 同行）两种格式
        if 'CURRENT_LAYER' in stripped:
            m = re.search(r'CURRENT_LAYER\s*=\s*(\d+)', stripped)
            if m:
                current_layer = int(m.group(1))
        
        # 检测总层数（从 SET_PRINT_STATS_INFO TOTAL_LAYER 提取）
        if 'SET_PRINT_STATS_INFO TOTAL_LAYER' in stripped:
            m = re.search(r'TOTAL_LAYER\s*=\s*(\d+)', stripped)
            if m:
                total_layer_count = int(m.group(1))
        
        # 监察风扇速度（取喷墨头宏会 M106 S0 / M106 P2 S0，放回后需恢复）
        if stripped.startswith('M106'):
            if 'P2' in stripped:
                m = re.search(r'S(\d+(?:\.\d+)?)', stripped)
                if m:
                    last_fan_p2_s = m.group(1)
            else:
                m = re.search(r'S(\d+(?:\.\d+)?)', stripped)
                if m:
                    last_fan_s = m.group(1)

        # 追踪工具头切换（用于 CP TOOLCHANGE WIPE 材料拆分）
        tm = re.match(r'^T(\d+)$', stripped)
        if tm:
            active_tool = int(tm.group(1))
        tc_match = re.match(r';\s*Change\s+Tool\d+\s*->\s*Tool(\d+)', stripped)
        if tc_match:
            active_tool = int(tc_match.group(1))
        
        # ---- AFTER_LAYER_CHANGE 处理 ----
        # 插入顺序: AFTER_LAYER_CHANGE → 上传 → 取喷墨头 → 纹理GCODE → 放回喷墨头 → 擦嘴塔
        # 擦嘴塔在喷墨之后：喷墨可能弄脏喷嘴，擦完再进入下一层模型打印
        if stripped == ';AFTER_LAYER_CHANGE':
            # 保留原 AFTER_LAYER_CHANGE 行（GCode 预览依赖此标记识别层边界）
            output_lines.append(line.rstrip('\n'))
            _coating_buf_start = len(output_lines)  # 涂布内容起始位置（将延迟到模型打印完再输出）
            # 拿一次喷墨头就递增一次，从 0000 开始
            next_seq = true_layer_seq + 1
            
            # 判断是否为"真层"：Z 值等于 首层层高 + 序号*常规层高 才算真实打印层
            # 支撑/填充等可能用不同层高，这些层不输出喷墨宏
            expected_z = _first_layer_height + next_seq * typical_height
            if abs(current_z - expected_z) > 0.001:
                print('  跳过 (支撑/填充), Z={:.3f} ≠ 预期={:.3f}'.format(current_z, expected_z))
                continue
            
            true_layer_seq = next_seq
            
            inkjet_key = true_layer_seq
            
            print('  处理第 {} 层, Z={:.3f} ...'.format(inkjet_key, current_z))
            
            # 展开宏中的特殊标记（ZUPADJUST / ZDOWNADJUST / ZRESTOREADJUST）
            expanded_grab = _expand_macro(grab_macro, current_z)
            expanded_release = _expand_macro(release_macro, current_z)
            
            # 扣留放回宏中的 G1 E（空驶到塔位置后再输出）
            expanded_release, detained_e_release = _detain_g1_e_in_text(expanded_release)
            if detained_e_release > 0.001:
                print('  放回宏扣留 E={:.4f}'.format(detained_e_release))
            
            layer_tag = 'layer_{:04d}'.format(inkjet_key)
            
            # ========== 1. 上传（前置于其他操作，供托盘监控预下载）==========
            # 无额外操作，upload 指令已嵌入纹理 GCODE 内部
            
            # ========== 2. 取喷墨头 ==========
            output_lines.append('')
            output_lines.append(';=== GRAB INKJET HEAD ===')

            # 首次喷墨前：冲洗喷嘴（长按清洗）
            if first_inkjet:
                first_inkjet = False
                output_lines.append(';=== NOZZLE CLEAN ===')
                output_lines.append('G4 P2000  ; 等待喷嘴冲洗 2 秒')
                output_lines.append('')

            output_lines.append(expanded_grab)

            # ========== 3. 插入纹理切片 GCODE ==========
            if inkjet_key in inkjet_layers:
                output_lines.append(';=== TEXTURE INKJET LAYER {} ==='.format(inkjet_key))
                for ink_line in inkjet_layers[inkjet_key]:
                    output_lines.append(ink_line)
            else:
                output_lines.append(';=== NO INKJET DATA FOR LAYER {} ==='.format(inkjet_key))
            
            # ========== 重复喷墨（喷墨头保持取出状态，不重复取放）==========
            for _rep in range(1, repeat_count):
                output_lines.append('')
                output_lines.append(';=== REPEAT INKJET PASS {}/{} ==='.format(_rep + 1, repeat_count))
                output_lines.append('M106 P2 S255  ; 风扇全开（吹干墨水）')
                output_lines.append('G1 X251 F30000  ; 躲风位-靠边')
                output_lines.append('G1 Y150 F30000  ; 躲风位-沿边走')
                output_lines.append('G1 Y20 F30000  ; 躲风位-进入')
                output_lines.append('G4 P{}  ; 等待 {} 秒'.format(dry_time * 1000, dry_time))
                output_lines.append('M106 P2 S0  ; 关闭风扇')
                output_lines.append('G1 Y150 F30000  ; 躲风位-退出')
                output_lines.append('')
                if inkjet_key in inkjet_layers:
                    output_lines.append(';=== TEXTURE INKJET LAYER {} ==='.format(inkjet_key))
                    for ink_line in inkjet_layers[inkjet_key]:
                        output_lines.append(ink_line)
                else:
                    output_lines.append(';=== NO INKJET DATA FOR LAYER {} ==='.format(inkjet_key))

            # ========== 4. 放回喷墨头（所有喷墨结束后）==========
            output_lines.append(expanded_release)
            output_lines.append(';=== RELEASE INKJET HEAD ===')

            # ========== 5. 擦嘴塔（喷墨后清理喷嘴，为下一层模型做准备）==========
            # 强制擦嘴塔：每层都出塔；由 _build_tower_plan 在无换刀时合成 per-layer 事件
            tower_flag = True
            if tower_plan:
                planned_layers = {ld.layer for ld in tower_plan.layers}
                # 强制：即使 planned_layers 漏层也仍出塔（兜底到强制出塔语义）
                tower_flag = (inkjet_key in planned_layers) or True
            else:
                # 兜底：tower_plan 未能构建时，用波浪模板确保仍出塔（不阻断后续塔代码分支）
                tower_flag = True
            suggested_lh = 0.65 * Params.Nozzle_Diameter
            if suggested_lh < typical_height:
                suggested_lh = typical_height
            if curr_max_tower_height + suggested_lh < current_z:
                curr_max_tower_height += suggested_lh
            elif curr_max_tower_height < current_z:
                curr_max_tower_height = current_z

            if tower_flag:
                tower_layer_count += 1

                output_lines.append('')
                output_lines.append(';=== WIPE TOWER LAYER {} ==='.format(tower_layer_count))
                # 塔层高度注释必须在塔内任何移动/挤出之前，供预览器正确分层。
                output_lines.append(';HEIGHT:{:.3f}'.format(typical_height))

                # ---- 塔前导段：真实换刀才卸/装料；同工具只定位到塔入口 ----
                preamble = _generate_wipe_toolchange_preamble(
                    config_tower_x, config_tower_y, current_z,
                    active_tool, active_tool,  # MKPColorPLA 同工具
                    filament_types, tool_temps, tower_layer_count,
                    wipe_speed=_wipe_speed)
                output_lines.extend(preamble)

                # ---- 打印顺序: CP TOOLCHANGE WIPE → 外墙 ----
                has_any_content = False
                if tower_plan is None:
                    # 兜底：规划失败仍强制出塔（波浪模板，外墙+EMPTY_GRID，居中到配置点）
                    _tw_fb = float(config_tower_width or getattr(Params, 'Tower_Width', None) or 20.0)
                    _td_fb = 20.0
                    _rot_fb = float(config_tower_rotation or 0.0)
                    _ctx, _cty = config_tower_x, config_tower_y
                    # 波浪外墙模板取最后一层作为兜底外墙
                    try:
                        _brims_fb, _ = load_wave_tower_brims()
                        _brim_fb = list(_brims_fb[-1]) if _brims_fb else []
                        if _brim_fb:
                            tmpl_ox, tmpl_oy = get_template_tower_origin()
                            _tmpl_cx = tmpl_ox + _TEMPLATE_TOWER_BRIM_WIDTH_X / 2
                            _cpwipe_cx = config_tower_x + 15.5
                            _brim_dx = _cpwipe_cx - _tmpl_cx
                            _tmpl_cy = tmpl_oy + _TEMPLATE_TOWER_BRIM_HEIGHT_Y / 2
                            _cpwipe_cy = config_tower_y - 10
                            _brim_dy = _cpwipe_cy - _tmpl_cy
                            lh_scale = e_scale_first if tower_layer_count == 1 else e_scale_regular
                            offset_brim = _offset_brim_coordinates(_brim_fb, _brim_dx, _brim_dy)
                            scaled_brim = _scale_e_in_lines(offset_brim, lh_scale)
                            wave_wall, brim_empty = _extract_empty_grid_from_brim(scaled_brim)
                            if brim_empty:
                                output_lines.extend(_prepend_travel_and_prime(brim_empty))
                                has_any_content = True
                            if wave_wall:
                                output_lines.append('G92 E0')
                                output_lines.append('; WIPE_TOWER_BRIM_START')
                                output_lines.append('G1 F{}'.format(_wipe_speed * 60))
                                output_lines.extend(wave_wall)
                                output_lines.append('; WIPE_TOWER_BRIM_END')
                                has_any_content = True
                    except Exception as _e:
                        print('[TowerFallback] 波浪模板兜底失败: {}'.format(_e))
                    # 若模板仍无内容，至少给一个参数化矩形外墙
                    if not has_any_content:
                        from _tower_plan import TowerPlan as _TP
                        _fb_plan = _TP(
                            tower_x=config_tower_x, tower_y=config_tower_y,
                            tower_width=_tw_fb, rotation_angle=_rot_fb,
                            nozzle_diameter=float(Params.Nozzle_Diameter),
                            layer_height=typical_height, first_layer_height=typical_height,
                            perimeter_width=float(Params.Nozzle_Diameter) * 1.25,
                            max_purge_speed=_wipe_speed,
                            infill_speed=300.0, perimeter_speed=200.0, travel_speed=500.0,
                            first_layer_speed=25.0, height=current_z + typical_height, depth=_td_fb)
                        _fb_plan.extra_flow = 1.0
                        _fb_plan.extra_spacing_wipe = 1.0
                        try:
                            _wl = generate_finish_layer_wall(_fb_plan, None, tower_layer_count == 1)
                            output_lines.append('G92 E0')
                            output_lines.extend(_transform_tower_lines(_wl, _ctx, _cty, _rot_fb))
                            has_any_content = True
                        except Exception as _e2:
                            print('[TowerFallback] 矩形外墙兜底失败: {}'.format(_e2))
                else:
                    # 正常：参数化塔（Orca 移植，波浪外墙 + CP WIPE 保留）
                    layer_ld = next((ld for ld in tower_plan.layers if ld.layer == inkjet_key), None)
                    rotation = getattr(tower_plan, 'rotation_angle', 0.0) or 0.0
                    _tw = getattr(tower_plan, 'tower_width', 0.0) or 0.0
                    _td = getattr(tower_plan, 'depth', 0.0) or 0.0
                    center_tx = getattr(tower_plan, 'tower_x', config_tower_x)
                    center_ty = getattr(tower_plan, 'tower_y', config_tower_y)
                    tower_local_offset = getattr(tower_plan, 'rib_offset', (0.0, 0.0)) or (0.0, 0.0)

                    # CP TOOLCHANGE WIPE 擦拭线（Orca toolchange_Wipe，参数化生成，保留）
                    depth_consumed = 0.0
                    real_toolchanges = ([ev for ev in layer_ld.tool_changes
                                         if ev.old_tool != ev.new_tool]
                                        if layer_ld else [])
                    if real_toolchanges:
                        is_first = layer_ld.is_first
                        for ev in real_toolchanges:
                            wipe_lines, used = generate_toolchange_wipe(
                                tower_plan, ev, {}, is_first, fill_box=False, depth_consumed=depth_consumed)
                            depth_consumed += used
                            if wipe_lines:
                                output_lines.append('G92 E0')
                                output_lines.extend(_transform_tower_lines(
                                    wipe_lines, center_tx, center_ty, rotation,
                                    local_offset=tower_local_offset))
                                has_any_content = True
                    else:
                        depth_consumed = 0.0
                        is_first = (layer_ld.is_first if layer_ld else (tower_layer_count == 1))
                        clean_lines = generate_no_toolchange_cross(tower_plan, is_first)
                        if clean_lines:
                            output_lines.append('G92 E0')
                            output_lines.extend(_transform_tower_lines(
                                clean_lines, center_tx, center_ty, rotation,
                                local_offset=tower_local_offset))
                            has_any_content = True

                    # 稀疏/实心填充（CP EMPTY GRID，若 tower_writer 未提供则波浪模板 EMPTY_GRID 兜底由外墙段承载）
                    try:
                        infill_lines = generate_finish_layer_infill(
                            tower_plan, layer_ld, is_first if layer_ld else (tower_layer_count == 1),
                            toolchange_depth_consumed=depth_consumed)
                        if infill_lines:
                            output_lines.append('G92 E0')
                            output_lines.extend(_transform_tower_lines(
                                infill_lines, center_tx, center_ty, rotation,
                                local_offset=tower_local_offset))
                            has_any_content = True
                    except Exception as _e3:
                        print('[Tower] infill 生成失败: {}'.format(_e3))

                    # 外墙：官方肋墙（WipeTower::rib_section + rounding_polygon），带斜肋波浪感
                    # 自家 WAVE_BRIM 仅作异常兜底
                    try:
                        _is_first_wall = (layer_ld.is_first if layer_ld else (tower_layer_count == 1))
                        wall_lines = generate_finish_layer_wall(
                            tower_plan, layer_ld, _is_first_wall)
                        output_lines.append('G92 E0')
                        output_lines.extend(_transform_tower_lines(
                            wall_lines, center_tx, center_ty, rotation,
                            local_offset=tower_local_offset))
                        has_any_content = True
                    except Exception as _e4:
                        print('[Tower] 官方肋墙失败，回退波浪模板: {}'.format(_e4))
                        try:
                            _is_first_wall = (layer_ld.is_first if layer_ld else (tower_layer_count == 1))
                            _brims_all, _ = load_wave_tower_brims()
                            if _brims_all:
                                _idx = 0 if _is_first_wall else (tower_layer_count - 1) % len(_brims_all)
                                _brim_tpl = list(WAVE_BRIM_FIRST_LAYER) if (_is_first_wall and WAVE_BRIM_FIRST_LAYER) else list(_brims_all[_idx])
                                tmpl_ox, tmpl_oy = get_template_tower_origin()
                                _brim_dx = (config_tower_x + 15.5) - (tmpl_ox + _TEMPLATE_TOWER_BRIM_WIDTH_X / 2)
                                _brim_dy = (config_tower_y - 10) - (tmpl_oy + _TEMPLATE_TOWER_BRIM_HEIGHT_Y / 2)
                                lh_scale = e_scale_first if _is_first_wall else e_scale_regular
                                offset_brim = _offset_brim_coordinates(_brim_tpl, _brim_dx, _brim_dy)
                                scaled_brim = _scale_e_in_lines(offset_brim, lh_scale)
                                wave_wall, _brim_empty = _extract_empty_grid_from_brim(scaled_brim)
                                if wave_wall:
                                    output_lines.append('G92 E0')
                                    output_lines.append('; WIPE_TOWER_BRIM_START')
                                    output_lines.append('G1 F{}'.format(_wipe_speed * 60))
                                    output_lines.extend(wave_wall)
                                    output_lines.append('; WIPE_TOWER_BRIM_END')
                                    has_any_content = True
                                    if _brim_empty:
                                        output_lines.extend(_prepend_travel_and_prime(_brim_empty))
                                else:
                                    raise ValueError('wave_wall 为空')
                            else:
                                raise ValueError('WAVE_BRIM 模板为空')
                        except Exception as _e5:
                            print('[Tower] 波浪模板兜底也失败: {}'.format(_e5))

                if not has_any_content:
                    output_lines.append('; 无塔数据，跳过')

                output_lines.append('G1 E-1.5 F1800  ; retract after tower')
                output_lines.append(';WIPE_START')
                output_lines.append('G1 E-.3 F1800')
                output_lines.append(';WIPE_END')
                output_lines.append(';=== WIPE TOWER LAYER {} END ==='.format(tower_layer_count))
            
            # 恢复风扇（取喷墨头宏关闭了风扇）
            if last_fan_s is not None:
                output_lines.append('M106 S{}  ; restore fan after inkjet'.format(last_fan_s))
            if last_fan_p2_s is not None:
                output_lines.append('M106 P2 S{}  ; restore aux fan after inkjet'.format(last_fan_p2_s))
            
            output_lines.append('')
            # 涂布内容延迟到模型打印完成后（下一个 LAYER_CHANGE 前）再插入
            pending_coating_lines.extend(output_lines[_coating_buf_start:])
            del output_lines[_coating_buf_start:]
            continue
        
        # 在下一个 LAYER_CHANGE 之前：插入上一层的涂布（模型 → 涂布，物理顺序正确）
        if pending_coating_lines and (stripped == ';LAYER_CHANGE'):
            output_lines.extend(pending_coating_lines)
            pending_coating_lines = []
            output_lines.append('')
        
        # 检测 PRINT_END：所有喷墨/涂布必须在 PRINT_END 之前输出
        # PRINT_END 及其后所有行（收尾GCode）截留到喷墨完成后统一追加，并用 _print_end_seen 跳过后续迭代
        if stripped == 'PRINT_END':
            if pending_coating_lines:
                output_lines.extend(pending_coating_lines)
                pending_coating_lines = []
            output_lines.append(line.rstrip('\n'))
            for remaining_line in source_lines[idx + 1:]:
                output_lines.append(remaining_line.rstrip('\n'))
            _print_end_seen = True
            continue
        
        # 普通行：直接追加
        output_lines.append(line.rstrip('\n'))
        # PRINT_START 之后立即解压 _temp.zip（打印机侧）
        if stripped.startswith('PRINT_START'):
            output_lines.append('UNZIP_TEMP')
            _flush_ip = mbrush_ip or '192.168.1.8'
            _flush_speed = int(inkjet_speed) if inkjet_speed else 50
            output_lines.append('MBRUSH_FLUSH IP=' + _flush_ip + ' SPEED=' + str(_flush_speed))
    
    # 冲刷最后一层的延迟涂布
    if pending_coating_lines:
        output_lines.extend(pending_coating_lines)
        pending_coating_lines = []
    
    # 写入输出文件
    print('[GCodeGenerator] 写入输出文件: {}'.format(output_path))
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(output_lines))
    
    print('[GCodeGenerator] 完成! 共处理 {} 层, 塔高 {:.3f}mm, 塔层数 {}'.format(
        current_layer, curr_max_tower_height, tower_layer_count))
    print('[GCodeGenerator] 输出: {}'.format(output_path))
    
    return output_path


# ============================================================
# 入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(description='GCodeGenerator - GCode 后处理工具')
    parser.add_argument('--Gcode', type=str, required=True, help='GCode 文件路径（切片输出）')
    parser.add_argument('--Inkjet', type=str, default=None, help='纹理切片产生的 GCODE 文件路径（可选）')
    parser.add_argument('--Output', type=str, default=None, help='输出文件路径（可选，默认原名_output）')
    parser.add_argument('--InkjetSpeed', type=float, default=None, help='喷墨打印速度 (mm/s)，用于预测总时长')
    parser.add_argument('--Extract', action='store_true', help='仅提取切片参数和预估时长，输出 JSON 到 stdout')
    parser.add_argument('--ExtendTower', action='store_true', 
                        help='延长擦嘴塔外圈墙体至与零件等高（自动检测已有塔或从示范文件生成）')
    parser.add_argument('--TowerTemplate', type=str, default=None,
                        help='擦嘴塔示范文件路径（默认使用同目录下的 test1.gcode）')
    parser.add_argument('--Debug', action='store_true',
                        help='调试模式：输出到 _debug 子目录，不覆盖源文件')
    parser.add_argument('--FakeInkjet', action='store_true',
                        help='Debug：伪造墨水层数据，使 process_gcode 走完整喷墨流程（无需 --Inkjet）')
    
    args = parser.parse_args()
    
    if not os.path.exists(args.Gcode):
        print('[错误] GCode 文件不存在: {}'.format(args.Gcode))
        sys.exit(1)
    
    if args.Inkjet and not os.path.exists(args.Inkjet):
        print('[警告] 纹理 GCODE 文件不存在: {}，将跳过墨水层插入'.format(args.Inkjet))
        args.Inkjet = None
    
    # 提取参数（无论哪种模式都需要）
    sys.stderr.write('[GCodeGenerator] 正在分析切片参数...\n')
    sys.stderr.flush()
    params = extract_gcode_params(args.Gcode)
    inkjet_speed = args.InkjetSpeed
    
    # 估算时间
    est = estimate_print_time(params, inkjet_speed)
    
    # --Extract 模式：只输出 JSON
    if args.Extract:
        print(params_to_json(params, est))
        sys.stderr.write('[GCodeGenerator] 参数提取完成。预估总时长: {}\n'.format(est['total_time_str']))
        return
    
    # 提取擦嘴塔速度和原始层高
    _wipe_speed = params.get('wipe_tower_max_purge_speed', 90)
    _lh = params.get('layer_height', None)
    _flh = params.get('first_layer_height', None)

    # --ExtendTower 模式：延长擦嘴塔
    if args.ExtendTower:
        sys.stderr.write('[GCodeGenerator] 擦嘴塔延长模式\n')
        output = args.Output
        if not output:
            base, ext = os.path.splitext(args.Gcode)
            output = base + '_tower_extended' + ext
        result = extend_wipe_tower(args.Gcode, output, wipe_speed=_wipe_speed,
            default_layer_height=_lh, default_first_layer_height=_flh)
        sys.stderr.write('[GCodeGenerator] 塔延长完成: {}\n'.format(result))
        return
    
    # 正常后处理模式：显示参数信息并继续
    sys.stderr.write(('[GCodeGenerator] 层高={:.2f}mm  层数={}  '
                       '空驶速度={}mm/s  空驶加速度={}mm/s²  '
                       '预估FDM={:.1f}s  总时长={}\n').format(
        params['layer_height'], params['total_layers'],
        params['travel_speed'], params['travel_accel'],
        est['fdm_time_s'], est['total_time_str']))
    
    process_gcode(args.Gcode, args.Inkjet, args.Output, params, est,
                  inkjet_speed=inkjet_speed, debug_mode=args.Debug,
                  fake_inkjet=args.FakeInkjet)


if __name__ == '__main__':
    main()
