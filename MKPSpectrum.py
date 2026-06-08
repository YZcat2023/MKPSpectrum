import webview
import os
import sys
import json
import base64
import mimetypes
import traceback
import subprocess
import threading
import platform
from pathlib import Path
from datetime import datetime
import slice_standalone
import winreg


class ModelAPI:
    def __init__(self):
        self.last_obj_dir = None
        self.window = None
        self._hwnd = None
        self._is_dragging = False
        self._is_maximized = False
        # 纹理切片子进程状态
        self._slice_proc = None
        self._slice_status = {'state': 'idle', 'progress': 0, 'total': 0, 'images': 0, 'error': None}
        self._slice_thread = None
        self._slice_lock = threading.Lock()
        self._slice_output_dir = None

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

    def _kill_slice_proc(self):
        """终止纹理切片子进程"""
        if self._slice_proc:
            try:
                self._slice_proc.kill()
            except Exception as e:
                print(f"终止切片进程异常: {e}")
            self._slice_proc = None
            print("切片子进程已终止")

    def window_close(self):
        self._kill_slice_proc()
        if self.window:
            self.window.destroy()

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

    def _load_stl(self, file_path):
        return {
            'success': True,
            'type': 'stl',
            'data': self._read_file_base64(file_path)
        }

    def _load_gltf(self, file_path):
        return {
            'success': True,
            'type': 'gltf',
            'data': self._read_file_base64(file_path)
        }

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
        """获取用户设置文件的路径"""
        app_data_dir = Path.home() / '.mkpspectrum'
        app_data_dir.mkdir(parents=True, exist_ok=True)
        return str(app_data_dir / 'user_settings.json')

    def _get_print_settings_dir(self):
        """获取喷墨配置文件夹路径: Documents/MKPSpectrum/Printsetting/"""
        docs_dir = Path.home() / 'Documents' / 'MKPSpectrum' / 'Printsetting'
        docs_dir.mkdir(parents=True, exist_ok=True)
        return str(docs_dir)

    def list_print_settings(self):
        """列出所有喷墨配置文件"""
        try:
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
            return {'success': True, 'data': data}
        except Exception as e:
            print(f"加载喷墨配置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def save_settings(self, settings_str):
        """保存用户设置到文件"""
        try:
            settings = json.loads(settings_str) if isinstance(settings_str, str) else settings_str
            path = self._get_settings_path()
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(settings, f, indent=2, ensure_ascii=False)
            print(f"设置已保存到: {path}")
            return {'success': True}
        except Exception as e:
            print(f"保存设置失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def load_settings(self):
        """从文件加载用户设置"""
        try:
            path = self._get_settings_path()
            if not os.path.exists(path):
                print(f"设置文件不存在，使用默认值: {path}")
                return {
                    'success': True,
                    'settings': {
                        'maxHistory': 20,
                        'bedSize': {'x': 270, 'y': 270, 'z': 270},
                        'showGrid': True,
                        'gridTheme': 'dark',
                        'gridSize': 10,
                        'cameraMode': 'perspective',
                        'printerAddress': '',
                        'headAddress': '',
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

    def export_model_files(self, file_path):
        """导出模型文件（OBJ、MTL、贴图）到目标文件夹"""
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

            with zipfile.ZipFile(target_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                # 添加模型文件到 model/ 目录
                for model in project.get('models', []):
                    file_path = model.get('filePath')
                    if file_path and os.path.exists(file_path):
                        # 复制 OBJ 文件
                        obj_name = os.path.basename(file_path)
                        zf.write(file_path, f'model/{obj_name}')

                        # 复制关联的 MTL 文件
                        mtl_path = file_path.replace('.obj', '.mtl')
                        if os.path.exists(mtl_path):
                            zf.write(mtl_path, f'model/{os.path.basename(mtl_path)}')
                            # 复制纹理文件
                            source_dir = os.path.dirname(file_path)
                            texture_files = self._parse_mtl_textures(mtl_path)
                            for tex_name in texture_files:
                                tex_path = os.path.join(source_dir, tex_name)
                                if os.path.exists(tex_path):
                                    zf.write(tex_path, f'model/{tex_name}')

                # 添加 position 文件（不包含 filePath 等路径信息）
                position_data = {
                    'version': project.get('version', '1.0'),
                    'timestamp': project.get('timestamp', ''),
                    'bedSize': project.get('bedSize', {}),
                    'gridSize': project.get('gridSize', 10),
                    'showGrid': project.get('showGrid', True),
                    'models': []
                }
                for model in project.get('models', []):
                    model_scale = model.get('scale')
                    print(f"  [save_mkp] 写入模型: name={model.get('name')}, scale={model_scale}, pos={model.get('position')}")
                    position_data['models'].append({
                        'id': model.get('id'),
                        'name': model.get('name'),
                        'position': model.get('position'),
                        'rotation': model.get('rotation'),
                        'scale': model_scale
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
                    # 找到对应的 OBJ 文件
                    obj_file = None
                    for fname in os.listdir(model_dir):
                        if fname.lower().endswith('.obj'):
                            base = os.path.splitext(fname)[0]
                            # 匹配：模型名 或 模型名+后缀
                            if base == model_name or model_name.startswith(base):
                                obj_file = fname
                                break
                    if not obj_file:
                        print(f"  [load_mkp]   -> 未找到匹配的 OBJ 文件，跳过")
                        continue

                    obj_path = os.path.join(model_dir, obj_file)
                    print(f"  [load_mkp]   -> 匹配到: {obj_file}")
                    # 用 _load_obj 加载模型数据
                    model_data = self._load_obj(obj_path)
                    if model_data and model_data.get('success'):
                        model['_modelData'] = model_data
                        print(f"  [load_mkp]   -> _modelData 已设置, obj长度={len(model_data.get('obj','') or '')}")
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

    def load_gcode_file(self, file_path):
        """从文件读取 GCode 内容并返回文本"""
        try:
            if not file_path or not os.path.exists(file_path):
                return {'success': False, 'error': '文件不存在'}
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                gcode = f.read()
            return {'success': True, 'gcode': gcode}
        except Exception as e:
            print(f"读取GCode文件失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

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
                item = {
                    'path': proj.get('path') or '',
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
                    for fname in os.listdir(model_dir):
                        if fname.lower().endswith('.obj'):
                            base = os.path.splitext(fname)[0]
                            if base == model_name or model_name.startswith(base):
                                obj_file = fname
                                break
                    if not obj_file:
                        continue
                    obj_path = os.path.join(model_dir, obj_file)
                    print(f"  [load_mkp]   -> 加载: {obj_path}")
                    model_data = self._load_obj(obj_path)
                    if model_data and model_data.get('success'):
                        model['_modelData'] = model_data
                        print(f"  [load_mkp]   -> 成功")
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
        """注册 .mkp 文件关联到本程序（Windows）"""
        try:
            if platform.system() != 'Windows':
                return {'success': False, 'error': '仅支持Windows系统'}

            # 获取当前可执行文件路径
            if getattr(sys, 'frozen', False):
                exe_path = sys.executable
            else:
                exe_path = os.path.abspath(sys.argv[0])

            # 注册 .mkp 扩展名关联
            subprocess.run(
                ['cmd', '/c', 'assoc', '.mkp', '=MKPSpectrum.Project'],
                capture_output=True, text=True, check=True
            )

            # 注册文件类型命令
            subprocess.run(
                ['cmd', '/c', 'ftype', 'MKPSpectrum.Project', f'"{exe_path}" "%1"'],
                capture_output=True, text=True, check=True
            )

            print("MKP文件关联注册成功")
            return {'success': True, 'message': 'MKP文件关联注册成功'}
        except subprocess.CalledProcessError as e:
            print(f"注册MKP文件关联失败: {e}")
            return {'success': False, 'error': f'注册失败: {e.stderr or "需要管理员权限"}'}
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
        """纹理切片：启动子进程切片，完成后自动进行条带切割。

        接收前端传递的配置（含 obj_path, layer_height, resolution, model_regions 等），
        启动 slice_standalone.py 作为子进程，通过 stdout JSON 行传递进度。
        切片完成后自动调用 strip_processor 进行条带切割。
        返回 {'success': True/False, ...}
        """
        import json
        import glob

        try:
            config = json.loads(config_str) if isinstance(config_str, str) else config_str

            obj_path = config.get('obj_path', '')
            if not obj_path or not os.path.exists(obj_path):
                return {'success': False, 'error': 'OBJ 文件不存在'}

            # 1. 获取参数
            layer_height = float(config.get('layer_height', 0.2))
            resolution = int(config.get('resolution', 4000))

            # 2. 条带切割参数（切片完成后自动使用）
            model_regions = config.get('model_regions', None)
            motion_params = {}
            for k in ['travel_speed', 'travel_accel', 'print_speed',
                      'head_initial_x', 'head_initial_y']:
                if k in config:
                    motion_params[k] = float(config[k])

            # 3. 输出目录（先删后建，确保彻底清空旧切片）
            import shutil
            output_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if os.path.exists(output_dir):
                shutil.rmtree(output_dir)
            os.makedirs(output_dir, exist_ok=True)

            self._slice_output_dir = output_dir

            # 5. 重置状态
            with self._slice_lock:
                self._slice_status = {
                    'state': 'running',
                    'progress': 0,
                    'total': 0,
                    'images': 0,
                    'error': None,
                }

            # 6. 启动后台线程运行切片 + 条带切割（进程内调用，不依赖外部 Python）
            def _run_slice_and_strips():
                try:
                    # 进度回调 —— 更新共享状态
                    def _on_slice_progress(msg_type, data):
                        if msg_type == 'progress':
                            with self._slice_lock:
                                self._slice_status['progress'] = data.get('current', 0)
                                self._slice_status['total'] = data.get('total', 0)
                                self._slice_status['images'] = data.get('current', 0)
                        elif msg_type == 'done':
                            with self._slice_lock:
                                self._slice_status['state'] = 'done'
                                self._slice_status['progress'] = data.get('count', 0)
                                self._slice_status['total'] = data.get('count', 0)
                        elif msg_type == 'strip_done':
                            with self._slice_lock:
                                self._slice_status['state'] = 'strips_done'
                                self._slice_status['strip_layers'] = data.get('layers', 0)
                                self._slice_status['strip_blocks'] = data.get('total_blocks', 0)
                                self._slice_status['zip_path'] = data.get('zip_path', '')
                                self._slice_status['gcode_dir'] = data.get('gcode_dir', '')
                            print(f"条带切割完成: layers={data.get('layers')}, blocks={data.get('total_blocks')}")
                        # 'log' 消息只打印不存储

                    def _on_slice_log(msg):
                        print(f"[切片] {msg}")

                    from slice_standalone import run_slice

                    result = run_slice(
                        obj_path=obj_path,
                        output_dir=output_dir,
                        layer_height=layer_height,
                        resolution=resolution,
                        do_strip=True,
                        bed_size=270.0,
                        progress_callback=_on_slice_progress,
                        log_callback=_on_slice_log,
                    )

                    # 更新实际图片数量
                    png_files = sorted(glob.glob(os.path.join(output_dir, '*.png')))
                    with self._slice_lock:
                        self._slice_status['images'] = len(png_files)

                    # 如果已通过 strip_done 设置了 strip 状态，保持；否则回退 strip_processor
                    with self._slice_lock:
                        if self._slice_status['state'] not in ('strips_done', 'strips_error'):
                            self._slice_status['state'] = 'done'
                        self._slice_proc = None

                    # 如果 run_slice 返回了 strip_done 但状态未更新（兼容旧逻辑）
                    if result.get('strip_done') and self._slice_status.get('state') != 'strips_done':
                        sd = result['strip_done']
                        with self._slice_lock:
                            self._slice_status['state'] = 'strips_done'
                            self._slice_status['strip_layers'] = sd.get('layers', 0)
                            self._slice_status['strip_blocks'] = sd.get('total_blocks', 0)
                            self._slice_status['zip_path'] = sd.get('zip_path', '')
                            self._slice_status['gcode_dir'] = sd.get('gcode_dir', '')

                except Exception as e:
                    print(f"切片/条带处理异常: {e}")
                    traceback.print_exc()
                    with self._slice_lock:
                        self._slice_status['state'] = 'error'
                        self._slice_status['error'] = str(e)
                        self._slice_proc = None

            self._slice_thread = threading.Thread(target=_run_slice_and_strips, daemon=True)
            self._slice_thread.start()
            print(f"纹理切片已启动: obj={obj_path} layer={layer_height} res={resolution}")
            return {'success': True}

        except Exception as e:
            print(f"纹理切片启动失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def texture_slice_get_status(self):
        """获取当前切片进度状态

        返回: {state, progress, total, images, error}
        state: idle/running/done/cancelled/error
        """
        with self._slice_lock:
            return dict(self._slice_status)

    def texture_slice_cancel(self):
        """取消当前正在进行的纹理切片"""
        self._kill_slice_proc()
        with self._slice_lock:
            self._slice_status['state'] = 'cancelled'
        print("纹理切片已取消")
        return {'success': True}

    def texture_slice_load_images(self):
        """加载切片生成的所有 PNG 图片，返回 base64 列表"""
        import base64
        import glob

        try:
            output_dir = self._slice_output_dir or os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if not os.path.exists(output_dir):
                return {'success': True, 'images': [], 'count': 0}

            png_files = sorted(glob.glob(os.path.join(output_dir, '*.png')))
            images = []
            for f in png_files:
                with open(f, 'rb') as fh:
                    img_data = fh.read()
                b64 = base64.b64encode(img_data).decode('utf-8')
                images.append(f'data:image/png;base64,{b64}')

            print(f"加载切片图片: {len(images)} 张")
            return {
                'success': True,
                'images': images,
                'count': len(images),
                'output_dir': output_dir,
            }
        except Exception as e:
            print(f"加载切片图片失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'images': [], 'count': 0}

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

        返回: {success, total_layers, total_blocks, zip_path, gcode_dir}
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

            # 提取模型区域（仅处理这些 Y 范围内的条带）
            model_regions = params.get('model_regions', None)

            result = strip_processor.process_all_layers(
                preview_dir, output_dir,
                motion_params=motion if motion else None,
                model_regions=model_regions,
            )
            return result

        except Exception as e:
            print(f"条带切割失败: {e}")
            import traceback
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    def load_preview_images(self):
        """从 Temp/Texture/Preview 加载切片预览图片，返回 base64 列表"""
        import base64
        try:
            preview_dir = os.path.expanduser('~/Documents/MKPSpectrum/Temp/Texture/Preview')
            if not os.path.exists(preview_dir):
                return {'success': True, 'images': [], 'count': 0}

            png_files = sorted([
                f for f in os.listdir(preview_dir)
                if f.lower().endswith('.png')
            ])

            images = []
            for fname in png_files:
                fpath = os.path.join(preview_dir, fname)
                with open(fpath, 'rb') as f:
                    img_data = f.read()
                b64 = base64.b64encode(img_data).decode('utf-8')
                images.append(f'data:image/png;base64,{b64}')

            print(f"加载预览图片: {len(images)} 张")
            return {'success': True, 'images': images, 'count': len(images)}
        except Exception as e:
            print(f"加载预览图片失败: {e}")
            traceback.print_exc()
            return {'success': False, 'error': str(e), 'images': [], 'count': 0}

    def test_connection(self, address):
        """测试网络连接是否可达"""
        try:
            if not address or not address.strip():
                return {'success': False, 'message': '地址不能为空'}

            address = address.strip()

            param = '-n' if platform.system().lower() == 'windows' else '-c'
            timeout_param = '-w' if platform.system().lower() == 'windows' else '-W'
            timeout_value = '2000' if platform.system().lower() == 'windows' else '2'

            cmd = ['ping', param, '1', timeout_param, timeout_value, address]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)

            if result.returncode == 0:
                return {'success': True, 'message': '连接成功'}
            else:
                return {'success': False, 'message': '无法连接'}
        except subprocess.TimeoutExpired:
            return {'success': False, 'message': '连接超时'}
        except Exception as e:
            print(f"连接测试异常: {e}")
            return {'success': False, 'message': f'测试失败: {str(e)}'}


def get_frontend_path():
    if getattr(sys, 'frozen', False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, 'frontend', 'index.html')


def on_loaded(api, window):
    """窗口加载完成时触发"""
    print('[事件] 窗口加载完成，设置API窗口引用')
    api.set_window(window)


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
    """首次启动时设置 .mkp 文件图标，完成后写入 config.json 避免重复操作。"""
    try:
        config = _get_config()
        if config.get('icon_registered'):
            return

        # 获取程序所在目录（打包后为 exe 目录，开发时为本 py 目录）
        if getattr(sys, 'frozen', False):
            base_dir = os.path.dirname(sys.executable)
        else:
            base_dir = os.path.dirname(os.path.abspath(__file__))
        ico_path = os.path.join(base_dir, 'MKPProgram.ico')
        if not os.path.exists(ico_path):
            return

        progids = _get_mkp_progids()
        print(f'[icon] 找到 ProgID: {progids}')
        need_refresh = False

        for progid in progids:
            key_path = rf'Software\Classes\{progid}\DefaultIcon'
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                try:
                    current, _ = winreg.QueryValueEx(key, '')
                except FileNotFoundError:
                    current = None
                if current != ico_path:
                    print(f'[icon] 写入 {key_path} = {ico_path}')
                    winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_path)
                    need_refresh = True
                else:
                    print(f'[icon] 跳过 {key_path} (已正确)')

        # 兜底：即使有 ProgID，也直接写 .mkp\DefaultIcon
        fallback_key = r'Software\Classes\.mkp\DefaultIcon'
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, fallback_key) as key:
            try:
                current, _ = winreg.QueryValueEx(key, '')
            except FileNotFoundError:
                current = None
            if current != ico_path:
                print(f'[icon] 写入 {fallback_key} = {ico_path}')
                winreg.SetValueEx(key, '', 0, winreg.REG_SZ, ico_path)
                need_refresh = True
            else:
                print(f'[icon] 跳过 {fallback_key} (已正确)')

        if need_refresh:
            try:
                import ctypes
                ctypes.windll.shell32.SHChangeNotify(0x08000000, 0x0000, None, None)
            except Exception:
                pass

        config['icon_registered'] = True
        _save_config(config)
    except Exception:
        pass  # 非关键功能，静默忽略


def main():
    ensure_mkp_file_icon()
    html_path = get_frontend_path()
    api = ModelAPI()

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
    window.events.loaded += lambda: on_loaded(api, window)

    # 窗口关闭前清理子进程（覆盖前端按钮和系统关闭按钮）
    def _on_closing():
        api._kill_slice_proc()
    window.events.closing += _on_closing

    # 使用 single_thread 模式避免 COM 线程问题
    webview.start()


if __name__ == '__main__':
    main()
