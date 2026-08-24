"""MBD 预转换 — 在条带分割后将全部 PNG 转为 MBD，独立子进程运行。

用法:
  python mbd_preconvert.py <segments_dir>

保存 .mbd 文件到 PNG 同目录（layer_XXXX/00000.png → layer_XXXX/00000.mbd）。
每次调用会扫描全目录，跳过已存在的 .mbd。
"""

import os
import sys
import subprocess
import shutil
import json

_DPCONV_SCRIPT = None
_DPCONV_FLAGS = 0x08000000 if sys.platform == 'win32' else 0


def find_dpconv():
    global _DPCONV_SCRIPT
    if _DPCONV_SCRIPT and os.path.exists(_DPCONV_SCRIPT):
        return _DPCONV_SCRIPT
    candidates = [
        os.path.join(getattr(sys, '_MEIPASS', ''), "mbrush_dpconv", "dpconv.js"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "mbrush-maintenance-mbrush/tools/image_convert/cmd_tool/dpconv.js"),
    ]
    for c in candidates:
        if os.path.exists(c):
            _DPCONV_SCRIPT = c
            return c
    return None


def find_node():
    bundled = os.path.join(getattr(sys, '_MEIPASS', ''), "node_portable", "node.exe")
    if os.path.exists(bundled):
        return bundled
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "node_portable", "node.exe")
    if os.path.exists(local):
        return local
    node = shutil.which("node")
    if node:
        return node
    for p in [r"C:\Program Files\nodejs\node.exe", r"C:\Program Files (x86)\nodejs\node.exe"]:
        if os.path.exists(p):
            return p
    return None


def png_to_mbd(png_path, work_dir, brightness=110, saturation=105, density=50, invert=0):
    dpconv = find_dpconv()
    node = find_node()
    if not dpconv or not node:
        return None

    os.makedirs(work_dir, exist_ok=True)
    work_png = os.path.join(work_dir, "in.png")
    output_dir = os.path.join(work_dir, "output")
    os.makedirs(output_dir, exist_ok=True)

    old_mbd = os.path.join(output_dir, "0.mbd")
    if os.path.exists(old_mbd):
        os.unlink(old_mbd)

    try:
        shutil.copy2(png_path, work_png)
    except Exception:
        return None

    cmd = [node, dpconv, work_png, str(invert),
           "--cb", str(brightness), "--cs", str(saturation), "--cd", str(density)]
    try:
        subprocess.run(cmd, cwd=work_dir, capture_output=True, text=True,
                       timeout=30, creationflags=_DPCONV_FLAGS)
    except Exception:
        return None

    if os.path.exists(old_mbd):
        with open(old_mbd, "rb") as f:
            return f.read()
    return None


def preconvert(segments_dir):
    dpconv_work_dir = os.path.join(os.path.dirname(os.path.abspath(segments_dir)), '.mbd_temp')
    total = ok = skipped = 0

    layers = sorted(d for d in os.listdir(segments_dir)
                    if os.path.isdir(os.path.join(segments_dir, d)) and d.startswith('layer_'))

    for layer_name in layers:
        layer_path = os.path.join(segments_dir, layer_name)
        for fname in sorted(os.listdir(layer_path)):
            if not fname.lower().endswith('.png'):
                continue
            png_path = os.path.join(layer_path, fname)
            mbd_path = png_path.replace('.png', '.mbd')
            total += 1

            if os.path.exists(mbd_path):
                skipped += 1
                continue

            data = png_to_mbd(png_path, dpconv_work_dir)
            if data:
                with open(mbd_path, 'wb') as f:
                    f.write(data)
                ok += 1

    result = {'total': total, 'converted': ok, 'skipped': skipped, 'done': True}
    pid_file = os.path.join(os.path.dirname(os.path.abspath(segments_dir)), 'mbd_preconvert.json')
    try:
        with open(pid_file, 'w') as f:
            json.dump(result, f)
    except Exception:
        pass
    return result


def main():
    if len(sys.argv) < 2:
        print("Usage: mbd_preconvert.py <segments_dir>", file=sys.stderr)
        sys.exit(1)

    segments_dir = sys.argv[1]
    if not os.path.isdir(segments_dir):
        print(f"Not a directory: {segments_dir}", file=sys.stderr)
        sys.exit(1)

    # 写入 PID 文件，供主进程杀进程
    pid_file = os.path.join(os.path.dirname(os.path.abspath(segments_dir)), 'mbd_preconvert_pid.json')
    with open(pid_file, 'w') as f:
        json.dump({'pid': os.getpid()}, f)

    result = preconvert(segments_dir)
    print(json.dumps(result))

    # 清理 PID 文件
    try:
        os.unlink(pid_file)
    except Exception:
        pass


if __name__ == '__main__':
    main()
