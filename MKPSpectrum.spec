# -*- mode: python ; coding: utf-8 -*-

import sys
import os

block_cipher = None

# 前端文件
frontend_files = [
    ('frontend/index.html', 'frontend'),
    ('frontend/app.js', 'frontend'),
    ('frontend/style.css', 'frontend'),
    ('frontend/lib/three/three.module.js', 'frontend/lib/three'),
    ('frontend/lib/three/addons/controls/OrbitControls.js', 'frontend/lib/three/addons/controls'),
    ('frontend/lib/three/addons/controls/TransformControls.js', 'frontend/lib/three/addons/controls'),
    ('frontend/lib/three/addons/loaders/STLLoader.js', 'frontend/lib/three/addons/loaders'),
    ('frontend/lib/three/addons/loaders/GLTFLoader.js', 'frontend/lib/three/addons/loaders'),
    ('frontend/lib/three/addons/loaders/OBJLoader.js', 'frontend/lib/three/addons/loaders'),
    ('frontend/lib/three/addons/loaders/MTLLoader.js', 'frontend/lib/three/addons/loaders'),
    ('frontend/lib/three/addons/loaders/FBXLoader.js', 'frontend/lib/three/addons/loaders'),
    ('frontend/lib/three/addons/utils/BufferGeometryUtils.js', 'frontend/lib/three/addons/utils'),
    ('frontend/lib/three/addons/utils/TextureUtils.js', 'frontend/lib/three/addons/utils'),
    ('frontend/lib/three/addons/exporters/GLTFExporter.js', 'frontend/lib/three/addons/exporters'),
    # FBXLoader 依赖
    ('frontend/lib/three/addons/libs/fflate.module.js', 'frontend/lib/three/addons/libs'),
    ('frontend/lib/three/addons/geometries/ConvexGeometry.js', 'frontend/lib/three/addons/geometries'),
    ('frontend/lib/three/addons/math/ConvexHull.js', 'frontend/lib/three/addons/math'),
    ('frontend/lib/three/addons/curves/NURBSCurve.js', 'frontend/lib/three/addons/curves'),
    ('frontend/lib/three/addons/curves/NURBSUtils.js', 'frontend/lib/three/addons/curves'),
    ('frontend/lib/three/addons/lines/Line2.js', 'frontend/lib/three/addons/lines'),
    ('frontend/lib/three/addons/lines/LineGeometry.js', 'frontend/lib/three/addons/lines'),
    ('frontend/lib/three/addons/lines/LineMaterial.js', 'frontend/lib/three/addons/lines'),
    ('frontend/lib/three/addons/lines/LineSegments2.js', 'frontend/lib/three/addons/lines'),
    ('frontend/lib/three/addons/lines/LineSegmentsGeometry.js', 'frontend/lib/three/addons/lines'),
]

# 图标文件 — 使用 SPECPATH（PyInstaller 内置变量，指向 spec 文件所在目录）
ico_path = os.path.join(SPECPATH, 'MKPSpectrum.ico')
print(f'[spec] 程序图标: {ico_path}  存在: {os.path.exists(ico_path)}')
if not os.path.exists(ico_path):
    raise FileNotFoundError(f'找不到程序图标: {ico_path}')
mkp_ico_path = os.path.join(SPECPATH, 'MKPProgram.ico')
print(f'[spec] 项目图标: {mkp_ico_path}  存在: {os.path.exists(mkp_ico_path)}')
if not os.path.exists(mkp_ico_path):
    raise FileNotFoundError(f'找不到项目图标: {mkp_ico_path}')

# 额外的 Python 数据文件（子进程调用或动态导入）
extra_datas = [
    ('slice_standalone.py', '.'),
    ('strip_processor.py', '.'),
    ('GCodeGenerator.py', '.'),
    ('_tower_plan.py', '.'),
    ('_tower_writer.py', '.'),
    ('_tower_templates.py', '.'),
    ('fluidd_tray_monitor.py', '.'),
    ('fluidd_console_monitor.py', '.'),
    # 图标：MKPSpectrum.ico（程序窗口/EXE）+ MKPProgram.ico（.mkp 项目文件）
    (ico_path, '.'),
    (mkp_ico_path, '.'),
    # Pure Python MBD encoder calibration data
    ('mbrush_tools/mbd_calibration/white.mbd', 'mbd_calibration'),
    ('mbrush_tools/mbd_calibration/cyan_pair_y_map.json', 'mbd_calibration'),
    ('mbrush_tools/mbd_calibration/magenta_pair_y_map.json', 'mbd_calibration'),
    ('mbrush_tools/mbd_calibration/yellow_pair_y_map.json', 'mbd_calibration'),
    # Klipper 插件（可通过 GUI 一键安装到打印机）
    ('gcode_shell_command.py', '.'),
    # 校准模型
    ('calibe.glb', '.'),
]

conda_bin = os.path.join(os.path.dirname(sys.executable), 'Library', 'bin')
# 方案 B：显式收集 conda 的 ffi/libexpat/liblzma/LIBBZ2，解决 _ctypes/pyexpat/_lzma/_bz2 在 onedir 下找不到 DLL 导致 pythonnet 报错的问题
_conda_dlls = []
for _dll in ('ffi.dll', 'libexpat.dll', 'liblzma.dll', 'LIBBZ2.dll', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll'):
    _p = os.path.join(conda_bin, _dll)
    if os.path.exists(_p):
        _conda_dlls.append((_p, '.'))
a = Analysis(
    ['MKPSpectrum.py'],
    pathex=[conda_bin],
    binaries=_conda_dlls,
    datas=frontend_files + extra_datas,
    hiddenimports=[
        'webview',
        'webview.http',
        'webview.platforms.winforms',
        'slice_standalone',
        'strip_processor',
        'mbrush_tools.mbd_clone_runtime',
        'GCodeGenerator',
        '_tower_plan',
        '_tower_writer',
        '_tower_templates',
        'shapely',
        'clr',
        'PIL',
        'PIL.Image',
        'PIL.ImageDraw',
        'numpy',
        'pystray',
        'pystray._win32',
        'PIL.ImageTk',
        'websocket',
        'websocket._app',
        'fluidd_tray_monitor',
        # fluidd_tray_monitor.py 内联动态导入（PyInstaller 可能漏掉）
        'http.client',  # _handle_upload() 上传 MBD 到 mBrush
        'ctypes',       # _restore_main_window() / _show_status()
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name='MKPSpectrum',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ico_path,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='MKPSpectrum',
)
