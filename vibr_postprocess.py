#!/usr/bin/env python3
"""
GCode 振动后处理脚本
读取输入的 GCode 文件，在正常打印结束后（PRINT_END 之前），
沿所有挤出路径做空驶往返振动。
输出文件: {输入文件名}_vibr.gcode

振动参数:
  前进 0.4mm（不挤出），后退 0.2mm（挤出原挤出量的 30%），
  从第 2 层开始生效，路径向右下偏移 0.5×喷嘴直径，
  速度 F30000，加速度 20000
"""

import math
import os
import sys
import re

# ===== 可调参数 =====
VIBRATE_FORWARD = 0.4       # 前进步长 (mm)
VIBRATE_BACKWARD = 0.2      # 后退步长 (mm)
EXTRUSION_RATIO = 0.3       # 挤出量为原挤出量的比例
MIN_LAYER = 2               # 从第几层开始振动（1-based）
NOZZLE_DIAMETER = 0.4       # 喷嘴直径 (mm)
VIBRATE_SPEED = 30000       # 移动速度 (mm/min)
VIBRATE_ACCEL = 20000       # 振动时加速度
VIBRATE_ACCEL_TO_DECEL = 10000
RESTORE_ACCEL = 10000       # 恢复加速度
RESTORE_ACCEL_TO_DECEL = 5000

OUTPUT_SUFFIX = "_vibr"

# 路径偏移: 向右下角 45°, 距离 = 0.5 × 喷嘴直径
_OFFSET_DIST = 0.5 * NOZZLE_DIAMETER
_OFFSET_DIST_45 = _OFFSET_DIST / math.sqrt(2)
OFFSET_DX = _OFFSET_DIST_45    # 右
OFFSET_DY = -_OFFSET_DIST_45   # 下


def parse_params(text):
    """解析 GCode 参数字符串，返回 {轴: 值} 字典"""
    params = {}
    i = 0
    while i < len(text):
        if text[i].isalpha():
            key = text[i]
            j = i + 1
            while j < len(text) and (text[j].isdigit() or text[j] in '.-+'):
                j += 1
            if j > i + 1:
                try:
                    params[key] = float(text[i+1:j])
                except ValueError:
                    pass
            i = j
        else:
            i += 1
    return params


def collect_segments(filepath):
    """
    解析 GCode，收集所有挤出线段。
    追踪当前位置，记录每条 G1 (带 E>0) 的线段: (sx, sy, ex, ey, e_delta)
    """
    segments = []

    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        lines = f.readlines()

    cx, cy = 0.0, 0.0        # 当前位置 (绝对坐标)
    is_relative = False       # G91 相对定位模式
    is_relative_e = False     # M83 相对挤出模式
    current_e_abs = 0.0       # 当前绝对 E 位置
    current_layer = 0         # 当前层号

    for line in lines:
        raw = line.strip()

        # 追踪当前层号
        if "CURRENT_LAYER=" in raw:
            m = re.search(r'CURRENT_LAYER=(\d+)', raw)
            if m:
                current_layer = int(m.group(1))

        # 去掉注释部分
        code = raw.split(';')[0].strip()
        if not code:
            continue

        # 模式切换
        if code == 'G90':
            is_relative = False
            continue
        if code == 'G91':
            is_relative = True
            continue
        if code == 'M82':
            is_relative_e = False
            continue
        if code == 'M83':
            is_relative_e = True
            continue

        # 只处理 G0 / G1
        if not re.match(r'^G[01]\b', code):
            continue
        if code in ('G0', 'G1'):
            continue  # 无参数

        rest = code[2:].strip()
        params = parse_params(rest)

        has_xy = 'X' in params or 'Y' in params
        has_e = 'E' in params

        # 计算新 XY 位置
        if has_xy:
            if is_relative:
                nx = cx + params.get('X', 0.0)
                ny = cy + params.get('Y', 0.0)
            else:
                nx = params.get('X', cx)
                ny = params.get('Y', cy)
        else:
            nx, ny = cx, cy

        # 计算 E 增量
        if has_e:
            e_val = params['E']
            if is_relative_e:
                e_delta = e_val
            else:
                e_delta = e_val - current_e_abs
                current_e_abs = e_val
        else:
            e_delta = 0.0

        # 判断是否为挤出线段：有 XY 移动 + 正挤出量
        if has_xy and has_e and e_delta > 0.01 and current_layer >= MIN_LAYER:
            dx = nx - cx
            dy = ny - cy
            seg_len = math.hypot(dx, dy)
            if seg_len > 0.001:
                segments.append((cx, cy, nx, ny, e_delta))

        # 更新当前位置
        cx, cy = nx, ny

    return segments


def format_g1(x=None, y=None, f=None, e=None):
    """格式化 G1 命令。仅含 E 时可省略 XY"""
    if x is not None and y is not None:
        s = f"G1 X{x:.5f} Y{y:.5f}"
    else:
        s = "G1"
    if e is not None:
        s += f" E{e:.5f}"
    if f is not None:
        s += f" F{f}"
    return s


def generate_vibration(segments):
    """生成振动段 GCode（前进 0.4mm → 后退 0.2mm 往返）"""
    out = []
    if not segments:
        return out

    out.append("; ===== VIBRATION_START =====")
    out.append("M83 ; relative extrusion mode")
    out.append(f"SET_VELOCITY_LIMIT ACCEL={VIBRATE_ACCEL} ACCEL_TO_DECEL={VIBRATE_ACCEL_TO_DECEL}")
    out.append(f"; Vibrating along offset paths, forward={VIBRATE_FORWARD}mm backward={VIBRATE_BACKWARD}mm speed=F{VIBRATE_SPEED} extrusion={EXTRUSION_RATIO*100:.0f}% offset={_OFFSET_DIST:.3f}mm(45deg lower-right)")
    out.append("")

    for i, (sx, sy, ex, ey, e_total) in enumerate(segments):
        dx = ex - sx
        dy = ey - sy
        seg_len = math.hypot(dx, dy)
        if seg_len < 0.001:
            continue

        ux = dx / seg_len
        uy = dy / seg_len

        # 偏移后路径
        osx, osy = sx + OFFSET_DX, sy + OFFSET_DY

        # 每 mm 后退的挤出量
        e_per_mm_backward = e_total * EXTRUSION_RATIO / seg_len

        out.append(f"; Segment {i+1}: offset ({osx:.3f},{osy:.3f}) -> ({osx+dx:.3f},{osy+dy:.3f})  len={seg_len:.3f}mm  e={e_total:.5f}")

        px, py = osx, osy
        traveled = 0.0

        while traveled < seg_len - 1e-6:
            # --- 前进（无挤出） ---
            step_f = VIBRATE_FORWARD
            remaining = seg_len - traveled
            if step_f > remaining:
                step_f = remaining

            fx = px + ux * step_f
            fy = py + uy * step_f
            out.append(format_g1(fx, fy, VIBRATE_SPEED))

            if traveled + step_f >= seg_len - 1e-6:
                break

            # --- 后退（带挤出） ---
            step_b = VIBRATE_BACKWARD
            if step_b > step_f:
                step_b = step_f

            bx = fx - ux * step_b
            by = fy - uy * step_b
            e_b = step_b * e_per_mm_backward
            out.append(format_g1(bx, by, VIBRATE_SPEED, e_b))

            net = step_f - step_b
            px, py = bx, by
            traveled += net

    out.append("")
    out.append(f"SET_VELOCITY_LIMIT ACCEL={RESTORE_ACCEL} ACCEL_TO_DECEL={RESTORE_ACCEL_TO_DECEL}")
    out.append("; ===== VIBRATION_END =====")

    return out


def process_file(input_file):
    """处理单个 GCode 文件"""
    if not os.path.exists(input_file):
        print(f"错误: 找不到 {input_file}")
        return False

    print(f"[1/3] 解析 {input_file}，收集挤出线段...")
    segments = collect_segments(input_file)
    print(f"       找到 {len(segments)} 条挤出线段")

    if not segments:
        print("警告: 没有找到挤出线段，无法生成振动")
        return False

    print(f"[2/3] 生成振动 GCode...")
    vibration_lines = generate_vibration(segments)
    print(f"       生成了 {len(vibration_lines)} 行")

    # 生成输出文件名
    base, ext = os.path.splitext(input_file)
    output_file = f"{base}{OUTPUT_SUFFIX}{ext}"

    print(f"[3/3] 写入 {output_file}（在 PRINT_END 前插入振动段）...")
    with open(input_file, 'r', encoding='utf-8', errors='replace') as f:
        original = f.readlines()

    output = []
    inserted = False
    for line in original:
        if not inserted and line.strip() == "PRINT_END":
            for vl in vibration_lines:
                output.append(vl + "\n")
            inserted = True
        output.append(line)

    if not inserted:
        # 没有 PRINT_END，追加到末尾
        output.append("\n")
        for vl in vibration_lines:
            output.append(vl + "\n")

    with open(output_file, 'w', encoding='utf-8') as f:
        f.writelines(output)

    print(f"完成！输出文件: {output_file}")
    return True


def main():
    if len(sys.argv) < 2:
        print("用法: python vibr_postprocess.py <输入文件.gcode> [更多文件...]")
        print("示例: python vibr_postprocess.py test.gcode")
        sys.exit(1)

    for filepath in sys.argv[1:]:
        process_file(filepath)


if __name__ == "__main__":
    main()
