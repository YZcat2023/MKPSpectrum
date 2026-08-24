#!/usr/bin/env python3
"""修复 fulltest_colored.gcode 中硬编码 Z=2.000/2.030 的工具切换块。

问题：所有 `; Change Tool1 -> Tool0 (layer 19)` 块中的 Z 值被硬编码为
Z=2.000 和 Z=2.030，无论实际层高是多少。
在高层层，喷嘴会从 Z=25+ 降到 Z=2.0，导致撞坏模型甚至损坏打印机。

修复方法：
1. 通过解析 ;Z:N.N 标记跟踪当前层高
2. 当遇到 current_z > 2.0 的 (layer 19) 工具切换块时，将 Z=2.000 替换为
   当前层 Z，Z=2.030 替换为当前层 Z+0.030
3. 同步更新注释中的层号和 MKPColor OVERLAY Z 值
"""

import re
import sys

INPUT = "fulltest_colored.gcode"
OUTPUT = "fulltest_colored_fixed.gcode"


def main():
    print(f"Reading {INPUT}...")
    with open(INPUT, "r", encoding="utf-8") as f:
        lines = f.readlines()

    current_z = 0.0
    in_fix_block = False
    fixed_count = 0
    output_lines = []

    for i, line in enumerate(lines):
        # 跟踪当前层高 (;Z:0.1, ;Z:2.1, ;Z:25.1 ...)
        m_z = re.match(r"^;Z:([\d.]+)", line)
        if m_z:
            current_z = float(m_z.group(1))
            output_lines.append(line)
            continue

        # 检测进入错误的 (layer 19) 工具切换块
        # 只有当前层高 > 2.001（非真正的 Z=2.0 层）时才需要修复
        if (
            "; Change Tool1 -> Tool0 (layer 19)" in line
            and current_z > 2.001
        ):
            in_fix_block = True
            layer_num = int(current_z * 10 - 1)
            old_line = line
            line = line.replace("(layer 19)", f"(layer {layer_num})")
            print(f"  Line {i+1}: Fixing block at Z={current_z:.3f} (layer {layer_num})")

        if in_fix_block:
            # 替换 Z=2.000 → 当前层 Z
            old_line = line
            line = re.sub(r"\bZ2\.000\b", f"Z{current_z:.3f}", line)
            line = re.sub(r"\bZ2\.030\b", f"Z{current_z + 0.030:.3f}", line)
            # 更新 MKPColor OVERLAY 注释
            line = re.sub(
                r"MKPColor OVERLAY Z=2\.030",
                f"MKPColor OVERLAY Z={current_z + 0.030:.3f}",
                line,
            )

            if line != old_line:
                fixed_count += 1

            # restore Z to layer height 行标志着修复块的结束
            if "restore Z to layer height" in line:
                in_fix_block = False
                print(f"  -> Block ended at line {i+1}")

        output_lines.append(line)

    print(f"\nFixed {fixed_count} lines.")
    print(f"Writing {OUTPUT}...")
    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.writelines(output_lines)

    print("Done! Output written to:", OUTPUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
