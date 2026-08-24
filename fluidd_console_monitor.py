"""
Fluidd 控制台实时监控脚本
通过 Moonraker API 获取 Klipper 控制台输出，实时显示。
支持两种模式：
  - ws (WebSocket): 实时推送，推荐
  - poll (HTTP轮询): 纯内置库，无需安装依赖

用法:
  python fluidd_console_monitor.py                # 默认 ws 模式
  python fluidd_console_monitor.py --mode poll    # HTTP 轮询模式
  python fluidd_console_monitor.py --host 192.168.1.10
"""

import json
import sys
import time
import argparse
from datetime import datetime

MOONRAKER_HOST = "192.168.1.10"
MOONRAKER_PORT = 7125


def format_time(ts):
    """Unix timestamp -> HH:MM:SS"""
    if ts:
        return datetime.fromtimestamp(ts).strftime("%H:%M:%S")
    return "--:--:--"


def fmt_msg(msg_type, text, ts=None):
    """格式化一行控制台消息"""
    t = format_time(ts)
    tag = "[CMD]" if msg_type == "command" else "[>>] "
    return f"{t} {tag} {text.strip()}"


# ============================================================
# 模式1: HTTP 轮询
# ============================================================
class HttpPoller:
    def __init__(self, host, port):
        self.base = f"http://{host}:{port}"
        self.seen_times = set()  # 用时间戳去重

    def check_connection(self):
        """检查 Moonraker 是否可达"""
        import urllib.request
        try:
            req = urllib.request.Request(f"{self.base}/server/info")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                state = data.get("result", {}).get("klippy_state", "unknown")
                print(f"[连接成功] Klippy 状态: {state}")
                return True
        except Exception as e:
            print(f"[连接失败] {e}")
            return False

    def fetch_recent(self, count=50):
        """拉取最近的 gcode_store"""
        import urllib.request
        try:
            url = f"{self.base}/server/gcode_store?count={count}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                store = data.get("result", {}).get("gcode_store", [])
                return store
        except Exception as e:
            print(f"[请求失败] {e}")
            return []

    def print_new(self, store):
        """打印尚未见过的消息"""
        for item in store:
            ts = item.get("time")
            if ts not in self.seen_times:
                self.seen_times.add(ts)
                print(fmt_msg(item.get("type", "?"), item.get("message", ""), ts))

    def run(self, interval=1.0):
        print(f"模式: HTTP 轮询 (间隔 {interval}s)")
        if not self.check_connection():
            return

        # 先拉取当前缓存，只显示最后10条作为上下文
        initial = self.fetch_recent(50)
        if initial:
            for item in initial[-10:]:
                self.seen_times.add(item.get("time"))
                print(fmt_msg(item.get("type", "?"), item.get("message", ""), item.get("time")))
            print("--- 以上为历史记录，开始实时监控 ---")

        while True:
            try:
                store = self.fetch_recent(50)
                self.print_new(store)
            except KeyboardInterrupt:
                raise
            except Exception as e:
                print(f"[轮询错误] {e}")
            time.sleep(interval)


# ============================================================
# 模式2: WebSocket 实时推送
# ============================================================
class WebSocketMonitor:
    def __init__(self, host, port):
        self.url = f"ws://{host}:{port}/websocket"
        self.running = True

    def on_open(self, ws):
        print(f"[WebSocket 已连接] {self.url}")

    def on_message(self, ws, message):
        try:
            data = json.loads(message)
            method = data.get("method", "")

            if method == "notify_gcode_response":
                # params[0] 是 gcode 响应字符串
                text = data.get("params", [""])[0]
                print(f"{format_time(time.time())} [>>] {text.strip()}")

            elif method == "notify_klippy_ready":
                print(f"{format_time(time.time())} [**] Klipper 已就绪")

            elif method == "notify_klippy_shutdown":
                print(f"{format_time(time.time())} [!!] Klipper 已关闭")

            elif method == "notify_klippy_disconnected":
                print(f"{format_time(time.time())} [!!] Klipper 连接断开")

            # 忽略其他通知（status_update 等）
        except Exception:
            pass

    def on_error(self, ws, error):
        print(f"[WebSocket 错误] {error}")

    def on_close(self, ws, close_code, close_msg):
        print(f"[WebSocket 断开] code={close_code}")
        self.running = False

    def run(self):
        try:
            import websocket
        except ImportError:
            print("错误: 需要安装 websocket-client 库")
            print("  pip install websocket-client")
            print("或使用轮询模式: python fluidd_console_monitor.py --mode poll")
            return

        print(f"模式: WebSocket 实时推送")
        print(f"连接到 {self.url} ...")

        self.ws = websocket.WebSocketApp(
            self.url,
            on_open=self.on_open,
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close,
        )

        while self.running:
            try:
                self.ws.run_forever(ping_interval=10, ping_timeout=5)
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"[重连中...] {e}")
                time.sleep(3)


# ============================================================
# 主入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="Fluidd 控制台实时监控")
    parser.add_argument("--host", default=MOONRAKER_HOST, help=f"Moonraker 主机地址 (默认: {MOONRAKER_HOST})")
    parser.add_argument("--port", type=int, default=MOONRAKER_PORT, help=f"Moonraker 端口 (默认: {MOONRAKER_PORT})")
    parser.add_argument("--mode", choices=["ws", "poll"], default="ws",
                        help="监控模式: ws=WebSocket实时推送, poll=HTTP轮询 (默认: ws)")
    parser.add_argument("--interval", type=float, default=1.0,
                        help="轮询间隔秒数 (仅 poll 模式, 默认: 1.0)")
    args = parser.parse_args()

    print(f"Fluidd 控制台监控 - Moonraker @ {args.host}:{args.port}")
    print("按 Ctrl+C 停止\n")

    if args.mode == "poll":
        monitor = HttpPoller(args.host, args.port)
        monitor.run(interval=args.interval)
    else:
        monitor = WebSocketMonitor(args.host, args.port)
        try:
            monitor.run()
        except KeyboardInterrupt:
            print("\n[已停止]")

    sys.stdout.flush()


if __name__ == "__main__":
    main()
