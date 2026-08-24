# Run a shell command via gcode (with built-in mbrush_upload / flush / unzip_temp)
#
# Copyright (C) 2019  Eric Callahan <arksine.code@gmail.com>
# Modified: built-in mbrush_upload & mbrush_flush & unzip_temp for MKPSpectrum
#
# This file may be distributed under the terms of the GNU GPLv3 license.
import logging
import json
import os
import shlex
import subprocess
import time as _time

import http.client

GCodes_Dir = "/home/lava/printer_data/gcodes"
BOUNDARY = "----Mb"


def _mbrush_api(host, cmd, **params):
    """GET mBrush CGI 接口，返回解析后的 JSON"""
    qs = "&".join([f"{k}={v}" for k, v in params.items()])
    url = f"/cgi-bin/cmd?cmd={cmd}"
    if qs:
        url += "&" + qs
    conn = http.client.HTTPConnection(host, 80, timeout=10)
    conn.request("GET", url)
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return json.loads(body)


def _mbrush_post_mbd(host, file_path):
    """HTTP POST multipart 上传单个 MBD 文件到 mBrush"""
    with open(file_path, "rb") as f:
        data = f.read()
    body = (
        f"--{BOUNDARY}\r\n"
        'Content-Disposition: form-data; name="pos"\r\n\r\n0\r\n'
        f"--{BOUNDARY}\r\n"
        'Content-Disposition: form-data; name="file"; filename="0.mbd"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{BOUNDARY}--\r\n".encode()

    headers = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"}
    conn = http.client.HTTPConnection(host, 80, timeout=30)
    conn.request("POST", "/cgi-bin/upload", body=body, headers=headers)
    resp = conn.getresponse()
    result = json.loads(resp.read())
    conn.close()
    return result.get("status") == "ok"


class ShellCommand:
    def __init__(self, config):
        self.name = config.get_name().split()[-1]
        self.printer = config.get_printer()
        self.gcode = self.printer.lookup_object("gcode")

        # 判断是否为内置命令
        if self.name in ("mbrush_upload", "mbrush_flush", "clean_gcode"):
            self._run = self._cmd_builtin
            self.is_builtin = True
            self.command = [self.name]
            if self.name == "mbrush_upload":
                self.timeout = config.getfloat("timeout", 30.0, above=0.0)
            elif self.name == "mbrush_flush":
                self.timeout = config.getfloat("timeout", 5.0, above=0.0)
            elif self.name == "clean_gcode":
                self.timeout = config.getfloat("timeout", 10.0, above=0.0)
        else:
            self._run = self._cmd_run_shell
            self.is_builtin = False
            cmd = config.get("command")
            cmd = os.path.expanduser(cmd)
            cmd = os.path.expandvars(cmd)
            self.command = shlex.split(cmd)
            self.timeout = config.getfloat("timeout", 2.0, above=0.0)

        self.verbose = config.getboolean("verbose", True)
        self.proc_fd = None
        self.partial_output = ""

        self.gcode.register_mux_command(
            "RUN_SHELL_COMMAND",
            "CMD",
            self.name,
            self.cmd_RUN_SHELL_COMMAND,
            desc=self.cmd_RUN_SHELL_COMMAND_help,
        )

    def _respond(self, msg):
        """安全输出到终端"""
        try:
            self.gcode.respond_info(msg)
        except Exception:
            pass

    # --------------- built-in: mbrush_upload ---------------
    def _builtin_upload(self, params):
        """上传、预热并触发打印
        rm_upload → key=3 → POST → sync → key=0 → key=1(ARM) → key=1(FIRE)
        匀速模式由 MBRUSH_FLUSH 预先设置"""
        gcode_params = params.get("PARAMS", "")
        parts = shlex.split(gcode_params)
        if len(parts) < 2:
            raise self.gcode.error(
                "mbrush_upload: need PARAMS='<ip> <relative_file_path>'"
            )
        host = parts[0]
        rel_path = parts[1]
        full_path = os.path.join(GCodes_Dir, "_temp", rel_path)
        if not os.path.isfile(full_path):
            raise self.gcode.error(
                "mbrush_upload: file not found: %s" % full_path
            )
        self._respond("upload: %s" % rel_path)

        # 阶段1: 上传
        _mbrush_api(host, "rm_upload")
        _time.sleep(0.3)
        _mbrush_api(host, "simulate", key=3)
        _time.sleep(0.3)

        if not _mbrush_post_mbd(host, full_path):
            raise self.gcode.error(
                "mbrush_upload: POST failed for %s" % rel_path
            )

        _mbrush_api(host, "sync")
        _time.sleep(0.3)

        # 阶段2: 重载配置 + 加载数据到 RAM → FIRE
        _mbrush_api(host, "simulate", key=0)
        _time.sleep(0.3)
        _mbrush_api(host, "simulate", key=1)
        self._respond("preheat: %s" % rel_path)
        _mbrush_api(host, "simulate", key=1)
        self._respond("fire: %s" % rel_path)

    # --------------- built-in: mbrush_flush ---------------
    def _builtin_flush(self, params):
        """切换匀速模式并冲洗喷嘴（set_conf→key=2 长按冲洗）"""
        gcode_params = params.get("PARAMS", "")
        parts = shlex.split(gcode_params)
        if len(parts) < 2:
            raise self.gcode.error(
                "mbrush_flush: need PARAMS='<ip> <speed>'"
            )
        host = parts[0]
        speed = int(parts[1])
        period_us = round(41776.0 / speed)

        # set_conf 隐含 key=0，设置匀速模式供后续 upload 使用
        _mbrush_api(host, "set_conf",
                    conf=f"period_us%3D{period_us}%26strength%3D20")
        self._respond(f"flush: speed={speed}mm/s period={period_us}us")
        _time.sleep(0.3)
        _mbrush_api(host, "simulate", key=2)
        self._respond("flush done")

    # --------------- built-in: clean_gcode ---------------
    def _builtin_clean_gcode(self, params):
        """清理 Gcodes 目录下旧的 2D_flat_print_*.gcode 文件（大小写不敏感，保留当前占用中的）"""
        gcodes_dir = "/home/lava/printer_data/gcodes"
        prefix = "2d_flat_print_"
        ext = ".gcode"
        candidates = []
        try:
            for fname in os.listdir(gcodes_dir):
                lower = fname.lower()
                if lower.startswith(prefix) and lower.endswith(ext):
                    candidates.append(os.path.join(gcodes_dir, fname))
        except OSError:
            candidates = []
        files = sorted(candidates, key=os.path.getmtime, reverse=True)
        self._respond(f"clean_gcode: found {len(files)} file(s)")
        for fpath in files:
            try:
                os.remove(fpath)
                self._respond(f"  removed: {os.path.basename(fpath)}")
            except OSError:
                self._respond(f"  skip (in use): {os.path.basename(fpath)}")
        self._respond("clean_gcode: done")

    # --------------- dispatch ---------------
    _BUILTIN = {
        "mbrush_upload": "_builtin_upload",
        "mbrush_flush": "_builtin_flush",
        "clean_gcode": "_builtin_clean_gcode",
    }

    def _cmd_builtin(self, params):
        name = self._BUILTIN[self.name]
        getattr(self, name)(params)

    # --------------- normal shell command ---------------
    def _cmd_run_shell(self, params):
        gcode_params = params.get("PARAMS", "")
        gcode_params = shlex.split(gcode_params)
        reactor = self.printer.get_reactor()
        try:
            proc = subprocess.Popen(
                self.command + gcode_params,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
        except Exception:
            logging.exception(
                "shell_command: Command {%s} failed" % (self.name)
            )
            raise self.gcode.error("Error running command {%s}" % (self.name))
        if self.verbose:
            self.proc_fd = proc.stdout.fileno()
            self._respond("Running Command {%s}...:" % (self.name))
            hdl = reactor.register_fd(self.proc_fd, self._process_output)
        eventtime = reactor.monotonic()
        endtime = eventtime + self.timeout
        complete = False
        while eventtime < endtime:
            eventtime = reactor.pause(eventtime + 0.05)
            if proc.poll() is not None:
                complete = True
                break
        if not complete:
            proc.terminate()
        if self.verbose:
            if self.partial_output:
                self._respond(self.partial_output)
                self.partial_output = ""
            if complete:
                msg = "Command {%s} finished\n" % (self.name)
            else:
                msg = "Command {%s} timed out" % (self.name)
            self._respond(msg)
            reactor.unregister_fd(hdl)
            self.proc_fd = None

    def _process_output(self, eventime):
        if self.proc_fd is None:
            return
        try:
            data = os.read(self.proc_fd, 4096)
        except Exception:
            pass
        data = self.partial_output + data.decode()
        if "\n" not in data:
            self.partial_output = data
            return
        elif data[-1] != "\n":
            split = data.rfind("\n") + 1
            self.partial_output = data[split:]
            data = data[:split]
        else:
            self.partial_output = ""
        self._respond(data)

    cmd_RUN_SHELL_COMMAND_help = "Run a linux shell command"

    def cmd_RUN_SHELL_COMMAND(self, params):
        return self._run(params)


def load_config_prefix(config):
    return ShellCommand(config)
