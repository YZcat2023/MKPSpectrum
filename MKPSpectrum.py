import os
import sys

# 隐藏 pyinstaller console=True 模式下的控制台窗口
if sys.platform == 'win32' and getattr(sys, 'frozen', False):
    try:
        import ctypes as _ctypes
        _ctypes.windll.user32.ShowWindow(_ctypes.windll.kernel32.GetConsoleWindow(), 0)
    except Exception:
        pass

# PyInstaller frozen 环境：必须在主进程中调用 freeze_support，
# 否则后续任何库导入 multiprocessing 时可能出现不完整初始化。
# WebView2 COM 冲突已通过延迟 import webview 到 __main__ 中规避。
if getattr(sys, 'frozen', False):
    import multiprocessing
    multiprocessing.freeze_support()


# ── CLI 模式：OrcaSlicer 后处理调用（无 GUI，进度写文件回传主程序）────
def _run_headless_postprocess():
    """由 OrcaSlicer 调用的后台后处理：
    MKPSpectrum.exe --Config 'xxx.json' --Gcode 'xxx.gcode'
    1. 读取 pending_slice.json 获取 OBJ 路径
    2. 纹理切片 + 条带切割
    3. GCode 后处理（插入喷墨命令）
    4. 进度写入 progress.json，主 GUI 轮询
    """
    import argparse, json as _json, sys as _sys, traceback as _tb, tempfile as _tempfile, datetime as _dt, shutil as _shutil
    import logging as _logging
    from pathlib import Path as _Path
    # sys.stderr 在无控制台的 PyInstaller EXE 中可能是 None，用日志文件代替
    _log_dir = _Path.home() / 'Documents' / 'MKPSpectrum' / 'logs'
    _log_dir.mkdir(parents=True, exist_ok=True)
    _log_path = _log_dir / f'headless_{_dt.datetime.now().strftime("%Y%m%d_%H%M%S")}.log'
    _logger = _logging.getLogger('headless')
    _logger.setLevel(_logging.DEBUG)
    _fh = _logging.FileHandler(_log_path, encoding='utf-8')
    _fh.setFormatter(_logging.Formatter('%(asctime)s [%(levelname)s] %(message)s'))
    _logger.addHandler(_fh)
    _logger.info('Headless mode started, args: %s', _sys.argv)
    _log = lambda msg: (_logger.info(msg), None)[1]  # 安全日志函数

    _parser = argparse.ArgumentParser()
    _parser.add_argument('--Config', type=str, nargs='?', default='MKP standard')
    _parser.add_argument('--Gcode', type=str, default=None)
    _parser.add_argument('--debug', action='store_true', default=False)
    _args, _unknown = _parser.parse_known_args()
    # OrcaSlicer 在 --Gcode 之后追加 GCode 路径，_unknown 第一个就是
    _gcode_path = _args.Gcode
    if not _gcode_path and _unknown:
        for _u in _unknown:
            if not _u.startswith('-') and not _u.startswith('--'):
                _gcode_path = _u
                break
    if not _gcode_path:
        _logger.error('[FATAL] 未收到 GCode 路径')
        _sys.exit(1)
    _debug_mode = bool(_args.debug)
    _logger.info('Debug mode: %s, GCode: %s', _debug_mode, _gcode_path)

    # ── 读取主 GUI 写入的待处理信息（OBJ路径等）──
    _pending_path = _Path.home() / 'Documents' / 'MKPSpectrum' / 'pending_slice.json'
    _obj_path = None
    # 输出到持久化预览目录，而非 Orca 临时目录（主 GUI 从该目录加载预览图）
    _output_dir = str(_Path.home() / 'Documents' / 'MKPSpectrum' / 'Temp' / 'Texture' / 'Preview')
    _layer_height = 0.2
    _resolution = 4000
    _has_pending = False
    if _pending_path.exists():
        try:
            with open(_pending_path, 'r', encoding='utf-8') as _f:
                _pending = _json.load(_f)
            _obj_path = _pending.get('obj')
            _layer_height = _pending.get('layer_height', _layer_height)
            _resolution = _pending.get('resolution', _resolution)
            _has_pending = True
            _logger.info('[后处理] 读取 pending_slice: obj=%s, layer_height=%s, resolution=%s',
                         _obj_path, _layer_height, _resolution)
        except Exception as _ex:
            _logger.warning('[后处理] 读取 pending_slice.json 失败: %s', _ex)

    # ── 确定输出 GCode 名称：MKPS_<OBJ名>.gcode ──
    _gcode_out_dir = _Path.home() / 'Documents' / 'MKPSpectrum' / 'Temp' / 'Gcode'
    _gcode_out_dir.mkdir(parents=True, exist_ok=True)
    if _obj_path:
        _obj_basename = os.path.splitext(os.path.basename(_obj_path))[0]
    else:
        _obj_basename = os.path.splitext(os.path.basename(_gcode_path))[0]
    _gcode_out_name = f'MKPS_{_obj_basename}.gcode'
    _gcode_out_path = str(_gcode_out_dir / _gcode_out_name)

    # ── 将收到的 GCode 复制到输出路径（Orca 传来的可能是 .gcode.pp 等临时扩展名）──
    try:
        _shutil.copy2(_gcode_path, _gcode_out_path)
        _logger.info('[后处理] GCode 已重命名为: %s → %s', os.path.basename(_gcode_path), _gcode_out_path)
    except Exception as _copy_ex:
        _logger.warning('[后处理] GCode 重命名失败: %s', _copy_ex)
        _gcode_out_path = _gcode_path  # 回退

    # ── 进度输出到文件 + 优雅取消检测 ──
    import threading as _th
    import time as _time
    _progress_path = _Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_progress.json'
    _cancel_flag = _Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_cancel.flag'
    _progress_lock = _th.Lock()

    def _write_progress(data):
        with _progress_lock:
            try:
                with open(_progress_path, 'w', encoding='utf-8') as _f:
                    _json.dump(data, _f, ensure_ascii=False)
            except Exception:
                pass

    def _is_cancelled():
        try:
            return _cancel_flag.exists()
        except Exception:
            return False

    # 启动时若残留上次取消标志，先清理，避免一启动就判定为已取消
    # 但若是用户点取消后立即重触发 Orca，后一次启动不应清掉标志；所以只在非 running 状态下清理
    try:
        # 若当前没有进行中的取消流程，清理旧 flag
        pass
    except Exception:
        pass

    _write_progress({'state': 'starting', 'progress': 0, 'total': 0, 'stage': 'init'})

    # 从 GCode 注释中提取真实的层高（优先于 pending_slice.json / 前端传值）
    _gcode_layer_height = None
    try:
        from GCodeGenerator import extract_gcode_params
        _gcode_params_pre = extract_gcode_params(_gcode_out_path)
        _gcode_layer_height = _gcode_params_pre.get('layer_height')
        if _gcode_layer_height:
            _logger.info('[后处理] 从 GCode 读取层高: %.3f', _gcode_layer_height)
    except Exception:
        pass
    if _gcode_layer_height:
        _layer_height = _gcode_layer_height
    else:
        _logger.warning('[后处理] 无法从 GCode 读取层高，使用 pending/默认值: %.3f', _layer_height)

    try:
        gcode_lines_all = []

        if _obj_path and os.path.exists(_obj_path):
            _logger.info('[后处理] 开始纹理切片: obj=%s', _obj_path)
            # ── Stage 1: 纹理切片 + 条带切割 ──
            _write_progress({'state': 'slicing', 'progress': 0, 'total': 0, 'stage': 'texture'})

            from slice_standalone import run_slice

            def _on_progress(msg_type, data):
                if msg_type == 'progress':
                    data['state'] = 'slicing'
                    data['stage'] = 'texture'
                    _write_progress(data)
                elif msg_type == 'stage':
                    _write_progress({'state': 'slicing', 'current': 0, 'total': 0,
                                     'stage': data.get('stage', '')})

            # 读取打印机设置中的喷墨头 IP
            _motion_params = {}
            try:
                with open(_Path.home() / 'Documents' / 'MKPSpectrum' / 'printer_settings.json', 'r', encoding='utf-8') as _f:
                    _ps = _json.load(_f)
                _head_ip = _ps.get('headAddress', '') or '192.168.1.8'
                _motion_params['head_ip'] = _head_ip
            except Exception:
                _motion_params['head_ip'] = '192.168.1.8'

            # 优雅取消：run_slice 内部会轮询 slice_cancel.flag，若用户在纹理切片中点终止，
            # 这里会抛 SliceCancelledError，让 headless 进程自行写 cancelled 并 exit 0（而非被 taskkill 强杀）
            try:
                result = run_slice(
                    obj_path=_obj_path,
                    output_dir=_output_dir,
                    layer_height=_layer_height,
                    resolution=_resolution,
                    do_strip=True,
                    bed_size=270.0,
                    progress_callback=_on_progress,
                    log_callback=lambda msg: None,
                    zip_dir=str(_gcode_out_dir),
                    motion_params=_motion_params,
                    cancel_flag_path=str(_cancel_flag),
                    should_cancel=_is_cancelled,
                )
            except Exception as _cancel_ex:
                # 统一识别取消异常（slice_standalone.SliceCancelledError）
                _is_cancel = _cancel_ex.__class__.__name__ == 'SliceCancelledError' or '已取消' in str(_cancel_ex)
                if _is_cancel or _is_cancelled():
                    _logger.info('[后处理] 收到取消，优雅退出')
                    _write_progress({'state': 'cancelled', 'progress': 0, 'total': 0, 'stage': ''})
                    try:
                        from strip_processor import shutdown_mbd_procs as _sd
                        _sd()
                    except Exception:
                        pass
                    # 清理取消标志，避免下次启动被误判
                    try:
                        _cancel_flag.unlink(missing_ok=True)
                    except Exception:
                        pass
                    _sys.exit(0)
                raise

            gcode_lines_all = result.get('strip_done', {}).get('gcode_lines_all', []) if result.get('strip_done') else []
            if not gcode_lines_all:
                # 若此时已被取消，不报 error，直接优雅退出
                if _is_cancelled():
                    _write_progress({'state': 'cancelled', 'progress': 0, 'total': 0, 'stage': ''})
                    try:
                        _cancel_flag.unlink(missing_ok=True)
                    except Exception:
                        pass
                    _sys.exit(0)
                _logger.error('[后处理] 条带切割未生成喷墨 GCode')
                _write_progress({'state': 'error', 'error': '条带切割未生成喷墨 GCode'})
                _sys.exit(1)
            # 纹理切片完成后、进入 GCode 后处理前再检查一次取消
            if _is_cancelled():
                _logger.info('[后处理] 纹理完成但已取消，跳过 GCode 后处理并优雅退出')
                _write_progress({'state': 'cancelled', 'progress': 0, 'total': 0, 'stage': ''})
                try:
                    _cancel_flag.unlink(missing_ok=True)
                except Exception:
                    pass
                _sys.exit(0)
        else:
            _logger.warning('[后处理] 跳过纹理切片: obj_path=%s 不存在或 pending_slice.json 缺失', _obj_path)

        # 取消检查：跳过纹理后、后处理前也需检查
        if _is_cancelled():
            _write_progress({'state': 'cancelled', 'progress': 0, 'total': 0, 'stage': ''})
            try:
                _cancel_flag.unlink(missing_ok=True)
            except Exception:
                pass
            _sys.exit(0)

        # ── Stage 2: GCode 后处理（无论有无纹理切片都执行）──
        _write_progress({'state': 'postprocessing', 'progress': 100, 'total': 100, 'stage': 'postprocess'})

        # 将层列表转为 dict {layer_num: [gcode_lines]}（0-indexed，与 layer_0000 对齐）
        _inkjet_dict = {}
        for _li, _lines in enumerate(gcode_lines_all, 0):
            if _lines:
                _inkjet_dict[_li] = _lines

        from GCodeGenerator import process_gcode, extract_gcode_params, estimate_print_time
        _params = extract_gcode_params(_gcode_out_path)
        _est = estimate_print_time(_params)
        # 输出：对重命名后的 MKPS_xxx.gcode 做后处理（原地修改）
        # debug 模式额外保存 _debug，否则直接覆盖 MKPS_xxx.gcode
        if _debug_mode:
            _base, _ext = os.path.splitext(_gcode_out_path)
            _final_output = _base + '_debug' + _ext
        else:
            _final_output = _gcode_out_path

        # 从喷墨配置读取取得/放回宏
        _grab_macro = 'GRAB_INKJET_HEAD'
        _release_macro = 'RELEASE_INKJET_HEAD'
        try:
            _config_dir = _Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
            _cfg_raw = _args.Config if _args.Config else 'MKP standard'
            # 如果 --Config 收到的是完整路径，直接用；否则拼 print_settings/xxx.json
            if os.path.isfile(_cfg_raw):
                _cfg_path = _Path(_cfg_raw)
            else:
                _cfg_path = _config_dir / (_cfg_raw + '.json')
            if _cfg_path.exists():
                with open(_cfg_path, 'r', encoding='utf-8') as _cf:
                    _cfg = _json.load(_cf)
                _ij = _cfg.get('inkjet', {})
                _grab_macro = _ij.get('grab_macro', _grab_macro) or _grab_macro
                _release_macro = _ij.get('release_macro', _release_macro) or _release_macro
                _inkjet_speed = _ij.get('speed', 50)
                _repeat_count = int(_ij.get('repeat_count', 1))
                _dry_time = int(_ij.get('dry_time', 3))
        except Exception:
            _inkjet_speed = 50
            _repeat_count = 1
            _dry_time = 3
        # 从 printer_settings.json 读取喷墨机 IP
        _mbrush_ip = '192.168.1.8'
        try:
            _ps_path = _Path.home() / 'Documents' / 'MKPSpectrum' / 'printer_settings.json'
            if _ps_path.exists():
                with open(_ps_path, 'r', encoding='utf-8') as _pf:
                    _ps = _json.load(_pf)
                _mbrush_ip = _ps.get('headAddress', _mbrush_ip) or _mbrush_ip
        except Exception:
            pass
        process_gcode(_gcode_out_path, output_path=_final_output, params=_params, est=_est,
                      grab_macro=_grab_macro, release_macro=_release_macro,
                      inkjet_layers=_inkjet_dict if _inkjet_dict else None,
                      inkjet_speed=_inkjet_speed, mbrush_ip=_mbrush_ip,
                      repeat_count=_repeat_count, dry_time=_dry_time)

        # 把后处理结果复制回 Orca 的原始临时文件路径，让 Orca 认为后处理完成
        if _final_output != _gcode_path:
            try:
                _shutil.copy2(_final_output, _gcode_path)
                _logger.info('[后处理] 结果复制回 Orca 路径: %s', _gcode_path)
            except Exception as _cp_ex:
                _logger.warning('[后处理] 复制回 Orca 路径失败: %s', _cp_ex)

        _write_progress({
            'state': 'done',
            'progress': 100,
            'total': 100,
            'stage': 'done',
            'output': _final_output,
            'total_layers': len(_inkjet_dict),
        })
        _logger.info('[后处理] 完成 → {}'.format(_final_output))

    except SystemExit:
        raise
    except Exception as e:
        # 取消异常已在上层处理为 exit 0，这里只处理真正的错误
        is_cancel = e.__class__.__name__ == 'SliceCancelledError' or '已取消' in str(e)
        if is_cancel or _is_cancelled():
            _write_progress({'state': 'cancelled', 'progress': 0, 'total': 0, 'stage': ''})
            try:
                _cancel_flag.unlink(missing_ok=True)
            except Exception:
                pass
            _sys.exit(0)
        _write_progress({'state': 'error', 'error': str(e)})
        _logger.exception('Error in headless postprocess')
        _sys.exit(1)

    # 正常完成：清理取消标志
    try:
        _cancel_flag.unlink(missing_ok=True)
    except Exception:
        pass
    _sys.exit(0)

# ── 检测 OrcaSlicer 后处理调用 ──
if '--Gcode' in sys.argv:
    _run_headless_postprocess()
    # 不会执行到下面

# ── CLI 模式：MKPSpectrum.exe --mode slice-and-postprocess ────────
# 在 import webview 之前拦截，CLI 子进程不需要 GUI。
def _run_cli_mode():
    """CLI 模式：执行纹理切片 + 条带切割 + GCode 后处理，进度以 JSON 行输出到 stdout。"""
    import argparse
    import json as _json
    import sys as _sys
    import traceback as _tb
    import tempfile as _tempfile
    import logging as _cli_logging
    _cli_logger = _cli_logging.getLogger('cli')
    _cli_logger.setLevel(_cli_logging.DEBUG)
    try:
        _cli_log_path = _Path.home() / 'Documents' / 'MKPSpectrum' / 'logs' / 'cli.log'
        _cli_log_path.parent.mkdir(parents=True, exist_ok=True)
        _cli_fh = _cli_logging.FileHandler(_cli_log_path, encoding='utf-8')
        _cli_fh.setFormatter(_cli_logging.Formatter('%(asctime)s [%(levelname)s] %(message)s'))
        _cli_logger.addHandler(_cli_fh)
    except Exception:
        pass

    _parser = argparse.ArgumentParser()
    _parser.add_argument('--mode', required=True)
    _parser.add_argument('--obj', required=True, help='OBJ 模型路径')
    _parser.add_argument('--gcode', required=True, help='基础 GCode 路径（切片器输出）')
    _parser.add_argument('--output', required=True, help='输出目录')
    _parser.add_argument('--layer_height', type=float, default=0.2)
    _parser.add_argument('--resolution', type=int, default=4000)
    _args = _parser.parse_args()

    def _emit(msg_type, data):
        data['type'] = msg_type
        print(_json.dumps(data, ensure_ascii=False), flush=True)

    try:
        # ── Stage 1: 纹理切片 + 条带切割 ──
        _emit('stage', {'stage': 'slice'})

        from slice_standalone import run_slice
        from GCodeGenerator import extract_gcode_params as _ecp

        def _on_progress(msg_type, data):
            if msg_type == 'log':
                _cli_logger.debug(f"[slice] {data.get('message','')}")
            else:
                _emit(msg_type, data)

        # 读取喷墨 XY 偏移配置及 head IP
        _motion_params = {}
        try:
            _config_dir = _Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
            _cfg_path = _config_dir / 'MKP standard.json'
            if _cfg_path.exists():
                with open(_cfg_path, 'r', encoding='utf-8') as _cf:
                    _cfg = _json.load(_cf)
                _ij = _cfg.get('inkjet', {})
                _offset = _ij.get('offset', {})
                _motion_params['offset_x'] = float(_offset.get('x', 0))
                _motion_params['offset_y'] = float(_offset.get('y', 0))
                _motion_params['print_speed'] = float(_ij.get('speed', 20))
                _motion_params['inkjet_density'] = int(float(_ij.get('density', 0.5)) * 100)
                _motion_params['shear_mm'] = float(_ij.get('shear_mm', 0))
                # CMY 色调调节
                _cmy = _ij.get('cmy', {})
                _motion_params['cmy_c'] = float(_cmy.get('c', 1.0))
                _motion_params['cmy_m'] = float(_cmy.get('m', 1.0))
                _motion_params['cmy_y'] = float(_cmy.get('y', 1.0))
                _motion_params['cmy_saturation'] = float(_cmy.get('saturation', 0.0))
                _motion_params['cmy_brightness'] = float(_cmy.get('brightness', 0.0))
                _motion_params['contrast'] = float(_ij.get('contrast', 1.0))
        except Exception:
            pass

        # 读取喷墨头 IP
        try:
            _ps_path = _Path.home() / 'Documents' / 'MKPSpectrum' / 'printer_settings.json'
            if _ps_path.exists():
                with open(_ps_path, 'r', encoding='utf-8') as _f:
                    _ps = _json.load(_f)
                _motion_params['head_ip'] = _ps.get('headAddress', '') or '192.168.1.8'
        except Exception:
            _motion_params['head_ip'] = '192.168.1.8'

        # 从 GCode 注释中提取真实的层高（优先于前端 --layer_height 传值）
        _slice_layer_height = _args.layer_height
        try:
            _gcode_params_pre = _ecp(_args.gcode)
            _gh = _gcode_params_pre.get('layer_height')
            if _gh:
                _slice_layer_height = _gh
                _cli_logger.info('[CLI] 从 GCode 读取层高: %.3f (前端传入: %.3f)',
                                 _slice_layer_height, _args.layer_height)
        except Exception:
            pass

        _cli_cancel = Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_cancel.flag'
        def _cli_cancelled():
            try:
                return _cli_cancel.exists()
            except Exception:
                return False

        try:
            result = run_slice(
                obj_path=_args.obj,
                output_dir=_args.output,
                layer_height=_slice_layer_height,
                resolution=_args.resolution,
                do_strip=True,
                bed_size=270.0,
                progress_callback=_on_progress,
                log_callback=lambda msg: _cli_logger.debug(f"[slice] {msg}"),
                motion_params=_motion_params if _motion_params else None,
                cancel_flag_path=str(_cli_cancel),
                should_cancel=_cli_cancelled,
            )
        except Exception as _ce:
            is_c = _ce.__class__.__name__ == 'SliceCancelledError' or '已取消' in str(_ce)
            if is_c or _cli_cancelled():
                try:
                    from strip_processor import shutdown_mbd_procs as _sd2
                    _sd2()
                except Exception:
                    pass
                _emit('cancelled', {'message': '已取消'})
                try:
                    _cli_cancel.unlink(missing_ok=True)
                except Exception:
                    pass
                _sys.exit(0)
            raise

        gcode_lines_all = []
        if result.get('strip_done'):
            gcode_lines_all = result['strip_done'].get('gcode_lines_all', [])

        if not gcode_lines_all:
            if _cli_cancelled():
                _emit('cancelled', {'message': '已取消'})
                try:
                    _cli_cancel.unlink(missing_ok=True)
                except Exception:
                    pass
                _sys.exit(0)
            _emit('error', {'message': '条带切割未生成喷墨 GCode'})
            _sys.exit(1)

        if _cli_cancelled():
            _emit('cancelled', {'message': '已取消'})
            try:
                _cli_cancel.unlink(missing_ok=True)
            except Exception:
                pass
            _sys.exit(0)

        # ── Stage 2: 后处理 —— 将喷墨 GCode 插入基础 GCode ──
        _emit('stage', {'stage': 'postprocess'})

        # 将层列表转为 dict {layer_num: [gcode_lines]}（1-indexed），直接传内存不写文件
        _inkjet_dict = {}
        for _li, _lines in enumerate(gcode_lines_all, 1):
            if _lines:
                _inkjet_dict[_li] = _lines

        # 调用 GCodeGenerator 后处理
        _final_output = os.path.join(_args.output, 'final.gcode')
        from GCodeGenerator import process_gcode, extract_gcode_params, estimate_print_time

        _params = extract_gcode_params(_args.gcode)
        _est = estimate_print_time(_params)

        # 从喷墨配置读取取得/放回宏
        _grab_macro = 'GRAB_INKJET_HEAD'
        _release_macro = 'RELEASE_INKJET_HEAD'
        try:
            _config_dir = _Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
            _cfg_raw = getattr(_args, 'Config', 'MKP standard')
            if os.path.isfile(_cfg_raw):
                _cfg_path = _Path(_cfg_raw)
            else:
                _cfg_path = _config_dir / (_cfg_raw + '.json')
            if _cfg_path.exists():
                with open(_cfg_path, 'r', encoding='utf-8') as _cf:
                    _cfg = _json.load(_cf)
                _ij = _cfg.get('inkjet', {})
                _grab_macro = _ij.get('grab_macro', _grab_macro) or _grab_macro
                _release_macro = _ij.get('release_macro', _release_macro) or _release_macro
                _inkjet_speed = _ij.get('speed', 50)
                _repeat_count = int(_ij.get('repeat_count', 1))
                _dry_time = int(_ij.get('dry_time', 3))
        except Exception:
            _inkjet_speed = 50
            _repeat_count = 1
            _dry_time = 3
        # 从 printer_settings.json 读取喷墨机 IP
        _mbrush_ip2 = '192.168.1.8'
        try:
            _ps_path = _Path.home() / 'Documents' / 'MKPSpectrum' / 'printer_settings.json'
            if _ps_path.exists():
                with open(_ps_path, 'r', encoding='utf-8') as _pf:
                    _ps = _json.load(_pf)
                _mbrush_ip2 = _ps.get('headAddress', _mbrush_ip2) or _mbrush_ip2
        except Exception:
            pass
        process_gcode(_args.gcode, output_path=_final_output, params=_params, est=_est,
                      grab_macro=_grab_macro, release_macro=_release_macro,
                      inkjet_layers=_inkjet_dict,
                      inkjet_speed=_inkjet_speed, mbrush_ip=_mbrush_ip2,
                      repeat_count=_repeat_count, dry_time=_dry_time)

        _emit('result', {
            'success': True,
            'gcode_path': _final_output,
            'total_layers': result.get('num_layers', 0),
            'total_blocks': result.get('strip_done', {}).get('total_blocks', 0),
        })

    except Exception as e:
        _emit('error', {'message': str(e)})
        _cli_logger.exception('CLI mode error')
        _sys.exit(1)

if '--mode' in sys.argv:
    _run_cli_mode()
    sys.exit(0)
# ── End CLI mode ──────────────────────────────────────────────────


import webview
import json
import re
import base64
import mimetypes
import traceback
import subprocess
import tempfile
import threading
import platform
import requests
from pathlib import Path
from datetime import datetime
import winreg


class ModelAPI:
    def __init__(self):
        self.last_obj_dir = None
        self.window = None
        self._hwnd = None
        self._is_dragging = False
        self._is_maximized = False
        # 关闭幂等守卫：防止重复销毁 WebView2 窗口触发 .NET 异常
        self._destroy_lock = threading.Lock()
        self._destroy_started = False
        # 纹理切片子进程状态
        self._slice_proc = None
        self._slice_status = {'state': 'idle', 'progress': 0, 'total': 0, 'images': 0, 'stage': '', 'gcode_path': '', 'error': None}
        self._slice_thread = None
        self._slice_lock = threading.Lock()
        self._slice_output_dir = None
        self._slice_focus_mm = None
        self._slice_focus_guide = None
        # 预览原图本地 HTTP 静态服务：让前端 <img> 直接走 HTTP 加载 PNG，
        # 绕开 pywebview bridge 传大 base64 字符串（原图近 MB 传输不稳定）。
        self._preview_http = None
        self._preview_http_port = None
        self._preview_http_base = None
        self._preview_http_lock = threading.Lock()
        # GCode 内存状态
        self._loaded_gcode_text = None
        self._loaded_gcode_path = None
        self._gcode_params = None
        self._gcode_info = None

    def set_window(self, window):
        self.window = window

    # --- 窗口控制 (标题栏替代) ---
    def window_minimize(self):
        if self.window:
            self.window.minimize()

    def window_toggle_maximize(self):
        if self.window:
            if self._is_maximized:
                self.window.restore()
                self._is_maximized = False
            else:
                self.window.maximize()
                self._is_maximized = True
        return self._is_maximized

    def _kill_pid_tree(self, pid):
        """在 Windows 上用 taskkill /T /F 杀掉整棵进程树，无需 psutil。"""
        if not pid:
            return False
        if sys.platform == 'win32':
            # taskkill /T 会递归杀子进程（包括 Pool/Node 子进程）
            try:
                subprocess.run(
                    ['taskkill', '/PID', str(pid), '/T', '/F'],
                    capture_output=True, text=True,
                    creationflags=0x08000000,  # CREATE_NO_WINDOW
                    timeout=10,
                )
                return True
            except Exception as e:
                print(f"[kill_tree] taskkill 异常: {e}")
        # 回退：直接杀
        try:
            import signal as _sig
            os.kill(pid, _sig.SIGTERM)
        except Exception:
            pass
        return False

    def _kill_headless_slice_procs(self):
        """杀掉 OrcaSlicer 调起的外部后处理进程（MKPSpectrum.exe --Gcode / --mode slice-and-postprocess）。

        这类进程不是 self._slice_proc，旧的 texture_slice_cancel 完全管不到，
        所以用户点终止后后台 exe 仍在跑。必须用 taskkill /T 连同其 Pool/Node 子进程一起杀掉。

        修复：之前依赖 WMI CommandLine 枚举，常因权限/引号/截断取不到，导致
        “另一个 MKPSpectrum.exe 没被关掉”。现改为三重兜底：
        1) WMI CommandLine 精确杀；2) Get-Process 镜像名杀（排除自我 PID）；
        3) tasklist 解析兜底。确保无论哪种形态（frozen exe / python.exe）都能杀树。
        """
        if sys.platform != 'win32':
            return
        my_pid = os.getpid()
        killed_any = False

        def _taskkill_pid(pid):
            nonlocal killed_any
            try:
                r = subprocess.run(
                    ['taskkill', '/PID', str(pid), '/T', '/F'],
                    capture_output=True, text=True, timeout=8,
                    creationflags=0x08000000,
                )
                out = ((r.stdout or '') + (r.stderr or '')).strip()
                print(f"[kill_headless] taskkill /PID {pid} /T /F -> {out or 'ok'}")
                killed_any = True
            except Exception as e:
                print(f"[kill_headless] taskkill {pid} 异常: {e}")

        # 1) WMI CommandLine 精确杀（能取到时最准）
        try:
            ps = (
                f"$me={my_pid}; "
                "$pids = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { "
                "  $_.ProcessId -ne $me -and $_.Name -like 'MKPSpectrum*' -and $_.CommandLine -and ("
                "    $_.CommandLine -like '*--Gcode*' -or $_.CommandLine -like '*slice-and-postprocess*' -or $_.CommandLine -like '*--mode*'"
                "  )"
                "} | Select-Object -ExpandProperty ProcessId; "
                "$pids | ForEach-Object { Write-Output $_ }"
            )
            r = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps],
                capture_output=True, text=True, timeout=10,
                creationflags=0x08000000,
            )
            for line in (r.stdout or '').splitlines():
                line=line.strip()
                if line.isdigit():
                    _taskkill_pid(int(line))
            # 同理处理 python.exe 形态（源码运行）
            ps_py = (
                f"$me={my_pid}; "
                "$pids = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { "
                "  $_.ProcessId -ne $me -and $_.Name -like 'python*' -and $_.CommandLine -and ("
                "    $_.CommandLine -like '*--Gcode*' -or $_.CommandLine -like '*slice-and-postprocess*'"
                "  )"
                "} | Select-Object -ExpandProperty ProcessId; "
                "$pids | ForEach-Object { Write-Output $_ }"
            )
            r2 = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps_py],
                capture_output=True, text=True, timeout=10,
                creationflags=0x08000000,
            )
            for line in (r2.stdout or '').splitlines():
                line=line.strip()
                if line.isdigit():
                    _taskkill_pid(int(line))
        except Exception as e:
            print(f"[kill_headless] WMI 枚举异常: {e}")

        # 2) 镜像名兜底：杀掉除自我外的所有 MKPSpectrum 进程（正好解决“另一个 MKPSpectrum.exe 没关掉”）
        try:
            ps2 = (
                f"$me={my_pid}; "
                "Get-Process -Name MKPSpectrum* -ErrorAction SilentlyContinue "
                "| Where-Object { $_.Id -ne $me } | Select-Object -ExpandProperty Id | ForEach-Object { Write-Output $_ }"
            )
            r = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps2],
                capture_output=True, text=True, timeout=10,
                creationflags=0x08000000,
            )
            for line in (r.stdout or '').splitlines():
                line=line.strip()
                if line.isdigit():
                    # 避免重复杀已杀过的
                    _taskkill_pid(int(line))
        except Exception as e:
            print(f"[kill_headless] Get-Process 枚举异常: {e}")

        # 3) tasklist 解析兜底（不依赖 PowerShell，Win11 上 WMI 可能被限）
        if not killed_any:
            try:
                r = subprocess.run(
                    ['tasklist', '/FO', 'CSV', '/NH'],
                    capture_output=True, text=True, timeout=8,
                    creationflags=0x08000000,
                )
                import csv as _csv, io as _io
                reader = _csv.reader(_io.StringIO(r.stdout or ''))
                for row in reader:
                    if not row or len(row) < 2:
                        continue
                    name = row[0].strip().strip('"')
                    pid_s = row[1].strip().strip('"')
                    if name.lower().startswith('mkpspectrum') and pid_s.isdigit():
                        pid = int(pid_s)
                        if pid != my_pid:
                            _taskkill_pid(pid)
            except Exception as e:
                print(f"[kill_headless] tasklist 枚举异常: {e}")

        # 4) 最后再用 taskkill /IM 兜底（若枚举漏掉，仍有机会清掉残留；会排除自我需二次确认）
        try:
            import time as _time
            _time.sleep(0.4)
            r = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 f"$me={my_pid}; (Get-Process -Name MKPSpectrum* -ErrorAction SilentlyContinue | Where-Object {{ $_.Id -ne $me }} | Measure-Object).Count"],
                capture_output=True, text=True, timeout=8,
                creationflags=0x08000000,
            )
            try:
                cnt = int((r.stdout or '0').strip().split()[0] or '0')
            except Exception:
                cnt = 0
            if cnt and cnt > 0:
                print(f"[kill_headless] 仍有 {cnt} 个 MKPSpectrum 残留，执行 taskkill /IM 兜底")
                for pid_line in (r.stdout or '').splitlines():
                    pass
                # 逐个 taskkill 已在上面做过，这里再用 /IM 广播一次（带 /T 杀树），PowerShell 已排除自我所以安全
                subprocess.run(
                    ['taskkill', '/IM', 'MKPSpectrum.exe', '/T', '/F'],
                    capture_output=True, text=True, timeout=8,
                    creationflags=0x08000000,
                )
        except Exception:
            pass

    def _request_cancel_flag(self):
        """优雅取消：写入 slice_cancel.flag，让 headless/CLI 的 run_slice 轮询到后自行终止 Pool 并 exit 0。

        这比直接 taskkill 优雅，Orca 不会认为后处理异常崩溃。"""
        try:
            flag = Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_cancel.flag'
            flag.parent.mkdir(parents=True, exist_ok=True)
            flag.write_text(str(os.getpid()), encoding='utf-8')
            print(f"[cancel] 已写入取消标志: {flag}")
            return flag
        except Exception as e:
            print(f"[cancel] 写入取消标志失败: {e}")
            return None

    def _wait_for_graceful_exit(self, timeout=4.0):
        """等待 headless 后台优雅退出（slice_progress.json 变为 cancelled 或进程消失）。

        返回 True 表示已优雅退出，无需强杀。"""
        import time as _time
        flag = Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_cancel.flag'
        prog = Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_progress.json'
        start = _time.time()
        while _time.time() - start < timeout:
            # 若 headless 已把进度写为 cancelled，说明已进入优雅退出分支
            try:
                if prog.exists():
                    with open(prog, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    if data.get('state') == 'cancelled':
                        print("[cancel] 检测到 headless 已优雅取消")
                        return True
            except Exception:
                pass
            # 若已无 MKPSpectrum 残留进程，也算优雅退出
            try:
                r = subprocess.run(
                    ['powershell', '-NoProfile', '-Command',
                     f"$me={os.getpid()}; (Get-Process -Name MKPSpectrum* -ErrorAction SilentlyContinue | Where-Object {{ $_.Id -ne $me }} | Measure-Object).Count"],
                    capture_output=True, text=True, timeout=5,
                    creationflags=0x08000000,
                )
                try:
                    cnt = int((r.stdout or '0').strip().split()[0] or '0')
                except Exception:
                    cnt = 0
                if cnt == 0:
                    # headless 已退出，同时清理标志
                    return True
            except Exception:
                pass
            _time.sleep(0.5)
        return False

    def _kill_slice_proc(self):
        """优雅取消优先：先写 flag 让后台自行退出，仅超时才强杀进程树。"""
        # 1) 内部 CLI 子进程：先尝试优雅（它也会轮询 slice_cancel.flag）
        if self._slice_proc is not None:
            flag = self._request_cancel_flag()
            # 给子进程一点时间优雅退出（Pool.terminate + shutdown MBD + exit 0）
            graceful = False
            try:
                # 等待 CLI 子进程自身退出
                for _ in range(8):  # 最多 4 秒
                    import time as _time
                    _time.sleep(0.5)
                    if self._slice_proc.poll() is not None:
                        graceful = True
                        break
                    # 若子进程已把 flag 消费并写了 cancelled，也可以提前认为完成
                    try:
                        # 检查子进程是否已响应（通过轮询 flag 是否仍存在——headless 退出时会删除）
                        pass
                    except Exception:
                        pass
                if graceful:
                    print("[cancel] CLI 子进程已优雅退出")
                else:
                    print("[cancel] CLI 子进程未在时限内退出，执行强杀兜底")
                    pid = None
                    try:
                        pid = self._slice_proc.pid
                    except Exception:
                        pid = None
                    if pid:
                        self._kill_pid_tree(pid)
            except Exception as e:
                print(f"[cancel] 等待 CLI 优雅退出异常: {e}")
            # 回收句柄
            try:
                try:
                    self._slice_proc.kill()
                except Exception:
                    pass
                try:
                    self._slice_proc.wait(timeout=3)
                except Exception:
                    pass
                for attr in ('stdout', 'stderr', 'stdin'):
                    try:
                        fh = getattr(self._slice_proc, attr, None)
                        if fh:
                            fh.close()
                    except Exception:
                        pass
            except Exception as e:
                print(f"终止切片进程异常: {e}")
            finally:
                self._slice_proc = None
                print("切片子进程已终止")

        # 2) 外部 Orca 调起的 headless：同样先优雅等待
        try:
            # 若当前没有内部进程但有 headless，也需要先写 flag
            # （texture_slice_cancel 已在外层写过，这里补一次也无害）
            self._request_cancel_flag()
            ok = self._wait_for_graceful_exit(timeout=4.0)
            if ok:
                print("[cancel] headless 已优雅退出，无需强杀")
            else:
                print("[cancel] headless 未优雅退出，执行强杀兜底")
                self._kill_headless_slice_procs()
        except Exception:
            try:
                self._kill_headless_slice_procs()
            except Exception:
                pass

        # 清理 MBD 常驻进程 + 强制 GC，但不清除用户加载的 GCode
        try:
            from strip_processor import shutdown_mbd_procs
            shutdown_mbd_procs()
        except Exception:
            pass
        import gc
        gc.collect()
        # 取消流程结束，清理 flag
        try:
            (Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_cancel.flag').unlink(missing_ok=True)
        except Exception:
            pass

    def _cleanup_slice_memory(self):
        """切片结束后释放主进程中的大型缓存对象，避免 RAM 持续占用。"""
        import gc
        # 已加载的 GCode 文本（可能数百 MB），切片后不再需要
        self._loaded_gcode_text = None
        # 注意：不清理 _loaded_gcode_path，后续切片仍需使用
        self._gcode_params = None
        self._gcode_info = None
        self._slice_output_dir = None
        # 清理 strip_processor 中的常驻 MBD 进程（它们会持续占用内存）
        try:
            from strip_processor import shutdown_mbd_procs
            shutdown_mbd_procs()
        except Exception:
            pass
        gc.collect()
        # Windows: 尝试将物理内存归还给 OS（等效于 MemReduct 的清理效果）
        if sys.platform == 'win32':
            try:
                import ctypes
                ctypes.windll.psapi.EmptyWorkingSet(ctypes.windll.kernel32.GetCurrentProcess())
            except Exception:
                pass

    def window_close(self):
        # [已移除] 不再检测是否正在打印 MKPS* GCode，也不再弹窗询问是否最小化到托盘
        # 原因：不再需要后台常驻监控 (fluidd_tray_monitor)
        # try:
        #     status = self.check_printer_printing()
        #     if status.get('printing'):
        #         filename = status.get('filename') or ''
        #         can_minimize = filename.upper().startswith('MKPS')
        #         if self.window:
        #             js_arg = 'true' if can_minimize else 'false'
        #             js = f'window.showCloseTrayDialog && window.showCloseTrayDialog({js_arg})'
        #             self.window.evaluate_js(js)
        #         return
        # except Exception as e:
        #     print(f'[关闭] 打印状态检测失败: {e}')

        self._do_destroy()

    # [已移除] 托盘关闭弹窗回调，不再需要后台常驻监控 (fluidd_tray_monitor)
    # def tray_confirm_close(self, action):
    #     """托盘关闭弹窗回调：minimize=最小化到托盘, exit=终止打印并退出"""
    #     if action == 'minimize':
    #         if self.window:
    #             try:
    #                 self.window.hide()
    #             except Exception as e:
    #                 print(f'[关闭] 隐藏窗口失败: {e}')
    #     elif action == 'exit':
    #         try:
    #             settings = self.load_printer_settings()
    #             if settings.get('success'):
    #                 s = settings.get('settings', {})
    #                 addr = (s.get('printerAddress') or '').strip()
    #                 if addr:
    #                     import requests
    #                     requests.post(f'http://{addr}:7125/printer/print/cancel', timeout=5)
    #                     print('[关闭] 已发送取消打印指令')
    #         except Exception as e:
    #             print(f'[关闭] 取消打印失败: {e}')
    #         self._do_destroy()

    def _do_destroy(self):
        # 关闭须幂等：多次点击关闭按钮 / closing 事件 / JS 触发可能并发进入，
        # 对已销毁或正在销毁的 WebView2 窗口重复调用 destroy() 会抛出 .NET 异常。
        with self._destroy_lock:
            if self._destroy_started:
                return
            self._destroy_started = True
        self._kill_slice_proc()
        if self.window:
            try:
                self.window.destroy()
            except Exception:
                # 窗口可能已在 closing 事件里被销毁，点关闭后 destroy 抛异常属正常
                pass

    def _get_window_handle(self):
        """获取窗口句柄"""
        if self._hwnd:
            return self._hwnd

        try:
            import ctypes
            from ctypes import wintypes

            # 尝试获取 pywebview 窗口的句柄
            if hasattr(self.window, '_hwnd') and self.window._hwnd:
                self._hwnd = self.window._hwnd
                return self._hwnd

            # 使用 ctypes EnumWindows 查找
            EnumWindows = ctypes.windll.user32.EnumWindows
            EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, ctypes.POINTER(ctypes.c_int))
            GetWindowText = ctypes.windll.user32.GetWindowTextW
            GetWindowTextLength = ctypes.windll.user32.GetWindowTextLengthW
            IsWindowVisible = ctypes.windll.user32.IsWindowVisible

            results = []

            def foreach_window(hwnd, lParam):
                if IsWindowVisible(hwnd):
                    length = GetWindowTextLength(hwnd)
                    buff = ctypes.create_unicode_buffer(length + 1)
                    GetWindowText(hwnd, buff, length + 1)
                    if buff.value == 'MKPSpectrum - 3D热床预览':
                        results.append(hwnd)
                return True

            EnumWindows(EnumWindowsProc(foreach_window), 0)

            if results:
                self._hwnd = results[0]
                return self._hwnd
        except Exception as e:
            print(f"Error getting window handle: {e}")

        return None

    def start_drag(self, x, y):
        """开始拖动窗口 - 使用手动跟踪方式"""
        if self.window and sys.platform == 'win32':
            try:
                import ctypes
                from ctypes import wintypes
                import threading
                import time

                hwnd = self._get_window_handle()

                if hwnd:
                    user32 = ctypes.windll.user32

                    # 获取当前鼠标位置
                    class POINT(ctypes.Structure):
                        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

                    pt = POINT()
                    user32.GetCursorPos(ctypes.byref(pt))

                    # 获取当前窗口位置
                    class RECT(ctypes.Structure):
                        _fields_ = [
                            ('left', ctypes.c_long),
                            ('top', ctypes.c_long),
                            ('right', ctypes.c_long),
                            ('bottom', ctypes.c_long)
                        ]

                    rect = RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(rect))

                    # 计算偏移
                    offset_x = pt.x - rect.left
                    offset_y = pt.y - rect.top

                    # 标记拖动开始
                    self._is_dragging = True

                    # 设置鼠标捕获到窗口
                    user32.SetCapture(hwnd)

                    def drag_loop():
                        loop_count = 0
                        while self._is_dragging and loop_count < 1000:  # 最多10秒防止无限循环
                            loop_count += 1
                            try:
                                # 获取当前鼠标位置
                                user32.GetCursorPos(ctypes.byref(pt))

                                # 计算新窗口位置
                                new_x = pt.x - offset_x
                                new_y = pt.y - offset_y

                                # 移动窗口 - SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
                                user32.SetWindowPos(hwnd, 0, new_x, new_y, 0, 0, 0x0001 | 0x0004 | 0x0010)

                                # 检查鼠标左键是否释放
                                key_state = user32.GetAsyncKeyState(0x01)  # VK_LBUTTON
                                if (key_state & 0x8000) == 0:
                                    self._is_dragging = False

                                time.sleep(0.005)  # 5ms 刷新率
                            except Exception as e:
                                print(f"Drag loop error: {e}")
                                self._is_dragging = False

                        # 释放鼠标捕获
                        try:
                            user32.ReleaseCapture()
                        except:
                            pass

                    # 在新线程中运行拖动循环
                    drag_thread = threading.Thread(target=drag_loop)
                    drag_thread.daemon = True
                    drag_thread.start()

                    return {"success": True, "method": "manual_track"}
            except Exception as e:
                print(f"Drag error: {e}")
                import traceback
                traceback.print_exc()

        return {"success": False, "error": "Could not initiate drag"}

    def open_file_dialog(self, file_types=None):
        try:
            if self.window is None:
                print("错误: window 未设置")
                return None
            result = self.window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=file_types or ['3D Models (*.obj;*.stl;*.gltf;*.glb;*.fbx)', 'All files (*.*)']
            )
            if result and len(result) > 0:
                file_path = result[0]
                self.last_obj_dir = os.path.dirname(file_path)
                return {
                    'path': file_path,
                    'name': os.path.basename(file_path),
                    'dir': self.last_obj_dir
                }
            return None
        except Exception as e:
            print(f"打开文件对话框失败: {e}")
            traceback.print_exc()
            return None

    def load_model(self, file_info):
        try:
            print(f"load_model 被调用, file_info 类型: {type(file_info)}")

            if isinstance(file_info, str):
                import json
                try:
                    file_info = json.loads(file_info)
                except json.JSONDecodeError:
                    print(f"JSON解析失败: {file_info}")
                    return {'success': False, 'error': '参数格式错误'}

            if not isinstance(file_info, dict):
                print(f"错误: file_info 不是字典, 而是 {type(file_info)}")
                return {'success': False, 'error': f'参数类型错误: {type(file_info)}'}

            file_path = file_info.get('path')
            print(f"文件路径: {file_path}")

            if not file_path:
                return {'success': False, 'error': '文件路径为空'}
            if not os.path.exists(file_path):
                return {'success': False, 'error': f'文件不存在: {file_path}'}

            self.last_obj_dir = os.path.dirname(file_path)
            ext = os.path.splitext(file_path)[1].lower()
            print(f"文件扩展名: {ext}")

            if ext == '.stl':
                return self._load_stl(file_path)
            elif ext == '.obj':
                return self._load_obj(file_path)
            elif ext in ['.gltf', '.glb']:
                return self._load_gltf(file_path)
            elif ext == '.fbx':
                return self._load_fbx(file_path)
            else:
                return {'success': False, 'error': f'不支持的文件格式: {ext}'}
        except Exception as e:
            print(f"load_model 异常: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def _read_file_base64(self, file_path):
        with open(file_path, 'rb') as f:
            data = f.read()
        mime = mimetypes.guess_type(file_path)[0] or 'application/octet-stream'
        b64 = base64.b64encode(data).decode('utf-8')
        return f'data:{mime};base64,{b64}'

    def load_model_by_path(self, file_path):
        """通过文件路径直接加载模型（用于从磁盘重新加载）"""
        return self.load_model({'path': file_path})

    def get_calibration_model_path(self):
        """返回校准模型 GLB 文件的绝对路径（兼容开发环境和 PyInstaller 打包）"""
        if getattr(sys, 'frozen', False):
            return os.path.join(sys._MEIPASS, 'calibe.glb')
        else:
            return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'calibe.glb')

    def _load_stl(self, file_path):
        return {
            'success': True,
            'type': 'stl',
            'data': self._read_file_base64(file_path)
        }

    def _load_gltf(self, file_path):
        if str(file_path).lower().endswith('.gltf'):
            try:
                import json as _json
                import mimetypes as _mimetypes
                file_path = str(file_path)
                base_dir = os.path.dirname(file_path)
                with open(file_path, 'r', encoding='utf-8') as f:
                    gltf = _json.load(f)

                def _inline_uri(uri):
                    if not uri or uri.startswith('data:') or '://' in uri:
                        return uri
                    dep_path = os.path.normpath(os.path.join(base_dir, uri.replace('/', os.sep)))
                    if not os.path.exists(dep_path):
                        return uri
                    mime = _mimetypes.guess_type(dep_path)[0] or 'application/octet-stream'
                    with open(dep_path, 'rb') as df:
                        raw = base64.b64encode(df.read()).decode('utf-8')
                    return f'data:{mime};base64,{raw}'

                for buf in gltf.get('buffers', []) or []:
                    if isinstance(buf, dict) and 'uri' in buf:
                        buf['uri'] = _inline_uri(buf.get('uri'))
                for img in gltf.get('images', []) or []:
                    if isinstance(img, dict) and 'uri' in img:
                        img['uri'] = _inline_uri(img.get('uri'))

                payload = _json.dumps(gltf, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
                b64 = base64.b64encode(payload).decode('utf-8')
                return {
                    'success': True,
                    'type': 'gltf',
                    'data': f'data:model/gltf+json;base64,{b64}'
                }
            except Exception as e:
                print(f"内联 GLTF 资源失败，回退原文件: {e}")
        return {
            'success': True,
            'type': 'gltf',
            'data': self._read_file_base64(file_path)
        }

    def _parse_gltf_resources(self, gltf_path):
        resources = set()
        try:
            import json as _json
            with open(gltf_path, 'r', encoding='utf-8') as f:
                gltf = _json.load(f)
            for item in (gltf.get('buffers', []) or []) + (gltf.get('images', []) or []):
                uri = item.get('uri') if isinstance(item, dict) else None
                if not uri or uri.startswith('data:') or '://' in uri:
                    continue
                norm = uri.replace('\\', '/').lstrip('/')
                if '..' not in norm.split('/'):
                    resources.add(norm)
        except Exception as e:
            print(f"解析 GLTF 资源失败: {e}")
        return resources

    def _load_obj(self, file_path):
        file_path = str(file_path)
        obj_data = self._read_file_base64(file_path)
        result = {
            'success': True,
            'type': 'obj',
            'obj': obj_data,
            'mtl': None,
            'textures': {}
        }

        mtl_path = file_path.replace('.obj', '.mtl')
        if os.path.exists(mtl_path):
            result['mtl'] = self._read_file_base64(mtl_path)
            texture_files = self._parse_mtl_textures(mtl_path)
            # 贴图文件与 MTL 同目录
            tex_base = os.path.dirname(mtl_path)
            for tex_name in texture_files:
                tex_path = os.path.join(tex_base, tex_name)
                if os.path.exists(tex_path):
                    result['textures'][tex_name] = self._read_file_base64(tex_path)

        return result

    def _load_fbx(self, file_path):
        return {
            'success': True,
            'type': 'fbx',
            'data': self._read_file_base64(file_path)
        }

    def _parse_mtl_textures(self, mtl_path):
        textures = set()
        try:
            with open(mtl_path, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('map_Kd ') or line.startswith('map_Ka ') or \
                       line.startswith('map_Ks ') or line.startswith('map_Bump ') or \
                       line.startswith('bump ') or line.startswith('map_d '):
                        parts = line.split()
                        if len(parts) >= 2:
                            tex_name = parts[-1].strip()
                            if tex_name:
                                textures.add(tex_name)
        except Exception as e:
            print(f"解析MTL失败: {e}")
        return textures

    def _get_settings_path(self):
        """获取软件设置文件路径: Documents/MKPSpectrum/settings.json"""
        docs_dir = Path.home() / 'Documents' / 'MKPSpectrum'
        docs_dir.mkdir(parents=True, exist_ok=True)
        return str(docs_dir / 'settings.json')

    def _get_printer_settings_path(self):
        """获取打印机设置文件路径: Documents/MKPSpectrum/printer_settings.json"""
        docs_dir = Path.home() / 'Documents' / 'MKPSpectrum'
        docs_dir.mkdir(parents=True, exist_ok=True)
        return str(docs_dir / 'printer_settings.json')

    def _get_print_settings_dir(self):
        """获取喷墨配置文件夹路径: Documents/MKPSpectrum/Printsetting/"""
        docs_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
        docs_dir.mkdir(parents=True, exist_ok=True)
        return str(docs_dir)

    def list_print_settings(self):
        """列出所有喷墨配置文件，若无则自动创建默认"""
        try:
            self.ensure_default_config()
            settings_dir = self._get_print_settings_dir()
            files = []
            for fname in sorted(os.listdir(settings_dir)):
                if fname.lower().endswith('.json'):
                    name = os.path.splitext(fname)[0]
                    fpath = os.path.join(settings_dir, fname)
                    mtime = os.path.getmtime(fpath)
                    files.append({'name': name, 'mtime': mtime})
            return {'success': True, 'files': files}
        except Exception as e:
            print(f"列出喷墨配置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'files': []}

    def save_print_setting(self, name, data_str):
        """保存喷墨配置文件"""
        try:
            settings_dir = self._get_print_settings_dir()
            data = json.loads(data_str) if isinstance(data_str, str) else data_str
            fpath = os.path.join(settings_dir, name + '.json')
            with open(fpath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            print(f"喷墨配置已保存: {fpath}")
            return {'success': True}
        except Exception as e:
            print(f"保存喷墨配置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def load_print_setting(self, name):
        """加载喷墨配置文件"""
        try:
            settings_dir = self._get_print_settings_dir()
            fpath = os.path.join(settings_dir, name + '.json')
            if not os.path.exists(fpath):
                return {'success': False, 'error': '文件不存在'}
            with open(fpath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self._current_inkjet_config = name  # 记住当前配置
            return {'success': True, 'data': data}
        except Exception as e:
            print(f"加载喷墨配置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def _get_current_macros(self):
        """从当前喷墨配置读取取得/放回宏"""
        name = getattr(self, '_current_inkjet_config', None)
        if not name:
            return ('GRAB_INKJET_HEAD', 'RELEASE_INKJET_HEAD')
        try:
            data = self.load_print_setting(name)
            if data.get('success') and data.get('data', {}).get('inkjet'):
                ij = data['data']['inkjet']
                return (
                    ij.get('grab_macro') or 'GRAB_INKJET_HEAD',
                    ij.get('release_macro') or 'RELEASE_INKJET_HEAD',
                )
        except Exception:
            pass
        return ('GRAB_INKJET_HEAD', 'RELEASE_INKJET_HEAD')

    def get_postprocess_command(self, config_name):
        """获取后处理命令字符串，格式: "完整路径" --Config "xxx.json" --Gcode"""
        return self.get_gcode_generator_path(config_name)

    def save_settings(self, settings_str):
        """保存用户设置到文件（合并模式：只更新传入的字段，保留已有设置）"""
        try:
            new_settings = json.loads(settings_str) if isinstance(settings_str, str) else settings_str
            path = self._get_settings_path()

            # 合并：先读取已有设置，再用新值覆盖
            existing = {}
            if os.path.exists(path):
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        existing = json.load(f)
                except (json.JSONDecodeError, IOError):
                    existing = {}

            merged = {**existing, **new_settings}

            with open(path, 'w', encoding='utf-8') as f:
                json.dump(merged, f, indent=2, ensure_ascii=False)
            print(f"设置已保存到: {path}")
            return {'success': True}
        except Exception as e:
            print(f"保存设置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def load_settings(self):
        """从文件加载软件设置"""
        try:
            path = self._get_settings_path()
            if not os.path.exists(path):
                print(f"设置文件不存在，使用默认值: {path}")
                return {
                    'success': True,
                    'settings': {
                        'maxHistory': 20,
                        'showGrid': True,
                        'gridTheme': 'dark',
                        'gridSize': 10,
                        'cameraMode': 'perspective',
                        'orcaSlicerPath': '',
                        'snapmakerOrcaPath': '',
                        'gcodeSlicerType': 'orcaslicer',
                        'textureResolution': 1024
                    }
                }
            with open(path, 'r', encoding='utf-8') as f:
                settings = json.load(f)
            print(f"设置已从 {path} 加载")
            return {'success': True, 'settings': settings}
        except Exception as e:
            print(f"加载设置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'settings': None}

    def load_printer_settings(self):
        """从 Documents/MKPSpectrum/printer_settings.json 加载打印机设置"""
        try:
            path = self._get_printer_settings_path()
            if not os.path.exists(path):
                print(f"打印机设置文件不存在，使用默认值: {path}")
                return {
                    'success': True,
                    'settings': {
                        'bedSize': {'x': 270, 'y': 270, 'z': 270},
                        'printerAddress': '',
                        'headAddress': ''
                    }
                }
            with open(path, 'r', encoding='utf-8') as f:
                settings = json.load(f)
            print(f"打印机设置已从 {path} 加载")
            return {'success': True, 'settings': settings}
        except Exception as e:
            print(f"加载打印机设置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'settings': None}

    def save_printer_settings(self, settings_str):
        """保存打印机设置到文件（合并模式）"""
        try:
            new_settings = json.loads(settings_str) if isinstance(settings_str, str) else settings_str
            path = self._get_printer_settings_path()

            existing = {}
            if os.path.exists(path):
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        existing = json.load(f)
                except (json.JSONDecodeError, IOError):
                    existing = {}

            merged = {**existing, **new_settings}

            with open(path, 'w', encoding='utf-8') as f:
                json.dump(merged, f, indent=2, ensure_ascii=False)
            print(f"打印机设置已保存到: {path}")
            return {'success': True}
        except Exception as e:
            print(f"保存打印机设置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def export_model_files(self, file_path):
        """导出模型文件到目标文件夹（支持 OBJ/GLB/GLTF）"""
        try:
            if not file_path or not os.path.exists(file_path):
                return {'success': False, 'error': '文件不存在'}

            if self.window is None:
                return {'success': False, 'error': '窗口未初始化'}

            # 打开文件夹选择对话框
            folder = self.window.create_file_dialog(
                webview.FOLDER_DIALOG,
                directory=self.last_obj_dir or os.path.dirname(file_path)
            )
            if not folder:
                return {'success': False, 'error': '未选择文件夹'}

            target_dir = folder[0] if isinstance(folder, (list, tuple)) else folder
            source_dir = os.path.dirname(file_path)

            import shutil

            ext = os.path.splitext(file_path)[1].lower()

            # GLB / GLTF：直接复制单个文件
            if ext in ['.glb', '.gltf']:
                obj_name = os.path.basename(file_path)
                shutil.copy2(file_path, os.path.join(target_dir, obj_name))
            else:
                # 复制 OBJ 文件
                obj_name = os.path.basename(file_path)
                shutil.copy2(file_path, os.path.join(target_dir, obj_name))

                # 复制 MTL 文件
                mtl_path = file_path.replace('.obj', '.mtl')
                if os.path.exists(mtl_path):
                    shutil.copy2(mtl_path, os.path.join(target_dir, os.path.basename(mtl_path)))
                    # 复制纹理文件
                    texture_files = self._parse_mtl_textures(mtl_path)
                    for tex_name in texture_files:
                        tex_path = os.path.join(source_dir, tex_name)
                        if os.path.exists(tex_path):
                            shutil.copy2(tex_path, os.path.join(target_dir, tex_name))

            print(f"模型文件已导出到: {target_dir}")
            return {'success': True, 'path': target_dir}
        except Exception as e:
            print(f"导出模型失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def save_mkp_project(self, project_json_str, save_path=None, default_name=None):
        """保存MKP项目文件（ZIP格式：model/ + position + tex/）
        
        如果 save_path 已提供则直接保存，否则弹出保存对话框。
        default_name 用于未保存时自定义对话框默认文件名。
        """
        import json
        import zipfile
        from datetime import datetime

        try:
            project = json.loads(project_json_str) if isinstance(project_json_str, str) else project_json_str

            # 诊断：dump 前端传来的 models 数据（不含大字段）
            for i, m in enumerate(project.get('models', [])):
                print(f"  [save_mkp] 前端传入 model[{i}]: name={m.get('name')}, scale={m.get('scale')}, pos={m.get('position')}, rot={m.get('rotation')}, filePath={m.get('filePath')}")

            if self.window is None:
                return {'success': False, 'error': '窗口未初始化'}

            if save_path:
                # 已有路径，直接保存
                target_path = save_path
            else:
                # 确定默认文件名
                if default_name:
                    fn = f'{default_name}.mkp'
                else:
                    fn = f'project_{datetime.now().strftime("%Y%m%d")}.mkp'
                # 打开保存对话框
                save_path = self.window.create_file_dialog(
                    webview.SAVE_DIALOG,
                    save_filename=fn,
                    file_types=['MKP Project (*.mkp)', 'All files (*.*)']
                )
                if not save_path:
                    return {'success': False, 'error': '未选择保存路径'}

                target_path = save_path[0] if isinstance(save_path, (list, tuple)) else save_path

            if not target_path.endswith('.mkp'):
                target_path += '.mkp'

            model_archive_paths = {}

            with zipfile.ZipFile(target_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                # 添加模型文件到 model/ 目录
                for i, model in enumerate(project.get('models', [])):
                    file_path = model.get('filePath')
                    if file_path and os.path.exists(file_path):
                        model_key = str(model.get('id') if model.get('id') is not None else i)
                        safe_key = ''.join(c if c.isalnum() or c in ('-', '_') else '_' for c in model_key) or str(i)
                        model_subdir = f'model_{safe_key}_{i}'
                        ext = os.path.splitext(file_path)[1].lower()
                        # 复制 GLB / GLTF 文件
                        if ext in ['.glb', '.gltf']:
                            arcname = f'model/{model_subdir}/{os.path.basename(file_path)}'
                            zf.write(file_path, arcname)
                            model_archive_paths[model_key] = f'{model_subdir}/{os.path.basename(file_path)}'
                            if ext == '.gltf':
                                source_dir = os.path.dirname(file_path)
                                for res_name in self._parse_gltf_resources(file_path):
                                    res_path = os.path.join(source_dir, res_name)
                                    if os.path.exists(res_path):
                                        zf.write(res_path, f'model/{model_subdir}/{res_name}')
                        # 复制 OBJ 文件 + MTL + 贴图
                        elif ext == '.obj':
                            obj_name = os.path.basename(file_path)
                            zf.write(file_path, f'model/{model_subdir}/{obj_name}')
                            model_archive_paths[model_key] = f'{model_subdir}/{obj_name}'

                            # 复制关联的 MTL 文件
                            mtl_path = os.path.splitext(file_path)[0] + '.mtl'
                            if os.path.exists(mtl_path):
                                zf.write(mtl_path, f'model/{model_subdir}/{os.path.basename(mtl_path)}')
                                # 复制纹理文件
                                source_dir = os.path.dirname(file_path)
                                texture_files = self._parse_mtl_textures(mtl_path)
                                for tex_name in texture_files:
                                    tex_path = os.path.join(source_dir, tex_name)
                                    if os.path.exists(tex_path):
                                        tex_arc = tex_name.replace('\\', '/').lstrip('/')
                                        if '..' not in tex_arc.split('/'):
                                            zf.write(tex_path, f'model/{model_subdir}/{tex_arc}')

                # 添加 position 文件（不包含 filePath 等路径信息）
                position_data = {
                    'version': project.get('version', '1.0'),
                    'timestamp': project.get('timestamp', ''),
                    'bedSize': project.get('bedSize', {}),
                    'gridSize': project.get('gridSize', 10),
                    'showGrid': project.get('showGrid', True),
                    'plates': project.get('plates', []),
                    'currentPlateId': project.get('currentPlateId'),
                    'models': []
                }
                for model in project.get('models', []):
                    model_key = str(model.get('id')) if model.get('id') is not None else None
                    model_scale = model.get('scale')
                    print(f"  [save_mkp] 写入模型: name={model.get('name')}, scale={model_scale}, pos={model.get('position')}")
                    position_data['models'].append({
                        'id': model.get('id'),
                        'name': model.get('name'),
                        'position': model.get('position'),
                        'rotation': model.get('rotation'),
                        'scale': model_scale,
                        'plateId': model.get('plateId'),
                        'assetMode': model.get('assetMode'),
                        'modelFile': model_archive_paths.get(model_key)
                    })
                print(f"  [save_mkp] position_data.models 完整内容: {json.dumps(position_data['models'], indent=2, ensure_ascii=False)}")
                zf.writestr('position', json.dumps(position_data, indent=2, ensure_ascii=False))

                # 创建 tex/ 空文件夹
                zf.writestr('tex/', '')

            print(f"MKP项目已保存到: {target_path}")
            return {'success': True, 'path': target_path}
        except Exception as e:
            print(f"保存MKP项目失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def open_mkp_project(self):
        """打开MKP项目文件（从ZIP提取并加载模型）"""
        import json
        import zipfile
        import tempfile
        import shutil

        try:
            if self.window is None:
                return {'success': False, 'error': '窗口未初始化'}

            # 打开文件对话框选择 .mkp 文件
            result = self.window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=['MKP Project (*.mkp)', 'All files (*.*)']
            )
            if not result:
                return None

            mkp_path = result[0] if isinstance(result, (list, tuple)) else result

            # 创建临时目录用于提取
            extract_dir = tempfile.mkdtemp(prefix='mkp_')

            with zipfile.ZipFile(mkp_path, 'r') as zf:
                zf.extractall(extract_dir)

            # 读取 position 文件
            position_path = os.path.join(extract_dir, 'position')
            if not os.path.exists(position_path):
                shutil.rmtree(extract_dir, ignore_errors=True)
                return {'success': False, 'error': '无效的MKP文件：缺少 position 文件'}

            with open(position_path, 'r', encoding='utf-8') as f:
                project = json.load(f)

            # 从 model/ 目录加载模型
            model_dir = os.path.join(extract_dir, 'model')
            if os.path.exists(model_dir):
                print(f"  [load_mkp] model/ 目录内容: {os.listdir(model_dir)}")
                for model in project.get('models', []):
                    model_name = (model.get('name') or '')
                    print(f"  [load_mkp] 加载模型: '{model_name}', scale={model.get('scale')}")
                    # 找到对应的模型文件
                    obj_file = None
                    file_ext = None
                    model_file = model.get('modelFile')
                    if model_file:
                        candidate = os.path.normpath(os.path.join(model_dir, model_file))
                        model_root = os.path.abspath(model_dir)
                        if os.path.abspath(candidate).startswith(model_root) and os.path.exists(candidate):
                            obj_file = os.path.relpath(candidate, model_dir)
                            file_ext = os.path.splitext(candidate)[1].lower()
                    for fname in os.listdir(model_dir):
                        if obj_file:
                            break
                        fl = fname.lower()
                        if fl.endswith(('.obj', '.glb', '.gltf')):
                            base = os.path.splitext(fname)[0]
                            # 匹配：模型名 或 模型名+后缀
                            if base == model_name or model_name.startswith(base):
                                obj_file = fname
                                file_ext = os.path.splitext(fname)[1].lower()
                                break
                    if not obj_file:
                        print(f"  [load_mkp]   -> 未找到匹配的模型文件，跳过")
                        continue

                    obj_path = os.path.join(model_dir, obj_file)
                    print(f"  [load_mkp]   -> 匹配到: {obj_file}")
                    if file_ext in ['.glb', '.gltf']:
                        gltf_data = self._load_gltf(obj_path)
                        model['_modelData'] = {
                            'type': 'gltf',
                            'gltf': gltf_data.get('data') if gltf_data and gltf_data.get('success') else self._read_file_base64(obj_path)
                        }
                        model['_modelFilePath'] = obj_path
                        print(f"  [load_mkp]   -> GLTF _modelData 已设置")
                    else:
                        # 用 _load_obj 加载模型数据
                        model_data = self._load_obj(obj_path)
                        if model_data and model_data.get('success'):
                            model['_modelData'] = model_data
                            model['_modelFilePath'] = obj_path
                            print(f"  [load_mkp]   -> OBJ _modelData 已设置, obj长度={len(model_data.get('obj','') or '')}")
                        else:
                            print(f"  [load_mkp]   -> _load_obj 失败")

            # 记录临时目录和源文件路径
            project['_extractDir'] = extract_dir
            project['_mkpPath'] = mkp_path

            return {'success': True, 'project': project}
        except Exception as e:
            print(f"打开MKP项目失败: {e}")
            traceback.print_exc()
            # 清理临时目录
            try:
                shutil.rmtree(extract_dir, ignore_errors=True)
            except:
                pass
            return {'success': False, 'error': str(e)}

    def _extract_params_via_subprocess(self, gcode_path):
        """直接导入 GCodeGenerator 提取参数，返回 info dict"""
        import json as _json
        from GCodeGenerator import extract_gcode_params as _extract_params, estimate_print_time, params_to_json
        params = _extract_params(gcode_path)
        est = estimate_print_time(params)
        return _json.loads(params_to_json(params, est))

    def load_gcode_file(self, file_path):
        """从文件读取 GCode 内容，提取参数，存入内存并返回"""
        try:
            if not file_path or not os.path.exists(file_path):
                return {'success': False, 'error': '文件不存在'}
            if not file_path.lower().endswith('.gcode'):
                return {'success': False, 'error': '不是 .gcode 文件'}

            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                gcode = f.read()

            # 存入内存
            self._loaded_gcode_text = gcode
            self._loaded_gcode_path = file_path

            # 同步到切片状态，供 upload_gcode_to_printer 读取
            with self._slice_lock:
                self._slice_status['gcode_path'] = file_path

            # 通过子进程提取参数（避免主进程卡顿）
            import json as _json
            try:
                info = self._extract_params_via_subprocess(file_path)
                # 缓存 GCodeGenerator.estimate_print_time 所需的关键参数
                self._gcode_params = {
                    'inner_wall_speed': info.get('inner_wall_speed', 300),
                    'outer_wall_speed': info.get('outer_wall_speed', 200),
                    'total_print_distance': info.get('total_print_distance', 0),
                    'total_travel_distance': info.get('total_travel_distance', 0),
                    'travel_speed': info.get('travel_speed', 500),
                    'total_layers': info.get('total_layers', 0),
                    'layer_height': info.get('layer_height', 0.2),
                    'first_layer_height': info.get('first_layer_height', 0),
                    'travel_accel': info.get('travel_accel', 10000),
                    'total_e_distance': info.get('total_e_distance', 0),
                }
                self._gcode_info = info
                extra = {
                    'name': os.path.basename(file_path),
                    'path': file_path,
                    'size_bytes': len(gcode),
                }
                info.update(extra)
                return {'success': True, 'gcode': gcode, 'info': info}
            except Exception as e:
                # 参数提取失败不影响 gcode 加载
                print(f'提取 GCode 参数失败: {e}')
                self._gcode_params = None
                self._gcode_info = None
                return {
                    'success': True,
                    'gcode': gcode,
                    'info': {
                        'name': os.path.basename(file_path),
                        'path': file_path,
                        'size_bytes': len(gcode),
                    }
                }
        except Exception as e:
            print(f"读取GCode文件失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def get_gcode_info(self):
        """返回当前已加载的 GCode 信息（不导入任何模块）"""
        if self._loaded_gcode_text is None:
            return {'success': True, 'loaded': False}
        info = {
            'success': True,
            'loaded': True,
            'name': os.path.basename(self._loaded_gcode_path) if self._loaded_gcode_path else '',
            'path': self._loaded_gcode_path or '',
            'size_bytes': len(self._loaded_gcode_text),
        }
        if self._gcode_info:
            info.update(self._gcode_info)
        return info

    def get_gcode_generator_path(self, config_name="MKP standard"):
        """返回完整的后处理命令，包含 --Config 和 --Gcode"""
        if getattr(sys, 'frozen', False):
            exe_path = sys.executable
        else:
            exe_path = os.path.abspath(__file__)
        # 传完整配置文件路径（避免名称含空格被命令行拆散）
        settings_dir = self._get_print_settings_dir()
        config_path = os.path.join(settings_dir, config_name + '.json')
        if not os.path.exists(config_path):
            # 确保默认配置存在
            config_path = self.ensure_default_config()
        command = '"{}" --Config "{}" --Gcode'.format(exe_path, config_path)
        return {'success': True, 'command': command}

    def write_pending_slice(self, obj_path, layer_height=0.2, resolution=4000, focus_mm=None):
        """在触发 OrcaSlicer 前写入待处理信息，供后台子进程读取。
        若传入 focus_mm（前端算好的模型聚焦区 + padding，OBJ 空间 mm），
        同时算出聚焦缩放指导并写入 slice_focus.json，供预览预放大使用。
        """
        try:
            from pathlib import Path
            pending_path = Path.home() / 'Documents' / 'MKPSpectrum' / 'pending_slice.json'
            pending_path.parent.mkdir(parents=True, exist_ok=True)
            # 同时删除旧的进度文件，确保新一轮切片从干净状态开始
            old_progress = Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_progress.json'
            if old_progress.exists():
                try:
                    old_progress.unlink()
                    print('[write_pending_slice] 已删除旧进度文件')
                except Exception:
                    pass
            # 若给了聚焦区，就当场由主进程据此算好聚焦指导并写完 JSON（不依赖子进程）
            if focus_mm:
                self._slice_focus_mm = focus_mm
                self._slice_focus_guide = self._compute_focus_guide(obj_path, focus_mm, resolution)
                self._save_focus_guide(self._slice_focus_guide)
                print(f'[write_pending_slice] 已写入聚焦指导: {self._slice_focus_guide}')
            data = {
                'obj': obj_path,
                'layer_height': float(layer_height) if layer_height else 0.2,
                'resolution': int(resolution) if resolution else 4000,
            }
            with open(pending_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def read_slice_progress(self):
        """读取后台子进程的切片进度"""
        try:
            from pathlib import Path
            progress_path = Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_progress.json'
            if progress_path.exists():
                with open(progress_path, 'r', encoding='utf-8') as f:
                    return {'success': True, 'progress': json.load(f)}
            return {'success': True, 'progress': None}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def ensure_default_config(self):
        """确保 MKP standard.json 存在，不存在则从 Gitee 自动下载"""
        import urllib.request
        settings_dir = self._get_print_settings_dir()
        fpath = os.path.join(settings_dir, 'MKP standard.json')
        if not os.path.exists(fpath):
            _url = 'https://gitee.com/Jhmodel/mkpspectrum/raw/master/CONF/MKP%20standard.json'
            print(f"[Config] MKP standard.json 不存在，正在从 Gitee 自动下载...")
            try:
                urllib.request.urlretrieve(_url, fpath)
                print(f"[Config] 下载成功: {fpath}")
                return {'success': True, 'created': True}
            except Exception as e:
                print(f"[Config] 自动下载失败: {e}")
                print("[Config] 将创建最小默认配置以继续运行")
                default_data = {
                    "inkjet": {
                        "offset": {"x": 0, "y": 0},
                        "step": 0.1,
                        "imageOffset": {"x": "---", "y": "---"},
                        "density": 0.5,
                        "speed": 50,
                        "grab_macro": "GRAB_INKJET_HEAD",
                        "release_macro": "RELEASE_INKJET_HEAD",
                        "cmy": {"c": 1.0, "m": 1.0, "y": 1.0, "saturation": 0.0, "brightness": 0.0}
                    }
                }
                with open(fpath, 'w', encoding='utf-8') as f:
                    json.dump(default_data, f, indent=2, ensure_ascii=False)
                print(f"自动创建最小默认配置: {fpath}")
            return {'success': True, 'created': True}
        return {'success': True, 'created': False}

    def extract_gcode_params(self, gcode_path, inkjet_speed=None):
        """通过子进程提取切片参数（空驶速度/加速度/层高等）"""
        try:
            if not os.path.exists(gcode_path):
                return {'success': False, 'error': 'GCode 文件不存在: {}'.format(gcode_path)}
            info = self._extract_params_via_subprocess(gcode_path)
            return {'success': True, 'params': info}
        except Exception as e:
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def parse_gcode_toolpath(self):
        """在 Python 侧解析已加载的 GCode 为工具路径层/段数据，
        避免 JS 主线程解析大文本导致 UI 卡顿。
        返回 {success, layers: [{z, segments: [{type, points: [[x,y,z],...], color}]}]}"""
        import json as _json
        gcode = self._loaded_gcode_text
        if not gcode:
            return {'success': True, 'layers': []}

        TYPE_MAP = {
            'inner wall': 'inner_wall',
            'outer wall': 'outer_wall',
            'overhang wall': 'inner_wall',
            'sparse infill': 'infill',
            'internal solid infill': 'solid',
            'bottom surface': 'solid',
            'top surface': 'solid',
            'gap fill': 'infill',
            'support': 'support',
            'support interface': 'support',
            'skirt': 'travel',
            'brim': 'outer_wall',
        }
        COLOR_MAP = {
            'inner_wall': 0x4a9eff,
            'outer_wall': 0xff6b6b,
            'infill': 0x51cf66,
            'solid': 0xffd43b,
            'support': 0xcc9eff,
            'travel': 0x666666,
        }

        layers = []
        current_layer = None
        current_seg_type = 'travel'
        last_x = None
        last_y = None
        last_z = 0.0
        last_e = 0.0
        current_seg_points = []

        def flush_segment():
            nonlocal current_seg_points
            if len(current_seg_points) >= 2 and current_layer is not None:
                current_layer['segments'].append({
                    'type': current_seg_type,
                    'points': current_seg_points,
                    'color': COLOR_MAP.get(current_seg_type, COLOR_MAP['travel']),
                })
                current_seg_points = []

        def start_new_segment(seg_type):
            nonlocal current_seg_type, current_seg_points
            flush_segment()
            current_seg_type = seg_type
            if last_x is not None and last_y is not None:
                current_seg_points = [[last_x, last_y, last_z]]
            else:
                current_seg_points = []

        for line in gcode.split('\n'):
            line = line.strip()
            if not line or line.startswith(';'):
                m = re.match(r'^;LAYER_CHANGE', line, re.IGNORECASE)
                if m:
                    flush_segment()
                    current_layer = {'z': last_z, 'segments': []}
                    layers.append(current_layer)
                    current_seg_points = []
                    current_seg_type = 'travel'
                    last_e = 0.0
                m = re.match(r'^;TYPE:\s*(.+)', line, re.IGNORECASE)
                if m:
                    raw_type = m.group(1).strip().lower()
                    mapped = TYPE_MAP.get(raw_type, current_seg_type)
                    start_new_segment(mapped)
                m = re.match(r'^;Z:\s*([\d.]+)', line, re.IGNORECASE)
                if m and current_layer is not None:
                    current_layer['z'] = float(m.group(1))
                continue

            cmd_match = re.match(r'^(G[0-3])\s', line, re.IGNORECASE)
            if not cmd_match:
                continue
            cmd = cmd_match.group(1)

            x_val = None
            y_val = None
            z_val = None
            e_val = None
            i_val = None
            j_val = None

            for part in line.split():
                if part.startswith('X') or part.startswith('x'):
                    try: x_val = float(part[1:])
                    except: pass
                elif part.startswith('Y') or part.startswith('y'):
                    try: y_val = float(part[1:])
                    except: pass
                elif part.startswith('Z') or part.startswith('z'):
                    try: z_val = float(part[1:])
                    except: pass
                elif part.startswith('E') or part.startswith('e'):
                    try: e_val = float(part[1:])
                    except: pass
                elif part.startswith('I') or part.startswith('i'):
                    try: i_val = float(part[1:])
                    except: pass
                elif part.startswith('J') or part.startswith('j'):
                    try: j_val = float(part[1:])
                    except: pass

            if z_val is not None:
                last_z = z_val

            is_extrude = False
            if e_val is not None:
                if e_val > 0.0001:
                    is_extrude = True
                last_e = e_val

            if x_val is not None and y_val is not None:
                if not is_extrude and current_seg_type != 'travel':
                    start_new_segment('travel')
                    current_seg_points.append([x_val, y_val, last_z])

                if not current_seg_points:
                    current_seg_points.append([x_val, y_val, last_z])

                # G2/G3 arc
                if cmd in ('G2', 'G3') and i_val is not None and j_val is not None:
                    cx = (last_x or 0) + i_val
                    cy = (last_y or 0) + j_val
                    rad = math.sqrt(i_val ** 2 + j_val ** 2)
                    if rad > 0.01:
                        start_angle = math.atan2((last_y or 0) - cy, (last_x or 0) - cx)
                        end_angle = math.atan2(y_val - cy, x_val - cx)
                        arc_segs = 16
                        ccw = cmd == 'G3'
                        for s in range(1, arc_segs):
                            t = s / arc_segs
                            if ccw and end_angle <= start_angle:
                                angle = start_angle + (end_angle + 2 * math.pi - start_angle) * t
                            elif not ccw and end_angle > start_angle:
                                angle = start_angle + (end_angle - 2 * math.pi - start_angle) * t
                            else:
                                angle = start_angle + (end_angle - start_angle) * t
                            ax = cx + rad * math.cos(angle)
                            ay = cy + rad * math.sin(angle)
                            current_seg_points.append([ax, ay, last_z])

                current_seg_points.append([x_val, y_val, last_z])
                last_x = x_val
                last_y = y_val

        flush_segment()
        return {'success': True, 'layers': layers}

    def cleanup_temp_dir(self, dir_path):
        """清理 MKP 解压后的临时目录"""
        import shutil
        try:
            if dir_path and os.path.exists(dir_path):
                shutil.rmtree(dir_path, ignore_errors=True)
            return True
        except Exception:
            return False

    def get_recent_projects(self):
        """获取最近打开的项目列表（缩略图以 base64 嵌入）"""
        import base64
        import hashlib
        try:
            config = self._get_full_config()
            raw_projects = config.get('recentProjects', [])
            thumb_dir = self._get_thumb_dir()
            projects = []
            for proj in raw_projects:
                path = proj.get('path') or ''
                # 原文件已不存在时不再显示
                if not os.path.exists(path):
                    continue
                item = {
                    'path': path,
                    'name': proj.get('name') or '',
                    'date': proj.get('date') or '',
                    'thumbnail': ''
                }
                # 尝试从 Thumb 目录读取缩略图
                path_hash = hashlib.md5((proj.get('path') or '').encode('utf-8')).hexdigest()
                thumb_path = str(thumb_dir / f'{path_hash}.png')
                if os.path.exists(thumb_path):
                    try:
                        with open(thumb_path, 'rb') as f:
                            img_data = f.read()
                            b64 = base64.b64encode(img_data).decode('utf-8')
                            item['thumbnailData'] = 'data:image/png;base64,' + b64
                    except:
                        pass
                projects.append(item)
            return {'success': True, 'projects': projects}
        except Exception as e:
            print(f"获取最近项目失败: {e}")
            return {'success': False, 'projects': []}

    def add_recent_project(self, file_path):
        """添加项目到最近列表（最多5个，超出移除较老项目和对应缩略图）"""
        import hashlib
        try:
            if not file_path or not os.path.exists(file_path):
                return {'success': False}
            config = self._get_full_config()
            projects = config.get('recentProjects', [])
            # 去重
            projects = [p for p in projects if p.get('path') != file_path]
            # 添加到最前
            projects.insert(0, {
                'path': file_path,
                'name': os.path.splitext(os.path.basename(file_path))[0],
                'date': datetime.now().strftime('%Y-%m-%d %H:%M')
            })
            # 超过5个时，删除较老项目的缩略图
            if len(projects) > 5:
                thumb_dir = self._get_thumb_dir()
                for old_proj in projects[5:]:
                    old_hash = hashlib.md5((old_proj.get('path') or '').encode('utf-8')).hexdigest()
                    old_thumb = thumb_dir / f'{old_hash}.png'
                    if old_thumb.exists():
                        try:
                            old_thumb.unlink()
                            print(f"已移除旧缩略图: {old_thumb}")
                        except:
                            pass
            # 保留最多5个
            config['recentProjects'] = projects[:5]
            self._save_full_config(config)
            return {'success': True}
        except Exception as e:
            print(f"添加最近项目失败: {e}")
            return {'success': False}

    def clear_recent_projects(self):
        """清空最近项目列表和所有缩略图"""
        try:
            thumb_dir = self._get_thumb_dir()
            # 删除所有缩略图文件
            for f in thumb_dir.glob('*.png'):
                try:
                    f.unlink()
                except:
                    pass
            config = self._get_full_config()
            config['recentProjects'] = []
            self._save_full_config(config)
            print("最近项目已清空")
            return {'success': True}
        except Exception as e:
            print(f"清空最近项目失败: {e}")
            return {'success': False}

    def _get_thumb_dir(self):
        """获取缩略图存储目录 Documents/MKPSpectrum/Thumb/"""
        thumb_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Thumb'
        thumb_dir.mkdir(parents=True, exist_ok=True)
        return thumb_dir

    def save_project_thumbnail(self, mkp_path, thumbnail_base64):
        """保存项目缩略图（128x128 PNG）到 Documents/MKPSpectrum/Thumb/"""
        import base64
        import hashlib
        try:
            if not mkp_path:
                return {'success': False, 'error': '路径为空'}
            # 用 mkp 路径的 hash 作为缩略图文件名，避免路径中特殊字符问题
            path_hash = hashlib.md5(mkp_path.encode('utf-8')).hexdigest()
            thumb_dir = self._get_thumb_dir()
            thumb_path = str(thumb_dir / f'{path_hash}.png')
            # 解析 base64（可能包含 data:image/png;base64, 前缀）
            if ',' in thumbnail_base64:
                thumbnail_base64 = thumbnail_base64.split(',')[1]
            img_data = base64.b64decode(thumbnail_base64)
            with open(thumb_path, 'wb') as f:
                f.write(img_data)
            print(f"缩略图已保存: {thumb_path}")
            return {'success': True, 'thumbnail': thumb_path}
        except Exception as e:
            print(f"保存缩略图失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def _get_full_config(self):
        """读取完整配置文件"""
        import json
        path = self._get_settings_path()
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return {}

    def _save_full_config(self, config):
        """写入完整配置文件"""
        import json
        path = self._get_settings_path()
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)

    def load_mkp_project(self, file_path):
        """按路径直接打开 MKP 项目（用于最近项目列表）"""
        import json
        import zipfile
        import tempfile
        import shutil

        try:
            if not file_path or not os.path.exists(file_path):
                return {'success': False, 'error': '文件不存在'}

            extract_dir = tempfile.mkdtemp(prefix='mkp_')

            with zipfile.ZipFile(file_path, 'r') as zf:
                zf.extractall(extract_dir)

            position_path = os.path.join(extract_dir, 'position')
            if not os.path.exists(position_path):
                shutil.rmtree(extract_dir, ignore_errors=True)
                return {'success': False, 'error': '无效的MKP文件：缺少 position 文件'}

            with open(position_path, 'r', encoding='utf-8') as f:
                project = json.load(f)

            # 从 model/ 加载模型
            model_dir = os.path.join(extract_dir, 'model')
            if os.path.exists(model_dir):
                for model in project.get('models', []):
                    model_name = model.get('name', '')
                    obj_file = None
                    file_ext = None
                    model_file = model.get('modelFile')
                    if model_file:
                        candidate = os.path.normpath(os.path.join(model_dir, model_file))
                        model_root = os.path.abspath(model_dir)
                        if os.path.abspath(candidate).startswith(model_root) and os.path.exists(candidate):
                            obj_file = os.path.relpath(candidate, model_dir)
                            file_ext = os.path.splitext(candidate)[1].lower()
                    # 先查找 .obj 文件
                    if not obj_file:
                        for fname in os.listdir(model_dir):
                            if fname.lower().endswith('.obj'):
                                base = os.path.splitext(fname)[0]
                                if base == model_name or model_name.startswith(base):
                                    obj_file = fname
                                    file_ext = '.obj'
                                    break
                    # 再查找 .glb / .gltf 文件
                    if not obj_file:
                        for fname in os.listdir(model_dir):
                            if fname.lower().endswith(('.glb', '.gltf')):
                                base = os.path.splitext(fname)[0]
                                if base == model_name or model_name.startswith(base):
                                    obj_file = fname
                                    file_ext = os.path.splitext(fname)[1].lower()
                                    break
                    if not obj_file:
                        print(f"  [load_mkp]   -> 未找到模型文件: {model_name}")
                        continue
                    obj_path = os.path.join(model_dir, obj_file)
                    print(f"  [load_mkp]   -> 加载: {obj_path}")
                    if file_ext in ['.glb', '.gltf']:
                        # GLB/GLTF: 读取为 base64 data URL
                        gltf_data = self._load_gltf(obj_path)
                        model['_modelData'] = {
                            'type': 'gltf',
                            'gltf': gltf_data.get('data') if gltf_data and gltf_data.get('success') else self._read_file_base64(obj_path)
                        }
                        model['_modelFilePath'] = obj_path
                        print(f"  [load_mkp]   -> GLTF 成功")
                    else:
                        model_data = self._load_obj(obj_path)
                        if model_data and model_data.get('success'):
                            model['_modelData'] = model_data
                            model['_modelFilePath'] = obj_path
                            print(f"  [load_mkp]   -> OBJ 成功")
                        else:
                            err = (model_data or {}).get('error', '未知错误')
                            print(f"  [load_mkp]   -> 失败: {err}")

            project['_extractDir'] = extract_dir
            return {'success': True, 'project': project}
        except Exception as e:
            print(f"打开MKP项目失败: {e}")
            traceback.print_exc()
            try:
                shutil.rmtree(extract_dir, ignore_errors=True)
            except:
                pass
            return {'success': False, 'error': str(e)}

    def register_mkp_association(self):
        """注册 .mkp 文件关联到本程序（Windows）——极简方案：只写 HKCU，不碰 UserChoice。

        首次双击会弹出“打开方式”选择框，本程序排在首位，用户勾选“始终使用此应用”后即为默认。
        无需管理员权限，不依赖 SetUserFTA/Hash。
        """
        try:
            if platform.system() != 'Windows':
                return {'success': False, 'error': '仅支持Windows系统'}

            if getattr(sys, 'frozen', False):
                exe_path = os.path.abspath(sys.executable)
                base_dir = getattr(sys, '_MEIPASS', os.path.dirname(exe_path))
                open_cmd = f'"{exe_path}" "%1"'
            else:
                exe_path = os.path.abspath(sys.executable)
                script_path = os.path.abspath(__file__)
                base_dir = os.path.dirname(script_path)
                open_cmd = f'"{exe_path}" "{script_path}" "%1"'

            ico_candidates = [
                os.path.join(base_dir, 'MKPProgram.ico'),
                os.path.join(os.path.dirname(os.path.abspath(sys.executable)), 'MKPProgram.ico'),
                os.path.join(os.path.dirname(os.path.abspath(sys.executable)), '_internal', 'MKPProgram.ico'),
                os.path.join(os.path.dirname(os.path.abspath(__file__)), 'MKPProgram.ico'),
            ]
            ico_path = next((p for p in ico_candidates if os.path.exists(p)), None)
            if ico_path:
                ico_path = os.path.abspath(ico_path)
                ico_value = f'{ico_path},0'
            else:
                ico_value = None
                print(f'[register] 未找到 MKPProgram.ico，跳过图标写入')

            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\.mkp') as key:
                winreg.SetValueEx(key, '', 0, winreg.REG_SZ, 'MKPSpectrum.Project')

            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\MKPSpectrum.Project') as key:
                winreg.SetValueEx(key, '', 0, winreg.REG_SZ, 'MKP Project')

            if ico_value:
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\MKPSpectrum.Project\DefaultIcon') as key:
                    winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_value)
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\.mkp\DefaultIcon') as key:
                    winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_value)
                try:
                    for progid in _get_mkp_progids():
                        if progid == 'MKPSpectrum.Project':
                            continue
                        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf'Software\Classes\{progid}\DefaultIcon') as key:
                            try:
                                cur, _ = winreg.QueryValueEx(key, '')
                            except FileNotFoundError:
                                cur = None
                            if cur != ico_value:
                                winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_value)
                except Exception:
                    pass

            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\MKPSpectrum.Project\shell\open\command') as key:
                winreg.SetValueEx(key, '', 0, winreg.REG_SZ, open_cmd)

            try:
                import ctypes
                ctypes.windll.shell32.SHChangeNotify(0x08000000, 0x0000, None, None)
            except Exception:
                pass

            try:
                cfg = _get_config()
                cfg['icon_registered'] = True
                _save_config(cfg)
            except Exception:
                pass

            print("MKP文件关联注册成功（极简：首次双击需勾选始终使用）")
            return {'success': True, 'message': 'MKP文件关联注册成功，首次双击请勾选“始终使用此应用”'}
        except Exception as e:
            print(f"注册MKP文件关联异常: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def process_dropped_file(self, file_name, base64_data, extra_files_str=None):
        """处理拖拽导入的文件（保存到临时目录后加载）
        
        extra_files_str: JSON 字符串，格式 [{"name": "file.mtl", "data": "base64..."}, ...]
        用于在拖拽 OBJ 时一起保存 MTL 和贴图文件。
        """
        import tempfile
        import base64
        import shutil
        import json

        try:
            # 解码并保存主文件
            if ',' in base64_data:
                base64_data = base64_data.split(',')[1]
            file_content = base64.b64decode(base64_data)

            temp_dir = tempfile.mkdtemp(prefix='drop_')
            save_path = os.path.join(temp_dir, file_name)
            with open(save_path, 'wb') as f:
                f.write(file_content)

            # 保存额外文件（MTL、贴图等）
            if extra_files_str:
                try:
                    extra_files = json.loads(extra_files_str) if isinstance(extra_files_str, str) else extra_files_str
                    for ef in extra_files:
                        ef_name = ef.get('name', '')
                        ef_data = ef.get('data', '')
                        if ef_name and ef_data:
                            if ',' in ef_data:
                                ef_data = ef_data.split(',')[1]
                            ef_bytes = base64.b64decode(ef_data)
                            ef_path = os.path.join(temp_dir, ef_name)
                            with open(ef_path, 'wb') as f:
                                f.write(ef_bytes)
                            print(f"  额外文件已保存: {ef_name}")
                except Exception as e:
                    print(f"保存额外文件失败 (非致命): {e}")

            ext = os.path.splitext(file_name)[1].lower()

            # MKP 项目文件
            if ext == '.mkp':
                result = self.load_mkp_project(save_path)
                if result and result.get('success'):
                    result['mkpPath'] = save_path  # 供前端 add_recent_project 使用
                return result

            # 模型文件
            result = self.load_model({'path': save_path})
            if result and result.get('success'):
                result['savedPath'] = save_path
                # 记录临时目录，后续清理
                result['_tempDir'] = temp_dir
            else:
                shutil.rmtree(temp_dir, ignore_errors=True)
            return result

        except Exception as e:
            print(f"处理拖拽文件失败: {e}")
            traceback.print_exc()
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except:
                pass
            return {'success': False, 'error': str(e)}

    def save_stl_to_temp(self, stl_str, filename):
        """保存STL字符串到 Documents/MKPSpectrum/Temp/Model/Stl 文件夹（先清空旧文件）"""
        try:
            import shutil
            stl_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Temp' / 'Model' / 'Stl'
            # 清空已有文件
            if stl_dir.exists():
                shutil.rmtree(stl_dir)
            stl_dir.mkdir(parents=True, exist_ok=True)
            file_path = stl_dir / filename
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(stl_str)
            print(f"STL已保存到: {file_path}")
            return {'success': True, 'path': str(file_path)}
        except Exception as e:
            print(f"保存STL失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def save_baked_model_to_temp(self, data_json_str):
        """保存烘焙后的模型（OBJ + MTL + 贴图）到临时目录，返回文件路径"""
        import json
        import base64
        import tempfile

        try:
            data = json.loads(data_json_str) if isinstance(data_json_str, str) else data_json_str

            # 创建临时目录
            temp_dir = tempfile.mkdtemp(prefix='mkp_baked_')

            obj_content = data.get('obj', '')
            model_name = data.get('name', 'model')
            # 去掉扩展名，确保保存为 .obj
            model_base = os.path.splitext(model_name)[0]
            obj_name = f'{model_base}.obj'
            obj_path = os.path.join(temp_dir, obj_name)
            with open(obj_path, 'w', encoding='utf-8') as f:
                f.write(obj_content)

            mtl_content = data.get('mtl', '')
            if mtl_content:
                mtl_name = f'{model_base}.mtl'
                mtl_path = os.path.join(temp_dir, mtl_name)
                with open(mtl_path, 'w', encoding='utf-8') as f:
                    f.write(mtl_content)

            for tex_name, tex_data in data.get('textures', {}).items():
                if ',' in tex_data:
                    tex_data = tex_data.split(',')[1]
                img_bytes = base64.b64decode(tex_data)
                with open(os.path.join(temp_dir, tex_name), 'wb') as f:
                    f.write(img_bytes)

            print(f"烘焙模型已保存到: {obj_path}")
            return {'success': True, 'path': obj_path}
        except Exception as e:
            print(f"保存烘焙模型失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def _baked_base_name(self, name_hint):
        base = os.path.splitext((name_hint or 'model').strip() or 'model')[0]
        base = ''.join(c if c.isalnum() or c in ('-', '_') else '_' for c in base).strip('_') or 'model'
        return base

    def save_baked_glb(self, glb_b64, name_hint='model'):
        """烘焙后的 GLB（已把当前变换写入顶点）。弹出系统另存为对话框，默认文件名 <模型名>.glb。"""
        import base64
        try:
            if self.window is None:
                return {'success': False, 'error': '窗口未初始化'}
            if not glb_b64:
                return {'success': False, 'error': 'GLB 数据为空'}
            raw = glb_b64.split(',', 1)[1] if ',' in glb_b64 else glb_b64
            glb_bytes = base64.b64decode(raw)
            base = self._baked_base_name(name_hint)
            suggestion = f'{base}.glb'
            target = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggestion,
                file_types=['GLB (*.glb)', 'All files (*.*)'],
            )
            if not target:
                return {'success': False, 'error': '已取消'}
            target_path = target[0] if isinstance(target, (list, tuple)) else target
            if not target_path.lower().endswith('.glb'):
                target_path += '.glb'
            os.makedirs(os.path.dirname(os.path.abspath(target_path)) or '.', exist_ok=True)
            with open(target_path, 'wb') as f:
                f.write(glb_bytes)
            print(f"[导出GLB] 已导出到: {target_path} ({len(glb_bytes)} bytes)")
            return {'success': True, 'path': target_path}
        except Exception as e:
            print(f"[导出GLB] 失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def save_baked_obj_bundle(self, data_json_str):
        """烘焙后的 OBJ + MTL + 贴图。弹出系统另存为（选 OBJ 路径），同目录同步写出 MTL 与贴图。"""
        import json as _json
        import base64 as _b64
        try:
            if self.window is None:
                return {'success': False, 'error': '窗口未初始化'}
            data = _json.loads(data_json_str) if isinstance(data_json_str, str) else data_json_str
            name_hint = data.get('name') or data.get('name_hint') or 'model'
            base = self._baked_base_name(name_hint)
            suggestion = f'{base}.obj'
            target = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggestion,
                file_types=['Wavefront OBJ (*.obj)', 'All files (*.*)'],
            )
            if not target:
                return {'success': False, 'error': '已取消'}
            obj_path = target[0] if isinstance(target, (list, tuple)) else target
            if not obj_path.lower().endswith('.obj'):
                obj_path += '.obj'
            out_dir = os.path.dirname(os.path.abspath(obj_path)) or '.'
            os.makedirs(out_dir, exist_ok=True)
            base_no_ext = os.path.splitext(os.path.basename(obj_path))[0]
            obj_content = data.get('obj') or ''
            mtl_content = data.get('mtl') or ''
            textures = data.get('textures') or {}
            if mtl_content:
                obj_content = obj_content.replace(f'mtllib {base}.mtl', f'mtllib {base_no_ext}.mtl')
                obj_content = obj_content.replace('mtllib model.mtl', f'mtllib {base_no_ext}.mtl')
            with open(obj_path, 'w', encoding='utf-8') as f:
                f.write(obj_content)
            if mtl_content:
                mtl_path = os.path.join(out_dir, f'{base_no_ext}.mtl')
                mtl_to_write = mtl_content
                with open(mtl_path, 'w', encoding='utf-8') as f:
                    f.write(mtl_to_write)
            for tex_name, tex_b64 in textures.items():
                raw = tex_b64.split(',', 1)[1] if isinstance(tex_b64, str) and ',' in tex_b64 else tex_b64
                try:
                    img = _b64.b64decode(raw) if isinstance(raw, str) else raw
                except Exception:
                    continue
                # 贴图与 OBJ 同目录
                safe_name = os.path.basename(tex_name)
                with open(os.path.join(out_dir, safe_name), 'wb') as f:
                    f.write(img)
            print(f"[导出OBJ] 已导出到: {obj_path} (+ .mtl + {len(textures)} 张贴图)")
            return {'success': True, 'path': obj_path}
        except Exception as e:
            print(f"[导出OBJ] 失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def save_textured_obj_to_temp(self, data_json_str):
        """保存 OBJ + MTL + 贴图到 Documents/MKPSpectrum/Temp/Model/Tex 目录（先清空旧文件）"""
        import json
        import base64
        import shutil

        try:
            data = json.loads(data_json_str) if isinstance(data_json_str, str) else data_json_str

            # 固定目录: Documents/MKPSpectrum/Temp/Model/Tex
            tex_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Temp' / 'Model' / 'Tex'
            if tex_dir.exists():
                shutil.rmtree(tex_dir)
            tex_dir.mkdir(parents=True, exist_ok=True)

            # 写 OBJ 文件
            obj_content = data.get('obj', '')
            obj_path = tex_dir / 'model.obj'
            with open(obj_path, 'w', encoding='utf-8') as f:
                f.write(obj_content)

            # 写 MTL 文件
            mtl_content = data.get('mtl', '')
            if mtl_content:
                with open(tex_dir / 'model.mtl', 'w', encoding='utf-8') as f:
                    f.write(mtl_content)

            # 写贴图文件
            for tex_name, tex_data in data.get('textures', {}).items():
                if ',' in tex_data:
                    tex_data = tex_data.split(',')[1]
                img_bytes = base64.b64decode(tex_data)
                with open(tex_dir / tex_name, 'wb') as f:
                    f.write(img_bytes)

            print(f"纹理 OBJ 已保存到: {obj_path}")
            return {'success': True, 'path': str(obj_path)}
        except Exception as e:
            print(f"保存纹理 OBJ 失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def slice_model(self, project_json_str):
        """切片模型：调用 OrcaSlicer 进行层积切片
        
        接收前端传递的项目数据（含切片参数），
        生成 OrcaSlicer 配置文件并执行切片。
        """
        import json
        import subprocess
        from datetime import datetime

        try:
            project = json.loads(project_json_str) if isinstance(project_json_str, str) else project_json_str

            # 1. 获取切片参数
            slice_params = project.get('sliceParams', {})
            orca_path = project.get('orcaSlicerPath', '') or self.resolve_orca_slicer().get('path', '')

            if not orca_path or not os.path.exists(orca_path):
                # 尝试从配置加载
                config = self._get_full_config()
                orca_path = config.get('orcaSlicerPath', '')
                if not orca_path or not os.path.exists(orca_path):
                    return {'success': False, 'error': 'OrcaSlicer 路径未配置'}

            # 2. 找到最近的 STL 文件
            temp_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Temp' / 'Model' / 'Stl'
            stl_files = sorted(temp_dir.glob('*.stl'), key=os.path.getmtime, reverse=True)
            if not stl_files:
                return {'success': False, 'error': '未找到导出的 STL 文件，请先导出 STL'}
            stl_path = str(stl_files[0])

            # 3. 生成 OrcaSlicer 配置文件
            now_str = datetime.now().strftime('%Y%m%d_%H%M%S')
            config_dir = temp_dir / 'configs'
            config_dir.mkdir(parents=True, exist_ok=True)

            # 提取参数（带默认值）
            layer_height = float(slice_params.get('layer_height', 0.20))
            infill_density = int(slice_params.get('infill_density', 20))
            wall_count = int(slice_params.get('wall_count', 3))
            top_layers = int(slice_params.get('top_layers', 4))
            bottom_layers = int(slice_params.get('bottom_layers', 4))
            print_speed = int(slice_params.get('print_speed', 60))
            support = slice_params.get('support', 'none')

            # 生成 .config 配置（OrcaSlicer ini 风格）
            config_lines = [
                '# generated by MKPSpectrum',
                f'# {datetime.now().isoformat()}',
                '',
                'print_settings = MKPSpectrum_Process',
                '',
                '[MKPSpectrum_Process]',
                f'layer_height = {layer_height}',
                f'initial_layer_print_height = {layer_height}',
                f'wall_loops = {wall_count}',
                f'top_shell_layers = {top_layers}',
                f'bottom_shell_layers = {bottom_layers}',
                f'sparse_infill_density = {infill_density}%',
                f'speed = {print_speed}',
                '',
                '[filament_settings]',
                'filament_settings_id = MKPSpectrum_Filament',
                '',
                '[MKPSpectrum_Filament]',
                'filament_type = PLA',
                'filament_density = 1.24',
                f'print_speed = {print_speed}',
                '',
                '[printer_settings]',
                'printer_settings_id = MKPSpectrum_Printer',
                '',
                '[MKPSpectrum_Printer]',
                f'printable_area = 0x0,{project.get("bedSize",{}).get("x",270)}x0,{project.get("bedSize",{}).get("x",270)}x{project.get("bedSize",{}).get("y",270)},0x{project.get("bedSize",{}).get("y",270)}',
                f'printable_height = {project.get("bedSize",{}).get("z",270)}',
            ]

            if support != 'none':
                config_lines.append(f'enable_support = 1')
                config_lines.append(f'support_type = {support}')
            else:
                config_lines.append(f'enable_support = 0')

            config_path = config_dir / f'mkp_config_{now_str}.config'
            with open(config_path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(config_lines))

            # 4. 输出 GCode 路径
            output_gcode = str(temp_dir / f'mkp_output_{now_str}.gcode')

            # 5. 调用 OrcaSlicer
            # OrcaSlicer_console 在 OrcaSlicer 安装目录下
            orca_dir = os.path.dirname(orca_path)
            console_path = os.path.join(orca_dir, 'OrcaSlicer_console.exe')
            if not os.path.exists(console_path):
                # 直接用 orca_path（可能是 orca_slicer.exe）
                console_path = orca_path

            cmd = [
                console_path,
                '--export-gcode',
                '--load', str(config_path),
                '--output', output_gcode,
                stl_path,
            ]

            print(f"执行切片命令: {' '.join(cmd)}")
            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=600
            )

            if result.returncode != 0:
                error_msg = result.stderr.strip() or result.stdout.strip() or '未知错误'
                return {'success': False, 'error': f'OrcaSlicer 返回错误: {error_msg[:500]}'}

            # 6. 读取生成的 GCode
            if os.path.exists(output_gcode):
                self._last_slice_output = output_gcode
                with open(output_gcode, 'r', encoding='utf-8', errors='replace') as f:
                    gcode_text = f.read()
                return {
                    'success': True,
                    'gcode': gcode_text,
                    'path': output_gcode,
                    'params': slice_params
                }
            else:
                return {'success': False, 'error': 'OrcaSlicer 未生成 GCode 文件'}

        except subprocess.TimeoutExpired:
            return {'success': False, 'error': '切片超时（超过 10 分钟）'}
        except Exception as e:
            print(f"切片异常: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def texture_slice_start(self, config_str):
        """纹理切片 + 后处理一体化：
        启动 MKPSpectrum.exe --mode slice-and-postprocess 子进程，
        子进程执行 纹理切片 → 条带切割 → GCode 后处理，
        进度以 JSON 行输出到 stdout，完成后生成最终 GCode。
        """
        import json

        if self._slice_proc is not None:
            return {'success': False, 'error': '已有切片任务在进行中'}

        try:
            config = json.loads(config_str) if isinstance(config_str, str) else config_str

            obj_path = config.get('obj_path', '')
            if not obj_path or not os.path.exists(obj_path):
                return {'success': False, 'error': 'OBJ 文件不存在'}

            # 需要先加载基础 GCode
            if not self._loaded_gcode_path or not os.path.exists(self._loaded_gcode_path):
                return {'success': False, 'error': '请先加载基础 GCode 文件'}

            layer_height = float(config.get('layer_height', 0.2))
            resolution = int(config.get('resolution', 4000))

            # 前端传来的聚焦矩形（OBJ 空间的模型包围盒 + padding，mm）→ 预览图缩放指导
            focus_mm = config.get('focus_mm', None)
            self._slice_focus_mm = focus_mm
            self._slice_focus_guide = self._compute_focus_guide(obj_path, focus_mm, resolution)
            self._save_focus_guide(self._slice_focus_guide)

            # 输出目录
            import shutil
            output_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if os.path.exists(output_dir):
                shutil.rmtree(output_dir)
            os.makedirs(output_dir, exist_ok=True)
            self._slice_output_dir = output_dir

            # 重置状态
            with self._slice_lock:
                self._slice_status = {
                    'state': 'running',
                    'progress': 0,
                    'total': 0,
                    'images': 0,
                    'stage': 'slice',
                    'gcode_path': '',
                    'error': None,
                }

            # 构建子进程命令行
            if getattr(sys, 'frozen', False):
                cmd = [sys.executable]
            else:
                cmd = [sys.executable, os.path.abspath(__file__)]

            cmd += [
                '--mode', 'slice-and-postprocess',
                '--obj', obj_path,
                '--gcode', self._loaded_gcode_path,
                '--output', output_dir,
                '--layer_height', str(layer_height),
                '--resolution', str(resolution),
            ]

            # 启动子进程
            creationflags = 0x08000000 if sys.platform == 'win32' else 0  # CREATE_NO_WINDOW
            self._slice_proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                creationflags=creationflags,
            )

            # 后台线程读取子进程 stdout
            def _read_subprocess_output():
                try:
                    for line in self._slice_proc.stdout:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            msg = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        msg_type = msg.get('type', '')
                        if msg_type == 'progress':
                            with self._slice_lock:
                                self._slice_status['progress'] = msg.get('current', 0)
                                self._slice_status['total'] = msg.get('total', 0)
                                self._slice_status['images'] = msg.get('current', 0)
                        elif msg_type == 'stage':
                            with self._slice_lock:
                                self._slice_status['stage'] = msg.get('stage', '')
                        elif msg_type == 'done':
                            with self._slice_lock:
                                if msg.get('stage', '') == 'slice':
                                    self._slice_status['state'] = 'done'
                                    self._slice_status['progress'] = msg.get('count', 0)
                                    self._slice_status['total'] = msg.get('count', 0)
                        elif msg_type == 'strip_done':
                            with self._slice_lock:
                                self._slice_status['state'] = 'strips_done'
                                self._slice_status['progress'] = msg.get('layers', 0)
                                self._slice_status['total'] = msg.get('layers', 0)
                        elif msg_type == 'result':
                            with self._slice_lock:
                                self._slice_status['state'] = 'complete'
                                self._slice_status['gcode_path'] = msg.get('gcode_path', '')
                                self._slice_status['images'] = msg.get('total_layers', 0)
                                self._slice_status['stage'] = 'done'
                        elif msg_type == 'cancelled':
                            with self._slice_lock:
                                self._slice_status['state'] = 'cancelled'
                        elif msg_type == 'error':
                            with self._slice_lock:
                                self._slice_status['state'] = 'error'
                                self._slice_status['error'] = msg.get('message', '未知错误')
                except Exception as e:
                    with self._slice_lock:
                        if self._slice_status['state'] not in ('complete', 'cancelled'):
                            self._slice_status['state'] = 'error'
                            self._slice_status['error'] = str(e)
                finally:
                    # 等待子进程退出
                    if self._slice_proc:
                        try:
                            self._slice_proc.wait(timeout=5)
                        except Exception:
                            pass
                        self._slice_proc = None  # 释放引用，允许下次切片启动
                    # 更新实际图片数量
                    try:
                        import glob as _glob
                        png_files = _glob.glob(os.path.join(output_dir, '*.png'))
                        with self._slice_lock:
                            self._slice_status['images'] = len(png_files)
                    except Exception:
                        pass
                    # 切片结束，释放主进程中的大型缓存
                    self._cleanup_slice_memory()

            self._slice_thread = threading.Thread(target=_read_subprocess_output, daemon=True)
            self._slice_thread.start()

            # 后台线程读取子进程 stderr，防止管道缓冲区满导致死锁
            def _read_subprocess_stderr():
                try:
                    for _line in self._slice_proc.stderr:
                        pass  # 静默丢弃，仅防止管道阻塞
                except Exception:
                    pass

            self._stderr_thread = threading.Thread(target=_read_subprocess_stderr, daemon=True)
            self._stderr_thread.start()

            print(f"切片+后处理子进程已启动: obj={obj_path} layer={layer_height} res={resolution} gcode={self._loaded_gcode_path}")
            return {'success': True}

        except Exception as e:
            print(f"切片+后处理启动失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def _compute_focus_guide(self, obj_path, focus_mm, resolution):
        """把前端传来的聚焦矩形（OBJ 空间模型 bbox+padding，mm）换算成预览图归一化矩形。

        复用与 slice_standalone.run_slice 一致的 fit 逻辑：全部顶点（含四角定位面）
        决定渲染 scale/center，再把 focus_mm 经 _w2p 映射到预览图像素并归一化到 0..1。

        返回: {'x','y','w','h'}（0..1）或 None（无法计算）。
        """
        try:
            if not obj_path or not os.path.exists(obj_path):
                return None
            import slice_standalone
            vertices, _, faces_by_material = slice_standalone.parse_obj(obj_path)
            if not vertices:
                return None
            min_x = min(v[0] for v in vertices)
            max_x = max(v[0] for v in vertices)
            min_y = min(v[1] for v in vertices)
            max_y = max(v[1] for v in vertices)
            if max_x <= min_x or max_y <= min_y:
                return None

            img_size = int(resolution) or 4000
            span_x = max_x - min_x
            span_y = max_y - min_y
            scale = min(img_size / span_x, img_size / span_y)
            center_x = (min_x + max_x) / 2.0
            center_y = (min_y + max_y) / 2.0
            half_size = img_size / 2.0

            def w2p(x, y):
                return ((x - center_x) * scale + half_size,
                        half_size - (y - center_y) * scale)

            # Prefer the exported OBJ itself as the source of truth: preview PNGs are
            # rendered from this OBJ, while the four corner planes only define bed fit.
            # Excluding them gives the actual model area even when plate offsets differ.
            model_vertex_idxs = set()
            try:
                for mtl_name, faces in faces_by_material.items():
                    if mtl_name == 'corner_plane_mat':
                        continue
                    for v_idxs, _uv_idxs in faces:
                        model_vertex_idxs.update(v_idxs)
            except Exception:
                model_vertex_idxs = set()

            if model_vertex_idxs:
                xs = [vertices[i][0] for i in model_vertex_idxs if 0 <= i < len(vertices)]
                ys = [vertices[i][1] for i in model_vertex_idxs if 0 <= i < len(vertices)]
                if xs and ys:
                    pad = 12.0
                    fx = min(xs) - pad
                    fy = min(ys) - pad
                    fw = (max(xs) - min(xs)) + pad * 2
                    fh = (max(ys) - min(ys)) + pad * 2
                else:
                    fx = fy = fw = fh = 0
            elif focus_mm:
                fx = float(focus_mm.get('x', 0))
                fy = float(focus_mm.get('y', 0))
                fw = float(focus_mm.get('w', 0))
                fh = float(focus_mm.get('h', 0))
            else:
                return None

            if fw <= 0 or fh <= 0:
                return None

            x0, y_hi = w2p(fx, fy + fh)  # 左下角，像素 y 向下为正
            x1, y_lo = w2p(fx + fw, fy)
            px = min(x0, x1) / img_size
            py = min(y_hi, y_lo) / img_size
            pw = abs(x1 - x0) / img_size
            ph = abs(y_hi - y_lo) / img_size
            px = max(0.0, min(1.0, px))
            py = max(0.0, min(1.0, py))
            pw = max(0.02, min(1.0 - px, pw))
            ph = max(0.02, min(1.0 - py, ph))
            guide = {'x': px, 'y': py, 'w': pw, 'h': ph}
            print(f"[focus] guide={guide} model_mm=({fx:.2f},{fy:.2f},{fw:.2f},{fh:.2f}) obj_bounds=({min_x:.2f},{min_y:.2f},{max_x:.2f},{max_y:.2f})")
            return guide
        except Exception as e:
            print(f"计算聚焦指导失败: {e}")
            traceback.print_exc()
            return None

    def _focus_guide_path(self):
        return os.path.join(os.path.expanduser('~/Documents/MKPSpectrum'), 'slice_focus.json')

    def _save_focus_guide(self, guide):
        """把聚焦指导持久化到 ~/Documents/MKPSpectrum/slice_focus.json，便于重启后仍能读取。"""
        try:
            import json
            path = self._focus_guide_path()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(guide, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"保存聚焦指导失败: {e}")

    def _load_focus_guide(self):
        """内存无聚焦指导时从磁盘 JSON 读取（切片后重启 / 重新打开预览时兜底）。"""
        try:
            import json
            with open(self._focus_guide_path(), 'r', encoding='utf-8') as f:
                data = json.load(f)
            if data and all(k in data for k in ('x', 'y', 'w', 'h')):
                self._slice_focus_guide = {
                    'x': float(data['x']), 'y': float(data['y']),
                    'w': float(data['w']), 'h': float(data['h']),
                }
                return self._slice_focus_guide
        except Exception:
            pass
        return None

    def texture_slice_get_status(self):
        """获取当前切片进度状态

        返回: {state, progress, total, images, error}
        state: idle/running/done/cancelled/error
        同时检查头样子进程写入的 slice_progress.json，确保 Orca 调起的后处理进度可见。
        """
        with self._slice_lock:
            internal = dict(self._slice_status)
        # 内部切片不在运行中时（idle/complete/error/cancelled），检查头样子进程进度
        if internal.get('state', 'idle') in ('idle', 'complete', 'error', 'cancelled'):
            headless = self._read_headless_progress()
            if headless:
                return headless
        return internal

    def _read_headless_progress(self):
        """读取头样子进程（Orca 调起）写入的 slice_progress.json
        
        不再依赖 mtime 新鲜度判断—write_pending_slice 会在新切片前删除旧文件，
        所以文件存在即表示子进程已启动（或刚完成）。
        前端 _headlessDone 标记负责防止重复处理 complete/error。
        """
        try:
            from pathlib import Path
            progress_path = Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_progress.json'
            if not progress_path.exists():
                return None
            with open(progress_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            headless_state = data.get('state', 'idle')
            # 将 headless 状态映射为 slice status 格式
            if headless_state == 'starting':
                return {'state': 'running', 'progress': 0, 'total': 0, 'stage': 'init'}
            elif headless_state == 'slicing':
                return {
                    'state': 'slicing',
                    'progress': data.get('current', data.get('progress', 0)),
                    'total': data.get('total', 0),
                    'stage': 'texture',
                }
            elif headless_state == 'postprocessing':
                return {
                    'state': 'slicing',
                    'progress': data.get('current', data.get('progress', 0)),
                    'total': data.get('total', 0),
                    'stage': 'postprocess',
                }
            elif headless_state == 'done':
                return {
                    'state': 'complete',
                    'progress': data.get('total_layers', 0),
                    'total': data.get('total_layers', 0),
                    'stage': 'done',
                    'gcode_path': data.get('output', ''),
                }
            elif headless_state == 'cancelled':
                return {'state': 'cancelled'}
            elif headless_state == 'error':
                return {'state': 'error', 'error': data.get('error', '未知错误')}
        except Exception:
            pass
        return None

    def texture_slice_cancel(self):
        """取消当前正在进行的纹理切片"""
        self._kill_slice_proc()
        with self._slice_lock:
            self._slice_status['state'] = 'cancelled'
        # 同步将外部后处理的进度文件标记为已取消，避免前端继续把旧 running 状态当成还在跑
        try:
            from pathlib import Path as _Path
            import json as _json
            _pp = _Path.home() / 'Documents' / 'MKPSpectrum' / 'slice_progress.json'
            if _pp.exists():
                try:
                    # 覆盖为 cancelled，让 _read_headless_progress 能识别
                    with open(_pp, 'w', encoding='utf-8') as _f:
                        _json.dump({'state': 'cancelled', 'progress': 0, 'total': 0, 'stage': ''}, _f, ensure_ascii=False)
                except Exception:
                    # 写失败就直接删掉，也能让轮询回到 idle
                    try:
                        _pp.unlink()
                    except Exception:
                        pass
        except Exception:
            pass
        print("纹理切片已取消")
        return {'success': True}

    def texture_slice_load_images(self):
        """加载切片生成的所有 PNG 图片信息（不含图片数据，仅返回计数和路径）"""
        import glob

        try:
            output_dir = self._slice_output_dir or os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if not os.path.exists(output_dir):
                return {'success': True, 'count': 0, 'output_dir': output_dir, 'files': [], 'focus_rect': None}

            png_files = sorted(glob.glob(os.path.join(output_dir, '*.png')))
            filenames = [os.path.basename(f) for f in png_files]

            if not self._slice_focus_guide:
                # 切片可能由 Orca 后处理子进程完成，主进程内存态为空时从磁盘兜底读取。
                self._load_focus_guide()

            print(f"切片图片信息: {len(filenames)} 张")
            return {
                'success': True,
                'count': len(filenames),
                'output_dir': output_dir,
                'files': filenames,
                'focus_rect': self._slice_focus_guide,
            }
        except Exception as e:
            print(f"加载切片图片信息失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'count': 0, 'output_dir': '', 'files': []}

    def texture_slice_load_single_image(self, index):
        """按索引懒加载单张切片预览图，返回缩略图 base64 data URL（宽≤1000px）"""
        import base64
        import glob
        import io

        try:
            from PIL import Image
            output_dir = self._slice_output_dir or os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if not os.path.exists(output_dir):
                return {'success': False, 'error': '预览目录不存在', 'image': None}

            png_files = sorted(glob.glob(os.path.join(output_dir, '*.png')))
            idx = int(index)
            if idx < 0 or idx >= len(png_files):
                return {'success': False, 'error': f'索引 {idx} 超出范围 (0..{len(png_files)-1})', 'image': None}

            # 缩放为缩略图（最大宽度 1000px），大幅减少内存占用
            img = Image.open(png_files[idx])
            w, h = img.size
            if w > 1000:
                ratio = 1000.0 / w
                new_size = (1000, int(h * ratio))
                img = img.resize(new_size, Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            img.close()
            b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
            buf.close()
            return {'success': True, 'image': f'data:image/png;base64,{b64}', 'index': idx}
        except Exception as e:
            print(f"加载单张切片图片失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'image': None}

    def _ensure_preview_http(self):
        """确保一个只服务切片预览 PNG 目录的本地 HTTP 静态服务在运行。

        返回 (http_root_url, base). http_root_url 如 http://127.0.0.1:8899/，
        base 是 Preview 绝对路径。供前端 <img> 直接 HTTP 加载原图，绕开 bridge 大字符串。
        """
        if self._preview_http is not None and self._preview_http_port:
            return self._preview_http, self._preview_http_base
        with self._preview_http_lock:
            if self._preview_http is not None and self._preview_http_port:
                return self._preview_http, self._preview_http_base
            import http.server
            import socketserver
            import functools
            base = os.path.abspath(
                self._slice_output_dir
                or os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview'))
            os.makedirs(base, exist_ok=True)

            class _PreviewHandler(http.server.SimpleHTTPRequestHandler):
                def __init__(self, *a, **kw):
                    super().__init__(*a, directory=base, **kw)
                def log_message(self, *a):  # 静默，避免刷终端
                    pass

            # 选端口：从 8899 起找空闲
            port = None
            for p in range(8899, 8999):
                try:
                    httpd = socketserver.TCPServer(('127.0.0.1', p), _PreviewHandler)
                    port = p
                    break
                except OSError:
                    continue
            if port is None:
                return None, base
            thr = threading.Thread(target=httpd.serve_forever, daemon=True)
            thr.start()
            self._preview_http = httpd
            self._preview_http_port = port
            self._preview_http_base = base
            return 'http://127.0.0.1:%d/' % port, base

    def texture_slice_load_full_image(self, index):
        """按索引加载单张原图（供缩放查看时替换为清晰图）。

        用 PIL 重新压缩后返回 base64：原始磁盘 PNG 常因未压缩达 ~1MB，直接走
        pywebview bridge 传大字符串不可靠；重压到清晰尺寸后约几十 KB，bridge 稳定。
        用 base64 data URL 而非 http/file URL，避免 <img> 跨源加载导致图片消失。
        """
        import base64
        import glob
        import io

        try:
            from PIL import Image
            output_dir = self._slice_output_dir or os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if not os.path.exists(output_dir):
                return {'success': False, 'error': '预览目录不存在', 'image': None}

            png_files = sorted(glob.glob(os.path.join(output_dir, '*.png')))
            idx = int(index)
            if idx < 0 or idx >= len(png_files):
                return {'success': False, 'error': f'索引 {idx} 超出范围', 'image': None}

            img = Image.open(png_files[idx])
            img.load()
            # 重压缩：最大宽度 4096 保证清晰度，PNG 重新编码显著缩小体积
            if img.width > 4096:
                ratio = 4096.0 / img.width
                img = img.resize((4096, int(img.height * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format='PNG', optimize=True)
            img.close()
            b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
            buf.close()
            return {'success': True, 'image': f'data:image/png;base64,{b64}', 'index': idx}
        except Exception as e:
            print(f"加载原图失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'image': None}

    def report_js_error(self, error_str):
        """接收前端 window.onerror / unhandledrejection 上报的错误，打印到 stdout 便于定位。"""
        try:
            print(f"[JS-ERROR] {error_str}", flush=True)
        except Exception:
            pass
        return {'success': True}

    def _resolve_lnk_target(self, lnk_path):
        """解析 .lnk 快捷方式的目标路径（使用 PowerShell）

        Windows 的 .lnk 文件本质是 Shell Link binary format，
        通过 PowerShell COM 对象 WScript.Shell 可以可靠解析。
        """
        try:
            if not os.path.exists(lnk_path):
                print(f"快捷方式不存在: {lnk_path}")
                return None

            # PowerShell 单引号字面量可以正确处理含空格的路径
            ps_cmd = (
                f'& '
                f'{{(New-Object -ComObject WScript.Shell).CreateShortcut(\'{lnk_path}\').TargetPath}}'
            )
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps_cmd],
                capture_output=True, text=True, timeout=10
            )

            if result.returncode != 0:
                print(f"PowerShell 解析失败 (exit={result.returncode}): {result.stderr.strip()}")
                return None

            path = result.stdout.strip()
            if not path:
                print(f"PowerShell 返回空结果: {lnk_path}")
                return None
            if not os.path.exists(path):
                print(f"解析出的 exe 不存在: {path}")
                return None

            print(f"快捷方式 -> {path}")
            return path
        except subprocess.TimeoutExpired:
            print(f"PowerShell 超时: {lnk_path}")
            return None
        except Exception as e:
            print(f"_resolve_lnk_target 异常: {e}")
            traceback.print_exc()
            return None

    def open_with_orca_slicer(self, stl_path, slicer_path):
        """用 OrcaSlicer GUI 打开 STL 文件"""
        try:
            if not os.path.exists(stl_path):
                return {'success': False, 'error': f'STL 文件不存在: {stl_path}'}
            if not slicer_path or not os.path.exists(slicer_path):
                return {'success': False, 'error': 'OrcaSlicer 路径无效'}

            # 用 subprocess.Popen 打开 OrcaSlicer（不阻塞）
            import subprocess
            subprocess.Popen([slicer_path, stl_path], shell=False)
            print(f"已打开 OrcaSlicer: {slicer_path} {stl_path}")
            return {'success': True, 'message': 'OrcaSlicer 已启动'}
        except Exception as e:
            print(f"打开 OrcaSlicer 失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def resolve_orca_slicer(self):
        """从开始菜单快捷方式解析 OrcaSlicer 路径"""
        try:
            search_dirs = [
                os.path.expandvars(
                    r'%ProgramData%\Microsoft\Windows\Start Menu\Programs\OrcaSlicer'
                ),
                os.path.expandvars(
                    r'%APPDATA%\Microsoft\Windows\Start Menu\Programs\OrcaSlicer'
                ),
            ]

            for search_dir in search_dirs:
                if not os.path.isdir(search_dir):
                    print(f"目录不存在: {search_dir}")
                    continue

                print(f"搜索目录: {search_dir}")
                for entry in os.listdir(search_dir):
                    if entry.lower().endswith('.lnk'):
                        lnk_path = os.path.join(search_dir, entry)
                        target = self._resolve_lnk_target(lnk_path)
                        if target and 'orca' in target.lower():
                            print(f"从快捷方式解析到 OrcaSlicer: {target}")
                            return {'success': True, 'path': target}

            return {'success': False, 'error': '未找到 OrcaSlicer 快捷方式'}
        except Exception as e:
            print(f"解析 OrcaSlicer 路径失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def resolve_snapmaker_orca(self):
        """从开始菜单快捷方式解析 Snapmaker Orca 路径"""
        try:
            search_dirs = [
                os.path.expandvars(
                    r'%ProgramData%\Microsoft\Windows\Start Menu\Programs\Snapmaker_Orca'
                ),
                os.path.expandvars(
                    r'%APPDATA%\Microsoft\Windows\Start Menu\Programs\Snapmaker_Orca'
                ),
            ]

            for search_dir in search_dirs:
                if not os.path.isdir(search_dir):
                    print(f"目录不存在: {search_dir}")
                    continue

                print(f"搜索目录: {search_dir}")
                for entry in os.listdir(search_dir):
                    if entry.lower().endswith('.lnk'):
                        lnk_path = os.path.join(search_dir, entry)
                        target = self._resolve_lnk_target(lnk_path)
                        if target and ('snapmaker' in target.lower() or 'orca' in target.lower()):
                            print(f"从快捷方式解析到 Snapmaker Orca: {target}")
                            return {'success': True, 'path': target}

            return {'success': False, 'error': '未找到 Snapmaker Orca 快捷方式'}
        except Exception as e:
            print(f"解析 Snapmaker Orca 路径失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def select_orca_slicer(self):
        """打开文件对话框让用户手动选择 orca-slicer.exe"""
        try:
            if self.window is None:
                return {'success': False, 'error': '窗口未初始化'}
            result = self.window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=['Executable (*.exe)', 'All files (*.*)']
            )
            if result and len(result) > 0:
                path = result[0]
                return {'success': True, 'path': path}
            return {'success': False, 'error': '未选择文件'}
        except Exception as e:
            print(f"选择 OrcaSlicer 失败: {e}")
            return {'success': False, 'error': str(e)}

    def texture_generate_strips(self, params_str=None):
        """将 Preview 图片切割为打印头条带，生成 G-code 和 ZIP 包。

        接收可选的运动参数字典（JSON字符串），调用 strip_processor 处理。
        输出到 Documents/MKPSpectrum/Temp/Texture/Segment/。

        返回: {success, total_layers, total_blocks, zip_path, gcode_lines_all}
        """
        import strip_processor
        import json
        import threading

        try:
            params = {}
            if params_str:
                params = json.loads(params_str) if isinstance(params_str, str) else params_str

            preview_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if not os.path.exists(preview_dir):
                return {'success': False, 'error': 'Preview 目录不存在，请先执行纹理切片'}

            output_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture')

            # 提取运动参数
            motion = {}
            for k in ['travel_speed', 'travel_accel', 'print_speed',
                      'head_initial_x', 'head_initial_y']:
                if k in params:
                    motion[k] = float(params[k])

            # 空驶速度/加速度：优先用前端传入的值，否则从 GCode 注释中读取
            if 'travel_speed' not in motion and self._gcode_params:
                motion['travel_speed'] = self._gcode_params.get('travel_speed', 150)
            if 'travel_accel' not in motion and self._gcode_params:
                motion['travel_accel'] = self._gcode_params.get('travel_accel', 500)

            # 喷墨机 IP：从 printer_settings.json 读取
            try:
                ps = self.load_printer_settings()
                _head_ip = ps.get('settings', {}).get('headAddress', '') or '192.168.1.8'
                motion['head_ip'] = _head_ip
            except Exception:
                motion['head_ip'] = '192.168.1.8'

            # 从喷墨配置读取 XY 偏移（喷墨头相对于喷嘴的物理偏移）
            try:
                config_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
                cfg_path = config_dir / 'MKP standard.json'
                if cfg_path.exists():
                    with open(cfg_path, 'r', encoding='utf-8') as cf:
                        cfg = json.load(cf)
                    ij = cfg.get('inkjet', {})
                    offset = ij.get('offset', {})
                    motion['offset_x'] = float(offset.get('x', 0))
                    motion['offset_y'] = float(offset.get('y', 0))
                    # MBD 喷墨浓度: JSON 存小数 (0.5=50%)，转为 0-100 整数
                    density_val = ij.get('density', 0.5)
                    motion['inkjet_density'] = int(float(density_val) * 100)
                    # 喷墨打印速度 (mm/s)，来自 JSON
                    speed_val = ij.get('speed', 20)
                    motion['print_speed'] = float(speed_val)
                    # CMY 色调调节
                    cmy = ij.get('cmy', {})
                    motion['cmy_c'] = float(cmy.get('c', 1.0))
                    motion['cmy_m'] = float(cmy.get('m', 1.0))
                    motion['cmy_y'] = float(cmy.get('y', 1.0))
                    motion['cmy_saturation'] = float(cmy.get('saturation', 0.0))
                    motion['cmy_brightness'] = float(cmy.get('brightness', 0.0))
                    # 对比度
                    motion['contrast'] = float(ij.get('contrast', 1.0))
                    # 平行四边形剪切补偿（mm），补偿喷头倾斜
                    motion['shear_mm'] = float(ij.get('shear_mm', 0))
            except Exception:
                pass

            # 提取模型区域（仅处理这些 Y 范围内的条带）
            model_regions = params.get('model_regions', None)

            result = strip_processor.process_all_layers(
                preview_dir, output_dir,
                motion_params=motion if motion else None,
                model_regions=model_regions,
            )

            # 强制 MBD 转换 + 打包 _temp.zip
            if result.get('success') and result.get('layers'):
                print("开始 MBD 转换...")
                from strip_processor import generate_blocks_for_layer
                from concurrent.futures import ThreadPoolExecutor, as_completed
                import zipfile as _zipfile

                segment_dir = os.path.join(output_dir, 'Segment')
                temp_dir = os.path.join(segment_dir, '_temp')
                for d in [temp_dir]:
                    if os.path.exists(d):
                        shutil.rmtree(d, ignore_errors=True)
                    os.makedirs(d, exist_ok=True)

                mbd_workers = min(4, max(1, multiprocessing.cpu_count() or 1))
                print(f"[texture_generate_strips] MBD 转换线程数: {mbd_workers}")
                mbd_total = 0
                mbd_futures = {}
                with ThreadPoolExecutor(max_workers=mbd_workers) as mbd_pool:
                    for name in result['layers']:
                        layer_dir = os.path.join(temp_dir, name)
                        os.makedirs(layer_dir, exist_ok=True)
                        png_path = os.path.join(preview_dir, f"{name}.png")
                        fut = mbd_pool.submit(generate_blocks_for_layer, png_path, layer_dir, motion if motion else None)
                        mbd_futures[fut] = name

                    done = 0
                    for fut in as_completed(mbd_futures):
                        name = mbd_futures[fut]
                        done += 1
                        try:
                            r = fut.result()
                            mbd_total += r.get('blocks', 0)
                        except Exception:
                            pass
                        if done % 10 == 0 or done <= 2 or done == len(result['layers']):
                            print(f"  MBD {done}/{len(result['layers'])}  {name}")

                print(f"MBD 转换完成: {mbd_total} 个文件")

                # 打包 _temp.zip 到 GCode 输出目录（与 uploaded GCode 同级）
                _gcode_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Gcode')
                os.makedirs(_gcode_dir, exist_ok=True)
                zip_path = os.path.join(_gcode_dir, '_temp.zip')
                with _zipfile.ZipFile(zip_path, 'w', _zipfile.ZIP_DEFLATED) as zf:
                    for root, dirs, files in os.walk(temp_dir):
                        for fn in files:
                            fp = os.path.join(root, fn)
                            zf.write(fp, os.path.relpath(fp, temp_dir))
                print(f"已打包: {zip_path}")
                result['zip_path'] = zip_path

            return result

        except Exception as e:
            print(f"条带切割失败: {e}")
            import traceback
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def load_preview_images(self):
        """从 Temp/Texture/Preview 获取切片预览图片信息（仅计数，不加载图片数据）"""
        try:
            preview_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if not os.path.exists(preview_dir):
                return {'success': True, 'count': 0, 'image_count': 0}

            png_files = sorted([
                f for f in os.listdir(preview_dir)
                if f.lower().endswith('.png')
            ])

            count = len(png_files)
            print(f"预览图片数量: {count} 张（不加载数据）")
            if not self._slice_focus_guide:
                # 切片内存态已被重置（如重启后），从磁盘 JSON 兜底读取
                self._load_focus_guide()
            return {
                'success': True, 'count': count, 'image_count': count,
                'focus_rect': self._slice_focus_guide,
            }
        except Exception as e:
            print(f"获取预览图片信息失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'count': 0}

    def load_preview_image(self, index=0):
        """按索引加载单张预览缩略图（base64），宽≤1000px"""
        import base64
        import io
        try:
            from PIL import Image
            preview_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if not os.path.exists(preview_dir):
                return {'success': False, 'error': '预览目录不存在', 'image': None}

            png_files = sorted([
                f for f in os.listdir(preview_dir)
                if f.lower().endswith('.png')
            ])

            if not png_files or index < 0 or index >= len(png_files):
                return {'success': False, 'error': '索引越界', 'image': None, 'total': len(png_files)}

            fpath = os.path.join(preview_dir, png_files[index])
            img = Image.open(fpath)
            w, h = img.size
            if w > 1000:
                ratio = 1000.0 / w
                img = img.resize((1000, int(h * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            img.close()
            b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
            buf.close()
            return {
                'success': True,
                'image': f'data:image/png;base64,{b64}',
                'index': index,
                'total': len(png_files),
            }
        except Exception as e:
            print(f"加载预览图片失败 (index={index}): {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'image': None}

    def test_connection(self, address, role='printer'):
        """测试连接：printer=检查Fluidd页面, head=检查Mbrush页面"""
        try:
            if not address or not address.strip():
                return {'success': False, 'message': '地址不能为空'}
            address = address.strip()
            if ':' not in address:
                address = address + ':80'

            url = f'http://{address}/'
            resp = requests.get(url, timeout=5)
            title_match = re.search(r'<title>(.*?)</title>', resp.text, re.IGNORECASE)
            title = title_match.group(1).strip() if title_match else resp.text[:200]

            if role == 'printer':
                if 'fluidd' in title.lower() or 'mainsail' in title.lower():
                    return {'success': True, 'message': 'OK'}
                return {'success': False, 'message': '不是 Fluidd'}
            else:
                if 'mbrush' in title.lower():
                    return {'success': True, 'message': 'OK'}
                return {'success': False, 'message': '不是 Mbrush'}
        except requests.ConnectionError:
            return {'success': False, 'message': '拒绝连接'}
        except requests.Timeout:
            return {'success': False, 'message': '超时'}
        except Exception as e:
            print(f"连接测试异常: {e}")
            return {'success': False, 'message': '失败'}

    def test_printer_fluidd(self, address):
        """测试打印机Fluidd"""
        return self.test_connection(address, role='printer')

    def test_head_mbrush(self, address):
        """测试喷墨头Mbrush"""
        return self.test_connection(address, role='head')

    def check_printer_plugin_installed(self, address):
        """SSH 检查打印机上是否已安装插件"""
        try:
            ip = address.strip().split(':')[0] if ':' in address else address.strip()
            plink = r'C:\Program Files\PuTTY\plink.exe'
            cmd = [plink, '-no-antispoof', '-pw', 'snapmaker',
                   '-hostkey', 'ssh-ed25519 255 SHA256:tcB++7BmRj2YKZ1VUygY4Qji336ughrpINlEEXUgTxA',
                   f'root@{ip}',
                   'test -f /home/lava/klipper/klippy/extras/gcode_shell_command.py '
                   '&& echo INSTALLED || echo NOT_FOUND']
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            installed = 'INSTALLED' in result.stdout
            return {'success': True, 'installed': installed,
                    'message': '已安装' if installed else '未安装'}
        except Exception as e:
            print(f"检查插件异常: {e}")
            return {'success': False, 'installed': False, 'message': str(e)}

    def install_printer_plugin(self, address):
        """SSH 安装 gcode_shell_command.py 到打印机，并注入 MBRUSH_START 宏"""
        try:
            ip = address.strip().split(':')[0] if ':' in address else address.strip()

            # 定位插件文件（兼容开发环境和 PyInstaller 打包）
            if getattr(sys, 'frozen', False):
                base_dir = sys._MEIPASS
            else:
                base_dir = os.path.dirname(__file__)
            plugin_path = os.path.join(base_dir, 'gcode_shell_command.py')
            if not os.path.exists(plugin_path):
                return {'success': False, 'message': '插件文件未找到: gcode_shell_command.py'}

            pscp = r'C:\Program Files\PuTTY\pscp.exe'
            plink = r'C:\Program Files\PuTTY\plink.exe'
            hostkey_opt = 'ssh-ed25519 255 SHA256:tcB++7BmRj2YKZ1VUygY4Qji336ughrpINlEEXUgTxA'

            # Step 1: 启用持久化
            subprocess.run([plink, '-no-antispoof', '-pw', 'snapmaker',
                           '-hostkey', hostkey_opt, f'root@{ip}',
                           'touch /oem/.debug'], capture_output=True, timeout=10)

            # Step 2: 传送插件文件
            subprocess.run([pscp, '-pw', 'snapmaker', plugin_path,
                           f'root@{ip}:/home/lava/klipper/klippy/extras/gcode_shell_command.py'],
                          capture_output=True, text=True, timeout=15)

            # Step 3: 注入 cfg 宏（base64 避免 shell 转义问题）
            _CFG_INJECT_SCRIPT = (
                "import sys\n"
                "c = '/home/lava/printer_data/config/printer.cfg'\n"
                "t = open(c, 'r').read()\n"
                "i = t.find('#*#')\n"
                "before = t[:i] if i >= 0 else t\n"
                "after = t[i:] if i >= 0 else ''\n"
                "# 只检查 SAVE_CONFIG 之前的部分，独立判断每个宏\n"
                "b = ''\n"
                "if '[gcode_macro MBRUSH_UPLOAD]' not in before:\n"
                "    b += (\n"
                "        '\\n'"
                "        '[gcode_macro MBRUSH_UPLOAD]\\n'\n"
                "        'gcode:\\n'\n"
                "        '    {% set ip = params.IP %}\\n'\n"
                "        '    {% set file = params.FILE|default(\"\"\"\") %}\\n'\n"
                "        '    RUN_SHELL_COMMAND CMD=mbrush_upload PARAMS=\"{ip} {file}\"\\n'\n"
                "        '\\n'\n"
                "        '[gcode_shell_command mbrush_upload]\\n'\n"
                "        'timeout: 30\\n'\n"
                "    )\n"
                "if '[gcode_macro MBRUSH_FLUSH]' not in before:\n"
                "    b += (\n"
                "        '\\n'"
                "        '[gcode_macro MBRUSH_FLUSH]\\n'\n"
                "        'gcode:\\n'\n"
                "        '    {% set ip = params.IP %}\\n'\n"
                "        '    {% set speed = params.SPEED|default(50)|int %}\\n'\n"
                "        '    RUN_SHELL_COMMAND CMD=mbrush_flush PARAMS=\"{ip} {speed}\"\\n'\n"
                "        '\\n'\n"
                "        '[gcode_shell_command mbrush_flush]\\n'\n"
                "        'timeout: 5\\n'\n"
                "    )\n"
                "# unzip_temp\n"
                "if '[gcode_macro UNZIP_TEMP]' not in before:\n"
                "    b += (\n"
                "        '\\n'"
                "        '[gcode_macro UNZIP_TEMP]\\n'\n"
                "        'gcode:\\n'\n"
                "        '    RUN_SHELL_COMMAND CMD=unzip_temp\\n'\n"
                "        '\\n'\n"
                "        '[gcode_shell_command unzip_temp]\\n'\n"
                "        'command: /bin/sh -c \\'"
                "if [ -f /home/lava/printer_data/gcodes/_temp.zip ]; "
                "then rm -rf /home/lava/printer_data/gcodes/_temp; "
                "python3 -c \\\"import zipfile,sys;"
                "zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])\\\" "
                "/home/lava/printer_data/gcodes/_temp.zip "
                "/home/lava/printer_data/gcodes/_temp; "
                "        'rm /home/lava/printer_data/gcodes/_temp.zip; fi\\'\\n'\n"
                "        'timeout: 300\\n'\n"
                "    )\n"
                "# CLEAN_GCODE\n"
                "if '[gcode_macro CLEAN_GCODE]' not in before:\n"
                "    b += (\n"
                "        '\\n'"
                "        '[gcode_macro CLEAN_GCODE]\\n'\n"
                "        'gcode:\\n'\n"
                "        '    RUN_SHELL_COMMAND CMD=clean_gcode\\n'\n"
                "        '\\n'\n"
                "        '[gcode_shell_command clean_gcode]\\n'\n"
                "        'timeout: 10\\n'\n"
                "    )\n"
                "# IDLE_TIMEOUT\n"
                "if '[idle_timeout]' not in before:\n"
                "    b += (\n"
                "        '\\n'"
                "        '[idle_timeout]\\n'\n"
                "        'timeout: 600\\n'\n"
                "        'gcode:\\n'\n"
                "        '    M84\\n'\n"
                "    )\n"
                "# CHECK_MOTORS_AND_HOME\n"
                "if '[gcode_macro CHECK_MOTORS_AND_HOME]' not in before:\n"
                "    b += (\n"
                "        '\\n'"
                "        '[gcode_macro CHECK_MOTORS_AND_HOME]\\n'\n"
                "        'gcode:\\n'\n"
                "        '    {% if \\'z\\' not in printer.toolhead.homed_axes %}\\n'\n"
                "        '        RESPOND MSG=\\\"Axis not homed, running G28\\\"\\n'\n"
                "        '        G28\\n'\n"
                "        '    {% else %}\\n'\n"
                "        '        RESPOND MSG=\\\"no need for G28\\\"\\n'\n"
                "        '    {% endif %}\\n'\n"
                "    )\n"
                "if not b:\n"
                "    print('CFG_EXISTS')\n"
                "    sys.exit(0)\n"
                "r = before + b + after\n"
                "open(c, 'w').write(r)\n"
                "print('CFG_OK')\n"
            )
            encoded = base64.b64encode(_CFG_INJECT_SCRIPT.encode()).decode()
            inject_cmd = (
                f'python3 -c "import base64, sys; '
                f'exec(base64.b64decode(\'{encoded}\').decode())"'
            )
            cfg_result = subprocess.run(
                [plink, '-no-antispoof', '-pw', 'snapmaker',
                 '-hostkey', hostkey_opt, f'root@{ip}', inject_cmd],
                capture_output=True, text=True, timeout=15)

            print(f"[install_plugin] cfg inject: {cfg_result.stdout.strip()}")

            # Step 4: 修正权限 + 备份 + 重启 Klipper
            setup_result = subprocess.run([plink, '-no-antispoof', '-pw', 'snapmaker',
                                          '-hostkey', hostkey_opt, f'root@{ip}',
                                          'chown lava:lava /home/lava/klipper/klippy/extras/gcode_shell_command.py; '
                                          'chmod 644 /home/lava/klipper/klippy/extras/gcode_shell_command.py; '
                                          'mkdir -p /oem/printer_data/klippy/extras; '
                                          'cp /home/lava/klipper/klippy/extras/gcode_shell_command.py /oem/printer_data/klippy/extras/gcode_shell_command.py; '
                                          'sync; /etc/init.d/S60klipper restart'],
                                         capture_output=True, text=True, timeout=30)

            if 'Starting klipper' in setup_result.stdout or 'All passed' in setup_result.stdout:
                return {'success': True, 'message': '安装完成，Klipper 已重启'}
            return {'success': True, 'message': '文件已安装，请手动重启 Klipper'}
        except Exception as e:
            print(f"安装插件异常: {e}")
            return {'success': False, 'message': str(e)}

    def check_printer_printing(self, printer_addr=None):
        """查询 3D 打印机是否正在打印。

        通过 Moonraker API 查询 print_stats 状态。
        返回: {success, printing (bool), state (str), filename (str|null)}
        """
        import requests
        try:
            if not printer_addr:
                settings = self.load_printer_settings()
                if settings.get('success'):
                    s = settings.get('settings', {})
                    printer_addr = (s.get('printerAddress') or '').strip()
            if not printer_addr:
                return {'success': False, 'printing': False, 'state': 'unknown',
                        'error': '未配置打印机地址'}

            url = f'http://{printer_addr}:7125/printer/objects/query?print_stats'
            print(f'[PrintStatus] 查询 Moonraker: {url}')
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                print(f'[PrintStatus] Moonraker 返回: {json.dumps(data, ensure_ascii=False, indent=2)[:500]}')
                stats = (data.get('result', {})
                              .get('status', {})
                              .get('print_stats', {}))
                state = stats.get('state', 'unknown')
                filename = stats.get('filename', None)
                printing = state == 'printing'
                print(f'[PrintStatus] state={state}, printing={printing}, filename={filename}')
                return {
                    'success': True,
                    'printing': printing,
                    'state': state,
                    'filename': filename,
                }
            return {'success': False, 'printing': False, 'state': 'error',
                    'error': f'HTTP {resp.status_code}'}
        except Exception as e:
            print(f'[PrintStatus] 查询异常: {e}')
            return {'success': False, 'printing': False, 'state': 'error',
                    'error': str(e)}

    # [已移除] 不再需要后台常驻监控 (fluidd_tray_monitor)
    # def launch_tray_monitor(self):
    #     """启动托盘监听进程（供前端调用）。
    #
    #     返回: {success, error}
    #     """
    #     try:
    #         settings = self.load_printer_settings()
    #         s = {}
    #         if settings.get('success'):
    #             s = settings.get('settings', {})
    #         printer_addr = (s.get('printerAddress') or '127.0.0.1').strip()
    #         head_addr = (s.get('headAddress') or '').strip()
    #
    #         err = self._launch_tray_monitor(printer_addr, head_addr)
    #         if err:
    #             return {'success': False, 'error': err}
    #         return {'success': True}
    #     except Exception as e:
    #         return {'success': False, 'error': str(e)}

    def _postprocess_gcode_memory(self, gcode_text, inkjet_layers_data, gcode_name, params=None,
                                   grab_macro=None, release_macro=None):
        """将内存中的 GCode 后处理（喷墨命令 + 擦嘴塔）写入临时文件并返回路径。

        统一走 GCodeGenerator.process_gcode 主流程（含 Orca 参数化擦嘴塔管线），
        替代旧的、导入已失效符号的重复实现，避免 ImportError 导致拖拽 GCode 后处理失败。
        """
        import tempfile
        try:
            from GCodeGenerator import process_gcode, extract_gcode_params
            # 写临时源文件
            tmp_fd, tmp_path = tempfile.mkstemp(suffix='.gcode')
            with os.fdopen(tmp_fd, 'w', encoding='utf-8') as f:
                f.write(gcode_text)
            # 结构化 inkjet 层数据
            inkjet_dict = {}
            if isinstance(inkjet_layers_data, list):
                for i, layer_lines in enumerate(inkjet_layers_data):
                    if layer_lines:
                        inkjet_dict[i + 1] = layer_lines
            elif isinstance(inkjet_layers_data, dict):
                inkjet_dict = inkjet_layers_data
            if params is None:
                params = extract_gcode_params(tmp_path)
            out_dir = tempfile.mkdtemp(prefix='mkp_gcode_')
            output_path = os.path.join(out_dir, gcode_name.replace('.gcode', '') + '_post.gcode')
            process_gcode(tmp_path, output_path=output_path, params=params,
                          inkjet_layers=inkjet_dict, debug_mode=False)
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            print('[后处理] 完成! 输出: {}'.format(output_path))
            return {'success': True, 'output_path': output_path}
        except Exception as e:
            print('[后处理] 失败: {}'.format(e))
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    # [已移除] 不再需要后台常驻监控 (fluidd_tray_monitor)
    # def _start_tray_if_configured(self):
    #     """软件启动时直接启动托盘监控，无需检查地址配置。"""
    #     s = {}
    #     try:
    #         settings = self.load_printer_settings()
    #         if settings.get('success'):
    #             s = settings.get('settings', {})
    #     except Exception:
    #         pass
    #     printer_addr = (s.get('printerAddress') or '127.0.0.1').strip()
    #     head_addr = (s.get('headAddress') or '').strip()
    #     err = self._launch_tray_monitor(printer_addr, head_addr)
    #     if err:
    #         print(f'[托盘] 启动失败: {err}')
    #     else:
    #         print('[托盘] 已随软件启动')
    
    # [已移除] 不再需要后台常驻监控 (fluidd_tray_monitor)
    # def _launch_tray_monitor(self, printer_addr, head_addr):
    #     """启动 Fluidd 控制台托盘（在主进程中以线程方式运行）。
    #
    #     返回 None 表示成功，否则返回错误信息字符串。
    #     """
    #     if not head_addr or not head_addr.strip():
    #         return '未配置打印头地址 (headAddress)，请在打印机设置中填写 mBrush IP'
    #     if not printer_addr or not printer_addr.strip():
    #         return '未配置打印机地址 (printerAddress)，请在打印机设置中填写 Moonraker IP'
    #
    #     try:
    #         # 防重复
    #         if hasattr(self, '_tray_thread') and self._tray_thread and self._tray_thread.is_alive():
    #             print('[托盘] 已在运行，跳过启动')
    #             return None
    #
    #         moonraker_arg = printer_addr
    #         if ':' not in moonraker_arg:
    #             moonraker_arg = f'{printer_addr}:7125'
    #
    #         try:
    #             from fluidd_tray_monitor import TrayApp
    #         except ImportError as e:
    #             return f'无法导入 fluidd_tray_monitor: {e}'
    #
    #         class _Args:
    #             pass
    #         args = _Args()
    #         args.moonraker = moonraker_arg
    #         args.mbrush = head_addr
    #         args.segments_dir = None
    #         args.work_dir = None
    #         args.respond_delay = 0
    #
    #         # 恢复主窗口的回调
    #         def _restore_window():
    #             if self.window:
    #                 try:
    #                     self.window.show()
    #                 except Exception:
    #                     pass
    #
    #         tray_app = TrayApp(args, restore_callback=_restore_window)
    #
    #         def _run_tray():
    #             try:
    #                 tray_app.run()
    #             except Exception as e:
    #                 print(f'[托盘] 线程异常退出: {e}')
    #
    #         t = threading.Thread(target=_run_tray, daemon=True, name='fluidd-tray')
    #         t.start()
    #         self._tray_app = tray_app
    #         self._tray_thread = t
    #         print('[托盘] 已在主进程中启动')
    #         return None
    #
    #     except Exception as e:
    #         _log(f'[LAUNCH] FATAL: {e}\n{traceback.format_exc()}')
    #         return str(e)
    #
    # def _stop_tray_monitor(self):
    #     """停止托盘监控"""
    #     try:
    #         app = getattr(self, '_tray_app', None)
    #         if app and app.icon:
    #             app._exit(app.icon)
    #     except Exception:
    #         pass
    #     self._tray_app = None
    #     self._tray_thread = None

    def upload_gcode_to_printer(self):
        """仅上传后处理 GCode 到 3D 打印机（Klipper/Moonraker），不启动打印。

        同时上传 _temp.zip（同行路径），供打印机端 unzip_temp 宏解压。
        返回 {success, error, gcode_name}。
        """
        import requests

        try:
            settings = self.load_printer_settings()
            if not settings.get('success'):
                return {'success': False, 'error': '无法读取打印机设置'}
            s = settings.get('settings', {})
            printer_addr = (s.get('printerAddress') or '').strip()

            if not printer_addr:
                return {'success': False, 'error': '未配置打印机地址'}

            # 优先：切片+后处理子进程已生成最终 GCode
            gcode_path = self._slice_status.get('gcode_path', '')
            gcode_name = ''
            if gcode_path and os.path.exists(gcode_path):
                gcode_name = os.path.basename(gcode_path)
                print('[上传] 使用一体化子进程生成的后处理 GCode: {}'.format(gcode_path))
            else:
                return {'success': False, 'error': '没有可上传的 GCode，请先完成纹理切片'}

            # Moonraker base URL
            moonraker_base = f'http://{printer_addr}:7125'

            # 上传 GCode
            moonraker_url = f'{moonraker_base}/server/files/upload'
            print(f'[上传] 上传 GCode 到 Moonraker: {moonraker_url}')
            print(f'[上传] 文件: {gcode_path}')

            with open(gcode_path, 'rb') as f:
                resp = requests.post(
                    moonraker_url,
                    files={'file': (gcode_name, f, 'application/octet-stream')},
                    timeout=30
                )

            if resp.status_code not in (200, 201, 202):
                err_msg = f'Moonraker 返回 {resp.status_code}'
                try:
                    err_detail = resp.json()
                    if isinstance(err_detail, dict):
                        err_msg += f': {err_detail.get("error", resp.text[:200])}'
                except Exception:
                    err_msg += f': {resp.text[:200]}'
                print(f'[上传] GCode 上传失败: {err_msg}')
                return {'success': False, 'error': err_msg}

            print(f'[上传] GCode 上传成功: {resp.status_code}')

            # 上传 _temp.zip（与 final.gcode 同级）
            gcode_dir = os.path.dirname(gcode_path)
            zip_path = os.path.join(gcode_dir, '_temp.zip')
            zip_uploaded = False
            if os.path.exists(zip_path):
                zip_name = '_temp.zip'
                print(f'[上传] 上传 _temp.zip 到 Moonraker: {zip_path}')
                try:
                    with open(zip_path, 'rb') as f:
                        resp = requests.post(
                            moonraker_url,
                            files={'file': (zip_name, f, 'application/zip')},
                            timeout=60
                        )
                    if resp.status_code in (200, 201, 202):
                        zip_uploaded = True
                        print(f'[上传] _temp.zip 上传成功: {resp.status_code}')
                    else:
                        print(f'[上传] _temp.zip 上传失败: {resp.status_code}')
                except Exception as e:
                    print(f'[上传] _temp.zip 上传异常: {e}')
            else:
                print('[上传] _temp.zip 不存在，仅上传 GCode')

            return {
                'success': True,
                'gcode_name': gcode_name,
                'zip_uploaded': zip_uploaded,
            }

        except requests.exceptions.ConnectionError:
            msg = f'无法连接到打印机 ({printer_addr}:7125)'
            print(f'[上传] {msg}')
            return {'success': False, 'error': msg}
        except Exception as e:
            print(f'[上传] 上传异常: {e}')
            return {'success': False, 'error': str(e)}

    def start_print(self):
        """开始打印：上传 GCode 到 3D 打印机（Klipper/Moonraker），上传 ZIP 到喷墨打印机。
        
        返回 {success, printer_result, inkjet_result, detail}。
        """
        import requests

        result = {
            'success': False,
            'printer_result': None,
            'inkjet_result': None,
            'detail': ''
        }
        errors = []

        # ---- 1. 读取打印机配置 ----
        try:
            settings = self.load_printer_settings()
            if not settings.get('success'):
                return {'success': False, 'error': '无法读取打印机设置', 'detail': ''}
            s = settings.get('settings', {})
            printer_addr = (s.get('printerAddress') or '').strip()
            head_addr = (s.get('headAddress') or '').strip()
        except Exception as e:
            return {'success': False, 'error': f'读取设置失败: {e}', 'detail': ''}

        if not printer_addr and not head_addr:
            return {
                'success': False,
                'error': '未配置打印机地址和喷墨头地址',
                'detail': '请点击打印机选择旁的编辑按钮配置网络地址'
            }

        # ---- 2. 准备 GCode 文件 ----
        gcode_path = None
        gcode_name = ''

        # 优先：切片+后处理子进程已生成最终 GCode
        final_gcode = self._slice_status.get('gcode_path', '')
        if final_gcode and os.path.exists(final_gcode):
            gcode_path = final_gcode
            gcode_name = os.path.basename(final_gcode)
            print('[打印] 使用一体化子进程生成的后处理 GCode: {}'.format(gcode_path))
        elif self._loaded_gcode_text:
            # 兼容旧流程：用户拖拽的 GCode → 后处理 → 临时文件
            print('[打印] 使用拖拽的 GCode 进行后处理...')
            inkjet_layers = self._slice_status.get('gcode_lines_all', [])
            gcode_name = (os.path.basename(self._loaded_gcode_path)
                          if self._loaded_gcode_path else 'loaded.gcode')
            pp = self._postprocess_gcode_memory(
                self._loaded_gcode_text,
                inkjet_layers,
                gcode_name,
                self._gcode_params
            )
            if pp.get('success'):
                gcode_path = pp['output_path']
                print('[打印] 后处理完成: {}'.format(gcode_path))
            else:
                errors.append('打印机: 后处理失败: {}'.format(pp.get('error', '未知')))
                # 回退：上传原始拖拽 GCode
                import tempfile
                temp_dir = tempfile.mkdtemp(prefix='mkp_gcode_')
                gcode_path = os.path.join(temp_dir, gcode_name)
                with open(gcode_path, 'w', encoding='utf-8') as f:
                    f.write(self._loaded_gcode_text)
                print('[打印] 后处理失败，回退到原始 GCode: {}'.format(gcode_path))

        # 次选：切片输出的 GCode
        if not gcode_path:
            output_gcode = getattr(self, '_last_slice_output', None)
            if output_gcode and os.path.exists(output_gcode):
                gcode_path = output_gcode
                gcode_name = os.path.basename(output_gcode)

        # 回退：yangli.gcode
        if not gcode_path:
            if getattr(sys, 'frozen', False):
                exe_dir = os.path.dirname(sys.executable)
            else:
                exe_dir = os.path.dirname(os.path.abspath(__file__))
            yangli_path = os.path.join(exe_dir, 'yangli.gcode')
            if os.path.exists(yangli_path):
                gcode_path = yangli_path
                gcode_name = 'yangli.gcode'
                print(f'[start_print] 使用样例 gcode: {yangli_path}')
        elif not gcode_name:
            gcode_name = os.path.basename(gcode_path)

        # ---- 3. 查找 _temp.zip（与 final.gcode 同级） ----
        zip_path = None
        if gcode_path:
            gcode_dir = os.path.dirname(gcode_path)
            candidate = os.path.join(gcode_dir, '_temp.zip')
            if os.path.exists(candidate):
                zip_path = candidate

        if not gcode_path and not os.path.exists(zip_path):
            return {
                'success': False,
                'error': '未找到可上传的 GCode 或 ZIP 文件',
                'detail': '请先执行模型切片和纹理切片'
            }

        # ---- 4. 上传 GCode 到 3D 打印机 (Moonraker) ----
        if printer_addr:
            if not gcode_path:
                errors.append('打印机: 未找到 GCode 文件')
            else:
                try:
                    # Moonraker API: upload file
                    moonraker_url = f'http://{printer_addr}:7125/server/files/upload'
                    print(f'[打印] 上传 GCode 到 Moonraker: {moonraker_url}')
                    print(f'[打印] 文件: {gcode_path}')

                    with open(gcode_path, 'rb') as f:
                        resp = requests.post(
                            moonraker_url,
                            files={'file': (gcode_name, f, 'application/octet-stream')},
                            timeout=30
                        )

                    if resp.status_code in (200, 201, 202):
                        # 解析 Moonraker 返回的文件路径
                        uploaded_path = gcode_name
                        try:
                            resp_json = resp.json()
                            if isinstance(resp_json, dict):
                                item = resp_json.get('item') or resp_json.get('result') or {}
                                uploaded_path = item.get('path', gcode_name)
                                print(f'[打印] Moonraker 返回路径: {uploaded_path}')
                        except Exception:
                            pass

                        result['printer_result'] = {
                            'success': True,
                            'message': f'GCode 已上传至打印机 ({gcode_name})'
                        }
                        print(f'[打印] GCode 上传成功: {resp.status_code}')

                        # 发送开始打印命令
                        try:
                            start_url = f'http://{printer_addr}:7125/printer/print/start'
                            start_resp = requests.post(
                                start_url,
                                json={'filename': uploaded_path},
                                timeout=15
                            )
                            if start_resp.status_code in (200, 201, 202):
                                result['printer_result']['message'] += '，打印机已开始运行'
                                print(f'[打印] 打印机启动命令发送成功')

                                # [已移除] 不再需要后台常驻监控 (fluidd_tray_monitor)
                                # tray_err = self._launch_tray_monitor(printer_addr, head_addr)
                                # if tray_err:
                                #     print(f'[打印] 托盘进程启动失败: {tray_err}')
                                # else:
                                #     print(f'[打印] 托盘监听进程已启动')
                            else:
                                err = f'启动打印失败: Moonraker返回{start_resp.status_code}'
                                result['printer_result']['message'] += f'，但{err}'
                                errors.append(f'打印机: {err}')
                                print(f'[打印] {err}: {start_resp.text[:200]}')
                        except requests.exceptions.ConnectionError:
                            err = '启动打印失败: 无法连接(启动命令)'
                            result['printer_result']['message'] += f'，但{err}'
                            errors.append(f'打印机: {err}')
                        except Exception as e:
                            result['printer_result']['message'] += f'，但启动命令异常: {e}'
                            errors.append(f'打印机: 启动打印异常: {e}')
                            print(f'[打印] 启动打印异常: {e}')
                    else:
                        err_msg = f'Moonraker 返回 {resp.status_code}'
                        try:
                            err_detail = resp.json()
                            if isinstance(err_detail, dict):
                                err_msg += f': {err_detail.get("error", resp.text[:200])}'
                        except Exception:
                            err_msg += f': {resp.text[:200]}'
                        result['printer_result'] = {'success': False, 'message': err_msg}
                        errors.append(f'打印机: {err_msg}')
                        print(f'[打印] GCode 上传失败: {err_msg}')
                except requests.exceptions.ConnectionError:
                    msg = f'无法连接到打印机 ({printer_addr}:7125)'
                    result['printer_result'] = {'success': False, 'message': msg}
                    errors.append(f'打印机: {msg}')
                    print(f'[打印] {msg}')
                except requests.exceptions.Timeout:
                    msg = f'连接打印机超时 ({printer_addr}:7125)'
                    result['printer_result'] = {'success': False, 'message': msg}
                    errors.append(f'打印机: {msg}')
                    print(f'[打印] {msg}')
                except Exception as e:
                    msg = f'上传 GCode 异常: {e}'
                    result['printer_result'] = {'success': False, 'message': msg}
                    errors.append(f'打印机: {msg}')
                    print(f'[打印] {msg}')
                    traceback.print_exc()
        else:
            errors.append('打印机: 未配置地址')

        # ---- 5. 上传 _temp.zip 到 3D 打印机 (Moonraker) ----
        if printer_addr and zip_path:
            try:
                moonraker_url = f'http://{printer_addr}:7125/server/files/upload'
                print(f'[打印] 上传 _temp.zip 到 Moonraker: {moonraker_url}')
                print(f'[打印] 文件: {zip_path}')

                with open(zip_path, 'rb') as f:
                    resp = requests.post(
                        moonraker_url,
                        files={'file': ('_temp.zip', f, 'application/zip')},
                        timeout=60
                    )

                if resp.status_code in (200, 201, 202):
                    print(f'[打印] _temp.zip 上传成功: {resp.status_code}')
                else:
                    err_msg = f'Moonraker 返回 {resp.status_code}'
                    try:
                        err_msg += f': {resp.text[:200]}'
                    except Exception:
                        pass
                    errors.append(f'_temp.zip: {err_msg}')
                    print(f'[打印] _temp.zip 上传失败: {err_msg}')
            except requests.exceptions.ConnectionError:
                print(f'[打印] 无法连接 Moonraker 上传 _temp.zip')
                errors.append('_temp.zip: 无法连接 Moonraker')
            except Exception as e:
                print(f'[打印] _temp.zip 上传异常: {e}')
                errors.append(f'_temp.zip: {e}')

        # ---- 6. 汇总结果 ----
        result['detail'] = '；'.join(errors) if errors else '全部上传成功'
        result['success'] = len(errors) == 0

        if not result['success']:
            result['error'] = result['detail']

        print(f'[打印] 完成. success={result["success"]}, detail={result["detail"]}')
        return result

    def planar_gcode_upload(self, gcode_content):
        """上传平面打印 GCode 到 3D 打印机（Klipper/Moonraker）。

        以 '2D_' 前缀命名 GCode 文件，用于区分 2D 平面打印。

        参数:
            gcode_content: str，GCode 文本内容

        返回 {success, error, gcode_name}。
        """
        import requests
        import uuid

        try:
            settings = self.load_printer_settings()
            if not settings.get('success'):
                return {'success': False, 'error': '无法读取打印机设置'}
            s = settings.get('settings', {})
            printer_addr = (s.get('printerAddress') or '').strip()

            if not printer_addr:
                return {'success': False, 'error': '未配置打印机地址'}

            # 以 2D_ 前缀命名 GCode 文件
            unique_id = str(uuid.uuid4())[:8]
            gcode_name = f'2D_FLAT_PRINT_{unique_id}.gcode'

            # 写入临时文件
            tmp_dir = self.project_dir if hasattr(self, 'project_dir') and self.project_dir else os.path.expanduser('~')
            tmp_path = os.path.join(tmp_dir, gcode_name)
            with open(tmp_path, 'w', encoding='utf-8') as f:
                f.write(gcode_content)

            # 上传到 Moonraker
            moonraker_url = f'http://{printer_addr}:7125/server/files/upload'
            print(f'[平面打印] 上传 GCode 到 Moonraker: {moonraker_url}')
            print(f'[平面打印] 文件: {tmp_path}')

            with open(tmp_path, 'rb') as f:
                resp = requests.post(
                    moonraker_url,
                    files={'file': (gcode_name, f, 'application/octet-stream')},
                    timeout=30
                )

            # 清理临时文件
            try:
                os.remove(tmp_path)
            except Exception:
                pass

            if resp.status_code in (200, 201, 202):
                print(f'[平面打印] GCode 上传成功: {resp.status_code}')
                return {
                    'success': True,
                    'gcode_name': gcode_name,
                }
            else:
                err_msg = f'Moonraker 返回 {resp.status_code}'
                try:
                    err_detail = resp.json()
                    if isinstance(err_detail, dict):
                        err_msg += f': {err_detail.get("error", resp.text[:200])}'
                except Exception:
                    err_msg += f': {resp.text[:200]}'
                print(f'[平面打印] GCode 上传失败: {err_msg}')
                return {'success': False, 'error': err_msg}

        except requests.exceptions.ConnectionError:
            msg = f'无法连接到打印机 ({printer_addr}:7125)'
            print(f'[平面打印] {msg}')
            return {'success': False, 'error': msg}
        except Exception as e:
            print(f'[平面打印] 上传异常: {e}')
            import traceback
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def planar_strip_preview(self, png_base64):
        """平面打印预览：保存 Preview/layer_0000.png，调用 generate_blocks_for_layer
        生成 Segment/_temp/layer_0000/ 下的 MBD 文件（与正常纹理切片完全一致的输出）。

        返回 {success, blocks, strips}。
        """
        import base64
        import io
        import os
        import shutil
        import glob
        from PIL import Image
        from strip_processor import generate_blocks_for_layer

        # ---- 目录准备 ----
        preview_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
        segment_temp = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Segment/_temp')
        for d in [preview_dir, segment_temp]:
            if os.path.exists(d):
                shutil.rmtree(d, ignore_errors=True)
        os.makedirs(preview_dir, exist_ok=True)

        # ---- 解码 + 保存 layer_0000.png ----
        try:
            if ',' in png_base64:
                png_base64 = png_base64.split(',', 1)[1]
            img_data = base64.b64decode(png_base64)
            img = Image.open(io.BytesIO(img_data)).convert('RGBA')
            w, h = img.size
            if w != h:
                return {'success': False, 'error': f'图像必须为正方形，当前 {w}x{h}'}
        except Exception as e:
            return {'success': False, 'error': f'图像解码失败: {e}'}

        layer_path = os.path.join(preview_dir, 'layer_0000.png')
        img.save(layer_path, compress_level=1)

        # ---- 复用 generate_blocks_for_layer 做条带切割+MBD生成 ----
        layer_dir = os.path.join(segment_temp, '0000')
        os.makedirs(layer_dir, exist_ok=True)
        result = generate_blocks_for_layer(layer_path, layer_dir)

        if result['blocks'] == 0:
            return {'success': False, 'error': '画布无可打印内容'}

        # 统计条带数（通过 MBD 文件分布推断）
        mbd_files = sorted(glob.glob(os.path.join(layer_dir, '*.mbd')))
        total_blocks = len(mbd_files)

        print(f'[平面预览] Preview: {layer_path}')
        print(f'[平面预览] Segment: {layer_dir} ({total_blocks} MBD blocks)')
        return {
            'success': True,
            'blocks': total_blocks,
            'strips': total_blocks,  # generate_blocks_for_layer 不返回 strips，置等于 blocks
            'preview_dir': preview_dir,
            'segment_dir': layer_dir,
        }

    def planar_strip_slice(self, png_base64, z_height=0.0):
        """平面打印条带切割：完全对齐正常纹理切片流程（alpha渐变、块合并、
        MBRUSH_UPLOAD、MBD转换、_temp.zip打包），作为单层"0000"处理，无擦塔。

        参数:
            png_base64: str, canvas 导出的 base64 PNG 数据（含 data:image/png;base64 前缀）
            z_height: float, 用户设置的Z轴打印高度 mm（默认0，用于信封/衣物等厚物体）

        返回 {success, error, gcode_name, blocks, strips}。
        """
        import base64
        import glob
        import io
        import os
        import uuid
        import json as _json
        import math
        import zipfile
        import tempfile
        import shutil
        import numpy as np
        from PIL import Image
        from strip_processor import (
            BED_SIZE_MM, HEAD_WIDTH_MM, TRANSITION_MM, TRANSITION_STEP_MM,
            EFFECTIVE_STEP_MM, TRAVEL_SPEED_MM_S, TRAVEL_ACCEL_MM_S2, PRINT_SPEED_MM_S,
            HEAD_INITIAL_X_MM, HEAD_INITIAL_Y_MM, BLOCK_LEADIN_MM,
            _mm_to_px, _px_to_mm, _calculate_travel_time,
            _build_alpha_gradient, apply_alpha_gradient, apply_shear, find_non_white_blocks,
            _block_arr_to_mbd,
        )

        LAYER_NAME = 'layer_0000'

        # ---- 1. 解码图像 ----
        try:
            if ',' in png_base64:
                png_base64 = png_base64.split(',', 1)[1]
            img_data = base64.b64decode(png_base64)
            img = Image.open(io.BytesIO(img_data)).convert('RGBA')
            full_arr = np.array(img).astype(np.uint8)
        except Exception as e:
            return {'success': False, 'error': f'图像解码失败: {e}'}

        h, w = full_arr.shape[:2]
        if w != h:
            return {'success': False, 'error': f'图像必须为正方形，当前 {w}x{h}'}
        img_size = w

        # ---- 2. 读取打印机配置 ----
        import requests
        try:
            settings = self.load_printer_settings()
            if not settings.get('success'):
                return {'success': False, 'error': '无法读取打印机设置'}
            s = settings.get('settings', {})
            printer_addr = (s.get('printerAddress') or '').strip()
            head_addr = (s.get('headAddress') or '').strip()
        except Exception as e:
            return {'success': False, 'error': f'读取设置失败: {e}'}

        if not printer_addr:
            return {'success': False, 'error': '未配置打印机地址'}

        # ---- 3. 读取喷墨配置（XY偏移、浓度、打印速度，与 texture_generate_strips 一致）----
        head_ip = head_addr or '192.168.1.8'
        offset_x = 0.0
        offset_y = 0.0
        shear_mm = 0.0
        inkjet_density = 50
        print_speed = PRINT_SPEED_MM_S
        travel_speed = TRAVEL_SPEED_MM_S
        cmy_c = 1.0
        cmy_m = 1.0
        cmy_y = 1.0
        cmy_saturation = 0.0
        cmy_brightness = 0.0
        dry_time = 3
        try:
            from pathlib import Path
            config_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
            cfg_path = config_dir / 'MKP standard.json'
            if cfg_path.exists():
                with open(cfg_path, 'r', encoding='utf-8') as cf:
                    cfg = _json.load(cf)
                ij = cfg.get('inkjet', {})
                off = ij.get('offset', {})
                offset_x = float(off.get('x', 0))
                offset_y = float(off.get('y', 0))
                density_val = ij.get('density', 0.5)
                inkjet_density = int(float(density_val) * 100)
                speed_val = ij.get('speed', 20)
                print_speed = float(speed_val)
                # 平行四边形剪切补偿（mm），补偿喷头倾斜
                shear_mm = float(ij.get('shear_mm', 0))
                # CMY 色调调节
                cmy = ij.get('cmy', {})
                cmy_c = float(cmy.get('c', 1.0))
                cmy_m = float(cmy.get('m', 1.0))
                cmy_y = float(cmy.get('y', 1.0))
                cmy_saturation = float(cmy.get('saturation', 0.0))
                cmy_brightness = float(cmy.get('brightness', 0.0))
                cmy_contrast = float(ij.get('contrast', 1.0))
                repeat_count = int(ij.get('repeat_count', 1))
                dry_time = int(ij.get('dry_time', 3))
                print(f'[平面打印] 喷墨配置: offset=({offset_x},{offset_y}), '
                      f'shear={shear_mm}mm, density={inkjet_density}%, speed={print_speed}mm/s, repeat={repeat_count}')
        except Exception as e:
            print(f'[平面打印] 读取喷墨配置失败，使用默认值: {e}')

        # ---- 4. CMY 色调调节 ----
        from strip_processor import apply_cmy_adjustment
        full_arr = apply_cmy_adjustment(full_arr, cmy_c, cmy_m, cmy_y,
                                         cmy_saturation, cmy_brightness, cmy_contrast)
        print(f'[平面打印] CMY 调节: C={cmy_c:.2f}, M={cmy_m:.2f}, Y={cmy_y:.2f}, '
              f'Sat={cmy_saturation:+.2f}, Bri={cmy_brightness:+.2f}, Contrast={cmy_contrast:.2f}')

        # ---- 5. 条带参数 ----
        scale = img_size / BED_SIZE_MM
        head_width_px = _mm_to_px(HEAD_WIDTH_MM, scale)
        transition_px = _mm_to_px(TRANSITION_MM, scale)
        step_px = _mm_to_px(TRANSITION_STEP_MM, scale)

        # 条带数量
        remaining_mm = BED_SIZE_MM
        strip_count = 0
        while remaining_mm > 0.01:
            remaining_mm -= EFFECTIVE_STEP_MM
            strip_count += 1

        # 预计算 alpha 渐变
        std_strip_h = min(int(round(head_width_px)), img_size)
        alpha_grad = _build_alpha_gradient(std_strip_h, transition_px)

        # ---- 5. 临时目录（MBD输出 + GCode临时文件）----
        tmp_dir = tempfile.mkdtemp(prefix='mkp_flat_')
        mbd_dir = os.path.join(tmp_dir, LAYER_NAME)
        # png_dir = os.path.join(tmp_dir, 'PNG')
        os.makedirs(mbd_dir, exist_ok=True)
        # os.makedirs(png_dir, exist_ok=True)

        # ---- 6. 条带切割 + MBD转换 ----
        all_blocks = []       # 块信息，用于GCode生成
        block_counter = 0
        active_strips = 0
        # composite_strips = []  # 收集条带数据用于加法合成预览

        for s in range(strip_count):
            strip_top_mm = BED_SIZE_MM - s * EFFECTIVE_STEP_MM

            strip_img_top_px = int(round((BED_SIZE_MM - strip_top_mm) * scale))
            strip_img_bottom_px = int(round(strip_img_top_px + head_width_px))
            strip_img_top_px = max(0, strip_img_top_px)
            strip_img_bottom_px = min(img_size, strip_img_bottom_px)

            if strip_img_bottom_px <= strip_img_top_px:
                continue

            # 提取条带并应用 alpha 渐变（与 _process_layer_core 一致）
            strip_arr = full_arr[strip_img_top_px:strip_img_bottom_px, :, :].copy()
            strip_h = strip_arr.shape[0]
            grad = alpha_grad if strip_h == std_strip_h else _build_alpha_gradient(
                strip_h, transition_px)
            strip_arr = apply_alpha_gradient(strip_arr, grad)

            # # 记录条带数据用于加法合成预览（shear 之前）
            # composite_strips.append({
            #     'arr': strip_arr.copy(),
            #     'top_px': strip_img_top_px,
            # })

            # # 导出完整条带 PNG（含 alpha 渐变）
            # strip_png_path = os.path.join(
            #     png_dir, f'{LAYER_NAME}_strip{s:04d}_top{strip_img_top_px}_btm{strip_img_bottom_px}_mm{strip_top_mm:.1f}-{strip_top_mm - HEAD_WIDTH_MM:.1f}.png')
            # Image.fromarray(strip_arr, 'RGBA').save(strip_png_path, compress_level=1)

            # 平行四边形剪切变换（补偿喷头倾斜），顶部偏移、底部固定
            if abs(shear_mm) > 0.001:
                shear_px = shear_mm * scale
                strip_arr = apply_shear(strip_arr, shear_px)

            # 找非白块（4mm 间隙合并，与 _process_layer_core 一致）
            min_gap_px = int(round(_mm_to_px(4.0, scale)))
            blocks = find_non_white_blocks(strip_arr, min_gap_px)
            if not blocks:
                continue

            active_strips += 1
            strip_center_y_mm = strip_top_mm - HEAD_WIDTH_MM / 2.0

            for x_start_px, x_end_px in blocks:
                x_start_px = max(0, int(x_start_px))
                x_end_px = min(strip_arr.shape[1], int(x_end_px))

                # MBD块：带 leadin 空白引导（与 generate_blocks_for_layer 一致）
                leadin_px = int(round(_mm_to_px(BLOCK_LEADIN_MM, scale)))
                x_block_start_px = max(0, x_start_px - leadin_px)
                if x_block_start_px < x_start_px:
                    pad_w = x_start_px - x_block_start_px
                    core_arr = strip_arr[:, x_start_px:x_end_px, :]
                    white_pad = np.ones(
                        (core_arr.shape[0], pad_w, 4), dtype=np.uint8) * 255
                    block_arr = np.concatenate([white_pad, core_arr], axis=1)
                else:
                    block_arr = strip_arr[:, x_start_px:x_end_px, :]

                mbd_name = f'{block_counter:05d}.mbd'
                mbd_path = os.path.join(mbd_dir, mbd_name)

                # PNG → MBD 转换
                try:
                    _block_arr_to_mbd(block_arr, mbd_path, inkjet_density)
                except Exception as e:
                    print(f'[平面打印] MBD 转换失败 ({mbd_name}): {e}')
                    # 继续处理其他块，不阻塞整个流程

                # # 导出块 PNG（调试用）
                # block_png_name = f'{block_counter:05d}.png'
                # block_png_path = os.path.join(png_dir, block_png_name)
                # Image.fromarray(block_arr, 'RGBA').save(block_png_path, compress_level=1)

                # 记录块信息（GCode 用未填充的坐标）
                x_mm = _px_to_mm(x_start_px, scale)
                w_mm = _px_to_mm(x_end_px - x_start_px, scale)

                all_blocks.append({
                    'x_mm': round(x_mm, 3),
                    'y_mm': round(strip_center_y_mm, 3),
                    'w_mm': round(w_mm, 3),
                    'file': mbd_name,
                })
                block_counter += 1

        # # ---- 6.5 加法混合合成预览 ----
        # # sRGB "over" 合成在重叠区会偏浅（α=128+128→192，仅75%），
        # # 这里用加法混合模拟物理墨量叠加，供视觉检查条带接缝质量。
        # if composite_strips:
        #     can_w = full_arr.shape[1]
        #     composite_rgb = np.ones((img_size, can_w, 3), dtype=np.float64) * 255.0
        #     for sd in composite_strips:
        #         arr = sd['arr']
        #         top = sd['top_px']
        #         h, w = arr.shape[0], arr.shape[1]
        #         rgb = arr[:, :, :3].astype(np.float64)
        #         alpha = arr[:, :, 3].astype(np.float64) / 255.0
        #         for c in range(3):
        #             composite_rgb[top:top+h, :w, c] += rgb[:, :, c] * alpha
        #     composite_rgb = np.clip(composite_rgb, 0, 255).astype(np.uint8)
        #     composite_png_path = os.path.join(
        #         png_dir, f'{LAYER_NAME}_composite.png')
        #     Image.fromarray(composite_rgb, 'RGB').save(composite_png_path, compress_level=1)
        #     del composite_rgb, composite_strips

        if not all_blocks:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return {'success': False, 'error': '画布无可打印内容'}

        # ---- 7. 计算 block timing（与 _process_layer_core 一致）----
        prev_end_x = HEAD_INITIAL_X_MM
        prev_end_y = HEAD_INITIAL_Y_MM
        block_timings = []

        for blk in all_blocks:
            dx = blk['x_mm'] - prev_end_x
            dy = blk['y_mm'] - prev_end_y
            dist = math.sqrt(dx * dx + dy * dy)
            travel_time = _calculate_travel_time(dist)

            block_timings.append({
                'travel_s': round(travel_time, 4),
                'x_mm': blk['x_mm'],
                'y_mm': blk['y_mm'],
                'w_mm': blk['w_mm'],
                'file': blk['file'],
            })

            prev_end_x = blk['x_mm'] + blk['w_mm']
            prev_end_y = blk['y_mm']

        # ---- 8. 从喷墨配置读取 GRAB / RELEASE 宏（完全照搬 start_print 第 201-218 行逻辑）----
        from GCodeGenerator import _expand_macro
        grab_macro = 'GRAB_INKJET_HEAD'
        release_macro = 'RELEASE_INKJET_HEAD'
        try:
            _config_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
            _cfg_name = getattr(self, '_current_inkjet_config', None) or 'MKP standard'
            _cfg_path = _config_dir / (f'{_cfg_name}.json')
            if _cfg_path.exists():
                with open(str(_cfg_path), 'r', encoding='utf-8') as _cf:
                    _cfg = _json.load(_cf)
                _ij = _cfg.get('inkjet', {})
                grab_macro = _ij.get('grab_macro', grab_macro) or grab_macro
                release_macro = _ij.get('release_macro', release_macro) or release_macro
        except Exception:
            pass

        current_z = z_height if z_height > 0.001 else 0.0
        expanded_grab = _expand_macro(grab_macro, current_z)
        expanded_release = _expand_macro(release_macro, current_z)

        # 扣留 G1 E 行（平面打印无挤出，直接删除含挤出量的行）
        def _strip_g1_e(text):
            return '\n'.join(
                line for line in text.split('\n')
                if not re.match(r'^\s*G1\s+.*\bE\s*[\+\-]?\d', line.strip(), re.IGNORECASE)
            )
        expanded_grab = _strip_g1_e(expanded_grab)
        expanded_release = _strip_g1_e(expanded_release)

        # ---- 9. 生成 GCode（完全对齐 GCodeGenerator.process_gcode 第 1593-1616 行）----
        travel_feedrate = int(travel_speed * 60)
        print_feedrate = int(print_speed * 60)

        inkjet_speed_int = int(print_speed)

        gcode_lines = [
            'CHECK_MOTORS_AND_HOME',
        ]
        if z_height != 0:
            gcode_lines.append(f'G1 Z{z_height + 62.9:.3f} F3000 ; 移动到 Z 高度（本底62.9 + 用户设置{z_height}）')
            gcode_lines.append('PAUSE ; 暂停，确认高度后继续')
        gcode_lines.extend([
            'UNZIP_TEMP',
            f'MBRUSH_FLUSH IP={head_ip} SPEED={inkjet_speed_int}',
        ])
        gcode_lines.extend([
            f'; Layer: {LAYER_NAME}',
            f'; Strips: {active_strips}, Blocks: {len(all_blocks)}',
            f'; Head: {HEAD_WIDTH_MM}mm, Transition: {TRANSITION_MM}mm',
            f'; Travel speed: {travel_speed}mm/s, Print speed: {print_speed}mm/s',
            '; ---',
        ])

        gcode_lines.append('')
        gcode_lines.append(';=== GRAB INKJET HEAD ===')
        gcode_lines.append(';=== NOZZLE CLEAN ===')
        gcode_lines.append('G4 P2000  ; 等待喷嘴冲洗 2 秒')
        gcode_lines.append('')
        gcode_lines.append(expanded_grab)
        if z_height != 0:
            gcode_lines.append(f'G1 Z{z_height + 62.9:.3f} F3000 ; 确保 Z 高度（宏后）')

        gcode_lines.append(f';=== TEXTURE INKJET LAYER {LAYER_NAME} ===')

        for blk, tmg in zip(all_blocks, block_timings):
            x_start = blk['x_mm'] + offset_x
            x_end = blk['x_mm'] + blk['w_mm'] + offset_x
            y_pos = blk['y_mm'] + offset_y

            # X+ 延伸 10mm（不超过热床，与 _process_layer_core 一致）
            if not (x_end <= BED_SIZE_MM < x_end + 10.0):
                x_end += 10.0

            gcode_lines.append(
                f'G1 X{x_start:.3f} Y{y_pos:.3f} F{travel_feedrate}'
                f'  ; travel {tmg["travel_s"]:.4f}s (block: {blk["file"]})'
            )
            gcode_lines.append('M400  ; 等待所有动作完成')
            gcode_lines.append(
                f'MBRUSH_UPLOAD IP={head_ip} FILE="{LAYER_NAME}/{blk["file"]}"'
            )
            gcode_lines.append(
                f'G1 X{x_end:.3f} Y{y_pos:.3f} F{print_feedrate}'
                f'  ; print {blk["w_mm"]:.3f}mm'
            )
            gcode_lines.append('M400  ; 等待所有动作完成')
            gcode_lines.append(f'G1 F{travel_feedrate}  ; 空驶速度')

        # ---- 重复喷墨：第 2+ 次前吹干墨水、停泊、等待（中间不取放）----
        if repeat_count > 1:
            # 提取纯喷墨移动行（不含取放宏）
            inkjet_start = None
            for i, line in enumerate(gcode_lines):
                if line.startswith(';=== TEXTURE INKJET'):
                    inkjet_start = i
                    break
            if inkjet_start is not None:
                inkjet_only = gcode_lines[inkjet_start:]
                for pass_idx in range(1, repeat_count):
                    gcode_lines.append('')
                    gcode_lines.append(f';=== REPEAT INKJET PASS {pass_idx + 1}/{repeat_count} ===')
                    gcode_lines.append('M106 P2 S255  ; 风扇全开（吹干墨水）')
                    gcode_lines.append('G1 X251 F3000  ; 去躲风位X251')
                    gcode_lines.append('G1 Y150 F3000  ; 中间安全位Y150')
                    gcode_lines.append('G1 Y20 F3000  ; 去躲风位Y20')
                    gcode_lines.append('G4 P{}  ; 等待 {} 秒'.format(dry_time * 1000, dry_time))
                    gcode_lines.append('M106 P2 S0  ; 关闭风扇')
                    gcode_lines.append('G1 Y150 F3000  ; 退出躲风位')
                    gcode_lines.extend(inkjet_only)
            gcode_lines.append(f';=== END INKJET {repeat_count} PASSES ===')

        # 放回喷墨头（所有重复结束后只放一次）
        gcode_lines.append(expanded_release)
        gcode_lines.append(';=== RELEASE INKJET HEAD ===')

        gcode_lines.append('G1 Y50 F3000  ; 先Y退出到安全位')
        gcode_lines.append('G1 X2 F3000  ; 再X归零')
        gcode_lines.append('G1 Y2 F3000  ; 最后Y归零')
        gcode_lines.append('CLEAN_GCODE  ; clean old 2D flat print files on printer')
        gcode_lines.append('SET_IDLE_TIMEOUT TIMEOUT=2147483647  ; 闲置超时设极大值，保持电机使能，免去下次G28')
        # M84 removed: CHECK_MOTORS_AND_HOME 会自动判断电机状态

        gcode = '\n'.join(gcode_lines)

        # ---- 9. 保存 GCode 到 Gcode 目录（与纹理切片一致）----
        unique_id = uuid.uuid4().hex[:8]
        gcode_name = f'2D_flat_print_{unique_id}.gcode'
        gcode_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Gcode')
        os.makedirs(gcode_dir, exist_ok=True)

        # 清理旧的 2D 平面打印 GCode
        for _old in glob.glob(os.path.join(gcode_dir, '2D_FLAT_PRINT_*.gcode')):
            try:
                os.remove(_old)
                print(f'[平面打印] 清理旧 GCode: {os.path.basename(_old)}')
            except Exception:
                pass

        gcode_path = os.path.join(gcode_dir, gcode_name)
        with open(gcode_path, 'w', encoding='utf-8') as f:
            f.write(gcode)
        print(f'[平面打印] GCode 已保存: {gcode_path}')

        # ---- 10. 打包 _temp.zip（与 texture_generate_strips 一致）----
        zip_path = os.path.join(gcode_dir, '_temp.zip')
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(tmp_dir):
                for fn in files:
                    fp = os.path.join(root, fn)
                    zf.write(fp, os.path.relpath(fp, tmp_dir))
        print(f'[平面打印] _temp.zip 打包完成: {zip_path} ({len(all_blocks)} blocks)')

        # ---- 11. 先上传 _temp.zip（喷墨头需要先拿到 MBD 数据）----
        result = {
            'success': False,
            'printer_result': None,
            'inkjet_result': None,
            'detail': ''
        }
        errors = []
        zip_ok = True

        if printer_addr and os.path.exists(zip_path):
            try:
                moonraker_url = f'http://{printer_addr}:7125/server/files/upload'
                print(f'[平面打印] 上传 _temp.zip 到 Moonraker: {moonraker_url}')

                with open(zip_path, 'rb') as f:
                    resp = requests.post(
                        moonraker_url,
                        files={'file': ('_temp.zip', f, 'application/zip')},
                        timeout=60
                    )

                if resp.status_code in (200, 201, 202):
                    result['inkjet_result'] = {
                        'success': True,
                        'message': f'MBD 块已打包上传 (_temp.zip, {len(all_blocks)} blocks)'
                    }
                    print(f'[平面打印] _temp.zip 上传成功')
                else:
                    err_msg = f'Moonraker 返回 {resp.status_code}'
                    try:
                        err_msg += f': {resp.text[:200]}'
                    except Exception:
                        pass
                    result['inkjet_result'] = {'success': False, 'message': err_msg}
                    errors.append(f'_temp.zip: {err_msg}')
                    zip_ok = False
                    print(f'[平面打印] _temp.zip 上传失败: {err_msg}')
            except requests.exceptions.ConnectionError:
                print(f'[平面打印] 无法连接 Moonraker 上传 _temp.zip')
                errors.append('_temp.zip: 无法连接 Moonraker')
                result['inkjet_result'] = {'success': False, 'message': '无法连接 Moonraker'}
                zip_ok = False
            except Exception as e:
                print(f'[平面打印] _temp.zip 上传异常: {e}')
                errors.append(f'_temp.zip: {e}')
                result['inkjet_result'] = {'success': False, 'message': str(e)}
                zip_ok = False
        else:
            result['inkjet_result'] = {
                'success': True,
                'message': f'MBD 块已打包 (_temp.zip, {len(all_blocks)} blocks)'
            }

        # ---- 12. 上传 GCode + 启动打印（zip 成功后执行）----
        if zip_ok and printer_addr:
            try:
                moonraker_url = f'http://{printer_addr}:7125/server/files/upload'
                print(f'[平面打印] 上传 GCode 到 Moonraker: {moonraker_url}')

                with open(gcode_path, 'rb') as f:
                    resp = requests.post(
                        moonraker_url,
                        files={'file': (gcode_name, f, 'application/octet-stream')},
                        timeout=30
                    )

                if resp.status_code in (200, 201, 202):
                    uploaded_path = gcode_name
                    try:
                        resp_json = resp.json()
                        if isinstance(resp_json, dict):
                            item = resp_json.get('item') or resp_json.get('result') or {}
                            uploaded_path = item.get('path', gcode_name)
                            print(f'[平面打印] Moonraker 返回路径: {uploaded_path}')
                    except Exception:
                        pass

                    result['printer_result'] = {
                        'success': True,
                        'message': f'GCode 已上传至打印机 ({gcode_name})'
                    }
                    print(f'[平面打印] GCode 上传成功: {resp.status_code}')

                    # 发送开始打印命令
                    try:
                        start_url = f'http://{printer_addr}:7125/printer/print/start'
                        start_resp = requests.post(
                            start_url,
                            json={'filename': uploaded_path},
                            timeout=15
                        )
                        if start_resp.status_code in (200, 201, 202):
                            result['printer_result']['message'] += '，打印机已开始运行'
                            print(f'[平面打印] 打印机启动命令发送成功')
                        else:
                            err = f'启动打印失败: Moonraker返回{start_resp.status_code}'
                            result['printer_result']['message'] += f'，但{err}'
                            errors.append(f'打印机: {err}')
                            print(f'[平面打印] {err}: {start_resp.text[:200]}')
                    except requests.exceptions.ConnectionError:
                        err = '启动打印失败: 无法连接(启动命令)'
                        result['printer_result']['message'] += f'，但{err}'
                        errors.append(f'打印机: {err}')
                    except Exception as e:
                        result['printer_result']['message'] += f'，但启动命令异常: {e}'
                        errors.append(f'打印机: 启动打印异常: {e}')
                        print(f'[平面打印] 启动打印异常: {e}')
                else:
                    err_msg = f'Moonraker 返回 {resp.status_code}'
                    try:
                        err_detail = resp.json()
                        if isinstance(err_detail, dict):
                            err_msg += f': {err_detail.get("error", resp.text[:200])}'
                    except Exception:
                        err_msg += f': {resp.text[:200]}'
                    result['printer_result'] = {'success': False, 'message': err_msg}
                    errors.append(f'打印机: {err_msg}')
                    print(f'[平面打印] GCode 上传失败: {err_msg}')
            except requests.exceptions.ConnectionError:
                msg = f'无法连接到打印机 ({printer_addr}:7125)'
                result['printer_result'] = {'success': False, 'message': msg}
                errors.append(f'打印机: {msg}')
                print(f'[平面打印] {msg}')
            except requests.exceptions.Timeout:
                msg = f'连接打印机超时 ({printer_addr}:7125)'
                result['printer_result'] = {'success': False, 'message': msg}
                errors.append(f'打印机: {msg}')
                print(f'[平面打印] {msg}')
            except Exception as e:
                msg = f'上传 GCode 异常: {e}'
                result['printer_result'] = {'success': False, 'message': msg}
                errors.append(f'打印机: {msg}')
                print(f'[平面打印] {msg}')
                import traceback
                traceback.print_exc()
        elif not zip_ok:
            result['printer_result'] = {
                'success': False,
                'message': '因 _temp.zip 上传失败，跳过 GCode 上传和打印'
            }
            errors.append('打印机: 因 _temp.zip 上传失败，未执行 GCode 上传')
        elif not printer_addr:
            errors.append('打印机: 未配置地址')
        # try:
        #     # 导出 PNG 到项目 PNG 目录供检查
        #     debug_png_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'PNG', 'strips')
        #     if os.path.exists(debug_png_dir):
        #         shutil.rmtree(debug_png_dir, ignore_errors=True)
        #     os.makedirs(os.path.dirname(debug_png_dir), exist_ok=True)
        #     shutil.copytree(png_dir, debug_png_dir)
        #     print(f'[平面打印] 条带 PNG 已导出: {debug_png_dir}')
        # except Exception as e:
        #     print(f'[平面打印] PNG 导出失败: {e}')
        try:
            shutil.rmtree(tmp_dir)
        except Exception:
            pass

        # ---- 12. 汇总 ----
        result['detail'] = '；'.join(errors) if errors else '全部上传成功'
        result['success'] = len(errors) == 0
        if not result['success']:
            result['error'] = result['detail']

        result['blocks'] = len(all_blocks)
        result['strips'] = active_strips
        print(f'[平面打印] 完成. success={result["success"]}, '
              f'blocks={len(all_blocks)}, strips={active_strips}, detail={result["detail"]}')
        return result


def get_frontend_path(startup_mkp=None):
    if getattr(sys, 'frozen', False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    frontend_dir = os.path.join(base_path, 'frontend')
    html_path = os.path.join(frontend_dir, 'index.html')
    if startup_mkp:
        startup_html = os.path.join(frontend_dir, 'startup_index.html')
        with open(html_path, 'r', encoding='utf-8') as f:
            html = f.read()
        startup_script = (
            '<script>window.__STARTUP_MKP_PATH = '
            + json.dumps(startup_mkp, ensure_ascii=False)
            + ';document.documentElement.classList.add("startup-mkp");</script>'
        )
        html = html.replace('<link rel="icon" href="data:,">', '<link rel="icon" href="data:,">\n    ' + startup_script, 1)
        with open(startup_html, 'w', encoding='utf-8', newline='\n') as f:
            f.write(html)
        return startup_html
    return html_path


def on_loaded(api, window, pending_mkp=None):
    """窗口加载完成时触发"""
    print('[事件] 窗口加载完成，设置API窗口引用')
    api.set_window(window)
    # 确保默认配置存在
    api.ensure_default_config()
    # [已移除] 不再需要后台常驻监控 (fluidd_tray_monitor)
    # api._start_tray_if_configured()

    # 双击 .mkp 文件关联打开：前端就绪后注入加载逻辑
    if pending_mkp:
        escaped_path = pending_mkp.replace('\\', '\\\\').replace("'", "\\'")
        js = (
            "setTimeout(async function(){"
            "try{"
            "var r=await pywebview.api.load_mkp_project('" + escaped_path + "');"
            "if(r&&r.success){"
            "var app=window._app||window.bp||null;"
            "if(!app){console.error('MKP app instance not ready');return;}"
            "app.switchToPrepare();"
            "app.loadProject(r.project);"
            "app._currentMkpPath='" + escaped_path + "';"
            "pywebview.api.add_recent_project('" + escaped_path + "').catch(function(){});"
            "}"
            "}catch(e){console.error('MKP load error:',e);}"
            "},500);"
        )
        try:
            window.evaluate_js(js)
        except Exception as e:
            print(f'[启动] 注入MKP加载脚本失败: {e}')


def _get_config_dir():
    """获取 Documents\\MKPSpectrum 目录，不存在则创建。"""
    docs = os.path.join(os.path.expanduser('~'), 'Documents', 'MKPSpectrum')
    os.makedirs(docs, exist_ok=True)
    return docs

def _get_config():
    """读取 Documents\\MKPSpectrum\\config.json。"""
    config_path = os.path.join(_get_config_dir(), 'config.json')
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _save_config(config):
    """写回 config.json。"""
    config_path = os.path.join(_get_config_dir(), 'config.json')
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

def _get_mkp_progids():
    """找出所有与 .mkp 关联的 ProgID。

    覆盖三条路径：
    1. HKCR\\.mkp / HKCU\\Software\\Classes\\.mkp 的默认值
    2. HKCR\\.mkp\\OpenWithProgids / HKCU 对应路径
    3. FileExts\\.mkp\\UserChoice 的 ProgId（打开方式）
    4. FileExts\\.mkp\\OpenWithProgids
    """
    progids = set()

    # 1. 标准关联：.mkp 默认值 及 OpenWithProgids
    for hkey in (winreg.HKEY_CURRENT_USER, winreg.HKEY_CLASSES_ROOT):
        try:
            with winreg.OpenKey(hkey, r'.mkp') as key:
                progid, _ = winreg.QueryValueEx(key, '')
                if progid:
                    progids.add(progid)
        except (FileNotFoundError, OSError):
            pass
        try:
            with winreg.OpenKey(hkey, r'.mkp\OpenWithProgids') as key:
                for i in range(winreg.QueryInfoKey(key)[1]):
                    name, value, _ = winreg.EnumValue(key, i)
                    if value or name:
                        progids.add(name)
        except (FileNotFoundError, OSError):
            pass

    # 2. 用户通过"打开方式"设置的关联（优先级最高）
    cu_base = r'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mkp'
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, cu_base + r'\UserChoice') as key:
            progid, _ = winreg.QueryValueEx(key, 'ProgId')
            if progid:
                progids.add(progid)
    except (FileNotFoundError, OSError):
        pass
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, cu_base + r'\OpenWithProgids') as key:
            for i in range(winreg.QueryInfoKey(key)[1]):
                name, value, _ = winreg.EnumValue(key, i)
                if value or name:
                    progids.add(name)
    except (FileNotFoundError, OSError):
        pass

    # 兜底
    if not progids:
        progids.add('MKPSpectrum.mkp')
    return progids

def ensure_mkp_file_icon():
    """启动时确保 .mkp 文件图标正确（即使之前已标记过也会校验修复）。"""
    try:
        # 解析图标路径：兼容 onedir / onefile / 源码运行
        ico_path = None
        candidates = []
        if getattr(sys, 'frozen', False):
            meipass = getattr(sys, '_MEIPASS', None)
            if meipass:
                candidates.append(os.path.join(meipass, 'MKPProgram.ico'))
            candidates.append(os.path.join(os.path.dirname(os.path.abspath(sys.executable)), 'MKPProgram.ico'))
            # onedir 模式下 _internal 子目录
            candidates.append(os.path.join(os.path.dirname(os.path.abspath(sys.executable)), '_internal', 'MKPProgram.ico'))
        candidates.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'MKPProgram.ico'))
        for c in candidates:
            if c and os.path.exists(c):
                ico_path = os.path.abspath(c)
                break
        if not ico_path:
            return

        # Explorer 要求 DefaultIcon 值为 "路径,0"
        ico_value = f'{ico_path},0'

        # 即使 config 已标记，也要校验注册表是否真的正确；不正确则修复
        config = _get_config()
        already_flag = bool(config.get('icon_registered'))

        # 先检查是否已全部正确，若正确则直接补标记后返回
        def _is_correct(key_path):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as k:
                    cur, _ = winreg.QueryValueEx(k, '')
                    return cur == ico_value or cur == ico_path
            except FileNotFoundError:
                return False
            except OSError:
                return False

        progids = _get_mkp_progids()
        # 确保核心 ProgID 也在集合中，保证新安装时图标能写到正确位置
        progids.add('MKPSpectrum.Project')
        all_correct = all(_is_correct(rf'Software\Classes\{pid}\DefaultIcon') for pid in progids)
        all_correct = all_correct and _is_correct(r'Software\Classes\.mkp\DefaultIcon')
        all_correct = all_correct and _is_correct(r'Software\Classes\MKPSpectrum.Project\DefaultIcon')
        if all_correct and already_flag:
            return

        print(f'[icon] 找到 ProgID: {progids}  图标: {ico_value}')
        need_refresh = False

        for progid in progids:
            key_path = rf'Software\Classes\{progid}\DefaultIcon'
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                try:
                    current, _ = winreg.QueryValueEx(key, '')
                except FileNotFoundError:
                    current = None
                if current != ico_value and current != ico_path:
                    print(f'[icon] 写入 {key_path} = {ico_value}')
                    winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_value)
                    need_refresh = True
                else:
                    if current == ico_path:
                        # 修正为带 ,0 的规范写法
                        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_value)
                        need_refresh = True
                    else:
                        print(f'[icon] 跳过 {key_path} (已正确)')

        # 显式保证 MKPSpectrum.Project
        for extra_key in [r'Software\Classes\MKPSpectrum.Project\DefaultIcon',
                          r'Software\Classes\.mkp\DefaultIcon']:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, extra_key) as key:
                try:
                    current, _ = winreg.QueryValueEx(key, '')
                except FileNotFoundError:
                    current = None
                if current != ico_value and current != ico_path:
                    print(f'[icon] 写入 {extra_key} = {ico_value}')
                    winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_value)
                    need_refresh = True
                else:
                    if current == ico_path:
                        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_value)
                        need_refresh = True
                    else:
                        print(f'[icon] 跳过 {extra_key} (已正确)')

        if need_refresh:
            try:
                import ctypes
                ctypes.windll.shell32.SHChangeNotify(0x08000000, 0x0000, None, None)
            except Exception:
                pass

        config['icon_registered'] = True
        _save_config(config)
    except Exception as e:
        print(f'[icon] 设置图标异常: {e}')


def main():
    ensure_mkp_file_icon()
    api = ModelAPI()

    # 检查命令行参数中是否有 .mkp 文件路径（双击文件关联打开）
    _pending_mkp = None
    for arg in sys.argv[1:]:
        if arg.lower().endswith('.mkp') and os.path.exists(arg):
            _pending_mkp = os.path.abspath(arg)
            print(f'[启动] 检测到 MKP 文件: {_pending_mkp}')
            break
    html_path = get_frontend_path(_pending_mkp)

    window = webview.create_window(
        title='MKPSpectrum - 3D热床预览',
        url=html_path,
        width=1400,
        height=900,
        min_size=(800, 600),
        text_select=False,
        js_api=api,
        frameless=True,
        easy_drag=False,
    )

    # 延迟到窗口加载完成后再设置窗口引用，避免 AccessibilityObject 递归错误
    window.events.loaded += lambda: on_loaded(api, window, None)

    # 窗口关闭前清理子进程（覆盖前端按钮和系统关闭按钮）
    def _on_closing():
        api._kill_slice_proc()
    window.events.closing += _on_closing

    # 使用 single_thread 模式避免 COM 线程问题
    webview.start(debug=os.environ.get('MKP_DEBUG', '') == '1')


if __name__ == '__main__':
    main()
