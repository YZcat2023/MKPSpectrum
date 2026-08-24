"""
条带切割处理器：将预览层图切割为打印头条带，跳过空白区域，
生成 Klipper 风格 G-code 和 timing 数据，存入内存列表。
"""
import os
import json
import math
import glob
import sys
import shutil
import struct
import threading
import atexit
import subprocess
import tempfile
import time as _time
import concurrent.futures as _cf
import io as _io
from PIL import Image
import numpy as np
from mbrush_tools.mbd_clone_runtime import encode as _encode_mbd_native


# ============================================================
# 物理常量
# ============================================================
BED_SIZE_MM = 270.0
HEAD_WIDTH_MM = 14.29
TRANSITION_MM = 2.15 / 3  # ≈0.717mm，过渡区收缩为原 1/3
TRANSITION_STEP_MM = 0.5
EFFECTIVE_STEP_MM = HEAD_WIDTH_MM - 2 * TRANSITION_MM  # 9.99 mm

# ============================================================
# 运动参数（硬编码，后续可改为传参）
# ============================================================
TRAVEL_SPEED_MM_S = 150.0    # 空驶速度 mm/s
TRAVEL_ACCEL_MM_S2 = 500.0   # 空驶加速度 mm/s²
PRINT_SPEED_MM_S = 20.0       # 打印速度 mm/s，与 Printsetting/MKP standard.json inkjet.speed 一致（默认 20）
HEAD_INITIAL_X_MM = 0.0      # 打印头初始位置 X
HEAD_INITIAL_Y_MM = 0.0      # 打印头初始位置 Y（左下角原点）
BLOCK_LEADIN_MM = 7.0         # 每个区块左侧附加的空白长度 mm
BLOCK_MERGE_GAP_MM = 20.0     # 相邻内容间隙小于该值时合并为同一区块 mm

# ============================================================
# 工具函数
# ============================================================

def _mm_to_px(mm_val, scale):
    return mm_val * scale


def _px_to_mm(px_val, scale):
    return px_val / scale


def _calculate_travel_time(dist_mm):
    """计算空驶移动时间（梯形/三角形速度曲线）"""
    if dist_mm <= 0.001:
        return 0.0
    d_accel = (TRAVEL_SPEED_MM_S ** 2) / (2 * TRAVEL_ACCEL_MM_S2)
    if dist_mm <= 2 * d_accel:
        # 三角形：加速到一半后减速
        return 2.0 * math.sqrt(dist_mm / TRAVEL_ACCEL_MM_S2)
    else:
        # 梯形：加速 + 匀速 + 减速
        return (2.0 * TRAVEL_SPEED_MM_S / TRAVEL_ACCEL_MM_S2 +
                (dist_mm - 2 * d_accel) / TRAVEL_SPEED_MM_S)


# ============================================================
# 核心处理
# ============================================================

def _build_alpha_gradient(h, transition_px):
    """每侧过渡区 = 2 * transition_px 行，线性渐变。
    过渡区中线（alpha=50%=128）落在 body 边缘上：
    - 顶部：0 → 255，下半（transition_px行）在body内，上半在条带外
    - 底部：255 → 0，上半（transition_px行）在body内，下半在条带外
    相邻条带 alpha 互补，叠加均匀。"""
    total_fade = int(round(2 * transition_px))
    total_fade = max(1, min(total_fade, h // 2))

    alpha = np.full(h, 255, dtype=np.uint8)

    # 顶部过渡：alpha 0 → 255，中心=128 在 body 顶部边缘 (row=total_fade/2≈transition_px)
    alpha[:total_fade] = np.linspace(0, 255, total_fade, dtype=np.uint8)

    # 底部过渡：alpha 255 → 0，中心=128 在 body 底部边缘 (row=h-total_fade/2≈h-transition_px)
    alpha[h - total_fade:] = np.linspace(255, 0, total_fade, dtype=np.uint8)

    return alpha.reshape(-1, 1)  # (h, 1) 便于广播


def apply_alpha_gradient(strip_arr, alpha_gradient):
    """应用 alpha 渐变乘数（0-255 uint8）到 uint8 数组（原地修改 alpha 通道）。
    使用 uint16 中间类型保证精度，避免 float32 开销。"""
    strip_arr[:, :, 3] = ((strip_arr[:, :, 3].astype(np.uint16) * alpha_gradient) // 255).astype(np.uint8)
    return strip_arr


def apply_shear(strip_arr, shear_px):
    """对条带图像施加水平剪切变换（平行四边形变换），补偿喷头倾斜。

    顶部偏移 shear_px 像素（正=右移，负=左移），底部固定不动。
    每行偏移量从顶部到底部线性递减至 0。
    偏移后露出的空白区域填充白色（alpha=0）。

    strip_arr: (h, w, 4) uint8 RGBA 数组
    shear_px: 顶部水平偏移量（像素）
    返回变换后的数组，尺寸不变。
    """
    if abs(shear_px) < 0.5:
        return strip_arr

    h, w = strip_arr.shape[:2]

    # 每行偏移量（顶部=shear_px → 底部=0）
    shifts = np.round(shear_px * np.linspace(1.0, 0.0, h)).astype(np.int32)

    # 白色背景（alpha=0 透明）
    result = np.ones_like(strip_arr) * 255
    result[:, :, 3] = 0

    for y in range(h):
        s = int(shifts[y])
        if s == 0:
            result[y, :, :] = strip_arr[y, :, :]
        elif s > 0:
            # 右移：源列 [0, w-s) → 目标列 [s, w)
            if w - s > 0:
                result[y, s:, :] = strip_arr[y, :w-s, :]
        else:  # s < 0
            # 左移：源列 [-s, w) → 目标列 [0, w+s)
            s_abs = -s
            if w - s_abs > 0:
                result[y, :w-s_abs, :] = strip_arr[y, s_abs:, :]

    return result


def apply_cmy_adjustment(arr, c_factor=1.0, m_factor=1.0, y_factor=1.0,
                         saturation=0.0, brightness=0.0, contrast=1.0):
    """调节 C/M/Y 出墨比例 + 饱和度 + 亮度 + 对比度。

    CMY: 将 RGB 分离为纯 CMY 三通道（C=1-R/255, M=1-G/255, Y=1-B/255），
         各自乘以墨量系数后合回 RGB。
         factor=1.0 标准出墨, >1.0 加墨(吸收更多对应光), <1.0 减墨(放更多对应光)。
         例: y_factor=2.0 → 黄墨加倍 → 吸收更多蓝光 → B↓ → 画面偏黄。
    saturation: -1(全灰) ~ 0(不变) ~ +1(加倍鲜艳)
    brightness: -1(全黑) ~ 0(不变) ~ +1(全白)
    contrast: 0.5~2.0, 1.0 为不变, >1 增强对比度, <1 减弱对比度
    返回新数组，不修改原数组。"""
    if (c_factor == 1.0 and m_factor == 1.0 and y_factor == 1.0
            and saturation == 0.0 and brightness == 0.0 and contrast == 1.0):
        return arr

    arr = arr.astype(np.float32)

    # 暗区保护因子：max(R,G,B) 越接近 0，调节效果越弱；
    # max(R,G,B) >= 60 时保护完全解除（t_dark = 1.0）
    max_rgb = np.maximum(np.maximum(arr[:, :, 0], arr[:, :, 1]), arr[:, :, 2])
    t_dark = np.clip((max_rgb / 60.0) ** 2, 0.0, 1.0)  # (H, W), 平方曲线

    # 1. RGB → CMY 分离为独立墨量通道 [0, 1]
    c_ch = 1.0 - arr[:, :, 0] / 255.0
    m_ch = 1.0 - arr[:, :, 1] / 255.0
    y_ch = 1.0 - arr[:, :, 2] / 255.0

    # 2. 各自乘以墨量系数（带暗区保护）
    if c_factor != 1.0:
        new_c = np.clip(c_ch * c_factor, 0.0, 1.0)
        c_ch = c_ch * (1.0 - t_dark) + new_c * t_dark
    if m_factor != 1.0:
        new_m = np.clip(m_ch * m_factor, 0.0, 1.0)
        m_ch = m_ch * (1.0 - t_dark) + new_m * t_dark
    if y_factor != 1.0:
        new_y = np.clip(y_ch * y_factor, 0.0, 1.0)
        y_ch = y_ch * (1.0 - t_dark) + new_y * t_dark

    # 3. CMY → RGB 合回
    arr[:, :, 0] = (1.0 - c_ch) * 255.0
    arr[:, :, 1] = (1.0 - m_ch) * 255.0
    arr[:, :, 2] = (1.0 - y_ch) * 255.0

    # 4. 饱和度调节（基于 Rec.601 亮度）
    if saturation != 0.0:
        gray = (arr[:, :, 0] * 0.299 +
                arr[:, :, 1] * 0.587 +
                arr[:, :, 2] * 0.114).reshape(arr.shape[0], arr.shape[1], 1)
        sat_factor = saturation + 1.0  # 0(全灰) ~ 2(加倍)
        arr[:, :, :3] = gray + (arr[:, :, :3] - gray) * sat_factor

    # 5. 亮度调节（带暗区保护）
    t_dark_3d = t_dark.reshape(t_dark.shape[0], t_dark.shape[1], 1)  # (H, W, 1)
    if brightness > 0.0:
        new_arr = arr[:, :, :3] * (1.0 - brightness) + 255.0 * brightness
        arr[:, :, :3] = arr[:, :, :3] * (1.0 - t_dark_3d) + new_arr * t_dark_3d
    elif brightness < 0.0:
        new_arr = arr[:, :, :3] * (1.0 + brightness)
        arr[:, :, :3] = arr[:, :, :3] * (1.0 - t_dark_3d) + new_arr * t_dark_3d

    # 6. 对比度调节（以 128 为中点拉伸）
    if contrast != 1.0:
        arr[:, :, :3] = (arr[:, :, :3] - 128.0) * contrast + 128.0

    return np.clip(arr, 0, 255).astype(np.uint8)


def find_non_white_blocks(strip_arr, min_gap_px=0):
    """
    向量化检测：在条带图像中找出所有包含非白像素的列，合并为连续块。
    返回 [(x_start_px, x_end_px), ...] 列表。
    如果相邻块之间的间距 < min_gap_px，则合并为一块。
    """
    if strip_arr.size == 0:
        return []

    # 非透明: alpha > 10
    opaque = strip_arr[:, :, 3] > 10  # (h, w) bool

    # 非白: R/G/B 不同时为 245+
    not_white = ~(
        (strip_arr[:, :, 0] > 245) &
        (strip_arr[:, :, 1] > 245) &
        (strip_arr[:, :, 2] > 245)
    )

    has_content = opaque & not_white  # (h, w) bool

    # 每列是否有任何内容像素
    col_has = np.any(has_content, axis=0)  # (w,) bool

    if not np.any(col_has):
        return []

    # 用 diff 找连续 True 段的边界
    padded = np.pad(col_has, (1, 1), constant_values=False)
    edges = np.diff(padded.astype(np.int8))
    starts = np.where(edges == 1)[0]
    ends = np.where(edges == -1)[0]

    blocks = list(zip(starts.tolist(), ends.tolist()))

    # 合并间距 < min_gap_px 的相邻块
    if min_gap_px > 0 and len(blocks) > 1:
        merged = [blocks[0]]
        for s, e in blocks[1:]:
            prev_s, prev_e = merged[-1]
            if s - prev_e < min_gap_px:
                merged[-1] = (prev_s, e)
            else:
                merged.append((s, e))
        return merged

    return blocks


def _strip_intersects_region(strip_y_top_mm, strip_y_bottom_mm, regions):
    """检查条带 Y 范围是否与任一模型区域相交。regions: [{x, y, w, h}, ...] mm，y 为左下角。"""
    if not regions:
        return True  # 未提供区域，默认全部处理
    for r in regions:
        ry_bottom = r['y']
        ry_top = r['y'] + r['h']
        # 条带 [strip_y_bottom, strip_y_top] 与区域 [ry_bottom, ry_top] 有交集
        if strip_y_top_mm > ry_bottom and strip_y_bottom_mm < ry_top:
            return True
    return False


# ============================================================
# PNG → MBD 转换（MBC WASM 管线，对齐 mbrush_tools/png2mbd.py）
# ============================================================
_MBC_HEAD_JS = None      # mbc-head-node.js 模板路径
_MBC_JS = None            # mbc.js (WASM 主逻辑)
_MBC_WASM = None          # mbc.wasm
_MBC_PERSIST_HEAD_JS = None  # mbc-head-persistent.js (常驻模式入口)
_MBC_NODE = None          # node.exe
_NO_WINDOW_FLAGS = 0x08000000 if sys.platform == 'win32' else 0


def _find_mbc_files():
    """定位 MBC 转换所需的文件（head-node.js / persist-head.js / mbc.js / mbc.wasm）"""
    global _MBC_HEAD_JS, _MBC_JS, _MBC_WASM, _MBC_PERSIST_HEAD_JS
    if _MBC_HEAD_JS and _MBC_JS and _MBC_WASM and _MBC_PERSIST_HEAD_JS:
        return True

    meipass = getattr(sys, '_MEIPASS', '')
    base_dirs = []
    if meipass:
        base_dirs.append(os.path.join(meipass, 'mbc'))
    base_dirs.append(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mbrush_tools', 'mbc')
    )

    for d in base_dirs:
        h = os.path.join(d, 'mbc-head-node.js')
        p = os.path.join(d, 'mbc-head-persistent.js')
        j = os.path.join(d, 'mbc.js')
        w = os.path.join(d, 'mbc.wasm')
        if os.path.exists(h) and os.path.exists(j) and os.path.exists(w):
            _MBC_HEAD_JS = h
            _MBC_JS = j
            _MBC_WASM = w
            _MBC_PERSIST_HEAD_JS = p if os.path.exists(p) else None
            return True
    return False


def _find_node():
    """查找 node.exe（优先项目内置 node_portable，其次系统 PATH）"""
    global _MBC_NODE
    if _MBC_NODE and os.path.exists(_MBC_NODE):
        return _MBC_NODE
    bundled = os.path.join(getattr(sys, '_MEIPASS', ''), 'node_portable', 'node.exe')
    if os.path.exists(bundled):
        _MBC_NODE = bundled
        return bundled
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'node_portable', 'node.exe')
    if os.path.exists(local):
        _MBC_NODE = local
        return local
    for p in [shutil.which('node'), shutil.which('node.exe'),
              r'C:\Program Files\nodejs\node.exe',
              r'C:\Program Files (x86)\nodejs\node.exe']:
        if p and os.path.exists(p):
            _MBC_NODE = p
            return p
    return None


def _convert_png_to_mbd_legacy(png_path,
                                brightness=100, saturation=100, density=50,
                                c_order=0, c_width=0, dpi_step=2, invert=0):
    """使用官方 MBC WASM 管线将单个 PNG 转为 MBD (单次 subprocess 版本，每块起一个 Node 进程)。
    仅在常驻进程不可用时作为回退使用。
    """
    mbd_path = png_path.replace('.png', '.mbd')
    if os.path.exists(mbd_path):
        return True

    node = _find_node()
    if not _find_mbc_files() or not node:
        if not node:
            print(f"[MBD] 找不到 Node.js", file=sys.stderr)
        else:
            print(f"[MBD] 找不到 MBC 文件 (head={_MBC_HEAD_JS}, js={_MBC_JS}, wasm={_MBC_WASM})", file=sys.stderr)
        return False

    tmp_png_path = None
    work_dir = None
    try:
        img = Image.open(png_path).convert('RGB')
        ow, oh = img.size
        new_h = 684
        new_w = max(1, int(ow * new_h / oh))
        img = img.resize((new_w, new_h), Image.LANCZOS)

        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        img.save(tmp.name)
        tmp.close()
        tmp_png_path = tmp.name

        density_n = max(100 - density, 1)
        with open(_MBC_HEAD_JS, 'r', encoding='utf-8') as f:
            head = f.read()
        head = head.replace(
            "Module.onRuntimeInitialized",
            "Module.wasmBinary = require('fs').readFileSync(__dirname + '/mbc.wasm'); Module.onRuntimeInitialized"
        ).replace("brightness: '100'", f"brightness: '{brightness}'") \
         .replace("saturation: '100'", f"saturation: '{saturation}'") \
         .replace("density_n: '40'", f"density_n: '{density_n}'") \
         .replace("invert: 0", f"invert: {invert}") \
         .replace("c_order: 0", f"c_order: {c_order}") \
         .replace("c_width: 0", f"c_width: {c_width}") \
         .replace("dpi_step: 2", f"dpi_step: {dpi_step}")

        work_dir = tempfile.mkdtemp(prefix='mbc_')
        custom_js = os.path.join(work_dir, 'mbc_node.js')
        with open(custom_js, 'w', encoding='utf-8') as f:
            f.write(head)
            with open(_MBC_JS, 'r', encoding='utf-8') as fj:
                f.write(fj.read())

        shutil.copy2(_MBC_WASM, os.path.join(work_dir, 'mbc.wasm'))
        out_mbd = os.path.join(work_dir, '0.mbd')

        result = subprocess.run(
            [node, custom_js, tmp_png_path, out_mbd],
            capture_output=True, text=True, timeout=60,
            creationflags=_NO_WINDOW_FLAGS,
        )
        if result.returncode != 0:
            print(f"[MBD] Node.js 退出码 {result.returncode}", file=sys.stderr)
            if result.stderr:
                print(f"[MBD] stderr: {result.stderr[:500]}", file=sys.stderr)
            if result.stdout:
                print(f"[MBD] stdout: {result.stdout[:500]}", file=sys.stderr)

        if os.path.exists(out_mbd):
            shutil.move(out_mbd, mbd_path)
            return True
        else:
            print(f"[MBD] 未生成输出文件: {out_mbd}", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print(f"[MBD] 转换超时: {os.path.basename(png_path)}", file=sys.stderr)
    except FileNotFoundError as e:
        print(f"[MBD] 文件未找到: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[MBD] 异常: {type(e).__name__}: {e}", file=sys.stderr)
    finally:
        if tmp_png_path:
            try:
                os.unlink(tmp_png_path)
            except Exception:
                pass
        if work_dir:
            try:
                shutil.rmtree(work_dir, ignore_errors=True)
            except Exception:
                pass
    return False


# ============================================================
# 按线程懒创建 Node.js MBD 转换进程
# 每个线程第一次用到 MBD 时启动自己的常驻进程，线程间无竞争。
# 进程数自然等于 ThreadPoolExecutor 的并发线程数（max_workers）。
# ============================================================
_mbd_thread_local = threading.local()  # 每个线程存储 (proc, work_dir)
_mbd_all_procs = []                    # 全局记录，用于 atexit 清理
_mbd_procs_lock = threading.Lock()     # 保护 _mbd_all_procs
_mbd_atexit_done = False               # 只注册一次 atexit


def _get_mbd_worker_limit(task_count):
    """返回本次 MBD 转换使用的并发数。

    默认对小块任务稍微激进一点，但保留环境变量兜底：
    MKPSPECTRUM_MBD_WORKERS=1/2/4/...
    """
    if task_count <= 0:
        return 0

    env_value = os.getenv("MKPSPECTRUM_MBD_WORKERS", "").strip()
    if env_value:
        try:
            env_limit = int(env_value)
            if env_limit > 0:
                return min(task_count, env_limit)
        except ValueError:
            pass

    default_limit = 1

    return min(task_count, default_limit)


def _start_one_mbd_proc():
    """启动一个常驻 MBD 转换进程。返回 (proc, work_dir) 或 (None, None)。"""
    node = _find_node()
    if not _find_mbc_files() or not node:
        return None, None
    if not _MBC_PERSIST_HEAD_JS:
        return None, None

    work_dir = tempfile.mkdtemp(prefix='mbc_persist_')
    js_path = os.path.join(work_dir, 'mbc_conv.js')
    with open(js_path, 'w', encoding='utf-8') as f:
        with open(_MBC_PERSIST_HEAD_JS, 'r', encoding='utf-8') as fh:
            head = fh.read()
        # 注入 wasm 预加载——Node v22+ 的 fetch 不支持 file:// URL
        head = head.replace(
            "Module.onRuntimeInitialized",
            "Module.wasmBinary = require('fs').readFileSync(__dirname + '/mbc.wasm'); Module.onRuntimeInitialized"
        )
        f.write(head)
        with open(_MBC_JS, 'r', encoding='utf-8') as fj:
            f.write(fj.read())
    shutil.copy2(_MBC_WASM, os.path.join(work_dir, 'mbc.wasm'))

    proc = subprocess.Popen(
        [node, js_path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_NO_WINDOW_FLAGS,
    )

    # 等待 WASM 初始化完成信号（1 字节 'R'）
    ready = proc.stdout.read(1)
    if ready != b'R':
        proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        shutil.rmtree(work_dir, ignore_errors=True)
        raise RuntimeError("常驻 MBD 进程初始化失败（未收到 ready 信号）")

    return proc, work_dir


def _kill_proc(proc):
    """强制关闭一个子进程。"""
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _get_thread_mbd_proc():
    """获取当前线程专属的 MBD 进程（懒创建，每个线程至多一个）。

    进程数 = 实际使用 MBD 转换的并发线程数（由 ThreadPoolExecutor 的 max_workers 决定）。
    """
    cached = getattr(_mbd_thread_local, 'entry', None)
    if cached is not None:
        proc, work_dir = cached
        if proc.poll() is None:
            return proc
        # 进程已死，清理重建
        _kill_proc(proc)
        shutil.rmtree(work_dir, ignore_errors=True)

    proc, work_dir = _start_one_mbd_proc()
    if proc is None:
        raise RuntimeError("无法启动 MBD 转换进程")

    _mbd_thread_local.entry = (proc, work_dir)
    with _mbd_procs_lock:
        _mbd_all_procs.append((proc, work_dir))
        global _mbd_atexit_done
        if not _mbd_atexit_done:
            _mbd_atexit_done = True
            atexit.register(_shutdown_all_mbd)
    return proc


def _invalidate_thread_mbd_proc():
    """废弃当前线程的 MBD 进程（通信失败时调用，下次自动重建）。

    不调用此函数会导致：同一坏进程被反复使用，
    每块都回退到 legacy 单次模式，产生大量临时 Node 进程。
    """
    cached = getattr(_mbd_thread_local, 'entry', None)
    if cached is None:
        return
    proc, work_dir = cached
    _mbd_thread_local.entry = None
    _kill_proc(proc)
    shutil.rmtree(work_dir, ignore_errors=True)


def _shutdown_all_mbd():
    """关闭所有线程的 MBD 进程（atexit 回调）。"""
    with _mbd_procs_lock:
        procs = list(_mbd_all_procs)
        _mbd_all_procs.clear()
    for proc, work_dir in procs:
        _kill_proc(proc)
        shutil.rmtree(work_dir, ignore_errors=True)
    # 清除线程本地存储中的引用
    try:
        del _mbd_thread_local.entry
    except AttributeError:
        pass


def shutdown_mbd_procs():
    """公开接口：切片结束后关闭所有 MBD 常驻进程以释放内存。
    
    调用此函数后，下次使用 MBD 转换时会自动重新启动进程。
    """
    _shutdown_all_mbd()


def _convert_png_to_mbd(png_path,
                           brightness=100, saturation=100, density=50,
                           c_order=0, c_width=0, dpi_step=2, invert=0):
    """将单个 PNG 转为 MBD。优先使用线程专属常驻进程，失败时回退到单次模式。"""
    mbd_path = png_path.replace('.png', '.mbd')
    if os.path.exists(mbd_path):
        return True

    # 尝试线程专属常驻进程
    try:
        proc = _get_thread_mbd_proc()
        img = Image.open(png_path).convert('RGB')
        ow, oh = img.size
        new_h = 684
        new_w = max(1, int(ow * new_h / oh))
        img = img.resize((new_w, new_h), Image.LANCZOS)

        buf = _io.BytesIO()
        img.save(buf, format='PNG')
        png_bytes = buf.getvalue()

        density_n = max(100 - density, 1)
        params = {
            'brightness': str(brightness),
            'saturation': str(saturation),
            'density_n': str(density_n),
            'invert': invert,
            'c_order': c_order,
            'c_width': c_width,
            'dpi_step': dpi_step,
        }
        params_json = json.dumps(params).encode('utf-8')

        frame = struct.pack('<I', len(png_bytes)) + png_bytes + params_json
        proc.stdin.write(struct.pack('<I', len(frame)) + frame)
        proc.stdin.flush()

        header = proc.stdout.read(5)
        if len(header) < 5:
            raise RuntimeError("常驻 MBD 进程意外断开")
        status = header[0]
        data_len = struct.unpack('<I', header[1:5])[0]
        data = proc.stdout.read(data_len)

        if status == 0:
            with open(mbd_path, 'wb') as f:
                f.write(data)
            return True
        else:
            err_msg = data.decode('utf-8', errors='replace')
            raise RuntimeError(err_msg)

    except Exception as e:
        print(f"[MBD] 转换失败 ({os.path.basename(png_path)}): {e}", file=sys.stderr)
        _invalidate_thread_mbd_proc()  # 废弃坏进程，下次自动重建

    # 回退：单次 subprocess 模式
    return _convert_png_to_mbd_legacy(
        png_path, brightness=brightness, saturation=saturation, density=density,
        c_order=c_order, c_width=c_width, dpi_step=dpi_step, invert=invert,
    )


def _process_layer_core(full_arr, img_w, img_h, layer_name, bed_size_mm,
                         output_zip_dir,
                         motion_params=None, model_regions=None,
                         block_output_dir=None, defer_mbd=False):
    """核心：对内存中的图层数组执行条带切割、渐变、找块、timing、G-code。
    注意：不再写出 PNG 块 / MBD / timing.json，仅返回 GCode 行。

    full_arr:  (img_h, img_w, 4) uint8 RGBA numpy 数组
    img_w, img_h: 图像宽高（像素），必须相等
    bed_size_mm: 打印床尺寸 mm，用于 px↔mm 换算
    output_zip_dir: 保留参数（兼容旧接口，不再使用）
    其他参数同 process_layer。
    """
    # 解析运动参数
    travel_speed = TRAVEL_SPEED_MM_S
    travel_accel = TRAVEL_ACCEL_MM_S2
    print_speed = PRINT_SPEED_MM_S
    head_init_x = HEAD_INITIAL_X_MM
    head_init_y = HEAD_INITIAL_Y_MM
    head_ip = '192.168.1.8'
    if motion_params:
        travel_speed = motion_params.get('travel_speed', travel_speed)
        travel_accel = motion_params.get('travel_accel', travel_accel)
        print_speed = motion_params.get('print_speed', print_speed)
        head_init_x = motion_params.get('head_initial_x', head_init_x)
        head_init_y = motion_params.get('head_initial_y', head_init_y)
        head_ip = motion_params.get('head_ip', head_ip)

    # 喷墨头 XY 偏移（相对于喷嘴），作用于 GCode 坐标
    offset_x = float(motion_params.get('offset_x', 0)) if motion_params else 0.0
    offset_y = float(motion_params.get('offset_y', 0)) if motion_params else 0.0

    # 喷墨密度（用于 MBD 转换）
    inkjet_density = int(motion_params.get('inkjet_density', 50)) if motion_params else 50

    # 条带剪切变换（平行四边形补偿），补偿喷头倾斜，mm
    shear_mm = float(motion_params.get('shear_mm', 0)) if motion_params else 0.0

    # CMY 色调调节
    if motion_params:
        c_cmy = float(motion_params.get('cmy_c', 1.0))
        m_cmy = float(motion_params.get('cmy_m', 1.0))
        y_cmy = float(motion_params.get('cmy_y', 1.0))
        sat = float(motion_params.get('cmy_saturation', 0.0))
        bri = float(motion_params.get('cmy_brightness', 0.0))
        contrast = float(motion_params.get('contrast', 1.0))
        full_arr = apply_cmy_adjustment(full_arr, c_cmy, m_cmy, y_cmy, sat, bri, contrast)

    # 计算缩放比例
    scale = img_w / bed_size_mm  # px/mm
    head_width_px = _mm_to_px(HEAD_WIDTH_MM, scale)
    transition_px = _mm_to_px(TRANSITION_MM, scale)
    step_px = _mm_to_px(TRANSITION_STEP_MM, scale)
    effective_step_px = _mm_to_px(EFFECTIVE_STEP_MM, scale)

    # 计算条带数量
    remaining_mm = bed_size_mm
    strip_count = 0
    while remaining_mm > 0.01:
        remaining_mm -= EFFECTIVE_STEP_MM
        strip_count += 1

    # 准备块计数器
    all_blocks = []  # [{x_mm, y_mm, w_mm, h_mm, file, idx}]
    block_counter = 0  # 每层从 0 开始编号

    # 预计算标准条带高度的 alpha 渐变（所有条带高度相同）
    std_strip_h = min(int(round(head_width_px)), img_h)
    alpha_grad = _build_alpha_gradient(std_strip_h, transition_px)
    _t_layer0 = _time.perf_counter()
    _t_strip_acc = 0.0
    _mbd_tasks = []  # 即时模式: (array, path); 延迟模式: (npy_path, path, density)

    # ---- 按条带处理 ----
    for s in range(strip_count):
        # 条带在图像中的 y 范围（图像坐标：Y轴向下，顶部=0）
        # 条带 s 的顶部在 mm 坐标 = bed_size_mm - s * EFFECTIVE_STEP_MM
        # 转换成图像坐标：img_top_y_px = (bed_size_mm - strip_top_mm) * scale
        strip_top_mm = bed_size_mm - s * EFFECTIVE_STEP_MM  # 条带顶部在热床上的 mm 位置
        strip_bottom_mm = strip_top_mm - HEAD_WIDTH_MM        # 条带底部

        # 快速跳过：条带不与任何模型区域相交
        if model_regions and not _strip_intersects_region(strip_top_mm, strip_bottom_mm, model_regions):
            continue

        # 图像中条带顶部对应的像素行
        strip_img_top_px = int(round((bed_size_mm - strip_top_mm) * scale))
        # 图像中条带底部对应的像素行
        strip_img_bottom_px = int(round(strip_img_top_px + head_width_px))

        # 边界裁剪
        strip_img_top_px = max(0, strip_img_top_px)
        strip_img_bottom_px = min(img_h, strip_img_bottom_px)

        if strip_img_bottom_px <= strip_img_top_px:
            continue

        _t0 = _time.perf_counter()
        # 提取条带并应用 alpha 渐变（uint8，无 float32 中转）
        strip_arr = full_arr[strip_img_top_px:strip_img_bottom_px, :, :].copy()
        strip_h = strip_arr.shape[0]
        # 边界条带可能高度不同，按需重算 alpha 渐变
        grad = alpha_grad if strip_h == std_strip_h else _build_alpha_gradient(strip_h, transition_px)
        strip_arr = apply_alpha_gradient(strip_arr, grad)

        # 平行四边形剪切变换（补偿喷头倾斜），顶部偏移、底部固定
        if abs(shear_mm) > 0.001:
            shear_px = shear_mm * scale
            strip_arr = apply_shear(strip_arr, shear_px)

        # 找非白块（直接操作 uint8 数组，无需 clip/astype）
        min_gap_px = int(round(_mm_to_px(BLOCK_MERGE_GAP_MM, scale)))
        blocks = find_non_white_blocks(strip_arr, min_gap_px)
        _t_strip_acc += _time.perf_counter() - _t0
        if not blocks:
            continue

        # 条带中心在热床上的 Y 坐标
        strip_center_y_mm = strip_top_mm - HEAD_WIDTH_MM / 2.0

        for bi, (x_start_px, x_end_px) in enumerate(blocks):
            # 裁剪块图像
            x_start_px = max(0, int(x_start_px))
            x_end_px = min(strip_arr.shape[1], int(x_end_px))

            # 块的文件名
            block_file = f"{block_counter:05d}.png"
            block_counter += 1

            # MBD 转换：先收集，条带循环结束后并行执行，避免块级串行阻塞
            if block_output_dir:
                mbd_file = f"{block_counter - 1:05d}.mbd"
                mbd_path = os.path.join(block_output_dir, mbd_file)
                if not os.path.exists(mbd_path):
                    leadin_px = int(round(_mm_to_px(BLOCK_LEADIN_MM, scale)))
                    x_block_start_px = max(0, x_start_px - leadin_px)
                    if x_block_start_px < x_start_px:
                        pad_w = x_start_px - x_block_start_px
                        core_arr = strip_arr[:, x_start_px:x_end_px, :]
                        white_pad = np.ones((core_arr.shape[0], pad_w, 4), dtype=np.uint8) * 255
                        block_arr = np.concatenate([white_pad, core_arr], axis=1)
                    else:
                        block_arr = strip_arr[:, x_start_px:x_end_px, :].copy()
                    if defer_mbd:
                        source_path = os.path.join(
                            block_output_dir, f".{block_counter - 1:05d}.mbd-source.npy"
                        )
                        np.save(source_path, block_arr, allow_pickle=False)
                        _mbd_tasks.append((source_path, mbd_path, inkjet_density))
                    else:
                        _mbd_tasks.append((block_arr, mbd_path))

            # 块在热床上的位置（mm）
            x_mm = _px_to_mm(x_start_px, scale)
            w_mm = _px_to_mm(x_end_px - x_start_px, scale)
            y_mm = strip_center_y_mm
            h_mm = HEAD_WIDTH_MM

            all_blocks.append({
                'x_mm': round(x_mm, 3),
                'y_mm': round(y_mm, 3),
                'w_mm': round(w_mm, 3),
                'h_mm': round(h_mm, 3),
                'file': block_file,
                'strip': s,
            })

    # ---- MBD 转换（纯 Python/NumPy 编码，无 Node/JS/WASM）----
    _t_mbd = 0.0
    if _mbd_tasks and not defer_mbd:
        _t_mbd0 = _time.perf_counter()
        _max_mbd_workers = _get_mbd_worker_limit(len(_mbd_tasks))
        def _mbd_one(task):
            arr_, path_ = task
            return _block_arr_to_mbd(arr_, path_, inkjet_density)
        with _cf.ThreadPoolExecutor(max_workers=_max_mbd_workers) as _mbd_pool:
            list(_mbd_pool.map(_mbd_one, _mbd_tasks))
        _t_mbd = _time.perf_counter() - _t_mbd0
    _t_total = _time.perf_counter() - _t_layer0
    # 单层打点：分割(纯条带) vs MBD vs 总计，便于对比
    try:
        print(f"[strip] {layer_name}: strip={_t_strip_acc:.3f}s  mbd={_t_mbd:.3f}s  blocks={len(all_blocks)}  total={_t_total:.3f}s", flush=True)
    except Exception:
        pass

    # ---- 计算 timing ----
    prev_end_x = head_init_x
    prev_end_y = head_init_y
    block_timings = []

    for i, blk in enumerate(all_blocks):
        dx = blk['x_mm'] - prev_end_x
        dy = blk['y_mm'] - prev_end_y
        dist = math.sqrt(dx * dx + dy * dy)
        travel_time = _calculate_travel_time(dist)

        block_timings.append({
            'file': blk['file'],
            'x_mm': blk['x_mm'],
            'y_mm': blk['y_mm'],
            'w_mm': blk['w_mm'],
            'travel_s': round(travel_time, 4),
        })

        prev_end_x = blk['x_mm'] + blk['w_mm']
        prev_end_y = blk['y_mm']

    # ---- 生成 Klipper 风格 G-code（存入列表，不写文件）----
    travel_feedrate = int(travel_speed * 60)   # mm/s → mm/min
    print_feedrate = int(print_speed * 60)

    gcode_lines = [
        f"; Layer: {layer_name}",
        f"; Strips: {strip_count}, Blocks: {len(all_blocks)}",
        f"; Head: {HEAD_WIDTH_MM}mm, Transition: {TRANSITION_MM}mm",
        f"; Travel speed: {travel_speed}mm/s, Print speed: {print_speed}mm/s",
        "; ---",
    ]

    for blk, tmg in zip(all_blocks, block_timings):
        x_start = blk['x_mm'] + offset_x
        x_end = blk['x_mm'] + blk['w_mm'] + offset_x
        y_pos = blk['y_mm'] + offset_y

        # 向 X+ 延伸 10mm
        if not (x_end <= 270.0 < x_end + 10.0):
            x_end += 10.0

        # 时序: G1 travel → M400 → MBRUSH_UPLOAD → G1 print → M400
        # MBRUSH_UPLOAD 由 gcode_shell_command.py built-in 处理
        # （set_conf(period_us=42333/speed) → rm_upload→key=3→POST→sync→key=0→key=1 ARM→key=1 FIRE）
        mbd_file = blk["file"].replace('.png', '.mbd')
        gcode_lines.append(
            f"G1 X{x_start:.3f} Y{y_pos:.3f} F{travel_feedrate}"
            f"  ; travel {tmg['travel_s']:.4f}s (block: {blk['file']})"
        )
        gcode_lines.append('M400  ; 等待所有动作完成')
        gcode_lines.append(
            f'MBRUSH_UPLOAD IP={head_ip} FILE="{layer_name}/{mbd_file}"'
        )
        gcode_lines.append(
            f"G1 X{x_end:.3f} Y{y_pos:.3f} F{print_feedrate}"
            f"  ; print {blk['w_mm']:.3f}mm"
        )
        gcode_lines.append('M400  ; 等待所有动作完成')
        gcode_lines.append(f'G1 F{travel_feedrate}  ; 空驶速度')

    return {
        'layer_name': layer_name,
        'strip_count': strip_count,
        'total_blocks': len(all_blocks),
        'gcode_lines': gcode_lines,
        'mbd_tasks': _mbd_tasks if defer_mbd else [],
    }


def generate_blocks_for_layer(image_path, output_dir, motion_params=None):
    """读取图层 PNG，执行条带切割，为每个块生成 PNG 并转为 MBD（仅文件写出，无 GCode）。

    供 fluidd_tray_monitor 延迟块生成使用。限制 CPU：单次调用只处理一层。
    """
    img = Image.open(image_path).convert('RGBA')
    w, h = img.size
    if w != h:
        raise ValueError(f"图像必须为正方形，当前尺寸: {w}x{h}")

    layer_name = os.path.splitext(os.path.basename(image_path))[0]

    # 解析运动参数
    inkjet_density = int(motion_params.get('inkjet_density', 50)) if motion_params else 50
    shear_mm = float(motion_params.get('shear_mm', 0)) if motion_params else 0.0

    scale = w / BED_SIZE_MM
    head_width_px = _mm_to_px(HEAD_WIDTH_MM, scale)
    transition_px = _mm_to_px(TRANSITION_MM, scale)
    step_px = _mm_to_px(TRANSITION_STEP_MM, scale)
    effective_step_px = _mm_to_px(EFFECTIVE_STEP_MM, scale)

    remaining_mm = BED_SIZE_MM
    strip_count = 0
    while remaining_mm > 0.01:
        remaining_mm -= EFFECTIVE_STEP_MM
        strip_count += 1

    os.makedirs(output_dir, exist_ok=True)
    full_arr = np.array(img)  # uint8

    # CMY 色调调节
    if motion_params:
        c = float(motion_params.get('cmy_c', 1.0))
        m = float(motion_params.get('cmy_m', 1.0))
        y = float(motion_params.get('cmy_y', 1.0))
        sat = float(motion_params.get('cmy_saturation', 0.0))
        bri = float(motion_params.get('cmy_brightness', 0.0))
        contrast = float(motion_params.get('contrast', 1.0))
        full_arr = apply_cmy_adjustment(full_arr, c, m, y, sat, bri, contrast)

    std_strip_h = min(int(round(head_width_px)), h)
    alpha_grad = _build_alpha_gradient(std_strip_h, transition_px)

    total_blocks = 0
    skipped = 0

    for s in range(strip_count):
        strip_top_mm = BED_SIZE_MM - s * EFFECTIVE_STEP_MM
        strip_bottom_mm = strip_top_mm - HEAD_WIDTH_MM

        strip_img_top_px = int(round((BED_SIZE_MM - strip_top_mm) * scale))
        strip_img_bottom_px = int(round(strip_img_top_px + head_width_px))
        strip_img_top_px = max(0, strip_img_top_px)
        strip_img_bottom_px = min(h, strip_img_bottom_px)

        if strip_img_bottom_px <= strip_img_top_px:
            continue

        strip_arr = full_arr[strip_img_top_px:strip_img_bottom_px, :, :].copy()
        strip_h_actual = strip_arr.shape[0]
        grad = alpha_grad if strip_h_actual == std_strip_h else _build_alpha_gradient(strip_h_actual, transition_px)
        strip_arr = apply_alpha_gradient(strip_arr, grad)

        # 平行四边形剪切变换（补偿喷头倾斜），顶部偏移、底部固定
        if abs(shear_mm) > 0.001:
            shear_px = shear_mm * scale
            strip_arr = apply_shear(strip_arr, shear_px)

        min_gap_px = int(round(_mm_to_px(BLOCK_MERGE_GAP_MM, scale)))
        blocks = find_non_white_blocks(strip_arr, min_gap_px)
        if not blocks:
            continue

        for bi, (x_start_px, x_end_px) in enumerate(blocks):
            x_start_px = max(0, int(x_start_px))
            x_end_px = min(strip_arr.shape[1], int(x_end_px))

            # 每个区块左侧附加空白引导
            leadin_px = int(round(_mm_to_px(BLOCK_LEADIN_MM, scale)))
            x_block_start_px = max(0, x_start_px - leadin_px)
            if x_block_start_px < x_start_px:
                # 左侧补白色像素
                pad_w = x_start_px - x_block_start_px
                core_arr = strip_arr[:, x_start_px:x_end_px, :]
                white_pad = np.ones((core_arr.shape[0], pad_w, 4), dtype=np.uint8) * 255
                block_arr = np.concatenate([white_pad, core_arr], axis=1)
            else:
                block_arr = strip_arr[:, x_start_px:x_end_px, :]
            mbd_file = f"{total_blocks:05d}.mbd"
            mbd_path = os.path.join(output_dir, mbd_file)
            total_blocks += 1

            if os.path.exists(mbd_path):
                skipped += 1
                continue

            if _block_arr_to_mbd(block_arr, mbd_path, inkjet_density):
                continue
            # 失败不阻塞，后续重试机会

    return {'layer': layer_name, 'blocks': total_blocks, 'skipped': skipped}


def _block_arr_to_mbd(arr, mbd_path, density):
    """将 uint8 RGBA 数组用纯 Python/NumPy 编码为 MBD。"""
    try:
        # 将 alpha 通道烘焙到 RGB（整数运算，避免 float32；与白色背景混合）
        a16 = arr[:, :, 3:4].astype(np.uint16)  # 0..255
        rgb16 = arr[:, :, :3].astype(np.uint16)
        rgb_blended = ((rgb16 * a16 + 255 * (255 - a16)) // 255).astype(np.uint8)
        img = Image.fromarray(rgb_blended, 'RGB')
        ow, oh = img.size
        new_h = 684
        new_w = max(1, int(ow * new_h / oh))
        # 热路径：块多为窄条，LANCZOS 过重，BILINEAR 快 3~5 倍且视觉差异可忽略
        img = img.resize((new_w, new_h), Image.BILINEAR)

        resource_root = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
        calibration_dir = os.path.join(resource_root, 'mbd_calibration')
        if not os.path.isdir(calibration_dir):
            calibration_dir = os.path.join(resource_root, 'mbrush_tools', 'mbd_calibration')
        data = _encode_mbd_native(
            img,
            calibration_dir,
            os.path.join(calibration_dir, 'white.mbd'),
            density=density,
        )
        with open(mbd_path, 'wb') as f:
            f.write(data)
        return True

    except Exception as e:
        print(f"[MBD-block] 转换失败 ({mbd_path}): {e}", file=sys.stderr)
    return False


def process_layer(image_path, output_zip_dir,
                  motion_params=None, model_regions=None):
    """
    处理单张图层图片（从文件读取）。

    参数：
        image_path:    图层 PNG 路径
        output_zip_dir: 保留参数（兼容旧接口，不再使用）
        motion_params: 可选 dict，覆盖默认运动参数
        model_regions: 可选 [{x, y, w, h}, ...]，mm 坐标（左下角原点）
    返回：
        dict: {layer_name, strip_count, total_blocks, gcode_lines}
    """
    img = Image.open(image_path).convert('RGBA')
    img_w, img_h = img.size
    if img_w != img_h:
        raise ValueError(f"图像必须为正方形，当前尺寸: {img_w}x{img_h}")

    layer_name = os.path.splitext(os.path.basename(image_path))[0]
    full_arr = np.array(img)  # 已是 uint8，无需转换

    return _process_layer_core(
        full_arr, img_w, img_h, layer_name, BED_SIZE_MM,
        output_zip_dir,
        motion_params=motion_params,
        model_regions=model_regions,
    )


def process_layer_from_array(arr, layer_name, img_size, bed_size_mm,
                              output_zip_dir,
                              motion_params=None, model_regions=None,
                              block_output_dir=None, defer_mbd=False):
    """处理内存中的图层数组（跳过 PNG 文件读写）。

    arr:          (img_size, img_size, 4) uint8 或 float32 RGBA numpy 数组
    layer_name:   图层名称（如 "layer_0000"）
    img_size:     图像边长（像素，必须与 arr.shape[:2] 一致）
    bed_size_mm:  打印床尺寸 mm
    其他参数同 process_layer。
    """
    h, w = arr.shape[:2]
    if w != h or w != img_size:
        raise ValueError(
            f"数组尺寸 ({w}x{h}) 与 img_size ({img_size}) 不匹配"
        )
    full_arr = arr.astype(np.uint8, copy=False)
    return _process_layer_core(
        full_arr, img_size, img_size, layer_name, bed_size_mm,
        output_zip_dir,
        motion_params=motion_params,
        model_regions=model_regions,
        block_output_dir=block_output_dir,
        defer_mbd=defer_mbd,
    )


def process_all_layers(preview_dir, output_base_dir, motion_params=None,
                       model_regions=None):
    """
    处理 Preview 目录下所有图层 PNG。

    输出结构：
        output_base_dir/
          ├── Segment/
          │   └── zip/
          │       └── segments.zip
          │           ├── layer_0000/
          │           │   ├── timing.json
          │           │   ├── s00_b000.png
          │           │   └── ...
          │           └── layer_0001/
          │               └── ...

    参数：
        preview_dir:    预览图目录
        output_base_dir: 输出根目录（其下创建 Segment/...）
        motion_params:   运动参数字典
        model_regions:   可选 [{x, y, w, h}, ...]，mm 坐标，只处理相交条带
    返回：
        dict: {success, layers, total_blocks, zip_path, gcode_lines_all}"""

    # 找到所有 PNG 并排序
    png_files = sorted(
        glob.glob(os.path.join(preview_dir, '*.png'))
    )
    if not png_files:
        return {'success': False, 'error': 'Preview 目录中没有 PNG 文件'}

    results = []
    total_blocks = 0
    gcode_lines_all = []  # 所有层的 gcode 行，存入内存列表

    for png_path in png_files:
        r = process_layer(
            png_path,
            output_zip_dir=os.path.join(output_base_dir, "Segment"),
            motion_params=motion_params,
            model_regions=model_regions,
        )
        results.append(r)
        total_blocks += r['total_blocks']
        gcode_lines_all.append(r['gcode_lines'])
        print(f"  [{r['layer_name']}] strips={r['strip_count']}, "
              f"blocks={r['total_blocks']}")

    return {
        'success': True,
        'layers': [r['layer_name'] for r in results],
        'total_layers': len(results),
        'total_blocks': total_blocks,
        'gcode_lines_all': gcode_lines_all,
        'zip_path': None,  # 不再打包 ZIP
    }


if __name__ == '__main__':
    # 测试运行
    import sys
    preview_dir = os.path.expanduser(
        '~/Documents/MKPSpectrum/Temp/Texture/Preview'
    )
    output_dir = os.path.expanduser(
        '~/Documents/MKPSpectrum/Temp/Texture'
    )
    result = process_all_layers(preview_dir, output_dir)
    print(json.dumps(result, indent=2, ensure_ascii=False))
