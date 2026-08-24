"""
Fluidd 控制台监听 + mBrush 打印机指挥 托盘程序
==============================================
独立托盘进程，在后台：
  1. 连接 Moonraker WebSocket 监听 Klipper 控制台
  2. 检测到 RESPOND 命令（upload pic=/print pic=）时
  3. 将 MBD 数据上传到 mBrush 并触发打印
  4. 检测到 "File selected" 时启动延迟块生成（条带切割 + PNG→MBD）

用法:
  python fluidd_tray_monitor.py --moonraker 192.168.1.10:7125 --mbrush 192.168.44.1 --segments-dir <路径>

依赖:
  pip install pystray pillow websocket-client requests numpy
"""

import json
import sys
import os
import re
import time
import queue
import signal
import tempfile
import threading
import argparse
import logging
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

import urllib.request
import http.client
import websocket
from PIL import Image, ImageDraw

try:
    from strip_processor import generate_blocks_for_layer
except Exception:
    generate_blocks_for_layer = None

# ============================================================
# 单实例锁 — 防止多个监控进程同时连接 mBrush 导致重复 key=1
# ============================================================
_LOCK_FILE = os.path.join(tempfile.gettempdir(), 'MKPSpectrum_monitor.lock')
_lock_fd = None

def _acquire_single_instance():
    """尝试获取单实例锁，成功返回 True，已有实例则返回 False 并退出"""
    global _lock_fd
    try:
        import tempfile
        _lock_fd = open(_LOCK_FILE, 'w')
        if sys.platform == 'win32':
            import msvcrt
            msvcrt.locking(_lock_fd.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _lock_fd.write(str(os.getpid()))
        _lock_fd.flush()
        return True
    except (IOError, OSError):
        print(f"另一个 MKPSpectrum 监控进程已在运行。如果确认没有，请删除 {_LOCK_FILE}")
        return False

if not _acquire_single_instance():
    sys.exit(0)

# ============================================================
# pystray 托盘图标
# ============================================================
try:
    import pystray
    _PYSTRAY_AVAILABLE = True
except ImportError:
    _PYSTRAY_AVAILABLE = False
    print("警告: 未安装 pystray 库，托盘图标不可用")

# ============================================================
# 日志
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger("fluidd_tray")

# ============================================================
# 配置常量
# ============================================================
DEFAULT_MOONRAKER = "192.168.1.10:7125"
DEFAULT_MBRUSH = ""  # 必须由调用方显式传入，不允许硬编码默认值
SEGMENTS_SEARCH_DIRS = [
    os.path.expanduser("~/Documents/MKPSpectrum/Temp/Texture/Segment"),
]


def find_segments_dir(override=None):
    """查找 segments 解压目录"""
    if override and os.path.isdir(override):
        return override

    for d in SEGMENTS_SEARCH_DIRS:
        if os.path.isdir(d):
            return d
    return None


# ============================================================
# mBrush 通信
# ============================================================
class MBrushClient:
    """mBrush 打印机 HTTP 客户端
    参考 mbrush_tools/png2mbd.py 和 print_strips.py 的上传/打印逻辑。
    """

    def __init__(self, host):
        self.host = host
        self.base = f"http://{host}"

    # ── 基础 API ────────────────────────────────────────────

    def _api(self, cmd, timeout=5):
        """通用 API 调用（参考 print_strips.py 使用 urllib）"""
        try:
            with urllib.request.urlopen(
                f"{self.base}/cgi-bin/cmd?cmd={cmd}", timeout=timeout
            ) as r:
                return json.loads(r.read())
        except Exception as e:
            log.warning(f"mBrush API 失败 [{cmd}]: {e}")
        return None

    def get_info(self):
        """获取设备信息 → {info, st, i, p, bat, ...} 或 None"""
        try:
            r = self._api("get_info")
            if r and "info" in r:
                return r
        except Exception:
            pass
        return None

    def get_state(self):
        """获取当前 st 状态码（0=idle, 1=printing, 2=cleaning, 3=wait trigger）"""
        for _ in range(3):
            r = self.get_info()
            if r:
                info = r.get("info", "")
                try:
                    return info.split("st: ")[1].split(",")[0]
                except (IndexError, AttributeError):
                    pass
            time.sleep(0.2)
        return None

    def sync(self):
        """同步文件系统（确保上传落盘）"""
        self._api("sync")

    def simulate_key(self, key):
        """模拟按键: 0=重载配置, 1=短按, 2=长按, 3=重置索引"""
        r = self._api(f"simulate&key={key}")
        return r and r.get("status") == "ok"

    def rm_upload(self):
        """清除上传目录"""
        r = self._api("rm_upload")
        return r and r.get("status") == "ok"

    def reload_config(self):
        """重载配置（simulate&key=0）"""
        return self.simulate_key(0)

    def reset_index(self):
        """重置数据索引到 0（simulate&key=3，包含在 rm_upload 中）"""
        return self.simulate_key(3)

    def trigger_print(self):
        """触发打印（模拟短按 key=1）"""
        return self.simulate_key(1)

    # ── 辅助 ────────────────────────────────────────────────

    def set_constant_speed(self, period_us, strength=20):
        """设置匀速模式参数
        
        参考 mbrush_tools: set_conf&conf=period_us%3D{val}%26strength%3D{val}
        """
        conf = f"period_us%3D{period_us}%26strength%3D{strength}"
        ret = self._api(f"set_conf&conf={conf}")
        if ret:
            log.info(f"mBrush set_config: period_us={period_us}, strength={strength}")
            return True
        return False

    def is_ready(self):
        """检查 mBrush 是否空闲 (st=0)"""
        return self.get_state() == "0"

    def wait_idle(self, timeout_sec=60):
        """轮询等待 mBrush 回到空闲状态 (st=0)

        参考 print_strips.py: 轮询 st，每 0.3s 一次。
        注意：不再自动补发 key=1，触发由 preheat+print 命令流控制。
        """
        for _ in range(int(timeout_sec / 0.3)):
            st = self.get_state()
            if st is None:
                time.sleep(0.3)
                continue
            if st == "0":
                return True
            time.sleep(0.3)
        log.warning(f"  mBrush wait_idle 超时 ({timeout_sec}s)")
        return False


# ============================================================
# 延迟块生成（条带切割 + PNG → MBD）
# ============================================================
class _DeferredBlockGenerator:
    """检测到 "File selected" 后，在后台生成 MBD 块文件。

    限制 CPU：最多 2 线程（条带切割计算 + MBD 转换交替进行）。
    """

    def __init__(self, segments_dir):
        self._segments_dir = segments_dir
        self._started = threading.Event()
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=2)

    def start(self):
        """非阻塞启动。已在运行时忽略重复调用。"""
        if self._started.is_set():
            return
        with self._lock:
            if self._started.is_set():
                return
            self._started.set()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        if generate_blocks_for_layer is None:
            log.error("[延迟块生成] strip_processor 未加载，跳过")
            return

        log.info("[延迟块生成] 开始扫描...")
        start = time.time()

        # 读取运动参数（与 MKPSpectrum.py L2473-2488 对齐）
        motion = {}
        try:
            cfg_path = Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting' / 'MKP standard.json'
            if cfg_path.exists():
                with open(cfg_path, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
                ij = cfg.get('inkjet', {})
                off = ij.get('offset', {})
                motion['offset_x'] = float(off.get('x', 0))
                motion['offset_y'] = float(off.get('y', 0))
                motion['inkjet_density'] = int(float(ij.get('density', 0.5)) * 100)
                motion['print_speed'] = float(ij.get('speed', 50))
                log.debug(f"[延迟块生成] 运动参数: {motion}")
        except Exception:
            pass

        # 收集所有图层 PNG — 从 Preview/ 目录读取（层图片在 Preview/ 下，不在 Segment/ 里）
        preview_dir = os.path.join(os.path.dirname(self._segments_dir), 'Preview')
        preview = Path(preview_dir)
        if not preview.is_dir():
            log.warning(f"[延迟块生成] Preview 目录不存在: {preview_dir}")
            return
        pngs = sorted(preview.glob('*.png'))

        if not pngs:
            log.warning("[延迟块生成] 未找到图层 PNG，跳过")
            return

        log.info(f"[延迟块生成] 共 {len(pngs)} 层，2 线程")

        futures = {}
        for png in pngs:
            layer_dir = os.path.join(self._segments_dir, '_temp', png.stem)
            os.makedirs(layer_dir, exist_ok=True)
            fut = self._executor.submit(
                generate_blocks_for_layer, str(png), layer_dir, motion
            )
            futures[png.stem] = fut

        total_blocks = 0
        total_skipped = 0
        for name, fut in futures.items():
            try:
                r = fut.result()
                total_blocks += r.get('blocks', 0)
                total_skipped += r.get('skipped', 0)
            except Exception as e:
                log.error(f"[延迟块生成] {name} 失败: {e}")

        elapsed = time.time() - start
        log.info(
            f"[延迟块生成] 完成 {total_blocks} 块"
            + (f" (跳过 {total_skipped})" if total_skipped else "")
            + f"  耗时 {elapsed:.1f}s"
        )


# ============================================================
# 核心监控逻辑
# ============================================================
class ConsoleMonitor:
    """Moonraker 控制台监听 + mBrush 指挥

    解析 Klipper RESPOND 命令：
      // upload pic=/layer_0001/00000.mbd  → 从缓存取出 .mbd 并上传到 mBrush
      // print pic=/layer_0001/00000.mbd  → 触发打印
    """

    def __init__(self, moonraker_host, moonraker_port, mbrush_host, segments_dir,
                 status_callback=None, respond_delay=0.0):
        self.ws_url = f"ws://{moonraker_host}:{moonraker_port}/websocket"
        self.moonraker_host = moonraker_host
        self.moonraker_port = moonraker_port
        self.mbrush = MBrushClient(mbrush_host)
        self.segments_dir = segments_dir
        self.status_callback = status_callback or (lambda s: None)
        self.ws = None
        self.running = False
        self.thread = None
        self.current_trigger = None
        self.trigger_count = 0
        self.last_status = "等待连接..."
        self._detected_files = {}  # cache: filename -> full path
        self._mbd_cache = {}       # cache: "layer_XXXX/00000.mbd" -> bytes
        self._print_done = threading.Event()   # 上一块打印完成信号，初始已就绪
        self._print_done.set()
        self._speed_set = False     # 匀速模式只设一次（首次上传前）
        self._respond_delay = respond_delay  # Klipper look-ahead 补偿延迟(秒)
        self._seen_responses = set()  # 去重: 已处理的 RESPOND 内容，防止 WebSocket 全量历史重复触发
        self._deferred_gen = None  # 延迟块生成器（首次 File selected 后才创建）
        self._refresh_file_cache()

    def _refresh_file_cache(self):
        """扫描 segments 目录，建立 filename → path 映射，并加载已转换的 .mbd"""
        if not self.segments_dir or not os.path.isdir(self.segments_dir):
            return
        self._detected_files.clear()
        for root, dirs, files in os.walk(self.segments_dir):
            for f in files:
                # 跳过非 PNG 文件
                if not f.lower().endswith('.png'):
                    continue
                # 跳过 timing.json 等
                if f in ('timing.json',):
                    continue
                full = os.path.join(root, f)
                # 用文件名做 key
                self._detected_files[f] = full
                # 相对路径 key（统一用 / 分隔符）
                rel = os.path.relpath(full, self.segments_dir).replace('\\', '/')
                self._detected_files[rel] = full
                # 去掉 _temp/ 前缀的 key（RESPOND 命令不带 _temp/）
                if rel.startswith('_temp/'):
                    self._detected_files[rel[6:]] = full

        # 加载已由 strip worker 生成的 .mbd 文件到 _mbd_cache
        mbd_loaded = 0
        for root, dirs, files in os.walk(self.segments_dir):
            for f in files:
                if not f.lower().endswith('.mbd'):
                    continue
                full = os.path.join(root, f)
                rel = os.path.relpath(full, self.segments_dir).replace('\\', '/')
                # _mbd_cache key 保持 .mbd 后缀（与 RESPOND 命令一致）
                cache_key = rel
                if cache_key in self._mbd_cache:
                    continue  # 已缓存
                try:
                    with open(full, 'rb') as _f:
                        self._mbd_cache[cache_key] = _f.read()
                    mbd_loaded += 1
                except Exception:
                    pass
                # 去掉 _temp/ 前缀的变体 key
                if rel.startswith('_temp/'):
                    alt_key = rel[6:]
                    if alt_key not in self._mbd_cache:
                        self._mbd_cache[alt_key] = self._mbd_cache.get(cache_key)

        log.info(f"文件缓存: {len(self._detected_files)} 个 PNG, {mbd_loaded} 个 MBD 已加载")


    @staticmethod
    def _calc_period_us():
        """从 JSON 打印配置读取喷墨速度，计算 mBrush 匀速 period_us。
        
        参考 print_strips.py #83-84: set_conf&conf=period_us%3D{val}%26strength%3D20
        600 DPI (dpi_step=2): period_us = 42333 / speed_mm_s
        """
        inkjet_speed = 50  # default
        try:
            cfg_path = Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting' / 'MKP standard.json'
            if cfg_path.exists():
                with open(cfg_path, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
                inkjet_speed = cfg.get('inkjet', {}).get('speed', 50)
        except Exception:
            pass
        period_us = round(42333.0 / inkjet_speed)
        log.info(f"mBrush 匀速模式: speed={inkjet_speed} mm/s → period_us={period_us}")
        return period_us

    def _handle_upload(self, pic_path):
        """上传 + sync + key=0 + key=1(ARM) → 900ms 计时器自动开火

        对齐 print_strips.py L87-99，但合并开火为内置计时器（无需 RESPOND print）
        rm_upload → key=3 → HTTP POST → sync → key=0 → key=1(ARM) → 900ms → key=1(FIRE) → st=0
        """
        t_start = time.time()
        log.info(f"[上传] {pic_path}")

        # 从缓存取出 MBD（延迟生成模式下，MBD 可能尚未生成完毕，轮询等待最多 3 秒）
        deadline = time.time() + 3.0
        mbd_data = None
        while time.time() < deadline:
            self._refresh_file_cache()
            mbd_data = self._mbd_cache.get(pic_path)
            if mbd_data:
                break
            if self.segments_dir:
                disk_path = os.path.join(self.segments_dir, pic_path)
                if os.path.isfile(disk_path):
                    try:
                        with open(disk_path, 'rb') as _f:
                            mbd_data = _f.read()
                        self._mbd_cache[pic_path] = mbd_data
                        log.info(f"  从磁盘直接加载: {disk_path}")
                        break
                    except Exception:
                        pass
            time.sleep(0.2)
        if not mbd_data:
            log.warning(f"  MBD 缓存未命中: {pic_path}")
            return

        # 等待上一块打印完成
        self._print_done.wait()
        self._print_done.clear()

        self.status_callback(f"上传: {os.path.basename(pic_path)}")

        # == 对齐 png2mbd.py upload_mbd(): rm_upload → key=3 → POST ==
        self.mbrush.rm_upload()
        time.sleep(0.15)
        self.mbrush.reset_index()
        time.sleep(0.15)

        # HTTP 上传
        try:
            boundary = "----Mb"
            body = (
                f"--{boundary}\r\n"
                'Content-Disposition: form-data; name="pos"\r\n\r\n0\r\n'
                f"--{boundary}\r\n"
                'Content-Disposition: form-data; name="file"; filename="0.mbd"\r\n'
                'Content-Type: application/octet-stream\r\n\r\n'
            ).encode() + mbd_data + f"\r\n--{boundary}--\r\n".encode()

            conn = http.client.HTTPConnection(self.mbrush.host, 80, timeout=30)
            conn.request("POST", "/cgi-bin/upload", body=body,
                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
            resp = json.loads(conn.getresponse().read())
            conn.close()
            ok = resp.get("status") == "ok"
        except Exception as e:
            err_msg = f"上传请求失败: {e}"
            log.warning(f"  {err_msg}")
            self.status_callback(err_msg)
            ok = False

        if not ok:
            log.warning(f"  上传失败: {pic_path}")
            self._print_done.set()
            return

        log.info(f"  上传完成: {pic_path}")
        # 上传完成即释放下一块（GCode MBRUSH_START 宏负责触发打印机）
        self._print_done.set()

    def _handle_print(self, pic_path):
        """已废弃 — upload 不再模拟触发，由 GCode MBRUSH_START 宏负责。"""
        pass

    def _start_deferred_blocks(self):
        """启动延迟块生成（后台线程，2 线程池限制 CPU）。只在 segments_dir 有效时触发。"""
        if not self.segments_dir or not os.path.isdir(self.segments_dir):
            return
        if self._deferred_gen is None:
            self._deferred_gen = _DeferredBlockGenerator(self.segments_dir)
        self._deferred_gen.start()

    def on_message(self, ws, message):
        try:
            data = json.loads(message)
            method = data.get("method", "")

            if method == "notify_gcode_response":
                text = data.get("params", [""])[0].strip()

                # 移除所有已知的 Klipper 控制台前缀（//、echo:、!!）
                content = text
                for prefix in ("//", "echo:", "!!"):
                    if content.startswith(prefix):
                        content = content[len(prefix):].strip()
                        break

                if not content or content.startswith("Klipper state"):
                    return

                # 去重：WebSocket 每次连接可能推送全量历史，只处理首次出现的命令
                if content in self._seen_responses:
                    return
                self._seen_responses.add(content)

                # 检测打印开始：Klipper 选择 GCode 文件后启动延迟块生成
                if content.startswith("File selected"):
                    log.info(f"[延迟块生成] 检测到打印开始: {content!r}")
                    self._start_deferred_blocks()
                    return

                # 喷嘴冲洗：长按 key=2
                if content == "clean_nozzle":
                    log.info("[冲洗喷嘴] 长按 key=2")
                    self.status_callback("冲洗喷嘴...")
                    threading.Thread(
                        target=self.mbrush.simulate_key,
                        args=(2,),
                        daemon=True,
                    ).start()
                    return

                # 上传单张图片: upload pic=/layer_XXXX/YYYYY.png
                if content.startswith("upload pic=/"):
                    if self._respond_delay > 0:
                        time.sleep(self._respond_delay)
                    pic_path = content[len("upload pic=/"):].strip()
                    if pic_path:
                        self.current_trigger = content
                        threading.Thread(
                            target=self._handle_upload,
                            args=(pic_path,),
                            daemon=True,
                        ).start()
                    return

            elif method == "notify_klippy_ready":
                self.status_callback("Klipper 就绪")

            elif method == "notify_klippy_shutdown":
                self.status_callback("Klipper 已关闭")

            elif method == "notify_klippy_disconnected":
                self.status_callback("Klipper 断开")

        except Exception as e:
            log.debug(f"消息解析错误: {e}")

    def on_error(self, ws, error):
        log.error(f"WebSocket 错误: {error}")
        self.status_callback("连接错误")

    def on_close(self, ws, close_code, close_msg):
        log.warning(f"WebSocket 断开: code={close_code}")
        self.status_callback("连接断开")

    def on_open(self, ws):
        log.info("WebSocket 已连接")
        self.status_callback("已连接到 Klipper")

        # 连接后立即设置匀速模式（参考 print_strips.py L83-84）
        # 必须在任何 RESPOND 命令到达之前完成，避免模式切换触发意外打印
        if not self._speed_set:
            self._speed_set = True
            period_us = ConsoleMonitor._calc_period_us()
            self.mbrush.set_constant_speed(period_us)
            time.sleep(0.05)

    def _run_ws(self):
        """WebSocket 主循环（在独立线程中运行）"""
        self.ws = websocket.WebSocketApp(
            self.ws_url,
            on_open=self.on_open,
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close,
        )

        while self.running:
            try:
                self.ws.run_forever(ping_interval=10, ping_timeout=5)
            except Exception as e:
                if self.running:
                    log.warning(f"WebSocket 异常，3秒后重连: {e}")
                    self.status_callback("重连中...")
                    time.sleep(3)

    def start(self):
        """启动监控"""
        self.running = True
        self.thread = threading.Thread(target=self._run_ws, daemon=True)
        self.thread.start()
        log.info(f"监控启动: {self.ws_url}")

    def stop(self):
        """停止监控"""
        self.running = False
        if self.ws:
            self.ws.close()
        if self.thread:
            self.thread.join(timeout=3)
        log.info("监控已停止")


# ============================================================
# 托盘图标生成
# ============================================================
def _get_icon_path():
    """获取程序图标路径"""
    if getattr(sys, 'frozen', False):
        base_dirs = [sys._MEIPASS, os.path.join(sys._MEIPASS, '_internal')]
    else:
        base_dirs = [os.path.dirname(os.path.abspath(__file__))]
    for base_dir in base_dirs:
        ico = os.path.join(base_dir, 'MKPSpectrum.ico')
        if os.path.exists(ico):
            return ico
        # 备用：搜索同目录 .ico
        try:
            for f in os.listdir(base_dir):
                if f.lower().endswith('.ico'):
                    return os.path.join(base_dir, f)
        except Exception:
            pass
    return None


def create_tray_icon_image(status="idle"):
    """生成托盘图标，优先加载 MKPSpectrum.ico"""
    ico_path = _get_icon_path()
    if ico_path:
        try:
            img = Image.open(ico_path)
            img = img.resize((32, 32), Image.LANCZOS)
            return img
        except Exception:
            pass
    
    # 备用：纯色方块图标
    size = 32
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    colors = {
        "idle": (128, 128, 128),
        "connected": (0, 180, 0),
        "active": (0, 120, 255),
        "error": (255, 50, 50),
    }
    color = colors.get(status, colors["idle"])

    margin = 2
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=6,
        fill=color,
    )

    cx, cy = size // 2, size // 2
    r = 4
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255))

    return img


# ============================================================
# 主程序
# ============================================================
class TrayApp:
    def __init__(self, args, restore_callback=None):
        self.args = args
        self.icon = None
        self.monitor = None
        self.status_text = "初始化..."
        self.status_icon = "idle"
        self.restore_callback = restore_callback  # 恢复主窗口的回调

        # 解析 Moonraker 地址
        host_port = args.moonraker.split(":")
        self.mr_host = host_port[0]
        self.mr_port = int(host_port[1]) if len(host_port) > 1 else 7125

        # mBrush 地址
        self.mbrush_host = (args.mbrush or '').strip()
        if not self.mbrush_host:
            log.error("mBrush 地址未配置！请在打印机设置中填写 headAddress，或通过 --mbrush 参数指定")
            raise ValueError("mBrush 地址为空，无法启动")

        # segments 目录
        self.segments_dir = find_segments_dir(args.segments_dir)
        if not self.segments_dir:
            log.warning("未找到 segments 目录，将使用临时搜索路径")

        # Klipper look-ahead 补偿延迟
        self.respond_delay = args.respond_delay / 1000.0  # ms -> s

    def _update_status(self, text):
        self.status_text = text
        if self.icon:
            self.icon.title = f"Fluidd Monitor\n{text}"

    def _update_icon(self, status):
        self.status_icon = status
        if self.icon:
            self.icon.icon = create_tray_icon_image(status)

    def _on_status(self, text):
        """状态回调（从监控线程）"""
        self._update_status(text)
        if "失败" in text or "错误" in text:
            self._update_icon("error")
        elif "转换" in text or "上传" in text or "触发" in text or "完成" in text:
            self._update_icon("active")
        else:
            self._update_icon("connected")

    def _start_monitor(self):
        """启动控制台监控"""
        self.monitor = ConsoleMonitor(
            moonraker_host=self.mr_host,
            moonraker_port=self.mr_port,
            mbrush_host=self.mbrush_host,
            segments_dir=self.segments_dir,
            status_callback=self._on_status,
            respond_delay=self.respond_delay,
        )
        self.monitor.start()
        self._update_icon("connected")
        self._update_status("已连接到 Klipper")

    def _stop_monitor(self):
        if self.monitor:
            self.monitor.stop()
            self.monitor = None
        self._update_icon("idle")
        self._update_status("已停止")

    def _exit(self, icon, item=None):
        self._stop_monitor()
        if icon:
            icon.stop()
        log.info("程序退出")

    def _restore_main_window(self, icon=None, item=None):
        """打开主窗口"""
        try:
            import ctypes
            hwnd = ctypes.windll.user32.FindWindowW(None, 'MKPSpectrum - 3D热床预览')
            if hwnd:
                ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                ctypes.windll.user32.SetForegroundWindow(hwnd)
                log.info("已恢复主窗口")
            elif self.restore_callback:
                self.restore_callback()
        except Exception as e:
            log.error(f"恢复主窗口失败: {e}")

    def _show_status(self, icon=None, item=None):
        """显示当前状态弹窗（独立线程避免与 pystray 消息循环冲突）"""
        msg = (
            f"Moonraker: {self.mr_host}:{self.mr_port}\n"
            f"mBrush: {self.mbrush_host}\n"
            f"Segments: {self.segments_dir or '未找到'}\n"
            f"状态: {self.status_text}\n"
            f"已触发: {self.monitor.trigger_count if self.monitor else 0} 次"
        )
        import threading
        def _show():
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "Fluidd Monitor 状态", 0x40)
        t = threading.Thread(target=_show, daemon=True)
        t.start()

    def run(self):
        """启动托盘应用"""
        if not _PYSTRAY_AVAILABLE:
            log.warning("pystray 未安装，无法创建托盘图标")
            return

        icon_image = create_tray_icon_image("idle")

        # 构建菜单
        menu = pystray.Menu(
            pystray.MenuItem("打开主窗口", self._restore_main_window),
            pystray.MenuItem("状态", self._show_status),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", self._exit),
        )

        self.icon = pystray.Icon(
            "fluidd_monitor",
            icon_image,
            "Fluidd Console Monitor",
            menu=menu,
        )

        # 启动监控
        self._start_monitor()

        # 进入托盘主循环
        self.icon.run()


def main():
    parser = argparse.ArgumentParser(description="Fluidd 控制台监听 + mBrush 指挥 托盘程序")
    parser.add_argument("--moonraker", default=DEFAULT_MOONRAKER,
                        help=f"Moonraker 地址:端口 (默认: {DEFAULT_MOONRAKER})")
    parser.add_argument("--mbrush", default=DEFAULT_MBRUSH,
                        help="mBrush 地址（必填，如 192.168.1.11）")
    parser.add_argument("--segments-dir", default=None,
                        help="segments PNG 解压目录（默认自动查找）")
    parser.add_argument("--work-dir", default=None,
                        help="dpconv 工作目录（默认 Documents/MKPSpectrum/Temp/mbrush_work）")
    parser.add_argument("--respond-delay", default=0, type=int,
                        help="RESPOND 命令延迟处理(ms),补偿 Klipper look-ahead (默认: 0，配合 M400)")
    args = parser.parse_args()

    if not args.mbrush or not args.mbrush.strip():
        log.error("mBrush 地址未配置！请通过 --mbrush 参数指定（如 --mbrush 192.168.1.11）")
        sys.exit(1)

    log.info("=" * 50)
    log.info("Fluidd 控制台监听 + mBrush 指挥 托盘程序")
    log.info(f"Moonraker: {args.moonraker}")
    log.info(f"mBrush: {args.mbrush}")
    log.info(f"Segments dir: {args.segments_dir or '自动查找'}")
    log.info(f"按 Ctrl+C 或点击托盘菜单退出")
    log.info("=" * 50)

    app = TrayApp(args)

    # 处理 Ctrl+C
    def sig_handler(sig, frame):
        log.info("收到退出信号")
        app._exit(app.icon)

    signal.signal(signal.SIGINT, sig_handler)
    signal.signal(signal.SIGTERM, sig_handler)

    app.run()


if __name__ == "__main__":
    main()
