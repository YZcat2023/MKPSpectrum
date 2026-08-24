/**
 * MKP文件格式说明
 * =================
 * .MKP 实际上是一种 ZIP 压缩格式，内部包含以下结构：
 *
 * model/          - 存放本次项目需要使用的模型文件和贴图
 *                 - 例如：1.obj, 1.mtl, texture.png 等
 *
 * position        - 记录项目中各个模型对象的使用情况
 *                 - 例如：1.obj 与 1.obj（1）都表示使用了 1.obj
 *                 - 记录每个对象的变换信息：旋转、移动、缩放
 *
 * tex/            - 存放纹理切片后生成的若干图片（与 model/ 同级）
 *                 - 用于日后的切片预览和处理
 *
 * gcode/          - 存放层积切片后生成的 Gcode 文件
 *                 - 用于 3D 打印控制
 *
 * 示例结构：
 * project.mkp
 *   ├── model/
 *   │   ├── 1.obj
 *   │   ├── 1.mtl
 *   │   └── texture.png
 *   ├── position   (JSON格式，记录模型位置、旋转、缩放)
 *   ├── tex/       (纹理切片图片)
 *   └── gcode/     (层积切片Gcode文件)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

class ModelObject {
    constructor(mesh, name, id) {
        this.mesh = mesh;
        this.name = name;
        this.id = id;
        this.visible = true;
        this.selected = false;
        this.printable = true;
        this.selectionBox = null;
        this._transformProxy = null;
        this.plateId = null; // 所属盘 id，null 表示未归属任何盘（默认归入默认盘）
        this._accumRotation = new THREE.Euler(0, 0, 0, 'XYZ');
    }
}

class GroupObject {
    constructor(mesh, name, id, children) {
        this.mesh = mesh;
        this.name = name;
        this.id = id;
        this.visible = true;
        this.selected = false;
        this.children = children || []; // 包含的模型 id 列表
        this.selectionBox = null;
        this._transformProxy = null;
    }
}

class HistoryManager {
    constructor(maxSize = 20) {
        this.history = [];
        this.currentIndex = -1;
        this.maxSize = maxSize;
    }

    setMaxSize(size) {
        this.maxSize = Math.max(1, size);
        while (this.history.length > this.maxSize) {
            this.history.shift();
            if (this.currentIndex > 0) this.currentIndex--;
        }
    }

    record(state) {
        // 创建深度拷贝，包含所有模型的变换状态
        const stateCopy = JSON.parse(JSON.stringify(state));
        
        // 如果当前不在历史末尾，删除当前位置之后的所有记录
        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }
        
        // 添加新记录
        this.history.push(stateCopy);
        
        // 如果超过最大数量，移除最旧的记录
        if (this.history.length > this.maxSize) {
            this.history.shift();
        } else {
            this.currentIndex++;
        }
        
        return this.getHistoryInfo();
    }

    undo() {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            return {
                state: JSON.parse(JSON.stringify(this.history[this.currentIndex])),
                info: this.getHistoryInfo()
            };
        }
        return null;
    }

    redo() {
        if (this.currentIndex < this.history.length - 1) {
            this.currentIndex++;
            return {
                state: JSON.parse(JSON.stringify(this.history[this.currentIndex])),
                info: this.getHistoryInfo()
            };
        }
        return null;
    }

    canUndo() {
        return this.currentIndex > 0;
    }

    canRedo() {
        return this.currentIndex < this.history.length - 1;
    }

    clear() {
        this.history = [];
        this.currentIndex = -1;
    }

    getHistoryInfo() {
        return {
            current: this.currentIndex + 1,
            total: this.history.length,
            canUndo: this.canUndo(),
            canRedo: this.canRedo()
        };
    }

    getAllHistory() {
        return this.history.map((state, index) => ({
            index,
            description: state.description || `操作 ${index + 1}`,
            timestamp: state.timestamp,
            isCurrent: index === this.currentIndex
        }));
    }
}

class BedPreview {
    constructor() {
        this._startupMkpPath = this._getStartupMkpPath();
        this.container = document.getElementById('canvas-container');
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.orbitControls = null;
        this.transformControls = null;
        this.bedMesh = null;
        this.gridHelper = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.bedSize = { x: 270, y: 270, z: 270 };
        this.gridSize = 10;
        this.showGrid = true;
        this.gridTheme = 'dark'; // 'dark' | 'light'
        this.printerAddress = '';
        this.headAddress = '';
        this.currentMode = null;
        this.isDraggingModel = false;
        this.isLayOnFaceMode = false;
        this.highlightedFace = null;
        this._triangulationOverlay = null; // 按面放平模式下整条模型的明亮三角面层

        this.models = new Map();
        this.groups = new Map();
        this.selectedGroups = new Set();
        this.selectedModels = new Set();
        this.nextModelId = 1;
        this.nextGroupId = 1;
        this.plates = new Map();      // Map<plateId, {id,name,locked,order}>
        this.nextPlateId = 1;
        this.currentPlateId = null;   // 当前显示的盘 id，null 表示默认盘
        this.plateActions = null;     // 当前激活盘对应的 3D 悬浮按钮组（THREE.Group）
        this.plateBoards = new Map(); // Map<plateId, THREE.Group> 每块盘的 3D 盘板组
        this.freePlateId = 0;         // 盘间自由区当作一个特殊盘
        this.freePlateGroup = null;   // 自由区模型容器（全局坐标，无偏移）
        this.clipboard = null;
        this.mouseDownPosition = null;

        this.historyManager = new HistoryManager();
        this.isUndoRedo = false;

        this.contextMenu = null;
        this.mirrorSubmenu = null;
        this.contextMenuTarget = null;
        this.cloneTargetId = null;
        this.modelFilePaths = new Map();

        this.isFreeDragging = false;
        this.freeDragModel = null;
        this.justFinishedTransform = false;
        this._selectedTower = null;   // 当前选中的擦料塔 mesh
        this._towerDrag = null;       // { tower, plateId } 正在拖拽的擦料塔
        this._extractDir = null;

        this.calibrateStep = 0.1;
        this.calibrateOffset = { x: 0, y: 0 };

        this.orcaSlicerPath = '';
        this.snapmakerOrcaPath = '';
        this.gcodeSlicerType = 'orcaslicer';
        this.textureResolution = 4000;
        this._rescaleDialogOpen = false;   // 尺寸过小放大询问框是否已打开（避免批量导入叠弹）
        this._savedPrintMaterials = new WeakMap(); // 材质 → 其可打印时的原始材质（避免经 userData JSON 序列化被破坏）
        this._sliceRunning = false;
        this._sliceCompleted = false;
        this._testGcodePath = '';
        this._gcode3DViewSwitching = false;  // 防止重入 switchToPreview
        this._previewImagesLoading = false;   // 防止重入 _loadPreviewFolderImages
        this._previewImagesCache = null;      // 懒加载缓存 {index: base64}
        this._headlessPollTimer = null;       // 轮询头样子进程进度的定时器
        this._headlessDone = false;           // 头样子进程已完成，防止重复处理
        this._sliceImagesCache = {};          // 切片预览图懒加载缓存 {index: base64_url}
        this._sliceLoadRequestId = 0;         // 递增请求 ID，防止过期异步回调覆盖最新视图
        this._sliceImagesCount = 0;           // 切片图片总数（用于懒加载模式）
        this._sliceImages = [];               // 切片图片文件名列表（懒加载模式）
        this._sliceFullImagesCache = {};      // 原图缓存 {index: base64_url}（缩放查看时加载）
        this._currentSliceImageIndex = 0;     // 当前显示的切片图片索引
        this._sliceZoomState = { scale: 1, panX: 0, panY: 0 };  // 缩放/平移视口状态（切层时保持不变）
        this._sliceFullLoadDebounce = null;   // 60ms 停稳后加载完整原图的定时器
        this._sliceFocusRect = null;          // 后端返回的聚焦归一化矩形（预放大缩放指导）
        this._sliceFocusApplied = false;      // 聚焦缩放是否已应用到当前预览

        // 平面打印
        // 平面打印
        this._flatImages = [];              // [{img:Image, x, y, rot, scale}]
        this._flatActiveIdx = -1;           // 当前选中图的索引
        this._flatSizeLocked = true;        // 长宽比锁定状态
        this._flatGridOn = false;           // 网格显示开关
        this._flatCanvasCtx = null;         // canvas 2D 上下文
        this._flatCtrlEl = null;            // 当前图片的角控件 DOM

        this.init();
        this.setupEventListeners();
        this.setupContextMenu();
        this.setupSettingsDialog();
        this.setupCloneDialog();
        this.setupPrinterSelect();
        this.setupPrinterDialog();
        this.renderer.domElement.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.animate();
        // 默认显示首页；双击 .mkp 启动时直接进入准备页并加载项目，避免先闪首页。
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        if (this._startupMkpPath) {
            this.switchToPrepare();
            this._loadStartupMkpProject(this._startupMkpPath);
        } else {
            setTimeout(() => {
                this.switchToHome();
            }, 50);
        }
        // 自动检测外部工具路径（方法内部有重试机制等待 pywebview API 就绪）
        this._autoDetectExternalTools();
        // 从配置文件加载已保存的偏好设置（相机模式、网格配色等）
        this._loadAndApplySettings();
    }

    _getStartupMkpPath() {
        try {
            if (window.__STARTUP_MKP_PATH) return window.__STARTUP_MKP_PATH;
            const params = new URLSearchParams(window.location.search);
            return params.get('startup_mkp') || '';
        } catch (e) {
            return '';
        }
    }

    async _loadStartupMkpProject(filePath) {
        for (let retry = 0; retry < 20; retry++) {
            if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.load_mkp_project === 'function') break;
            await new Promise(r => setTimeout(r, 100));
        }
        if (!window.pywebview || !window.pywebview.api || typeof window.pywebview.api.load_mkp_project !== 'function') {
            console.error('启动 MKP 加载失败: 后端 API 未就绪');
            return;
        }
        try {
            const result = await window.pywebview.api.load_mkp_project(filePath);
            if (!result || !result.success) {
                this.showToast('打开项目失败: ' + ((result && result.error) || '未知错误'), 'error');
                return;
            }
            this.switchToPrepare();
            this.loadProject(result.project);
            this._currentMkpPath = filePath;
            window.pywebview.api.add_recent_project(filePath).catch(() => {});
        } catch (e) {
            console.error('启动 MKP 加载异常:', e);
            this.showToast('打开项目异常: ' + e.message, 'error');
        } finally {
            document.documentElement.classList.remove('startup-mkp');
        }
    }

    init() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x2d2d3a);

        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        this.cameraMode = 'perspective'; // 默认透视视图
        this._createCamera(width, height);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.enableDamping = true;
        this.orbitControls.dampingFactor = 0.05;
        this.orbitControls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: null
        };
        this.orbitControls.enableZoom = true;
        if (this.camera.isOrthographicCamera) {
            this.orbitControls.minZoom = 0.1;
            this.orbitControls.maxZoom = 20;
        } else {
            this.orbitControls.minDistance = 10;
            this.orbitControls.maxDistance = 2000;
        }
        this.orbitControls.target.set(this.bedSize.x / 2, this.bedSize.y / 2, 0);
        this.orbitControls.update();

        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        // 缩放灵敏度系数（0-1）：调低到 0.25 让缩放更慢更易细调
        this.transformControls.scaleSpeed = 0.25;
        this.transformControls.addEventListener('dragging-changed', (event) => {
            this.orbitControls.enabled = !event.value;
            this.isDraggingModel = event.value;
        });
        this.transformControls.addEventListener('change', () => {
            this.updateTransformInputs();
        });
        // 拖拽开始只标记，不存历史（历史改为在 mouseUp 烘焙后存稳定快照）
        this.transformControls.addEventListener('mouseDown', () => {
            this._transformDragActive = true;
        });
        this.transformControls.addEventListener('mouseUp', () => {
            this._transformDragActive = false;
            this.justFinishedTransform = true;
            setTimeout(() => {
                this.justFinishedTransform = false;
            }, 100);

            // 任何变换结束后统一烘焙，把变换写进几何体顶点、proxy 重置为恒等，
            // 避免变换链累积与边界框漂移；组合体跳过烘焙保持现有行为
            this.selectedModels.forEach(id => {
                const model = this.models.get(id);
                if (!model || !model.mesh || model._groupData) return;
                this.bakeTransform(model);
            });

            // 烘焙完成后存一次稳定快照，撤销/重做都回到几何体与变换一致的状态
            this.saveState('变换模型');
        });
        this.scene.add(this.transformControls);

        this.setupLights();
        this.createBed();
        this.createGrid();

        this.initDefaultPlate();
        // 首次进入即构建当前激活盘的 3D 悬浮操作按钮组
        this.buildActivePlateActions();
        // 构建所有盘的 3D 盘板（平方布局平铺显示）
        this.rebuildAllPlateBoards();

        window.addEventListener('resize', () => this.onWindowResize());
    }

    setupLights() {
        const ambientLight = new THREE.AmbientLight(0x404040, 0.8);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
        directionalLight.position.set(200, 300, 200);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        this.scene.add(directionalLight);

        const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4);
        fillLight.position.set(-200, 100, -200);
        this.scene.add(fillLight);

        const backLight = new THREE.DirectionalLight(0xffeedd, 0.5);
        backLight.position.set(0, -300, 100);
        this.scene.add(backLight);

        const topLight = new THREE.DirectionalLight(0xffffff, 0.6);
        topLight.position.set(0, 0, 400);
        this.scene.add(topLight);

        const sideLight1 = new THREE.DirectionalLight(0xddffff, 0.4);
        sideLight1.position.set(300, 0, 150);
        this.scene.add(sideLight1);

        const sideLight2 = new THREE.DirectionalLight(0xffddff, 0.4);
        sideLight2.position.set(-300, 0, 150);
        this.scene.add(sideLight2);

        const bottomFill = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3);
        this.scene.add(bottomFill);
    }

    _createCamera(width, height) {
        const oldPos = this.camera ? this.camera.position.clone() : null;
        const oldTarget = this.orbitControls ? this.orbitControls.target.clone() : null;

        if (this.cameraMode === 'orthographic') {
            this._orthoHalfSize = Math.max(this.bedSize.x, this.bedSize.y) * 0.55;
            const aspect = width / height;
            this.camera = new THREE.OrthographicCamera(
                -this._orthoHalfSize * aspect, this._orthoHalfSize * aspect,
                this._orthoHalfSize, -this._orthoHalfSize,
                0.1, 10000
            );
        } else {
            this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
        }

        this.camera.up.set(0, 0, 1);

        if (oldPos) {
            this.camera.position.copy(oldPos);
        } else {
            // 初始位置：从斜上方俯视热床，X 对齐床中心，仅沿 Y 负方向偏移，
            // 使视口地平线与底面 X 轴（Y=0 线）平行，且方向与 fitCameraToModel 一致
            const cx = this.bedSize.x / 2;
            const cy = this.bedSize.y / 2;
            this.camera.position.set(cx, cy - this.bedSize.y * 0.3, 400);
        }

        // 首次初始化时也调用 lookAt，确保相机正确朝向
        if (oldTarget) {
            this.camera.lookAt(oldTarget);
        } else {
            this.camera.lookAt(this.bedSize.x / 2, this.bedSize.y / 2, 0);
        }

        // 更新 OrbitControls 的相机引用
        if (this.orbitControls) {
            this.orbitControls.object = this.camera;
            if (oldTarget) {
                this.orbitControls.target.copy(oldTarget);
            } else {
                this.orbitControls.target.set(this.bedSize.x / 2, this.bedSize.y / 2, 0);
            }
            if (this.camera.isOrthographicCamera) {
                this.orbitControls.minZoom = 0.1;
                this.orbitControls.maxZoom = 20;
                // 取消距离限制
                this.orbitControls.minDistance = -Infinity;
                this.orbitControls.maxDistance = Infinity;
            } else {
                this.orbitControls.minDistance = 10;
                this.orbitControls.maxDistance = 2000;
            }
            this.orbitControls.update();
        }
        // 更新 TransformControls 的相机引用
        if (this.transformControls) {
            this.transformControls.camera = this.camera;
        }
    }

    switchCameraMode(mode) {
        if (this.cameraMode === mode) return;
        this.cameraMode = mode;
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        this._createCamera(width, height);
        this.createBed();
    }

    createBed() {
        // 单块底层已由各盘的立体板取代：不再创建单独的 bedMesh/bedEdges，避免与盘1板重复重叠
        if (this.bedMesh) {
            this.scene.remove(this.bedMesh);
            this.bedMesh = null;
        }
        if (this.bedEdges) {
            this.scene.remove(this.bedEdges);
            this.bedEdges = null;
        }
    }

    createGrid() {
        // 每块盘板已自带网格线：不再创建单独的 gridHelper
        if (this.gridHelper) {
            this.scene.remove(this.gridHelper);
            this.gridHelper = null;
        }
    }

    updateBedSize() {
        this.createBed();
        this.createGrid();
    }

    updateGrid() {
        this.createGrid();
    }

    async loadModelFromBackend() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }
        try {
            const fileInfo = await window.pywebview.api.open_file_dialog();
            if (!fileInfo) return;
            const result = await window.pywebview.api.load_model(fileInfo);
            if (!result || !result.success) {
                this.showToast('加载失败: ' + (result ? result.error : '无返回'), 'error');
                return;
            }
            const name = fileInfo.name || `模型 ${this.nextModelId}`;
            const filePath = fileInfo.path || fileInfo.file_path;
            switch (result.type) {
                case 'stl':
                    this.loadSTL(result.data, name, filePath);
                    break;
                case 'obj':
                    this.loadOBJ(result, name, filePath);
                    break;
                case 'gltf':
                case 'glb':
                    this.loadGLTF(result.data, name, filePath);
                    break;
                case 'fbx':
                    this.loadFBX(result.data, name, filePath);
                    break;
            }
        } catch (e) {
            console.error('加载模型异常:', e);
            this.showToast('加载异常: ' + e.message, 'error');
        }
    }

    async loadGcodeFromBackend() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }
        try {
            const fileInfo = await window.pywebview.api.open_file_dialog(
                ['GCode Files (*.gcode)', 'All files (*.*)']
            );
            if (!fileInfo) return;
            await this._onGcodeDropped(fileInfo.path);
        } catch (e) {
            console.error('导入 GCode 异常:', e);
            this.showToast('导入异常: ' + e.message, 'error');
        }
    }

    loadSTL(dataUrl, name, filePath = null) {
        const loader = new STLLoader();
        loader.load(dataUrl, (geometry) => {
            this.addModel(geometry, name, filePath);
        });
    }

    loadGLTF(dataUrl, name, filePath = null) {
        const loader = new GLTFLoader();
        loader.load(dataUrl, (gltf) => {
            this.addModelObject(gltf.scene, name, filePath);
        });
    }

    loadOBJ(result, name, filePath = null) {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
            const cleanUrl = url.split('/').pop().split('\\').pop();
            return result.textures[cleanUrl] || url;
        });
        const objLoader = new OBJLoader(manager);
        objLoader.load(result.obj, (object) => {
            if (result.mtl) {
                const mtlLoader = new MTLLoader(manager);
                mtlLoader.load(result.mtl, (materials) => {
                    materials.preload();
                    object.traverse((child) => {
                        if (child.isMesh) {
                            const matName = child.material.name;
                            if (materials.materials[matName]) {
                                child.material = materials.materials[matName];
                            }
                        }
                    });
                    this.addModelObject(object, name, filePath);
                }, undefined, () => {
                    this.addModelObject(object, name, filePath);
                });
            } else {
                this.addModelObject(object, name, filePath);
            }
        });
    }

    loadFBX(dataUrl, name, filePath = null) {
        const loader = new FBXLoader();
        loader.load(dataUrl, (fbx) => {
            this.addModelObject(fbx, name, filePath);
        });
    }

    addModel(geometry, name, filePath = null) {
        geometry.computeBoundingBox();
        const minZ = geometry.boundingBox.min.z;
        const center = geometry.boundingBox.getCenter(new THREE.Vector3());
        // 放在所盘板的中心（局部原点），模型站到该盘板正中央
        geometry.translate(-center.x, -center.y, -minZ);
        // translate 后包围盒已过期，必须重算，否则后续 Box3.setFromObject 会用错旧包围盒
        geometry.computeBoundingBox();
        if (geometry.computeBoundingSphere) geometry.computeBoundingSphere();

        const material = new THREE.MeshStandardMaterial({
            color: 0x4a9eff,
            metalness: 0.3,
            roughness: 0.4,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.isModel = true;
        mesh.userData.modelId = this.nextModelId;

        const modelId = this.nextModelId++;
        const modelName = name || `模型 ${modelId}`;
        const modelObj = new ModelObject(mesh, modelName, modelId);

        modelObj.plateId = this.currentPlateId;
        this.models.set(modelId, modelObj);
        // 模型 = 项目全局子节点（scene），保持唯一 ID 与全局坐标；
        // plateId 仅标记它归属哪个盘（逻辑），显示时按归属盘定位。
        this.scene.add(mesh);
        // 放到所属盘中心，局部原点 = 盘左下角，居中于 (halfW, halfD)
        const centre = this._getPlateWorldPos(modelObj.plateId || this.freePlateId);
        mesh.position.set(centre.x, centre.y, 0);
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
        // 计算该盘容器把世界中心映射回局部（用于局部显示参照）——模型本身保持 scene 全局
        modelObj.worldAnchor = { x: centre.x, y: centre.y };

        if (filePath) {
            this.modelFilePaths.set(modelId, filePath);
        }

        this._invalidateHullCache(modelObj);
        this.updateObjectList();
        this.saveState('导入模型');
        // 不自动移动视口（保持用户当前视角）
        this.updatePlateTowerHeights();

        // 导入即烘焙一次（等价“缩放 ×1”）：把世界变换锁定进几何，
        // 避免后续“按面放平”在未烘焙/position 飘逸时以全局原点为旋转枢轴而失效。
        // 烘焙后必须再把模型水平居中到所属盘中心并贴床，否则模型会停在不居中的位置。
        if (!modelObj._groupData && modelObj.mesh) {
            this.bakeTransform(modelObj);
            this._seatModelInBed(modelObj);
        }
        // 若尺寸过小，自动询问是否放大
        this.askRescaleSmallModel(modelId);
    }

    addModelObject(object, name, filePath = null, options = {}) {
        const preserveProjectTransform = !!options.preserveProjectTransform;
        const projectLoad = !!options.projectLoad;
        let target = this._getPlateWorldPos(this.currentPlateId || this.freePlateId);

        if (!preserveProjectTransform) {
            // 先刷新待导入对象的世界矩阵，保证 Box3 计算准确（特别是大尺寸/远离原点的模型）
            object.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(object);
            // 居中：对象根置于所属盘中心（场景全局坐标）
            const centre = box.getCenter(new THREE.Vector3());
            object.position.x = target.x - centre.x;
            object.position.y = target.y - centre.y;
            object.position.z = (box.max.z - box.min.z) / 2 - centre.z;
            object.updateMatrix();
            object.updateMatrixWorld(true);
        } else {
            object.updateMatrixWorld(true);
        }

        const modelId = this.nextModelId++;

        object.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                child.userData.isModel = true;
                child.userData.modelId = modelId;

                // 修复 MTL 中 d/Tr 导致的不必要半透明问题
                // 如果 opacity >= 1 但 material 被标记为 transparent，恢复为不透明
                if (child.material) {
                    const materials = Array.isArray(child.material) ? child.material : [child.material];
                    for (const mat of materials) {
                        if (mat.transparent && mat.opacity >= 1.0) {
                            mat.transparent = false;
                            mat.depthWrite = true;
                            mat.needsUpdate = true;
                        }
                    }
                }
            }
        });
        object.userData.isModel = true;
        object.userData.modelId = modelId;

        const modelName = name || `模型 ${modelId}`;
        const modelObj = new ModelObject(object, modelName, modelId);

        modelObj.plateId = this.currentPlateId;
        this.models.set(modelId, modelObj);
        // 模型 = 项目全局子节点（scene），保持唯一 ID 与全局坐标；plateId 为逻辑归属。
        this.scene.add(object);
        modelObj.worldAnchor = { x: target.x, y: target.y };

        if (filePath) {
            this.modelFilePaths.set(modelId, filePath);
        }

        // 确保新导入对象的几何包围与世界矩阵已就绪，再清凸包缓存并排盘
        object.updateMatrixWorld(true);
        this._invalidateHullCache(modelObj);
        this.updateObjectList();
        if (!preserveProjectTransform && !projectLoad) this.saveState('导入模型');
        // 不自动移动视口（保持用户当前视角）
        this.updatePlateTowerHeights();

        // 普通导入才做自动烘焙/贴床；项目加载已有保存位姿，不能再次自动摆放。
        if (!preserveProjectTransform && !modelObj._groupData && modelObj.mesh) {
            this.bakeTransform(modelObj);
            this._seatModelInBed(modelObj);
        }
        // 若尺寸过小，自动询问是否放大
        if (!preserveProjectTransform && !projectLoad) this.askRescaleSmallModel(modelId);
    }

updateObjectList() {
        const listContainer = document.getElementById('objects-list');
        const countElement = document.getElementById('object-count');
        const modelCountElement = document.getElementById('model-count');
        const selectionCountElement = document.getElementById('selection-count');

        const total = this.models.size;
        // 当前盘上的对象数（用于对象列表计数与展示）
        const onPlate = Array.from(this.models.entries()).filter(([, m]) =>
            this._isOnCurrentPlate(m)
        );
        const curPlateName = this.currentPlateId ? (this.plates.get(this.currentPlateId)?.name || '默认盘') : '默认盘';
        if (countElement) countElement.textContent = `${onPlate.length} 个对象`;
        if (modelCountElement) modelCountElement.textContent = this.models.size;
        if (selectionCountElement) selectionCountElement.textContent = this.selectedModels.size;

        listContainer.innerHTML = '';
        
        if (onPlate.length === 0) {
            listContainer.innerHTML = `<div class="objects-empty">${curPlateName} 暂无对象</div>`;
            return;
        }

        // 仅渲染当前盘上的模型（包括组合体）
        onPlate.forEach(([, model]) => {
            const isGroup = !!model._groupData;
            const item = document.createElement('div');
            item.className = `object-item ${isGroup ? 'object-group' : ''} ${model.selected ? 'selected' : ''}`;
            item.dataset.id = model.id;
            // 锁定盘上的对象显示只读样式
            if (this.isModelLocked(model.id)) item.classList.add('locked');
            
            if (isGroup) {
                // 组合体：显示组图标和解组按钮
                item.innerHTML = `
                    <div class="object-icon group-icon">
                        <svg viewBox="0 0 24 24" width="16" height="16">
                            <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" opacity="0.5"/>
                            <rect x="13" y="3" width="8" height="8" rx="1" fill="currentColor" opacity="0.5"/>
                            <rect x="3" y="13" width="8" height="8" rx="1" fill="currentColor" opacity="0.5"/>
                            <rect x="13" y="13" width="8" height="8" rx="1" fill="currentColor"/>
                        </svg>
                    </div>
                    <span class="object-name">${model.name}</span>
                    <button class="object-printable-btn ${model.printable ? 'printable-yes' : 'printable-no'}"
                            title="${model.printable ? '点击设为不可打印' : '点击设为可打印'}">
                        <svg viewBox="0 0 24 24" width="14" height="14">
                            <path fill="currentColor" d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/>
                        </svg>
                    </button>
                    <button class="object-ungroup-btn" title="解组">
                        <svg viewBox="0 0 24 24" width="14" height="14">
                            <path fill="currentColor" d="M3 3h8v8H3V3zm0 10h8v8H3v-8zM13 3h8v8h-8V3zm0 10h8v8h-8v-8z" opacity="0.6"/>
                        </svg>
                    </button>
                    <button class="object-delete" title="删除">
                        <svg viewBox="0 0 24 24" width="14" height="14">
                            <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                `;
            } else {
                item.innerHTML = `
                    <div class="object-icon">
                        <svg viewBox="0 0 24 24" width="16" height="16">
                            <path fill="currentColor" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                        </svg>
                    </div>
                    <span class="object-name">${model.name}</span>
                    <button class="object-printable-btn ${model.printable ? 'printable-yes' : 'printable-no'}"
                            title="${model.printable ? '点击设为不可打印' : '点击设为可打印'}">
                        <svg viewBox="0 0 24 24" width="14" height="14">
                            <path fill="currentColor" d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/>
                        </svg>
                    </button>
                    <button class="object-delete" title="删除">
                        <svg viewBox="0 0 24 24" width="14" height="14">
                            <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                `;
            }
            
            item.addEventListener('click', (e) => {
                if (e.target.closest('.object-printable-btn') || e.target.closest('.object-delete') || e.target.closest('.object-ungroup-btn')) return;
                this.selectModelById(model.id, !e.ctrlKey && !e.metaKey);
            });

            // 点击打印按钮切换可打印状态（锁定盘不可操作）
            const printBtn = item.querySelector('.object-printable-btn');
            if (printBtn) {
                if (this.isModelLocked(model.id)) {
                    printBtn.style.opacity = '0.4';
                    printBtn.style.pointerEvents = 'none';
                } else {
                    printBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.toggleModelPrintable(model.id);
                    });
                }
            }

            // 右键菜单
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isModelLocked(model.id)) return;
                // 选中该模型
                this.selectModelById(model.id, true);
                this._showListContextMenu(e, model);
            });

            item.querySelector('.object-delete').addEventListener('click', () => {
                this.deleteModelById(model.id);
            });
            const ungroupBtn = item.querySelector('.object-ungroup-btn');
            if (ungroupBtn) {
                ungroupBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // 先选中再解组
                    if (!model.selected) {
                        this.selectModelById(model.id, true);
                    }
                    this.ungroupSelected();
                });
            }

            // 先追加组合体大标签，其零件列表显示在下方
            listContainer.appendChild(item);

            // 组合体下方显示零件列表
            if (isGroup && model._groupData && model._groupData.parts) {
                model._groupData.parts.forEach((part, idx) => {
                    const childItem = document.createElement('div');
                    childItem.className = 'object-item object-child';
                    childItem.innerHTML = `
                        <div class="object-icon child-icon">
                            <svg viewBox="0 0 24 24" width="12" height="12">
                                <circle cx="12" cy="12" r="4" fill="currentColor"/>
                            </svg>
                        </div>
                        <span class="object-name">${part.name || '零件 ' + (idx + 1)}</span>
                    `;
                    childItem.style.paddingLeft = '32px';
                    childItem.style.fontSize = '12px';
                    childItem.style.opacity = '0.7';
                    childItem.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.selectModelById(model.id, !e.ctrlKey && !e.metaKey);
                    });
                    listContainer.appendChild(childItem);
                });
            }
        });
    }

    selectModelById(modelId, clearOthers = true) {
        const model = this.models.get(modelId);
        if (!model) return;

        // 锁定盘上的对象不可选中/编辑
        if (this.isModelLocked(modelId)) {
            if (model.selected) {
                this.selectedModels.delete(modelId);
                model.selected = false;
                this.deselectModelInternal(model);
            }
            this.showToast('该对象所在盘已锁定，无法编辑', 'warning');
            return;
        }

        if (clearOthers) {
            this.selectedModels.forEach(id => {
                const m = this.models.get(id);
                if (m) {
                    m.selected = false;
                    this.deselectModelInternal(m);
                }
            });
            this.selectedModels.clear();
        }

        if (this.selectedModels.has(modelId)) {
            this.selectedModels.delete(modelId);
            model.selected = false;
            this.deselectModelInternal(model);
        } else {
            this.selectedModels.add(modelId);
            model.selected = true;
            this.selectModelInternal(model);
        }

        this.updateObjectList();
        this.updateTransformPanel();
    }

    selectGroupById(groupId, clearOthers = true) {
        const group = this.groups.get(groupId);
        if (!group) return;

        if (clearOthers) {
            // 取消选中所有模型
            this.selectedModels.forEach(id => {
                const m = this.models.get(id);
                if (m) {
                    m.selected = false;
                    this.deselectModelInternal(m);
                }
            });
            this.selectedModels.clear();
            // 取消选中其他组
            this.selectedGroups.forEach(id => {
                const g = this.groups.get(id);
                if (g) g.selected = false;
            });
            this.selectedGroups.clear();
        }

        if (this.selectedGroups.has(groupId)) {
            this.selectedGroups.delete(groupId);
            group.selected = false;
        } else {
            this.selectedGroups.add(groupId);
            group.selected = true;
        }

        this.updateObjectList();
        this.updateTransformPanel();
    }

    deleteGroupById(groupId) {
        const group = this.groups.get(groupId);
        if (!group) return;

        this.saveState();

        if (group.selected) {
            this.selectedGroups.delete(groupId);
        }

        // 从场景移除 THREE.Group
        this.scene.remove(group.mesh);

        // 从 groups Map 中删除
        this.groups.delete(groupId);

        this.updateObjectList();
        this.updateTransformPanel();
    }

    /** 根据子模型 id 查找所属的组合体 */
    _findGroupByChildId(modelId) {
        let foundGroup = null;
        this.groups.forEach((group) => {
            if (group.children && group.children.includes(modelId)) {
                foundGroup = group;
            }
        });
        return foundGroup;
    }

    selectModelInternal(model) {
        const box = new THREE.Box3().setFromObject(model.mesh);
        const center = box.getCenter(new THREE.Vector3());

        // 正确获取世界空间的 position / quaternion / scale
        const worldPosition = new THREE.Vector3();
        model.mesh.getWorldPosition(worldPosition);
        const worldQuat = new THREE.Quaternion();
        model.mesh.getWorldQuaternion(worldQuat);
        const worldScale = new THREE.Vector3();
        model.mesh.getWorldScale(worldScale);

        if (!model._transformProxy) {
            model._transformProxy = new THREE.Object3D();
            this.scene.add(model._transformProxy);
        }

        // 将偏移量转换到 proxy 的局部坐标系中，以正确保留 mesh 的世界位置
        const invQuat = new THREE.Quaternion().copy(worldQuat).invert();
        const invScale = new THREE.Vector3(1 / worldScale.x, 1 / worldScale.y, 1 / worldScale.z);
        const offset = new THREE.Vector3().copy(worldPosition).sub(center);
        offset.applyQuaternion(invQuat);
        offset.multiply(invScale);

        model._transformProxy.position.copy(center);
        model._transformProxy.quaternion.copy(worldQuat);
        model._transformProxy.scale.copy(worldScale);

        model._transformProxy.add(model.mesh);
        model.mesh.position.copy(offset);
        model.mesh.quaternion.identity();
        model.mesh.scale.set(1, 1, 1);

        model._transformProxy.updateMatrixWorld(true);

        if (this.selectedModels.size === 1 && this.currentMode !== null && !this.isModelLocked(model.id)) {
            // 校准模型只允许旋转，若当前为非旋转模式则强制切换
            if (model._isCalibration && this.currentMode !== 'rotate') {
                this.currentMode = 'rotate';
                this.transformControls.setMode('rotate');
                this.updateModeButtons();
            }
            this.transformControls.attach(model._transformProxy);
        } else {
            this.transformControls.detach();
        }

        this.createSelectionBox(model);
    }

    deselectModelInternal(model) {
        if (model._transformProxy && model.mesh.parent === model._transformProxy) {
            const worldPosition = new THREE.Vector3();
            const worldQuaternion = new THREE.Quaternion();
            const worldScale = new THREE.Vector3();
            model.mesh.getWorldPosition(worldPosition);
            model.mesh.getWorldQuaternion(worldQuaternion);
            model.mesh.getWorldScale(worldScale);

            model._transformProxy.remove(model.mesh);
            // 模型是场景全局子节点，回到 scene（保持世界坐标）
            this.scene.add(model.mesh);
            model.mesh.position.copy(worldPosition);
            model.mesh.quaternion.copy(worldQuaternion);
            model.mesh.scale.copy(worldScale);
        }

        if (this.selectedModels.size === 0) {
            this.transformControls.detach();
        }

        this.removeSelectionBox(model);
    }

    createSelectionBox(model) {
        this.removeSelectionBox(model);
        if (!model.mesh) return;

        model.mesh.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model.mesh);
        const min = box.min, max = box.max;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        // 角部短线的长度：取长方体最短边的 16%（只画角部三叉，不整圈框选）
        const len = Math.min(size.x, size.y, size.z) * 0.16;

        // 坐标用相对中心的局部坐标，这样 selectionBox.position = center 时正好贴合模型，
        // 不会因为几何已是世界坐标 + 再 set position 而把框挪到远离模型的地方。
        const positions = [];
        const corners = [
            [min.x, min.y, min.z], [max.x, min.y, min.z],
            [max.x, max.y, min.z], [min.x, max.y, min.z],
            [min.x, min.y, max.z], [max.x, min.y, max.z],
            [max.x, max.y, max.z], [min.x, max.y, max.z]
        ];
        for (const c of corners) {
            const cx = c[0] - center.x, cy = c[1] - center.y, cz = c[2] - center.z;
            // 该角在 x/y/z 上是 min 还是 max，决定三条棱向外延伸的方向
            const dx = Math.abs(c[0] - min.x) < 1e-6 ? 1 : -1;
            const dy = Math.abs(c[1] - min.y) < 1e-6 ? 1 : -1;
            const dz = Math.abs(c[2] - min.z) < 1e-6 ? 1 : -1;
            for (const [vx, vy, vz] of [[dx, 0, 0], [0, dy, 0], [0, 0, dz]]) {
                positions.push(cx, cy, cz, cx + vx * len, cy + vy * len, cz + vz * len);
            }
        }

        // 用 LineSegments2：每对 start/end 作为独立线段，不会把各角连成奇怪线条
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        const material = new LineMaterial({
            color: 0xffffff,
            linewidth: 4,
            transparent: true,
            opacity: 0.9,
            depthWrite: false
        });
        if (this.renderer) {
            const c = this.renderer.domElement;
            material.resolution.set(c.width, c.height);
        }

        model.selectionBox = new LineSegments2(geometry, material);
        model.selectionBox.position.copy(center);
        this.scene.add(model.selectionBox);
    }

    removeSelectionBox(model) {
        if (model.selectionBox) {
            this.scene.remove(model.selectionBox);
            model.selectionBox.geometry.dispose();
            model.selectionBox.material.dispose();
            model.selectionBox = null;
        }
    }

    updateSelectionBoxes() {
        this.selectedModels.forEach(id => {
            const model = this.models.get(id);
            if (model) {
                this.removeSelectionBox(model);
                this.createSelectionBox(model);
            }
        });
    }

    toggleModelVisibility(modelId) {
        const model = this.models.get(modelId);
        if (!model) return;
        model.visible = !model.visible;
        model.mesh.visible = model.visible;
        if (model.selectionBox) {
            model.selectionBox.visible = model.visible;
        }
        this.updateObjectList();
    }

    deleteModelById(modelId) {
        const model = this.models.get(modelId);
        if (!model) return;

        // 锁定盘上的对象不可删除
        if (this.isModelLocked(modelId)) {
            this.showToast('该对象所在盘已锁定，无法删除', 'warning');
            return;
        }

        this.saveState();
        this._deleteModelUnchecked(modelId);
        this.updateObjectList();
        this.updateTransformPanel();
    }

    // 无任何守卫/确认的内部删除，供删除盘时批量调用
    _deleteModelUnchecked(modelId) {
        const model = this.models.get(modelId);
        if (!model) return;

        // 如果删除的是校准模型，恢复按钮状态
        if (model._isCalibration) {
            const btn = document.getElementById('btn-calibrate');
            btn?.classList.remove('calib-active');
        }

        if (model.selected) {
            this.selectedModels.delete(modelId);
            this.deselectModelInternal(model);
        }

        this.removeSelectionBox(model);
        if (model._transformProxy) {
            this.scene.remove(model._transformProxy);
            model._transformProxy = null;
        }
        if (model.mesh) {
            if (model.mesh.parent) model.mesh.parent.remove(model.mesh);
            else this.scene.remove(model.mesh);
        }
        this.models.delete(modelId);
        this.updatePlateTowerHeights();
    }

    clearAllModels() {
        this.saveState();
        this.models.forEach((model) => {
            this.removeSelectionBox(model);
            if (model._transformProxy) {
                this.scene.remove(model._transformProxy);
                model._transformProxy = null;
            }
            if (model.mesh) {
                if (model.mesh.parent) model.mesh.parent.remove(model.mesh);
                else this.scene.remove(model.mesh);
            }
        });
        this.models.clear();
        this.selectedModels.clear();
        this.transformControls.detach();
        this.updateObjectList();
        this.updateTransformPanel();
        // 不再调用 historyManager.clear()：开头的 saveState 已记录清空前状态，
        // 清空本身应可撤销；clear() 会把刚存的快照一起抹掉，导致无法撤销
        this.updateUndoRedoButtons();

        // 清除校准按钮状态
        const calibBtn = document.getElementById('btn-calibrate');
        calibBtn?.classList.remove('calib-active');

        // 清理 MKP 临时目录
        this._cleanupExtractDir();

        // 清理分组/路径/交互残留，避免切新项目后仍带旧状态
        if (this.groups) {
            this.groups.forEach((g) => {
                if (g.mesh && g.mesh.parent) g.mesh.parent.remove(g.mesh);
                else if (g.mesh) this.scene.remove(g.mesh);
            });
            this.groups.clear();
        }
        if (this.selectedGroups) this.selectedGroups.clear();
        if (this.modelFilePaths) this.modelFilePaths.clear();
        this.clipboard = null;
        this._selectedTower = null;
        this._towerDrag = null;
        this._hideTowerSelection();
        if (this.freePlateGroup) {
            // 自由区容器仅为逻辑容器，不带模型时可一并清理以确保重建
            if (this.freePlateGroup.parent) this.freePlateGroup.parent.remove(this.freePlateGroup);
            this.freePlateGroup = null;
        }
        this.nextModelId = 1;
        this.nextGroupId = 1;

        // 清理切片 / 预览残留，避免新建/打开新项目后仍显示旧 GCode
        this._lastGcode = null;
        this._sliceImages = [];
        this._sliceImagesCache = {};
        this._sliceImagesCount = 0;
        this._sliceFullImagesCache = {};
        this._sliceCompleted = false;
        this._testGcodePath = '';
        this._hideSliceProgress();
        this._disposeGcode3DView();

        // 清理平面打印残留
        this._flatImages = [];
        this._flatActiveIdx = -1;
        this._flatDrag = null;

        // 重置盘（新建默认盘并设为当前盘）
        this.resetPlates();
        if (this.scene) this.rebuildAllPlateBoards();
        this.renderPlates();
        this.buildActivePlateActions();
        this.updatePlateBoardOpacity();

        // 重置项目路径，下次保存时弹出保存对话框
        this._currentMkpPath = null;
    }

    newProject() {
        const hasContent = this.models.size > 0 || this.plates.size > 1 || !!this._currentMkpPath || !!this._lastGcode;
        const doReset = () => {
            this.clearAllModels();
            this.switchToPrepare();
        };
        if (hasContent) {
            this.showConfirm('新建项目', '当前项目将被清空且不可撤销地回到默认盘，是否继续？', () => doReset(), '新建');
        } else {
            doReset();
        }
    }

    // ---------- 盘（构建板）管理 ----------

    initDefaultPlate() {
        this.resetPlates();
        this.renderPlates();
    }

    resetPlates() {
        this.plates.clear();
        this.removePlateActions();
        this.clearPlateBoards();
        const defaultId = this.nextPlateId++;
        this.plates.set(defaultId, { id: defaultId, name: '盘 1', locked: false, order: 1 });
        this.currentPlateId = defaultId;
    }

    // ---------- 3D 盘板（每块盘一块矩形网格板，平方布局平铺） ----------

    clearPlateBoards() {
        if (!this.scene) return;
        this.plateBoards.forEach((group) => {
            // 先把误挂在盘板模型容器下的模型子节点移回 scene（保持世界坐标），
            // 否则清空盘板会把模型一起带走，导致模型消失（点侧边栏选中又重新出现）
            const container = group.userData && group.userData.modelContainer;
            if (container) {
                const toRescue = [];
                container.children.forEach((obj) => {
                    if (obj.userData && obj.userData.isModel) toRescue.push(obj);
                });
                toRescue.forEach((obj) => this._rescueModelToScene(obj));
            }
            this.scene.remove(group);
            // 释放网格板几何
            group.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
        });
        this.plateBoards.clear();
    }

    // 把误挂在盘板容器下的模型恢复为 scene 全局子节点，保持世界坐标不变
    _rescueModelToScene(obj) {
        if (!this.scene || !obj) return;
        if (obj.parent) obj.parent.remove(obj);
        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        const ws = new THREE.Vector3();
        obj.getWorldPosition(wp);
        obj.getWorldQuaternion(wq);
        obj.getWorldScale(ws);
        this.scene.add(obj);
        obj.position.copy(wp);
        obj.quaternion.copy(wq);
        obj.scale.copy(ws);
        obj.updateMatrixWorld(true);
    }

    // 计算平方布局：第 index 个盘(从0)应放的列/行格位
    _plateGridPos(index) {
        const total = this.plates.size;
        const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
        const col = index % cols;
        const row = Math.floor(index / cols);
        return { cols, col, row };
    }

    // 计算某盘的世界中心坐标（按 order 定位其在平方布局中的格位）
    _getPlateWorldPos(plateId) {
        if (!this.plates.has(plateId)) return { x: this.bedSize.x / 2, y: this.bedSize.y / 2 };
        const sorted = Array.from(this.plates.values()).sort((a, b) => a.order - b.order);
        const index = sorted.findIndex((p) => p.id === plateId);
        if (index < 0) return { x: this.bedSize.x / 2, y: this.bedSize.y / 2 };
        const g = this._plateGridPos(index);
        const gap = 40;
        const cellW = this.bedSize.x + gap;
        const cellD = this.bedSize.y + gap;
        const centerX = this.bedSize.x / 2;
        const centerD = this.bedSize.y / 2;
        return {
            x: centerX + g.col * cellW,
            y: centerD - g.row * cellD,
        };
    }

    // 返回某盘（或自由区）的模型容器；自由区 = 全局坐标、无偏移
    _plateContainerFor(plateId) {
        if (plateId && this.plateBoards && this.plateBoards.has(plateId)) {
            const g = this.plateBoards.get(plateId);
            if (g && g.userData.modelContainer) return g.userData.modelContainer;
        }
        // 自由区（或未找到盘）：放入全局自由区容器
        if (!this.freePlateGroup) {
            this.freePlateGroup = new THREE.Group();
            this.scene.add(this.freePlateGroup);
        }
        return this.freePlateGroup;
    }

    // 新建盘后把视口居中并缩放到所有盘的整体范围（视角方向保持），以便看清全部盘
    _centerViewportOnAllPlates() {
        if (!this.camera || !this.orbitControls) return;
        if (!this.plates || this.plates.size === 0) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const halfW = this.bedSize.x / 2;
        const halfD = this.bedSize.y / 2;
        this.plates.forEach((_, pid) => {
            const c = this._getPlateWorldPos(pid);
            minX = Math.min(minX, c.x - halfW);
            maxX = Math.max(maxX, c.x + halfW);
            minY = Math.min(minY, c.y - halfD);
            maxY = Math.max(maxY, c.y + halfD);
        });
        const width = Math.max((maxX - minX), (maxY - minY));
        const newCenter = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, 0);
        const target = this.orbitControls.target;

        // 平移：相机与 target 一起移动，保持角度与方向
        const dx = newCenter.x - target.x;
        const dy = newCenter.y - target.y;
        this.camera.position.x += dx;
        this.camera.position.y += dy;
        target.copy(newCenter);

        if (this.camera.isOrthographicCamera) {
            // 正交：把 orthoHalfSize 调到能容纳全部盘
            const aspect = this.container ? this.container.clientWidth / this.container.clientHeight : 1;
            this._orthoHalfSize = (width / 2) * 1.1;
            this.camera.left = -this._orthoHalfSize * aspect;
            this.camera.right = this._orthoHalfSize * aspect;
            this.camera.top = this._orthoHalfSize;
            this.camera.bottom = -this._orthoHalfSize;
            this.camera.updateProjectionMatrix();
        } else {
            // 透视：沿当前视线方向重新定距
            const dir = new THREE.Vector3().subVectors(this.camera.position, target).normalize();
            const fov = this.camera.fov * Math.PI / 180;
            const fitted = (width / 2) / Math.tan(fov / 2) * 1.15;
            const lookDir = dir.clone();
            this.camera.position.copy(target).add(lookDir.multiplyScalar(fitted));
            this.camera.lookAt(target);
        }
        this.orbitControls.update();
    }

    // 把模型从当前父节点（可能是 scene/proxy）重挂到目标盘容器，保持世界坐标不变（转为局部坐标）
    _reparentModelToPlate(model, plateId) {
        const container = this._plateContainerFor(plateId);
        const obj = model.mesh;
        // 若在 proxy 下，先解出代理，保持世界位姿
        if (model._transformProxy && obj.parent === model._transformProxy) {
            model._transformProxy.remove(obj);
        }
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScl = new THREE.Vector3();
        obj.getWorldPosition(worldPos);
        obj.getWorldQuaternion(worldQuat);
        obj.getWorldScale(worldScl);
        if (obj.parent) obj.parent.remove(obj);
        container.add(obj);
        // 保持世界位姿不变：position 转为容器局部坐标
        container.updateMatrixWorld(true);
        const localPos = container.worldToLocal(worldPos.clone());
        obj.position.copy(localPos);
        obj.quaternion.copy(worldQuat);
        obj.scale.copy(worldScl);
        model.plateId = plateId;
        obj.updateMatrixWorld(true);
    }

    _reparentAllModelsToPlates() {
        this.models.forEach((model) => {
            const target = model.plateId || this.freePlateId;
            // 若已经在正确容器则跳过
            const cur = model.mesh.parent;
            const container = this._plateContainerFor(model.plateId || this.freePlateId);
            let ok = false;
            if (cur && container) {
                // 检查 cur 是否等于 container（通过 userData 或引用）
                ok = cur === container ||
                    (cur.userData && cur.userData.isContainer && container.userData && container.userData.isContainer && cur === container);
            }
            if (!ok) {
                this._reparentModelToPlate(model, model.plateId || this.freePlateId);
            }
        });
    }

    // 当前激活盘的擦料塔位置 = 该盘中心 ＋ 已拖拽的塔偏移（方块位置即擦嘴塔位置）
    _getCurrentPlateTowerPos() {
        const p = this._getPlateWorldPos(this.currentPlateId);
        let ox = 0, oy = 0;
        const g = this.plateBoards && this.plateBoards.get(this.currentPlateId);
        const towerMesh = g && g.userData && g.userData.towerMesh;
        if (towerMesh && towerMesh.userData && towerMesh.userData.offset) {
            ox = towerMesh.userData.offset.x || 0;
            oy = towerMesh.userData.offset.y || 0;
        }
        return { x: p.x + ox, y: p.y + oy };
    }

    // 根据模型世界中心的位置归属：落在某个盘范围内→归属该盘；否则→自由区
    _assignModelToPlateByPosition(model) {
        if (!model || !model.mesh) return;
        model.mesh.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model.mesh);
        const c = box.getCenter(new THREE.Vector3());
        // 计算所有盘世界包围盒，找模型中心所在的盘
        let target = this.freePlateId;
        if (this.plateBoards && this.plates) {
            const sorted = Array.from(this.plates.values()).sort((a, b) => a.order - b.order);
            for (let i = 0; i < sorted.length; i++) {
                const plate = sorted[i];
                const centre = this._getPlateWorldPos(plate.id);
                const halfW = this.bedSize.x / 2;
                const halfD = this.bedSize.y / 2;
                if (c.x >= centre.x - halfW && c.x <= centre.x + halfW &&
                    c.y >= centre.y - halfD && c.y <= centre.y + halfD) {
                    target = plate.id;
                    break;
                }
            }
        }
        const cur = model.plateId || this.freePlateId;
        if (target !== cur) {
            model.plateId = target;
            // 模型是世界坐标+全局ID，归属只改逻辑 plateId，不重挂父节点（避免坐标崩溃）
            this.updateObjectList();
        }
    }

    // 为第 index 个盘创建底部立体板：每块盘就是一块与底部黑色立体板一模一样的板子，
    // 板面上带有网格线，按平方布局沿地面平铺。选中盘的外勾线为白色高亮。
    _createPlateBoard(plateId, index) {
        const plate = this.plates.get(plateId);
        if (!plate || !this.scene) return;
        const g = this._plateGridPos(index);

        const boardW = this.bedSize.x;
        const boardD = this.bedSize.y;
        const thickness = 5;
        const gap = 40;
        const cellW = boardW + gap;
        const cellD = boardD + gap;

        // 第 0 块板居中于床面中心，其余按平方布局向右/向下铺开
        const centerX = this.bedSize.x / 2;
        const centerD = this.bedSize.y / 2;
        const worldX = centerX + g.col * cellW;
        const worldD = centerD - g.row * cellD; // 行往下，y 减小

        const group = new THREE.Group();
        group.userData.plateId = plateId;
        // 该盘的模型容器：模型作为其子节点，局部坐标 = 相对盘板【左下角】；容器世界位置 = 盘左下角。
        const modelContainer = new THREE.Group();
        modelContainer.userData.isContainer = true;
        modelContainer.position.set(worldX - boardW / 2, worldD - boardD / 2, 0);
        group.add(modelContainer);
        group.userData.modelContainer = modelContainer;

        // 黑色立体板（与 createBed 样式一致）。未激活的板带透明度，激活板不透明，无高光。
        const isLight = this.gridTheme === 'light';
        const isOrtho = this.camera && this.camera.isOrthographicCamera;
        const isCurrent = plateId === this.currentPlateId;
        const geometry = new THREE.BoxGeometry(boardW, boardD, thickness);
        const material = new THREE.MeshStandardMaterial({
            color: isLight ? 0x333333 : 0x000000,
            metalness: isOrtho ? 0.1 : 0.3,
            roughness: isOrtho ? 0.8 : 0.65,
            transparent: !isCurrent,
            opacity: isCurrent ? 1 : 0.45,
        });
        const board = new THREE.Mesh(geometry, material);
        board.position.set(worldX, worldD, -2.5);
        // 标记为盘板本体，供点击切换盘使用
        board.userData.isPlate = true;
        board.userData.plateId = plateId;
        board.userData.isLight = isLight;
        board.receiveShadow = true;
        group.add(board);
        group.userData.boardMesh = board;

        // 板面上网格线（略高于板顶面，浮在板上）
        const gridColor = isLight ? 0x888888 : 0x3a3a42;
        const divisionsX = Math.ceil(boardW / this.gridSize);
        const divisionsY = Math.ceil(boardD / this.gridSize);
        const topZ = 0.2;
        const gx0 = worldX - boardW / 2;
        const gd0 = worldD - boardD / 2;
        for (let i = 0; i <= divisionsY; i++) {
            const dd = gd0 + (i / divisionsY) * boardD;
            const pts = [new THREE.Vector3(gx0, dd, topZ), new THREE.Vector3(gx0 + boardW, dd, topZ)];
            group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
                new THREE.LineBasicMaterial({ color: gridColor })));
        }
        for (let i = 0; i <= divisionsX; i++) {
            const xx = gx0 + (i / divisionsX) * boardW;
            const pts = [new THREE.Vector3(xx, gd0, topZ), new THREE.Vector3(xx, gd0 + boardD, topZ)];
            group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
                new THREE.LineBasicMaterial({ color: gridColor })));
        }

        // 边框：所有盘统一简单灰细线（无白色高亮亮片）
        const edgeGeo = new THREE.EdgesGeometry(geometry);
        const edgeMat = new THREE.LineBasicMaterial({
            color: isLight ? 0xaaaaaa : 0x555555,
        });
        const edges = new THREE.LineSegments(edgeGeo, edgeMat);
        edges.position.copy(board.position);
        group.add(edges);

        // 擦料塔：两个半块拼成，垂直切开分色——左侧浅绿、右侧白
        // 32×32mm 底面，高度＝该盘最高模型高度（无模型则 10mm）
        const towerH = this._getPlateTowerHeight(plateId);
        const towerSize = 32;
        // 默认位于盘左上角、距边缘 padding=15（塔中心相对盘中心偏移）
        if (!plate.towerOffset) {
            plate.towerOffset = {
                x: -boardW / 2 + 15 + towerSize / 2,
                y: boardD / 2 - 15 - towerSize / 2,
            };
        }
        const tOff = plate.towerOffset;
        const h = Math.max(towerH, 1);

        const mkHalf = (color, opacity) => {
            const mat = new THREE.MeshStandardMaterial({
                color, transparent: true, opacity, roughness: 0.6, metalness: 0.1,
            });
            return { mat, mesh: new THREE.Mesh(new THREE.BoxGeometry(towerSize / 2, towerSize, 1), mat) };
        };
        const halfGreen = mkHalf(0x9ad6a0, 0.45);   // 浅绿
        const halfWhite = mkHalf(0xffffff, 0.45);   // 白

        const tower = new THREE.Group();
        // 垂直切开：沿 X 各占一半（左绿右白）
        halfGreen.mesh.position.set(-towerSize / 4, 0, 0);
        halfWhite.mesh.position.set(towerSize / 4, 0, 0);
        halfGreen.mesh.scale.z = h;
        halfWhite.mesh.scale.z = h;
        tower.add(halfGreen.mesh);
        tower.add(halfWhite.mesh);
        tower.position.set(worldX + tOff.x, worldD + tOff.y, h / 2); // 底部贴板面

        tower.userData.isTower = true;
        tower.userData.plateId = plateId;
        tower.userData.offset = { x: tOff.x, y: tOff.y };
        // towerMesh 存储引用，供透明度/高度更新；两个半块也带 isTower 供点击识别
        halfGreen.mesh.userData.isTower = true;
        halfGreen.mesh.userData.plateId = plateId;
        halfGreen.mesh.userData.towerGroup = tower;
        halfWhite.mesh.userData.isTower = true;
        halfWhite.mesh.userData.plateId = plateId;
        halfWhite.mesh.userData.towerGroup = tower;
        tower.userData.towerMeshes = [halfGreen.mesh, halfWhite.mesh];
        group.add(tower);
        group.userData.towerMesh = tower;

        this.scene.add(group);
        this.plateBoards.set(plateId, group);
    }

    // 计算某盘擦料塔高度：该盘所有模型（plateId 匹配）中最高的 z 尺寸；无模型返回 10mm
    _getPlateTowerHeight(plateId) {
        let maxH = 0;
        this.models.forEach((model) => {
            if (model.plateId !== plateId) return;
            if (!model.mesh) return;
            const box = new THREE.Box3().setFromObject(model.mesh);
            const size = box.getSize(new THREE.Vector3());
            if (size.z > maxH) maxH = size.z;
        });
        return maxH > 0 ? maxH : 10;
    }

    // 有模型变化后原地更新各盘擦料塔高度
    updatePlateTowerHeights() {
        if (!this.plateBoards) return;
        this.plateBoards.forEach((group) => {
            const tower = group.userData.towerMesh;
            if (!tower) return;
            const h = Math.max(this._getPlateTowerHeight(group.userData.plateId), 1);
            const halves = tower.userData.towerMeshes || [];
            halves.forEach((m) => { m.scale.z = h; });
            tower.position.z = h / 2;
        });
    }

    // 擦料塔选中：增加透明度值（更实、更亮眼），不强加高亮框
    _showTowerSelection(tower) {
        this._hideTowerSelection();
        if (!tower) return;
        const halves = tower.userData.towerMeshes || [tower];
        halves.forEach((m) => {
            if (m.material) {
                m.material.transparent = true;
                m.material.opacity = 0.85;
                m.material.needsUpdate = true;
            }
        });
    }

    _hideTowerSelection() {
        // 恢复默认透明度
        if (this.plateBoards) {
            this.plateBoards.forEach((group) => {
                const t = group.userData.towerMesh;
                if (!t) return;
                const halves = t.userData.towerMeshes || [t];
                halves.forEach((m) => {
                    if (m.material) {
                        m.material.transparent = true;
                        m.material.opacity = 0.45;
                        m.material.needsUpdate = true;
                    }
                });
            });
        }
    }

    // 重建所有盘的 3D 盘板（创建/删除盘、切换盘后调用）
    rebuildAllPlateBoards() {
        if (!this.scene) return;
        this.clearPlateBoards();
        const sorted = Array.from(this.plates.values()).sort((a, b) => a.order - b.order);
        sorted.forEach((plate, index) => {
            this._createPlateBoard(plate.id, index);
        });
    }

    // 切换盘后原地更新各板透明度：当前盘不透明，其余半透明
    updatePlateBoardOpacity() {
        if (!this.plateBoards) return;
        const cur = this.currentPlateId;
        this.plateBoards.forEach((group) => {
            const board = group.userData.boardMesh;
            if (board && board.material) {
                const isCur = group.userData.plateId === cur;
                board.material.transparent = !isCur;
                board.material.opacity = isCur ? 1 : 0.45;
                board.material.needsUpdate = true;
            }
        });
    }

    getPlate(id) {
        return this.plates.get(id);
    }

    getPlateForModel(modelId) {
        const model = this.models.get(modelId);
        if (!model) return null;
        return model.plateId ? this.plates.get(model.plateId) : null;
    }

    isPlateLocked(id) {
        const plate = this.plates.get(id);
        return !!plate && plate.locked;
    }

    isModelLocked(modelId) {
        const model = this.models.get(modelId);
        if (!model || !model.plateId) return false;
        return this.isPlateLocked(model.plateId);
    }

    // 当前显示的盘设为指定的盘
    setCurrentPlate(plateId) {
        if (!this.plates.has(plateId)) return;
        this.currentPlateId = plateId;
        // 切换盘时清空选中，防止跨盘选中
        this.clearSelection();
        // 取消擦料塔选中
        this._selectedTower = null;
        this._hideTowerSelection();
        // 所有模型保持可见，仅刷新列表
        this.applyCurrentPlateVisibility();
        // 重建当前激活盘的 3D 操作按钮组
        this.buildActivePlateActions();
        this.renderPlates();
        // 原地更新各板透明度（当前盘不透明，其余半透明）
        this.updatePlateBoardOpacity();
    }

    defaultPlateId() {
        // 排序后取 order 最小（最早创建）的盘作为默认盘
        let def = null;
        let minOrder = Infinity;
        this.plates.forEach((p) => {
            if (p.order < minOrder) { minOrder = p.order; def = p.id; }
        });
        return def;
    }

    _isOnCurrentPlate(model) {
        const cur = this.currentPlateId;
        if (!cur) return true;
        return model.plateId === cur || (model.plateId == null && cur === this.defaultPlateId());
    }

    // 当前盘在平方网格中的序号（按 order 排序后的下标）
    _activePlateIndex() {
        const sorted = Array.from(this.plates.values()).sort((a, b) => a.order - b.order);
        const idx = sorted.findIndex((p) => p.id === this.currentPlateId);
        return idx < 0 ? 0 : idx;
    }

    // 把当前盘原点对齐到床面原点所需的平移量：其他盘的模型在导出时要减去这一偏移，
    // 使模型与四角定位平面（固定于床面原点坐标）对齐，且不把其它盘的模型带进本次导出。
    _getPlateExportOffset() {
        const index = this._activePlateIndex();
        if (index <= 0) return { x: 0, y: 0 };
        const g = this._plateGridPos(index);
        const gap = 40;
        return {
            x: -g.col * (this.bedSize.x + gap),
            y: +g.row * (this.bedSize.y + gap),
        };
    }

    addPlate() {
        const id = this.nextPlateId++;
        const order = this.plates.size + 1;
        // 用自增 id 命名，避免与现有盘号碰撞（如已有"盘 1"时不会再生"盘 1"）
        this.plates.set(id, { id, name: `盘 ${id}`, locked: false, order });
        // 板数变化需重建布局
        this.setCurrentPlate(id);
        this.rebuildAllPlateBoards();
        // 新建盘后平移视口到所有盘的整体中心，照顾到新盘
        this._centerViewportOnAllPlates();
        this.saveState('新建盘');
        return id;
    }

    deletePlate(plateId) {
        const plate = this.plates.get(plateId);
        if (!plate) return;
        if (this.plates.size <= 1) {
            this.showToast('至少需要保留一个盘', 'warning');
            return;
        }
        if (plate.locked) {
            this.showToast('请先解锁该盘再删除', 'warning');
            return;
        }
        // 统计该盘上的对象
        const onPlate = [];
        this.models.forEach((model, modelId) => {
            if (model.plateId === plateId || (!model.plateId && plateId === this.defaultPlateId())) {
                onPlate.push(modelId);
            }
        });
        const doDelete = () => {
            this.saveState();
            // 删除盘上的所有对象
            onPlate.forEach((mid) => this._deleteModelUnchecked(mid));
            this.plates.delete(plateId);
            // 如果删除的是当前盘，切到剩余的第一个盘
            if (this.currentPlateId === plateId) {
                const firstId = this.defaultPlateId();
                this.currentPlateId = firstId;
                this.setCurrentPlate(firstId);
                this.rebuildAllPlateBoards();
            } else {
                this.updateObjectList();
                this.renderPlates();
                this.rebuildAllPlateBoards();
            }
            this.saveState('删除盘');
        };
        if (onPlate.length > 0) {
            this.showConfirm(
                `删除盘「${plate.name}」`,
                `此盘包含 ${onPlate.length} 个对象，删除后这些对象将一并移除。确定删除？`,
                doDelete
            );
        } else {
            doDelete();
        }
    }

    _lockPlateInternal(plateId) {
        const plate = this.plates.get(plateId);
        if (!plate || plate.locked) return false;
        plate.locked = true;
        this.models.forEach((model, mid) => {
            if (model.plateId === plateId && model.selected) {
                this.selectedModels.delete(mid);
                model.selected = false;
                this.deselectModelInternal(model);
            }
        });
        if (this._selectedTower && this._selectedTower.userData && this._selectedTower.userData.plateId === plateId) {
            this._selectedTower = null;
            this._hideTowerSelection();
        }
        this.updateObjectList();
        this.renderPlates();
        if (plateId === this.currentPlateId) this.buildActivePlateActions();
        try { this.saveState('锁定盘'); } catch (_) {}
        return true;
    }

    toggleLockPlate(plateId) {
        const plate = this.plates.get(plateId);
        if (!plate) return;
        if (!plate.locked) {
            this._lockPlateInternal(plateId);
            return;
        }
        plate.locked = false;
        this.updateObjectList();
        this.renderPlates();
        if (plateId === this.currentPlateId) this.buildActivePlateActions();
    }

    movePlateToFront(plateId) {
        const plate = this.plates.get(plateId);
        if (!plate) return;
        const sorted = Array.from(this.plates.values()).sort((a, b) => a.order - b.order);
        if (sorted.length > 0 && sorted[0].id === plateId) {
            return;
        }
        // 目标：被操作盘变为第 1 盘（最前），原第 1 变第 2，依次顺延；重排后盘板格位变化，模型随各自盘板平移对齐
        const oldCenters = new Map();
        this.plates.forEach((p) => { oldCenters.set(p.id, this._getPlateWorldPos(p.id)); });
        // 重新编号：被操作盘 -> 1，其余依次顺延
        let next = 1;
        const assign = [{ id: plateId, order: next++ }];
        sorted.forEach((p) => { if (p.id !== plateId) assign.push({ id: p.id, order: next++ }); });
        assign.forEach(({ id, order }) => { this.plates.get(id).order = order; });
        // 每个盘按其新旧格位差平移其上所有模型，保持模型与盘板对齐
        this.models.forEach((model) => {
            const oldC = oldCenters.get(model.plateId);
            if (!oldC) return; // 自由区模型不移动
            const newC = this._getPlateWorldPos(model.plateId);
            const dx = newC.x - oldC.x;
            const dy = newC.y - oldC.y;
            if (dx === 0 && dy === 0) return;
            // 若该模型正被变换(proxy 携带 mesh)，平移 proxy 即可；否则直接平移 scene 下的 mesh
            const target = (model._transformProxy && model.mesh.parent === model._transformProxy)
                ? model._transformProxy : model.mesh;
            if (target) {
                target.position.x += dx;
                target.position.y += dy;
                target.updateMatrixWorld(true);
            }
        });
        // 重建 3D 盘板（含擦料塔）与列表
        this.rebuildAllPlateBoards();
        this.updatePlateBoardOpacity();
        this.applyCurrentPlateVisibility();
        this.renderPlates();
        // 若被操作盘是当前盘，重建其 3D 操作按钮组以跟随新位置
        if (plateId === this.currentPlateId) this.buildActivePlateActions();
        this.saveState('盘移到最前');
    }

    renderPlates() {
        const container = document.getElementById('plates-list');
        if (!container) return;
        container.innerHTML = '';
        const total = this.plates.size;
        if (total === 0) return;

        // 平方网格布局：cols = ceil(sqrt(N))
        const cols = Math.ceil(Math.sqrt(total));
        container.style.display = 'grid';
        container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        container.style.gap = '6px';

        const sorted = Array.from(this.plates.values()).sort((a, b) => a.order - b.order);
        sorted.forEach((plate) => {
            const tab = document.createElement('div');
            tab.className = `plate-tab ${plate.id === this.currentPlateId ? 'active' : ''} ${plate.locked ? 'locked' : ''}`;
            tab.dataset.plateId = plate.id;

            const name = document.createElement('span');
            name.className = 'plate-name';
            name.textContent = plate.name;
            name.title = plate.locked ? `${plate.name}（已锁定）` : plate.name;

            tab.appendChild(name);

            tab.addEventListener('click', () => this.setCurrentPlate(plate.id));
            // 双击盘 tab 重命名
            tab.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.renamePlate(plate.id);
            });
            container.appendChild(tab);
        });
    }

    // 双击盘改名：不弹浏览器询问框，直接在原位置把盘名变成输入框
    renamePlate(plateId) {
        const plate = this.plates.get(plateId);
        if (!plate) return;
        const tab = document.querySelector(`.plate-tab[data-plate-id="${plateId}"] .plate-name`);
        if (!tab) return;
        const old = plate.name;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = old;
        input.className = 'plate-rename-input';
        input.style.width = '100%';
        input.style.fontSize = '12px';
        input.style.padding = '2px 4px';
        input.style.boxSizing = 'border-box';
        input.style.border = '1px solid #4a9eff';
        input.style.borderRadius = '4px';
        input.style.background = '#1e1e2e';
        input.style.color = '#fff';

        // 用输入框替换原盘名
        const parent = tab.parentNode;
        parent.replaceChild(input, tab);
        input.focus();
        input.select();

        const commit = () => {
            const val = input.value.trim();
            if (val && val !== old) {
                plate.name = val;
            }
            this.renderPlates();
        };
        const cancel = () => {
            this.renderPlates();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { commit(); input.blur(); }
            else if (e.key === 'Escape') { cancel(); }
        });
        input.addEventListener('blur', () => {
            // 失焦提交（若值有效）
            const val = input.value.trim();
            if (val && val !== old) plate.name = val;
            this.renderPlates();
        });
    }

    // ---------- 3D 悬浮盘操作按钮（仅当前激活盘一组） ----------

    // 在网格右侧靠上创建当前激活盘的 3D 操作按钮（悬浮网格外侧，与网格同高度）
    buildActivePlateActions() {
        // 移除旧按钮
        this.removePlateActions();
        if (!this.currentPlateId || !this.scene) return;

        const plate = this.plates.get(this.currentPlateId);
        if (!plate) return;

        // 按钮大小与间距（世界单位）
        const size = 18;
        const spacing = 24;

        // 按钮放在当前盘的板子上（板右侧、略高于板面）
        const center = this._getPlateWorldPos(this.currentPlateId);
        const x = center.x + this.bedSize.x / 2 + 16;
        let y = center.y + this.bedSize.y * 0.30;
        const z = 1.0;

        const defs = ['lock', 'front', 'del', 'add'];

        const meshes = [];
        for (const action of defs) {
            const btn = this._makePlateButton(action, size, this.currentPlateId);
            btn.position.set(x, y, z);
            y -= spacing;
            this.scene.add(btn);
            meshes.push(btn);
        }
        this.plateActions = meshes;
    }

    // 生成单个 3D 按钮（白色半透明圆角方块 + 图标）
    _makePlateButton(action, size, plateId) {
        const texture = this._renderPlateButtonTexture(action, plateId);
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        const geo = new THREE.PlaneGeometry(size, size);
        const mesh = new THREE.Mesh(geo, material);
        mesh.renderOrder = 5;
        mesh.userData.action = action;
        mesh.userData.plateId = plateId;
        return mesh;
    }

    // 用 Canvas 绘制白色半透明圆角方块 + 图标
    _renderPlateButtonTexture(action, plateId) {
        const dpr = 2;
        const px = 48 * dpr;
        const canvas = document.createElement('canvas');
        canvas.width = px;
        canvas.height = px;
        const ctx = canvas.getContext('2d');
        const s = px;

        // 按钮底：默认统一白色半透明圆角方块；仅"上锁"的这一颗在盘上锁时更亮（高光）
        const isLocked = action === 'lock' && plateId != null && this.isPlateLocked(plateId);
        const bgAlpha = isLocked ? 0.90 : 0.55;

        const r = s * 0.22;
        ctx.save();
        ctx.globalAlpha = bgAlpha;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        this._roundedRect(ctx, s * 0.06, s * 0.06, s * 0.88, s * 0.88, r);
        ctx.fill();
        ctx.restore();

        // 图标颜色（锁定态统一用深色，删除用红，其余深灰）
        let iconColor = '#444';
        if (isLocked) iconColor = '#222';
        if (action === 'del') iconColor = '#c0392b';
        ctx.strokeStyle = iconColor;
        ctx.fillStyle = iconColor;
        ctx.lineWidth = s * 0.06;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const box = s * 0.62;
        const cx = s / 2, cy = s / 2;
        if (action === 'lock') {
            this._drawLockIcon(ctx, cx, cy, box * 0.5, isLocked);
        } else if (action === 'front') {
            this._drawFrontIcon(ctx, cx, cy, box * 0.42);
        } else if (action === 'del') {
            this._drawTrashIcon(ctx, cx, cy, box * 0.5);
        } else if (action === 'add') {
            this._drawPlusIcon(ctx, cx, cy, box * 0.34);
        }
        return new THREE.CanvasTexture(canvas);
    }

    _roundedRect(ctx, x, y, w, h, r) {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    _drawLockIcon(ctx, cx, cy, r, locked) {
        ctx.save();
        ctx.lineWidth = r * 0.14;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const col = '#444';   // 锁体统一深色，与其它按钮图标一致，保证在浅底上清晰

        const bw = r * 1.25, bh = r * 0.9;
        const bx = cx - bw / 2;
        const by = cy - r * 0.28;   // 垂直居中

        // 锁体（圆角矩形，深色描边 + 很淡的深色填充，轮廓分明）
        ctx.strokeStyle = col;
        ctx.fillStyle = 'rgba(68,68,68,0.12)';
        this._roundedRect(ctx, bx, by, bw, bh, r * 0.16);
        ctx.fill();
        ctx.stroke();

        // 锁梁：默认(解锁)翘起弹开；锁定则贴紧扣合，均为深色
        ctx.strokeStyle = col;
        ctx.lineWidth = r * 0.14;
        const arcR = r * 0.40;
        if (locked) {
            ctx.beginPath();
            ctx.arc(cx, by - r * 0.02, arcR, Math.PI, 0);
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.arc(cx + r * 0.08, by - r * 0.34, arcR, Math.PI * 1.12, Math.PI * -0.12);
            ctx.stroke();
        }

        // 锁孔：统一深色
        ctx.fillStyle = col;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.arc(cx, by + bh * 0.50, r * 0.11, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx, by + bh * 0.46);
        ctx.lineTo(cx, by + bh * 0.68);
        ctx.stroke();
        ctx.restore();
    }


    // 向上箭头 + 上方一条横线（移到最前）——箭头加长
    _drawFrontIcon(ctx, cx, cy, r) {
        ctx.save();
        ctx.strokeStyle = '#444';
        ctx.fillStyle = '#444';
        ctx.lineWidth = r * 0.16;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const h = r * 1.6; // 加长 33%
        // 上方横线（表示"顶部"边界）
        const lw = r * 1.0;
        ctx.beginPath();
        ctx.moveTo(cx - lw, cy - h * 0.44);
        ctx.lineTo(cx + lw, cy - h * 0.44);
        ctx.stroke();
        // 箭头杆（显著加长）
        ctx.beginPath();
        ctx.moveTo(cx, cy - h * 0.34);
        ctx.lineTo(cx, cy + h * 0.38);
        ctx.stroke();
        // 箭头（三角，加长）
        const aw = r * 0.55;
        const ah = r * 0.55;
        ctx.beginPath();
        ctx.moveTo(cx, cy - h * 0.34);
        ctx.lineTo(cx - aw, cy - h * 0.34 + ah);
        ctx.lineTo(cx + aw, cy - h * 0.34 + ah);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // 更干净的垃圾桶
    _drawTrashIcon(ctx, cx, cy, r) {
        ctx.strokeStyle = '#c0392b';
        ctx.fillStyle = 'rgba(192,57,43,0.12)';
        ctx.lineWidth = r * 0.16;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const tw = r * 1.3, th = r * 1.5;
        // 盖子横条
        const lidW = tw * 0.65;
        ctx.beginPath();
        ctx.moveTo(cx - lidW, cy - th * 0.30);
        ctx.lineTo(cx + lidW, cy - th * 0.30);
        ctx.stroke();
        // 盖子把手（小凸起）
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.28, cy - th * 0.30);
        ctx.lineTo(cx - r * 0.28, cy - th * 0.44);
        ctx.lineTo(cx + r * 0.28, cy - th * 0.44);
        ctx.lineTo(cx + r * 0.28, cy - th * 0.30);
        ctx.stroke();
        // 桶身（梯形）
        const topW = tw * 0.50, botW = tw * 0.38;
        ctx.beginPath();
        ctx.moveTo(cx - topW, cy - th * 0.28);
        ctx.lineTo(cx - botW, cy + th * 0.50);
        ctx.lineTo(cx + botW, cy + th * 0.50);
        ctx.lineTo(cx + topW, cy - th * 0.28);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 桶身竖纹（两条竖线）
        for (let i = -1; i <= 1; i += 2) {
            ctx.beginPath();
            ctx.moveTo(cx + i * r * 0.22, cy - th * 0.18);
            ctx.lineTo(cx + i * r * 0.18, cy + th * 0.36);
            ctx.stroke();
        }
    }

    _drawPlusIcon(ctx, cx, cy, r) {
        ctx.strokeStyle = '#444';
        ctx.lineWidth = r * 0.24;
        ctx.lineCap = 'round';
        const h = r * 1.1;
        ctx.beginPath();
        ctx.moveTo(cx - h / 2, cy); ctx.lineTo(cx + h / 2, cy);
        ctx.moveTo(cx, cy - h / 2); ctx.lineTo(cx, cy + h / 2);
        ctx.stroke();
    }

    // 更新当前激活盘按钮组（锁定态变化/切盘后调用）
    refreshActivePlateActions() {
        // 重建当前激活盘的按钮组，保证图标状态（锁定）与归属正确
        this.buildActivePlateActions();
    }

    // 移除激活盘按钮组（清空/重置时调用）
    removePlateActions() {
        if (this.plateActions) {
            for (const btn of this.plateActions) {
                this.scene.remove(btn);
                if (btn.material) {
                    if (btn.material.map) btn.material.map.dispose();
                    btn.material.dispose();
                }
                if (btn.geometry) btn.geometry.dispose();
            }
            this.plateActions = null;
        }
    }


    async loadCalibrationModel() {
        const btn = document.getElementById('btn-calibrate');

        try {
            // 1. 获取校准模型路径（兼容开发环境和打包环境）
            if (!window.pywebview?.api) {
                this.showToast('后端API不可用', 'error');
                return;
            }

            const calibPath = await window.pywebview.api.get_calibration_model_path();

            // 2. 清空热床上所有模型
            this.clearAllModels();

            // 3. 切换至准备页面
            this.switchToPrepare();

            // 4. 通过后端 API 加载校准模型
            const result = await window.pywebview.api.load_model_by_path(calibPath);
            if (!result?.success) {
                this.showToast('加载校准模型失败: ' + (result?.error || '未知错误'), 'error');
                return;
            }

            // 5. 加载到场景并命名
            this.loadGLTF(result.data, '校准模型', calibPath);

            // 5. 延迟标记：等待 addModelObject 将模型注册到 this.models 后
            //    将校准模型标记，限制其只能旋转
            setTimeout(() => {
                let calibModelId = null;
                this.models.forEach((model, id) => {
                    if (model.name === '校准模型') {
                        model._isCalibration = true;
                        calibModelId = id;
                    }
                });
                if (calibModelId) {
                    this.showToast('校准模型已加载', 'success');
                    btn?.classList.add('calib-active');
                }
            }, 100);
        } catch (e) {
            console.error('加载校准模型异常:', e);
            this.showToast('加载校准模型异常: ' + e.message, 'error');
        }
    }

    _cleanupExtractDir() {
        if (this._extractDir && window.pywebview && window.pywebview.api) {
            window.pywebview.api.cleanup_temp_dir(this._extractDir).catch(() => {});
            this._extractDir = null;
        }
    }

    showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'toast';

        const icon = document.createElement('span');
        icon.className = `toast-icon ${type}`;
        icon.textContent = type === 'success' ? '✓' : type === 'error' ? '✗' : 'i';

        const msg = document.createElement('span');
        msg.className = 'toast-message';
        msg.textContent = message;

        toast.appendChild(icon);
        toast.appendChild(msg);
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-hiding');
            setTimeout(() => toast.remove(), 200);
        }, duration);
    }

    // 通用确认对话框：title 标题、message 内容、okLabel 确认按钮文字；用户点击确认后执行 onConfirm
    showConfirm(title, message, onConfirm, okLabel = '删除') {
        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay';
        overlay.style.zIndex = '9999';
        overlay.innerHTML = `
            <div class="dialog-box" style="min-width:360px; text-align:center;">
                <h3 class="dialog-title"></h3>
                <p class="dialog-desc" style="font-size:14px; line-height:1.8;"></p>
                <div class="dialog-buttons" style="justify-content:center; gap:12px;">
                    <button class="dialog-btn dialog-cancel">取消</button>
                    <button class="dialog-btn dialog-confirm"></button>
                </div>
            </div>
        `;
        overlay.querySelector('.dialog-title').textContent = title;
        overlay.querySelector('.dialog-desc').textContent = message;
        overlay.querySelector('.dialog-confirm').textContent = okLabel;
        document.body.appendChild(overlay);

        const cleanup = () => overlay.remove();
        overlay.querySelector('.dialog-cancel').addEventListener('click', () => { cleanup(); });
        overlay.querySelector('.dialog-confirm').addEventListener('click', () => { cleanup(); onConfirm(); });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup();
        });
    }

    // 导入的模型若三个维度都 < 10mm，弹出尺寸倍数调整对话框（复用 dialog 样式，但不带全局灰化背景）
    askRescaleSmallModel(modelId) {
        const model = this.models.get(modelId);
        if (!model) return;
        // 若已有一个缩放询问框打开，则跳过，避免批量导入时叠弹多个
        if (this._rescaleDialogOpen) return;

        model.mesh.updateWorldMatrix(true, true);
        const size = new THREE.Box3().setFromObject(model.mesh).getSize(new THREE.Vector3());
        if (size.x >= 10 || size.y >= 10 || size.z >= 10) return;

        // 默认建议倍数：把最大尺寸拉到 ≥10mm，取整到 1 位小数（至少 2 倍）
        const maxDim = Math.max(size.x, size.y, size.z);
        const divisor = maxDim > 0.01 ? maxDim : 10;
        const defaultMult = Math.max(2, Math.round((10 / divisor) * 10) / 10);

        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay';
        overlay.style.background = 'transparent'; // 不带全局灰化
        overlay.style.pointerEvents = 'none';     // 除对话框区域外点击穿透，不遮挡交互
        overlay.innerHTML = `
            <div class="dialog-box" style="pointer-events:auto; text-align:center;">
                <h3 class="dialog-title">模型尺寸过小</h3>
                <p class="dialog-desc" style="font-size:14px; line-height:1.8; white-space:pre-line;"></p>
                <input class="dialog-input" type="number" step="0.1" min="1" placeholder="输入放大倍数" style="text-align:center;" autocomplete="off">
                <div class="dialog-buttons" style="justify-content:center; gap:12px; margin-top:14px;">
                    <button class="dialog-btn dialog-cancel">跳过</button>
                    <button class="dialog-btn dialog-confirm">确认放大</button>
                </div>
            </div>
        `;
        const sizeTxt = size.x.toFixed(1) + ' x ' + size.y.toFixed(1) + ' x ' + size.z.toFixed(1) + ' mm';
        overlay.querySelector('.dialog-desc').textContent =
            `${sizeTxt}。是否按倍数调整？`;
        const inputEl = overlay.querySelector('.dialog-input');
        inputEl.value = String(defaultMult);
        document.body.appendChild(overlay);
        this._rescaleDialogOpen = true;

        const cleanup = () => {
            overlay.remove();
            this._rescaleDialogOpen = false;
        };
        const applyRescale = () => {
            const mult = parseFloat(inputEl.value);
            if (!mult || mult <= 0) {
                this.showToast('请输入有效的放大倍数', 'warning');
                return;
            }
            cleanup();
            model.mesh.scale.multiplyScalar(mult);
            model.mesh.updateWorldMatrix(true, true);
            this.bakeTransform(model);
            // 放大后的包围盒中心对齐到所属打印板中心，保持居中
            {
                const plateCenter = this._getPlateWorldPos(model.plateId || this.freePlateId);
                const target = model._transformProxy || model.mesh;
                const box = new THREE.Box3().setFromObject(target);
                const center = box.getCenter(new THREE.Vector3());
                const dx = plateCenter.x - center.x;
                const dy = plateCenter.y - center.y;
                if (target === model._transformProxy) {
                    target.position.x += dx;
                    target.position.y += dy;
                    target.updateMatrixWorld(true);
                } else {
                    model.mesh.position.x += dx;
                    model.mesh.position.y += dy;
                    model.mesh.updateMatrixWorld(true);
                }
                this.updateSelectionBoxes();
                this.updateTransformInputs();
            }
            this.updatePlateTowerHeights();
            this.saveState('导入后放大');
        };

        overlay.querySelector('.dialog-confirm').addEventListener('click', applyRescale);
        overlay.querySelector('.dialog-cancel').addEventListener('click', () => { cleanup(); });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') applyRescale();
            else if (e.key === 'Escape') cleanup();
        });
        // 焦点置于输入框并全选，方便直接改倍数
        inputEl.addEventListener('click', () => inputEl.select());
        inputEl.focus();
        inputEl.select();
    }

    _updateSidebarActive(activeId) {
        const ids = ['sidebar-nav-home', 'sidebar-nav-prepare', 'sidebar-nav-flat', 'sidebar-nav-calibrate', 'sidebar-import-file', 'sidebar-open-project', 'sidebar-settings', 'sidebar-about'];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (id === activeId) el.classList.add('active');
            else el.classList.remove('active');
        }
    }

    switchToHome() {
        this._stopHeadlessPolling();
        document.getElementById('nav-home')?.classList.add('active');
        document.getElementById('nav-prepare')?.classList.remove('active');
        document.getElementById('nav-preview')?.classList.remove('active');
        document.getElementById('nav-flat')?.classList.remove('active');
        document.getElementById('nav-device')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.remove('active');
        document.getElementById('home-page')?.classList.remove('hidden');
        document.getElementById('home-sidebar')?.classList.remove('hidden');
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('device-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        document.getElementById('flat-page')?.classList.add('hidden');
        document.getElementById('btn-model-slice')?.classList.add('hidden');
        document.getElementById('btn-model-retry')?.classList.add('hidden');
        document.getElementById('btn-flat-slice')?.classList.add('hidden');
        document.getElementById('btn-print-gcode')?.classList.add('hidden');
        this._disposeGcode3DView();
        this._updatePrintStatusText();
        this._updateSidebarActive('sidebar-nav-home');
        this.loadRecentProjects();
    }

    switchToPrepare() {
        document.getElementById('nav-home')?.classList.remove('active');
        document.getElementById('nav-prepare')?.classList.add('active');
        document.getElementById('nav-preview')?.classList.remove('active');
        document.getElementById('nav-flat')?.classList.remove('active');
        document.getElementById('nav-device')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.remove('active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('home-sidebar')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('device-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        document.getElementById('flat-page')?.classList.add('hidden');
        document.getElementById('main-container')?.classList.remove('hidden');
        document.getElementById('btn-model-slice')?.classList.remove('hidden');
        document.getElementById('btn-model-retry')?.classList.remove('hidden');
        document.getElementById('btn-flat-slice')?.classList.add('hidden');
        document.getElementById('btn-print-gcode')?.classList.add('hidden');
        this._disposeGcode3DView();
        // 强制重排，修复 Three.js 渲染器从 display:none 恢复后的尺寸
        this.onWindowResize();

        // 如果切片正在运行，恢复进度条显示
        if (this._sliceRunning) {
            const progressEl = document.getElementById('slice-progress');
            if (progressEl) progressEl.classList.remove('hidden');
            this._setPreviewTabDisabled(true);
        }
    }

    switchToPreview() {
        console.log('[GCodeDrop] switchToPreview called');
        // 切片进行中不允许切换到预览页
        if (this._sliceRunning) {
            this.showToast('纹理切片进行中，请等待完成', 'info');
            return;
        }
        // 防止重入
        if (this._gcode3DViewSwitching) {
            console.log('[GCodeDrop] switchToPreview: already switching, skip');
            return;
        }
        this._gcode3DViewSwitching = true;

        this._setupGcodeDropZone();
        document.getElementById('nav-home')?.classList.remove('active');
        document.getElementById('nav-prepare')?.classList.remove('active');
        document.getElementById('nav-preview')?.classList.add('active');
        document.getElementById('nav-flat')?.classList.remove('active');
        document.getElementById('nav-device')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.remove('active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('home-sidebar')?.classList.add('hidden');
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('device-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        document.getElementById('flat-page')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.remove('hidden');
        document.getElementById('btn-model-slice')?.classList.add('hidden');
        document.getElementById('btn-model-retry')?.classList.add('hidden');
        document.getElementById('btn-flat-slice')?.classList.add('hidden');
        // 预览页：已加载 GCode 才显示"立即打印"按钮
        if (this._lastGcode) {
            document.getElementById('btn-print-gcode')?.classList.remove('hidden');
        } else {
            document.getElementById('btn-print-gcode')?.classList.add('hidden');
        }

        // 仅在无切片结果时从预览文件夹加载（切片流程已通过 displaySliceImages 设置 _sliceImages）
        if (!this._sliceImages || this._sliceImages.length === 0) {
            this._loadPreviewFolderImages();
        }

        // 仅当已加载 GCode 时才初始化 3D 视图
        if (this._lastGcode && !this._gcode3DRenderer) {
            console.log('[GCodeDrop] switchToPreview: creating 3D view');
            this._setupGcode3DView();
        }
        if (this._lastGcode && this._gcode3DRenderer) {
            this._renderToolpath3D().catch(e => console.error('_renderToolpath3D error:', e));
        }
        // 触发 resize 以填充容器
        setTimeout(() => {
            if (this._gcode3DResizeHandler) this._gcode3DResizeHandler();
        }, 50);

        this._gcode3DViewSwitching = false;

        // 启动头样子进程轮询（Orca 调起的后处理进度）
        this._startHeadlessPolling();
    }

    /** 设置 GCode 导入区域 */
    _setupGcodeDropZone() {
        const container = document.getElementById('gcode-3d-container');
        if (!container || this._gcodeDropBound) return;

        // 绑定导入按钮点击事件
        const importBtn = document.getElementById('btn-import-gcode');
        if (importBtn) {
            importBtn.addEventListener('click', () => this.loadGcodeFromBackend());
        }

        // 绑定重新加载按钮（重新选择 GCode 文件）
        const reloadBtn = document.getElementById('btn-reload-gcode');
        if (reloadBtn) {
            reloadBtn.addEventListener('click', () => this.loadGcodeFromBackend());
        }

        // 保留拖拽阻止默认行为，防止浏览器打开文件
        const onDragOver = (e) => {
            e.preventDefault();
        };
        const onDrop = (e) => {
            e.preventDefault();
            this.showToast('请使用「导入 GCode」按钮选择文件', 'info');
        };
        container.addEventListener('dragover', onDragOver);
        container.addEventListener('drop', onDrop);

        this._gcodeDropBound = { container, onDragOver, onDrop };
    }

    /** GCode 拖入后的处理 */
    async _onGcodeDropped(filePath) {
        console.log('[GCodeDrop] _onGcodeDropped called, path:', filePath);
        if (!window.pywebview || !window.pywebview.api) {
            console.error('[GCodeDrop] pywebview not available');
            this.showToast('pywebview 不可用', 'error');
            return;
        }

        try {
            console.log('[GCodeDrop] calling load_gcode_file...');
            const result = await window.pywebview.api.load_gcode_file(filePath);
            console.log('[GCodeDrop] load_gcode_file result:', result);
            if (!result || !result.success) {
                this.showToast(result?.error || '读取 GCode 失败', 'error');
                return;
            }

            console.log(`[GCodeDrop] loaded: ${filePath}, size: ${result.gcode?.length || 0} bytes`);
            this._lastGcode = result.gcode;
            this._testGcodePath = filePath;  // 同步实际文件路径
            this._updatePrintStatusText();

            // 隐藏占位符
            const placeholder = document.getElementById('gcode-drop-placeholder');
            if (placeholder) {
                placeholder.style.display = 'none';
                console.log('[GCodeDrop] placeholder hidden');
            } else {
                console.warn('[GCodeDrop] placeholder not found');
            }

            // 显示参数信息 toast
            if (result.info) {
                const i = result.info;
                const msg = i.total_time_str
                    ? `${i.name} | 层高${i.layer_height}mm | ${i.total_layers}层 | 预估${i.total_time_str}`
                    : `${i.name} | ${(i.size_bytes / 1024).toFixed(1)}KB`;
                this.showToast(msg, 'info');
            }

            // 切换到预览页并渲染
            console.log('[GCodeDrop] switching to preview...');
            this.switchToPreview();
            console.log('[GCodeDrop] calling displayGcode...');
            await this.displayGcode(result.gcode);
            setTimeout(() => {
                console.log('[GCodeDrop] timeout: _updateLayerSlider');
                this._updateLayerSlider();
            }, 100);

        } catch (e) {
            console.error('[GCodeDrop] exception:', e);
            this.showToast('读取 GCode 异常: ' + e.message, 'error');
        }
    }

    /** 恢复 GCode 占位符显示 */
    _showGcodePlaceholder() {
        const placeholder = document.getElementById('gcode-drop-placeholder');
        if (placeholder) {
            placeholder.style.display = '';
        }
    }

    async _loadPreviewFolderImages() {
        const container = document.getElementById('slice-images-container');
        if (!container) return;
        if (!window.pywebview || !window.pywebview.api) return;
        // 防止重复加载
        if (this._previewImagesLoading) return;
        this._previewImagesLoading = true;

        try {
            const result = await window.pywebview.api.load_preview_images();
            const count = (result && result.count) ? result.count : 0;
            this._previewImageCount = count;
            // 缩放指导：后端把模型聚焦区换算成预览图归一化矩形，前端据此预放大铺满视口
            this._sliceFocusRect = (result && result.focus_rect
                && result.focus_rect.x != null && result.focus_rect.w > 0)
                ? result.focus_rect : null;
            this._sliceFocusApplied = false;

            // 异步等待期间，切片结果可能已通过 displaySliceImages 写入 _sliceImages，
            // 此时不应覆盖（直接模式的图片优先级高于文件夹懒加载）
            if (this._sliceImages && this._sliceImages.length > 0) {
                return;
            }

            if (count > 0) {
                // 全部缩略图都要预加载（翻层/缩放立即可用），先并行预加载全部，再渲染首张
                this._previewImagesCache = {};
                await this._preloadAllPreviewImages(count);
                if (this._previewImagesCache[0] !== undefined) {
                    this._showSliceImageByIndex(0, this._previewImagesCache[0]);
                } else {
                    await this._loadAndShowPreviewImage(0);
                }
            } else {
                this._updateLayerSlider();
            }
        } catch (e) {
            console.error('加载预览图片失败:', e);
        } finally {
            this._previewImagesLoading = false;
        }
    }

    // 并发预加载全部预览缩略图到 _previewImagesCache（文件夹路径）
    async _preloadAllPreviewImages(count) {
        const CONC = 8;
        for (let start = 0; start < count; start += CONC) {
            const batch = [];
            for (let i = start; i < Math.min(start + CONC, count); i++) {
                if (this._previewImagesCache && this._previewImagesCache[i] !== undefined) continue;
                batch.push((async () => {
                    try {
                        const result = await window.pywebview.api.load_preview_image(i);
                        if (result && result.success && result.image) {
                            if (this._previewImagesCache) this._previewImagesCache[i] = result.image;
                            if (result.total) this._previewImageCount = result.total;
                        }
                    } catch (e) {
                        console.error('[PreloadPreview] 预加载失败:', i, e);
                    }
                })());
            }
            await Promise.all(batch);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    async _loadAndShowPreviewImage(index) {
        if (!window.pywebview || !window.pywebview.api) return;
        if (this._previewImagesCache && this._previewImagesCache[index]) {
            this._showSliceImageByIndex(index, this._previewImagesCache[index]);
            return;
        }
        const reqId = ++this._sliceLoadRequestId;
        try {
            const result = await window.pywebview.api.load_preview_image(index);
            if (result && result.success && result.image && this._sliceLoadRequestId === reqId) {
                if (!this._previewImagesCache) this._previewImagesCache = {};
                this._previewImagesCache[index] = result.image;
                if (result.total) this._previewImageCount = result.total;
                this._showSliceImageByIndex(index, result.image);
            }
        } catch (e) {
            console.error('加载预览图片失败:', e);
        }
    }

    _showSliceImageByIndex(index, imageData) {
        const container = document.getElementById('slice-images-container');
        if (!container) return;

        const total = this._previewImageCount || 0;
        if (total === 0) {
            container.innerHTML = '<div class="slice-images-empty">暂无切片图片数据。</div>';
            return;
        }

        const i = Math.max(0, Math.min(index, total - 1));
        this._currentSliceImageIndex = i;

        container.innerHTML = '';

        const item = document.createElement('div');
        item.className = 'slice-image-item';

        const label = document.createElement('div');
        label.className = 'slice-image-label';
        label.textContent = `切片层 ${i + 1} / ${total}`;

        const zoomWrapper = document.createElement('div');
        zoomWrapper.className = 'slice-image-zoom-wrapper';

        const img = document.createElement('img');
        img.src = imageData;
        img.alt = `切片层 ${i + 1}`;
        img.draggable = false;

        zoomWrapper.appendChild(img);
        item.appendChild(label);
        item.appendChild(zoomWrapper);
        container.appendChild(item);

        this._setupImageZoom(zoomWrapper, img, i);
        this._updateLayerSlider();
    }

    switchToFlat() {
        this._stopHeadlessPolling();
        document.getElementById('nav-home')?.classList.remove('active');
        document.getElementById('nav-prepare')?.classList.remove('active');
        document.getElementById('nav-preview')?.classList.remove('active');
        document.getElementById('nav-flat')?.classList.add('active');
        document.getElementById('nav-device')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.remove('active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('home-sidebar')?.classList.add('hidden');
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('device-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        document.getElementById('flat-page')?.classList.remove('hidden');
        document.getElementById('btn-model-slice')?.classList.add('hidden');
        document.getElementById('btn-model-retry')?.classList.add('hidden');
        document.getElementById('btn-flat-slice')?.classList.remove('hidden');
        this._disposeGcode3DView();
        this._updateSidebarActive('sidebar-nav-flat');
        this._initFlatPage();
    }

    switchToCalibrate() {
        document.getElementById('nav-home')?.classList.remove('active');
        document.getElementById('nav-prepare')?.classList.remove('active');
        document.getElementById('nav-preview')?.classList.remove('active');
        document.getElementById('nav-flat')?.classList.remove('active');
        document.getElementById('nav-device')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.add('active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('home-sidebar')?.classList.add('hidden');
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('device-page')?.classList.add('hidden');
        document.getElementById('flat-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.remove('hidden');
        document.getElementById('btn-model-slice')?.classList.add('hidden');
        document.getElementById('btn-model-retry')?.classList.add('hidden');
        document.getElementById('btn-flat-slice')?.classList.add('hidden');
        document.getElementById('btn-print-gcode')?.classList.add('hidden');
        this._disposeGcode3DView();
        this.refreshPostprocessCommand();
        // 切换回配置页时重新加载当前配置，确保显示最新值
        const configName = this._configValueDisplay?.textContent;
        if (configName && configName !== '未配置' && window.pywebview?.api) {
            window.pywebview.api.load_print_setting(configName).then(result => {
                if (result?.success && result.data) {
                    // 触发自定义事件让 _setupPrintConfigSelect 中的 applyData 重新执行
                    const evt = new CustomEvent('mkp-reload-config', { detail: result.data });
                    document.dispatchEvent(evt);
                }
            }).catch(() => {});
        }
    }

    switchToDevice() {
        this._stopHeadlessPolling();
        document.getElementById('nav-home')?.classList.remove('active');
        document.getElementById('nav-prepare')?.classList.remove('active');
        document.getElementById('nav-preview')?.classList.remove('active');
        document.getElementById('nav-flat')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.remove('active');
        document.getElementById('nav-device')?.classList.add('active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('home-sidebar')?.classList.add('hidden');
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        document.getElementById('flat-page')?.classList.add('hidden');
        document.getElementById('device-page')?.classList.remove('hidden');
        document.getElementById('btn-model-slice')?.classList.add('hidden');
        document.getElementById('btn-model-retry')?.classList.add('hidden');
        document.getElementById('btn-flat-slice')?.classList.add('hidden');
        document.getElementById('btn-print-gcode')?.classList.add('hidden');
        this._disposeGcode3DView();
        this._loadDeviceUrl();
    }

    _loadDeviceUrl() {
        // 从打印机设置读取地址并自动加载
        if (window.pywebview && window.pywebview.api) {
            window.pywebview.api.load_printer_settings().then(result => {
                if (result && result.success && result.settings) {
                    const addr = (result.settings.printerAddress || '').trim();
                    if (addr) {
                        this._loadDeviceIframe(addr);
                    }
                }
            }).catch(() => {});
        }
    }

    _loadDeviceIframe(url) {
        const iframe = document.getElementById('device-iframe');
        const placeholder = document.getElementById('device-placeholder');
        if (!iframe) return;
        let targetUrl = url.trim();
        if (!targetUrl) {
            iframe.style.display = 'none';
            if (placeholder) placeholder.style.display = '';
            return;
        }
        // 自动补全协议
        if (!/^https?:\/\//i.test(targetUrl)) {
            targetUrl = 'http://' + targetUrl;
        }
        iframe.src = targetUrl;
        iframe.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
    }

    _triggerHomeImport() {
        document.getElementById('home-model-input')?.click();
    }

    async _importHomeFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        const supported = ['obj', 'stl', 'gltf', 'glb', 'fbx', 'mkp'];
        if (!supported.includes(ext)) {
            this.showToast('不支持的文件格式: .' + ext, 'error');
            return;
        }
        if (file.path) {
            await this.handleDroppedPath(file.path, file.name);
        } else {
            const reader = new FileReader();
            reader.onload = async (ev) => {
                const base64 = ev.target.result.split(',')[1];
                await this.handleDroppedFile(file.name, base64);
            };
            reader.readAsDataURL(file);
        }
    }

    _handleDrop(e) {
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;

        // pywebview 在部分环境支持 file.path，优先使用原始路径（保留 MTL/纹理关联）
        if (files[0].path) {
            this.handleDroppedPath(files[0].path, files[0].name);
            return;
        }

        // 降级：读取所有拖入文件为 base64，一起传给后端（确保 OBJ+MTL+贴图在同一目录）
        const readers = [];
        for (const file of files) {
            readers.push(new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (evt) => resolve({ name: file.name, data: evt.target.result });
                reader.onerror = () => reject(new Error('读取失败: ' + file.name));
                reader.readAsDataURL(file);
            }));
        }
        Promise.all(readers).then((fileInfos) => {
            this.handleDroppedFiles(fileInfos);
        }).catch((err) => {
            this.showToast(err.message, 'error');
        });
    }

    async handleDroppedFiles(fileInfos) {
        // 找到主模型文件（OBJ/STL/GLTF/GLB/FBX/MKP），其余作为额外文件
        const modelExts = ['obj', 'stl', 'gltf', 'glb', 'fbx', 'mkp'];
        let mainFile = null;
        const extraFiles = [];

        for (const fi of fileInfos) {
            const ext = fi.name.split('.').pop().toLowerCase();
            if (!mainFile && modelExts.includes(ext)) {
                mainFile = fi;
            } else {
                extraFiles.push(fi);
            }
        }

        if (!mainFile) {
            this.showToast('未找到可导入的模型文件', 'error');
            return;
        }

        const ext = mainFile.name.split('.').pop().toLowerCase();

        // OBJ 文件必须同时导入 MTL 和贴图（file.path 不可用时的降级路径）
        if (ext === 'obj') {
            const extraNames = extraFiles.map(f => f.name);
            const extraExts = extraFiles.map(f => f.name.split('.').pop().toLowerCase());
            const hasMtl = extraExts.includes('mtl');
            const imageExts = ['png', 'jpg', 'jpeg', 'bmp', 'tga', 'dds', 'tiff', 'tif', 'webp'];
            const hasTexture = extraExts.some(e => imageExts.includes(e));

            if (!hasMtl || !hasTexture) {
                const missing = [];
                if (!hasMtl) missing.push('MTL 材质文件 (.mtl)');
                if (!hasTexture) missing.push('贴图文件 (.png/.jpg/.bmp 等)');
                this.showToast(
                    'OBJ 文件缺少配套材质，请将以下文件一并拖入：\n' + missing.join('、'),
                    'error'
                );
                return;
            }
        }

        if (!window.pywebview?.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        const name = mainFile.name.replace(/\.[^/.]+$/, '');

        try {
            const extraFilesStr = extraFiles.length > 0 ? JSON.stringify(extraFiles) : null;
            const result = await window.pywebview.api.process_dropped_file(mainFile.name, mainFile.data, extraFilesStr);
            if (!result?.success) {
                this.showToast('导入失败: ' + (result?.error || '未知错误'), 'error');
                return;
            }

            if (ext === 'mkp') {
                this.switchToPrepare();
                this.loadProject(result.project);
                if (result.mkpPath) {
                    this._currentMkpPath = result.mkpPath;
                    window.pywebview.api.add_recent_project(result.mkpPath).catch(() => {});
                }
            } else {
                this.switchToPrepare();
                switch (result.type) {
                    case 'stl':
                        this.loadSTL(result.data, name, result.savedPath);
                        break;
                    case 'obj':
                        this.loadOBJ(result, name, result.savedPath);
                        break;
                    case 'gltf':
                    case 'glb':
                        this.loadGLTF(result.data, name, result.savedPath);
                        break;
                    case 'fbx':
                        this.loadFBX(result.data, name, result.savedPath);
                        break;
                }
            }
        } catch (e) {
            console.error('处理拖拽文件异常:', e);
            this.showToast('导入异常: ' + e.message, 'error');
        }
    }

    async handleDroppedPath(filePath, fileName) {
        if (!window.pywebview?.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        const ext = fileName.split('.').pop().toLowerCase();
        const name = fileName.replace(/\.[^/.]+$/, '');

        try {
            if (ext === 'gcode') {
                await this._onGcodeDropped(filePath);
            } else if (ext === 'mkp') {
                // 复用 load_mkp_project，直接使用原始路径
                const result = await window.pywebview.api.load_mkp_project(filePath);
                if (!result?.success) {
                    this.showToast('打开项目失败: ' + (result?.error || '未知错误'), 'error');
                    return;
                }
                this.switchToPrepare();
                this.loadProject(result.project);
                this._currentMkpPath = filePath;
                window.pywebview.api.add_recent_project(filePath).catch(() => {});
            } else {
                // 复用 load_model_by_path，文件保留在原路径，MTL/纹理可正常找到
                const result = await window.pywebview.api.load_model_by_path(filePath);
                if (!result?.success) {
                    this.showToast('导入失败: ' + (result?.error || '未知错误'), 'error');
                    return;
                }
                this.switchToPrepare();
                switch (result.type) {
                    case 'stl':
                        this.loadSTL(result.data, name, filePath);
                        break;
                    case 'obj':
                        this.loadOBJ(result, name, filePath);
                        break;
                    case 'gltf':
                    case 'glb':
                        this.loadGLTF(result.data, name, filePath);
                        break;
                    case 'fbx':
                        this.loadFBX(result.data, name, filePath);
                        break;
                }
            }
        } catch (e) {
            console.error('处理拖拽文件异常:', e);
            this.showToast('导入异常: ' + e.message, 'error');
        }
    }

    async handleDroppedFile(fileName, base64Data) {
        if (!window.pywebview?.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        const ext = fileName.split('.').pop().toLowerCase();
        const name = fileName.replace(/\.[^/.]+$/, '');

        // 交给后端保存并处理
        try {
            const result = await window.pywebview.api.process_dropped_file(fileName, base64Data);
            if (!result?.success) {
                this.showToast('导入失败: ' + (result?.error || '未知错误'), 'error');
                return;
            }

            if (ext === 'mkp') {
                // MKP 项目
                this.switchToPrepare();
                this.loadProject(result.project);
                if (result.mkpPath) {
                    this._currentMkpPath = result.mkpPath;
                    window.pywebview.api.add_recent_project(result.mkpPath).catch(() => {});
                }
            } else {
                // 模型文件
                this.switchToPrepare();
                switch (result.type) {
                    case 'stl':
                        this.loadSTL(result.data, name, result.savedPath);
                        break;
                    case 'obj':
                        this.loadOBJ(result, name, result.savedPath);
                        break;
                    case 'gltf':
                    case 'glb':
                        this.loadGLTF(result.data, name, result.savedPath);
                        break;
                    case 'fbx':
                        this.loadFBX(result.data, name, result.savedPath);
                        break;
                }
            }
        } catch (e) {
            console.error('处理拖拽文件异常:', e);
            this.showToast('导入异常: ' + e.message, 'error');
        }
    }

    async loadRecentProjects() {
        // 等待 pywebview API 就绪（最多重试 10 次 × 500ms = 5s）
        for (let retry = 0; retry < 10; retry++) {
            if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.get_recent_projects === 'function') break;
            await new Promise(r => setTimeout(r, 500));
        }
        if (!window.pywebview || !window.pywebview.api || typeof window.pywebview.api.get_recent_projects !== 'function') {
            console.warn('pywebview API 未就绪，跳过最近项目加载');
            return;
        }
        try {
            const result = await window.pywebview.api.get_recent_projects();
            if (!result || !result.success) return;

            const container = document.getElementById('recent-projects');
            if (!container) return;

            const projects = result.projects || [];
            if (projects.length === 0) {
                container.innerHTML = '<div class="recent-empty">暂无最近项目</div>';
                return;
            }

            container.innerHTML = '';
            for (const proj of projects) {
                const card = document.createElement('div');
                card.className = 'recent-thumb-card';

                const thumbWrapper = document.createElement('div');
                thumbWrapper.className = 'recent-thumb-wrapper';

                if (proj.thumbnailData) {
                    const thumb = document.createElement('img');
                    thumb.className = 'recent-thumb-image';
                    thumb.src = proj.thumbnailData;
                    thumbWrapper.appendChild(thumb);
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'recent-thumb-placeholder';
                    placeholder.textContent = '📄';
                    thumbWrapper.appendChild(placeholder);
                }

                const info = document.createElement('div');
                info.className = 'recent-thumb-info';

                const name = document.createElement('div');
                name.className = 'recent-thumb-name';
                name.textContent = proj.name || '未命名项目';

                const date = document.createElement('div');
                date.className = 'recent-thumb-date';
                date.textContent = proj.date || '';

                info.appendChild(name);
                info.appendChild(date);

                card.appendChild(thumbWrapper);
                card.appendChild(info);

                card.addEventListener('click', () => {
                    this.switchToPrepare();
                    setTimeout(() => this._openRecentProject(proj.path), 100);
                });

                container.appendChild(card);
            }
        } catch (e) {
            console.error('加载最近项目失败:', e);
        }
    }

    async _openRecentProject(filePath) {
        if (!window.pywebview || !window.pywebview.api) return;
        try {
            const result = await window.pywebview.api.load_mkp_project(filePath);
            if (!result) return;
            if (!result.success) {
                this.showToast('打开项目失败: ' + (result.error || '未知错误'), 'error');
                return;
            }
            this.loadProject(result.project);
            this._currentMkpPath = filePath;
            // 移到最近列表最前
            window.pywebview.api.add_recent_project(filePath).catch(() => {});
        } catch (e) {
            console.error('打开最近项目异常:', e);
            this.showToast('打开项目异常: ' + e.message, 'error');
        }
    }

    captureThumbnail() {
        try {
            // 强制渲染一帧，确保 WebGL 缓冲区有内容
            this.renderer.render(this.scene, this.camera);
            const src = this.renderer.domElement;
            const srcW = src.width;
            const srcH = src.height;

            // 从画布中心裁出正方形，避免拉伸变形
            const size = Math.min(srcW, srcH);
            const sx = (srcW - size) / 2;
            const sy = (srcH - size) / 2;

            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 512;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(src, sx, sy, size, size, 0, 0, 512, 512);
            return canvas.toDataURL('image/png');
        } catch (e) {
            console.error('截图失败:', e);
            return null;
        }
    }

    updateTransformPanel() {
        const panel = document.getElementById('transform-panel');
        if (!panel) return;
        if (this.selectedModels.size === 1 && this.currentMode !== null) {
            panel.classList.remove('hidden');
            this.updateTransformInputs();
        } else {
            panel.classList.add('hidden');
        }
    }

    updateTransformInputs() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        const transformSource = model._transformProxy || model.mesh;
        const box = new THREE.Box3().setFromObject(model.mesh);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        const scaleX = document.getElementById('scale-x');
        const scaleY = document.getElementById('scale-y');
        const scaleZ = document.getElementById('scale-z');
        const sizeX = document.getElementById('size-x');
        const sizeY = document.getElementById('size-y');
        const sizeZ = document.getElementById('size-z');
        const posX = document.getElementById('pos-x');
        const posY = document.getElementById('pos-y');
        const posZ = document.getElementById('pos-z');
        const rotX = document.getElementById('rot-x');
        const rotY = document.getElementById('rot-y');
        const rotZ = document.getElementById('rot-z');

        const _focused = document.activeElement;
        const _isFocused = (el) => el && _focused === el;
        if (scaleX && !_isFocused(scaleX)) scaleX.value = (transformSource.scale.x * 100).toFixed(2);
        if (scaleY && !_isFocused(scaleY)) scaleY.value = (transformSource.scale.y * 100).toFixed(2);
        if (scaleZ && !_isFocused(scaleZ)) scaleZ.value = (transformSource.scale.z * 100).toFixed(2);

        if (sizeX && !_isFocused(sizeX)) sizeX.value = size.x.toFixed(2);
        if (sizeY && !_isFocused(sizeY)) sizeY.value = size.y.toFixed(2);
        if (sizeZ && !_isFocused(sizeZ)) sizeZ.value = size.z.toFixed(2);

        // 位置显示为相对所属盘/自由区容器的局部坐标（盘左下角为 0,0）
        // 模型是世界坐标(scene子节点)，换算：局部 = 世界 − 归属盘左下角世界坐标
        let localCenter = center;
        const pid = model.plateId || this.freePlateId;
        if (pid) {
            const c = this._getPlateWorldPos(pid);
            localCenter = new THREE.Vector3(
                center.x - (c.x - this.bedSize.x / 2),
                center.y - (c.y - this.bedSize.y / 2),
                center.z
            );
        }
        if (posX && !_isFocused(posX)) posX.value = localCenter.x.toFixed(2);
        if (posY && !_isFocused(posY)) posY.value = localCenter.y.toFixed(2);
        if (posZ && !_isFocused(posZ)) posZ.value = localCenter.z.toFixed(2);

        // 校准模型：位置和缩放输入框设为只读
        const isCalib = model._isCalibration === true;
        [scaleX, scaleY, scaleZ, sizeX, sizeY, sizeZ, posX, posY].forEach(el => {
            if (el) el.readOnly = isCalib;
        });

        const liveEuler = new THREE.Euler().setFromQuaternion(transformSource.quaternion, 'XYZ');
        const accum = model._accumRotation || new THREE.Euler(0, 0, 0, 'XYZ');
        const dispX = accum.x + liveEuler.x;
        const dispY = accum.y + liveEuler.y;
        const dispZ = accum.z + liveEuler.z;
        if (rotX && !_isFocused(rotX)) rotX.value = (dispX * 180 / Math.PI).toFixed(2);
        if (rotY && !_isFocused(rotY)) rotY.value = (dispY * 180 / Math.PI).toFixed(2);
        if (rotZ && !_isFocused(rotZ)) rotZ.value = (dispZ * 180 / Math.PI).toFixed(2);
    }

    lockZAxis() {
        this.selectedModels.forEach(id => {
            const model = this.models.get(id);
            if (!model || !model.mesh) return;

            // 强制刷新世界矩阵，确保父级（_transformProxy）的 scale 变化已传播到 mesh
            model.mesh.updateMatrixWorld(true);

            const box = new THREE.Box3().setFromObject(model.mesh);
            const minZ = box.min.z;
            if (Math.abs(minZ) > 0.001) {
                if (model._transformProxy && model.selected) {
                    // 调整 mesh 子级偏移而非 _transformProxy.position，
                    // 避免被 TransformControls 的矩阵分解覆盖
                    const s = model._transformProxy.scale.z || 1;
                    model.mesh.position.z -= minZ / s;
                    model.mesh.updateMatrix();
                    model.mesh.updateMatrixWorld(true);
                } else {
                    model.mesh.position.z -= minZ;
                    model.mesh.updateMatrix();
                    model.mesh.updateMatrixWorld(true);
                }
            }
        });
        this.updateSelectionBoxes();
    }

    bakeTransform(model) {
        // 将当前世界变换烘焙到几何体顶点，重置对象变换为恒等
        // 这会使边界框始终准确，不再依赖矩阵链计算
        const mesh = model.mesh;
        mesh.updateMatrixWorld(true);

        if (!model._accumRotation) model._accumRotation = new THREE.Euler(0, 0, 0, 'XYZ');
        const transformSource = model._transformProxy || model.mesh;
        const liveEuler = new THREE.Euler().setFromQuaternion(transformSource.quaternion, 'XYZ');
        model._accumRotation.x += liveEuler.x;
        model._accumRotation.y += liveEuler.y;
        model._accumRotation.z += liveEuler.z;

        // 记录烘焙前的世界 XY 中心位置
        const preBox = new THREE.Box3().setFromObject(mesh);
        const preCenter = preBox.getCenter(new THREE.Vector3());

        // 把世界矩阵应用到所有几何体顶点（模型是场景全局子节点，世界=自身变换）
        mesh.traverse((child) => {
            if (child.geometry && child.geometry.attributes.position) {
                child.geometry.applyMatrix4(child.matrixWorld);
                child.geometry.computeBoundingBox();
            }
        });

        // 重置子级变换
        mesh.traverse((child) => {
            if (child !== mesh) {
                child.position.set(0, 0, 0);
                child.quaternion.identity();
                child.scale.set(1, 1, 1);
                child.updateMatrix();
            }
        });

        // 重置根变换
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
        mesh.updateMatrix();

        if (model._transformProxy) {
            model._transformProxy.position.set(0, 0, 0);
            model._transformProxy.quaternion.identity();
            model._transformProxy.scale.set(1, 1, 1);
            model._transformProxy.updateMatrix();
            model._transformProxy.updateMatrixWorld(true);
        } else {
            mesh.updateMatrixWorld(true);
        }

        // 重新贴底并对齐包围盒中心
        // proxy 放到视觉中心（Gizmo 跟随），mesh 反向偏移使顶点位置不变
        const targetObject = model._transformProxy || mesh;
        const box = new THREE.Box3().setFromObject(targetObject);
        const center = box.getCenter(new THREE.Vector3());

        if (model._transformProxy) {
            model._transformProxy.position.set(center.x, center.y, center.z);
            model.mesh.position.set(-center.x, -center.y, -(center.z + box.min.z));
            model.mesh.updateMatrix();
            model._transformProxy.updateMatrixWorld(true);
        } else {
            mesh.position.set(preCenter.x, preCenter.y, -box.min.z);
            mesh.updateMatrixWorld(true);
        }

        this.updateSelectionBoxes();
        this.updateTransformInputs();

        // 如果有 proxy 且已选中，延迟刷新 TransformControls 避免与 mouseUp 处理冲突
        if (model._transformProxy && model.selected &&
            this.selectedModels.size === 1 && this.currentMode !== null) {
            const proxy = model._transformProxy;
            setTimeout(() => this.transformControls.attach(proxy), 0);
        }

        // 几何顶点已重排，凸包缓存失效
        this._invalidateHullCache(model);
    }

    // 使某模型的凸包/平面缓存失效（几何/变换变化后调用）
    _invalidateHullCache(model) {
        if (!model) return;
        if (model._hullPlanes) {
            for (const p of model._hullPlanes) {
                if (p.geometry) p.geometry.dispose();
                if (p.material) p.material.dispose();
                if (p.mesh) { if (p.mesh.geometry) p.mesh.geometry.dispose(); if (p.mesh.material) p.mesh.material.dispose(); }
                if (p.raycastMesh) { if (p.raycastMesh.geometry) p.raycastMesh.geometry.dispose(); }
            }
            model._hullPlanes = null;
        }
        if (model._hullPickObjects) {
            for (const o of model._hullPickObjects) { if (o && o.geometry) o.geometry.dispose(); }
            model._hullPickObjects = null;
        }
    }

    // 收集模型所有网格的世界坐标唯一顶点（4 位小数去重，避免重复点拖慢凸包）
    _collectUniqueWorldPoints(model) {
        const mesh = model.mesh;
        mesh.updateMatrixWorld(true);
        const seen = new Set();
        const points = [];
        const pushVertex = (x, y, z) => {
            const key = x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
            if (seen.has(key)) return;
            seen.add(key);
            points.push(new THREE.Vector3(x, y, z));
        };
        mesh.traverse((child) => {
            if (!child.isMesh || !child.geometry) return;
            const pos = child.geometry.attributes.position;
            if (!pos) return;
            const idx = child.geometry.index;
            const n = idx ? idx.count : pos.count;
            const wp = new THREE.Vector3();
            for (let i = 0; i < n; i++) {
                const gi = idx ? idx.getX(i) : i;
                wp.set(pos.getX(gi), pos.getY(gi), pos.getZ(gi)).applyMatrix4(child.matrixWorld);
                pushVertex(wp.x, wp.y, wp.z);
            }
        });
        return points;
    }

    // 基于 OrcaSlicer GLGizmoFlatten::update_planes() 移植：
    // 1. 取模型三维凸包（ConvexHull）
    // 2. 把法线近似相同的相邻三角面合并成一个"平面"（BFS 泛洪）
    // 3. 剔除过小/过窄面，只保留面积最大的 254 个
    // 4. 向质心收缩 10% -> 用平滑迭代磨圆角 -> 沿法线抬升 0.1 防闪烁
    // 5. 三角扇生成几何，缓存到 model._hullPlanes
    _computeHullPlanes(model) {
        if (!model || !model.mesh) return null;
        if (model._hullPlanes) return model._hullPlanes;
        const points = this._collectUniqueWorldPoints(model);
        if (points.length < 4) return null;

        let hull;
        try {
            hull = new ConvexHull().setFromPoints(points);
        } catch (e) {
            console.warn('convex hull failed:', e);
            return null;
        }
        const faces = hull.faces; // Face[] ; face.normal、face.edge(HalfEdge 链) 可访问顶点与邻接
        const numFaces = faces.length;

        const sameNormal = (a, b) => Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001 && Math.abs(a.z - b.z) < 0.001;

        // 建立 face 对象 -> 下标的映射，再做 BFS 合并共面相邻三角面成"平面"
        const faceIndex = new Map();
        for (let i = 0; i < numFaces; i++) faceIndex.set(faces[i], i);
        const planeVisited = new Array(numFaces).fill(false);
        const resultPlanes = [];

        for (let start = 0; start < numFaces; start++) {
            if (planeVisited[start]) continue;
            const refNormal = faces[start].normal;
            const queue = [start];
            planeVisited[start] = true;
            const poly = [];
            // 只收集"与基准法线一致"的相邻三角面并扩散；法线不一致的邻居不标记、不入队，
            // 留给外层循环当作新的平面种子，否则第一次泛洪会把不同方向的侧面提前"吃掉"，
            // 导致方块只有顶/底两个平面、侧面消失。
            while (queue.length) {
                const fi = queue.pop();
                const face = faces[fi];
                let e = face.edge;
                do {
                    const p = e.vertex.point;
                    poly.push(new THREE.Vector3(p.x, p.y, p.z));
                    e = e.next;
                } while (e !== face.edge);
                // 只向同样共面的邻居扩散
                let nbr = face.edge;
                do {
                    const twin = nbr.twin;
                    if (twin) {
                        const nfi = faceIndex.get(twin.face);
                        if (nfi !== undefined && !planeVisited[nfi] && sameNormal(twin.face.normal, refNormal)) {
                            planeVisited[nfi] = true;
                            queue.push(nfi);
                        }
                    }
                    nbr = nbr.next;
                } while (nbr !== face.edge);
            }
            if (poly.length < 3) continue; // 至少一个三角形
            const normal = new THREE.Vector3().copy(refNormal).normalize();
            resultPlanes.push({ normal, verts: poly });
        }

        // ---- 后处理：剔除 + 收缩 + 磨圆 + 抬升 + 三角化（全部沿用 Orca 逻辑） ----
        // 阈值按模型尺寸相对缩放：Orca 按真实毫米模型用 5mm²/1mm，小模型需等比缩小，
        // 否则 8mm 的小猫几乎所有凸包面都会被滤掉。这里以模型包围盒对角线为基准；
        // 换算因子参考 Orca 默认模型（约 100mm 级）→ 面积比例 5/100²、边长比例 1/100。
        const diagLen = (() => {
            const bb2 = new THREE.Box3();
            for (const p of points) bb2.expandByPoint(p);
            return bb2.getSize(new THREE.Vector3()).length();
        })();
        const scaleF = Math.max(diagLen / 100.0, 0.001);
        // 温和过滤：只去掉过小到无意义的凸包面（避免渲染无数极小的碎面），
        // 但阈值相对模型尺寸缩放且留足余量，避免误杀球的两极、方块的侧面。
        const minimal_area = 0.1 * scaleF * scaleF;
        const minimal_side = 0.12 * scaleF;
        const minimal_angle = 15.0 * Math.PI / 180.0;

        const processed = [];
        for (const plane of resultPlanes) {
            // 先算凸包多边形轮廓（合并后 poly 含重复点，先对点集求凸包外壳多边形）
            let polygon = this._hullPolygonOutline(plane.verts);
            if (!polygon || polygon.length < 3) continue;

            // 淘汰：任一边过短
            let smallSide = false;
            for (let i = 0; i < polygon.length; i++) {
                const a = polygon[i], b = polygon[(i + 1) % polygon.length];
                if (a.distanceTo(b) < minimal_side) { smallSide = true; break; }
            }
            if (smallSide) continue;

            // 真实面积：用扇形三角化求和每个三角形的面积（叉积模长），坐标系无关、平移无关
            let area = 0;
            {
                const o = new THREE.Vector3();
                for (const p of polygon) o.add(p);
                o.divideScalar(polygon.length);
                const n = polygon.length;
                for (let i = 0; i < n; i++) {
                    const a = polygon[i], b = polygon[(i + 1) % n];
                    const tri = new THREE.Vector3().subVectors(a, o).cross(new THREE.Vector3().subVectors(b, o));
                    area += tri.length();
                }
                area *= 0.5;
            }
            if (area < minimal_area) continue;

            // 角度检查（最小内角）
            let badAngle = false;
            for (let i = 0; i < polygon.length; i++) {
                const prec = polygon[(i + polygon.length - 1) % polygon.length];
                const curr = polygon[i];
                const next = polygon[(i + 1) % polygon.length];
                const d1 = new THREE.Vector3().subVectors(prec, curr).normalize();
                const d2 = new THREE.Vector3().subVectors(next, curr).normalize();
                if (d1.angleTo(d2) < minimal_angle) { badAngle = true; break; }
            }
            if (badAngle) continue;

            // 向质心收缩 10%（避免接触模型边缘）
            const centroid = new THREE.Vector3();
            for (const v of polygon) centroid.add(v);
            centroid.divideScalar(polygon.length);
            for (const v of polygon) v.lerp(centroid, 0.1);

            // 磨圆：Orca 的迭代平滑
            polygon = this._roundPolygonCorners(polygon, 10, 0.2);

            // 抬升：沿法线抬 0.1 防 z-fighting
            const lift = plane.normal.clone().multiplyScalar(0.1);
            for (const v of polygon) v.add(lift);

            processed.push({ normal: plane.normal, polygon });
        }

        // 按面积降序，只保留面积最大的 254 个（过多会拖慢渲染）
        const withArea = processed.map((p) => {
            let area = 0;
            {
                const plg = p.polygon;
                const o = new THREE.Vector3();
                for (const pt of plg) o.add(pt);
                o.divideScalar(plg.length);
                const n = plg.length;
                for (let i = 0; i < n; i++) {
                    const ta = plg[i], tb = plg[(i + 1) % n];
                    const tri = new THREE.Vector3().subVectors(ta, o).cross(new THREE.Vector3().subVectors(tb, o));
                    area += tri.length();
                }
                area *= 0.5;
            }
            return { ...p, _area: area };
        });
        withArea.sort((a, b) => b._area - a._area);
        const top = withArea.slice(0, 254);

        // 生成每个平面的渲染数据：三角扇填充 + 圆角多边形外轮廓（供描边）
        const planes = top.map((p) => {
            const verts = p.polygon;
            const positions = [];
            const pts = [];
            for (const v of verts) { positions.push(v.x, v.y, v.z); pts.push(v); }
            const indices = [];
            for (let i = 1; i < pts.length - 1; i++) indices.push(0, i, i + 1);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
            geom.setIndex(indices);
            geom.computeVertexNormals();
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.5,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            return { normal: p.normal, geometry: geom, material: mat, area: p._area, polygon: pts };
        });

        model._hullPlanes = planes;
        return planes;
    }

    // 对给定顶点集求其二维凸包多边形（投影到法线平面），返回按序顶点数组
    _hullPolygonOutline(verts) {
        if (!verts || verts.length < 3) return null;
        // 用三个不共线点建立局部坐标系，投影到 2D 做单调链凸包
        // 简化：直接用 ConvexGeometry 求小凸包来获得轮廓（点的顺序由 QuickHull 保证）
        // 但为了得到简单有序的外轮廓，这里用角度排序法。
        // 先求质心
        const c = new THREE.Vector3();
        for (const v of verts) c.add(v);
        c.divideScalar(verts.length);
        // 计算近似法线（用前三个不共线点）
        let n = new THREE.Vector3();
        const v0 = verts[0];
        for (let i = 1; i < verts.length - 1; i++) {
            n = new THREE.Vector3().subVectors(verts[i], v0).cross(new THREE.Vector3().subVectors(verts[i + 1], v0));
            if (n.lengthSq() > 1e-12) break;
        }
        n.normalize();
        // 建立平面内两个正交轴
        const ref = new THREE.Vector3(1, 0, 0);
        if (Math.abs(n.dot(ref)) > 0.99) ref.set(0, 1, 0);
        const u = new THREE.Vector3().crossVectors(n, ref).normalize();
        const v = new THREE.Vector3().crossVectors(n, u).normalize();
        // 投影并绕质心按极角排序
        const proj = [];
        for (const p of verts) {
            const d = new THREE.Vector3().subVectors(p, c);
            proj.push({ x: d.dot(u), y: d.dot(v), p });
        }
        // 去掉重复投影点
        const seen = new Set();
        const uniq = [];
        for (const pr of proj) {
            const key = pr.x.toFixed(4) + ',' + pr.y.toFixed(4);
            if (seen.has(key)) continue;
            seen.add(key);
            uniq.push(pr);
        }
        if (uniq.length < 3) return null;
        // 以重心为极点，按角度排序得到凸包顺序（对近似凸点集有效）
        uniq.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
        return uniq.map((pr) => pr.p.clone());
    }

    // Orca 的角点磨圆算法：多次迭代把每个角向邻边中点平均方向收缩
    _roundPolygonCorners(polygon, k, aggressivity) {
        const N = polygon.length;
        if (N < 3 || k === 0) return polygon.slice();
        const pts = polygon.slice();
        const neighbours = [];
        const points_out = [];
        for (let j = 0; j < N; j++) {
            points_out[j * 2 * k] = pts[j].clone();
            neighbours.push([(j * 2 * k - k < 0) ? (N - 1) * 2 * k + k : j * 2 * k - k, j * 2 * k + k]);
        }
        for (let i = 0; i < k; i++) {
            for (let j = 0; j < N; j++) {
                if (i === 0) {
                    points_out[j * 2 * k + k] = new THREE.Vector3().copy(points_out[j * 2 * k])
                        .add(points_out[j === N - 1 ? 0 : (j + 1) * 2 * k]).multiplyScalar(0.5);
                } else {
                    const r = 0.2 + 0.3 / (k - 1) * i;
                    points_out[neighbours[j][0]] = new THREE.Vector3().copy(points_out[j * 2 * k]).multiplyScalar(r)
                        .addScaledVector(points_out[neighbours[j][0] - 1], 1 - r);
                    points_out[neighbours[j][1]] = new THREE.Vector3().copy(points_out[j * 2 * k]).multiplyScalar(r)
                        .addScaledVector(points_out[neighbours[j][1] + 1], 1 - r);
                }
            }
            for (let j = 0; j < N; j++) {
                const p = points_out[2 * k * j];
                points_out[2 * k * j] = new THREE.Vector3().copy(p).multiplyScalar(1 - aggressivity)
                    .addScaledVector(new THREE.Vector3().copy(points_out[neighbours[j][0]]).add(points_out[neighbours[j][1]]).multiplyScalar(0.5), aggressivity);
            }
            for (const nb of neighbours) { nb[0]++; nb[1]--; }
        }
        return points_out;
    }

    // 把指定平面（planeIndices 为 _hullPlanes 的下标）渲染成 Group（世界坐标）：
    // 每个平面 = 半透明填充 + 圆角亮边轮廓（参考图那种"明亮三角面 + 清晰边线"）
    _buildPlaneOverlay(model, planeIndices, style) {
        const planes = this._computeHullPlanes(model);
        if (!planes) return null;
        const opts = style || {};
        const group = new THREE.Group();
        const renderOrder = opts.renderOrder !== undefined ? opts.renderOrder : 1;
        for (const idx of (Array.isArray(planeIndices) ? planeIndices : [planeIndices])) {
            const plane = planes[idx];
            if (!plane) continue;
            const mat = new THREE.MeshBasicMaterial({
                color: opts.fillColor !== undefined ? opts.fillColor : 0xffffff,
                transparent: true,
                opacity: opts.opacity !== undefined ? opts.opacity : 0.5,
                side: THREE.DoubleSide,
                depthTest: opts.depthTest !== undefined ? opts.depthTest : true,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: 4,
                polygonOffsetUnits: 4
            });
            const mesh = new THREE.Mesh(plane.geometry, mat);
            mesh.renderOrder = renderOrder;
            group.add(mesh);

            // 圆角亮边：沿多边形轮廓画一圈闭合圆头线（Line2）
            if (opts.showOutline !== false && plane.polygon && plane.polygon.length >= 2) {
                const pts = plane.polygon;
                const polyPts = [];
                for (const p of pts) polyPts.push(p.x, p.y, p.z);
                polyPts.push(pts[0].x, pts[0].y, pts[0].z); // 闭合
                const lineGeom = new LineGeometry();
                lineGeom.setPositions(polyPts);
                const lineMat = new LineMaterial({
                    color: opts.outlineColor !== undefined ? opts.outlineColor : 0xa7ff6b,
                    linewidth: opts.outlineWidth !== undefined ? opts.outlineWidth : 3,
                    transparent: true,
                    opacity: opts.outlineOpacity !== undefined ? opts.outlineOpacity : 0.9,
                    depthTest: opts.depthTest !== undefined ? opts.depthTest : true,
                    depthWrite: false
                });
                if (this.renderer) {
                    const c = this.renderer.domElement;
                    lineMat.resolution.set(c.width, c.height);
                }
                const line = new Line2(lineGeom, lineMat);
                line.renderOrder = renderOrder + 1;
                group.add(line);
            }
        }
        return group;
    }

    // 返回光标射线命中的平面下标（-1 表示未命中）
    _pickPlane(model, raycaster) {
        const planes = this._computeHullPlanes(model);
        if (!planes) return -1;
        if (!model._hullPickObjects) model._hullPickObjects = [];
        if (model._hullPickObjects.length !== planes.length) model._hullPickObjects = [];
        let objects = model._hullPickObjects;
        for (let i = 0; i < planes.length; i++) {
            if (!objects[i]) {
                objects[i] = new THREE.Mesh(planes[i].geometry);
                objects[i].matrixAutoUpdate = false;
            }
            objects[i].matrixWorld.identity();
            objects[i].updateMatrixWorld(true);
        }
        const inter = raycaster.intersectObjects(objects, false);
        if (inter.length === 0) return -1;
        return objects.indexOf(inter[0].object);
    }

    saveState(description = '操作') {
        const state = {
            description: description,
            timestamp: new Date().toISOString(),
            models: {}
        };
        this.models.forEach((model, id) => {
            const transformSource = model._transformProxy || model.mesh;

            // 统一以【全局坐标】为准：无论模型当前挂在 proxy、scene 还是盘板容器下，
            // 都取 world 变换作为记录标准，避免盘板局部坐标错位。
            const worldPosition = new THREE.Vector3();
            const worldQuaternion = new THREE.Quaternion();
            const worldScale = new THREE.Vector3();
            model.mesh.getWorldPosition(worldPosition);
            model.mesh.getWorldQuaternion(worldQuaternion);
            model.mesh.getWorldScale(worldScale);

            const accum = model._accumRotation || new THREE.Euler(0, 0, 0, 'XYZ');
            state.models[id] = {
                name: model.name,
                position: {
                    x: transformSource.position.x,
                    y: transformSource.position.y,
                    z: transformSource.position.z
                },
                rotation: {
                    x: transformSource.rotation.x,
                    y: transformSource.rotation.y,
                    z: transformSource.rotation.z
                },
                scale: {
                    x: transformSource.scale.x,
                    y: transformSource.scale.y,
                    z: transformSource.scale.z
                },
                accumRotation: { x: accum.x, y: accum.y, z: accum.z },
                meshOffset: {
                    x: model.mesh.position.x,
                    y: model.mesh.position.y,
                    z: model.mesh.position.z
                },
                hasProxy: !!model._transformProxy,
                // 全局坐标快照（撤销/重做还原时的统一基准）
                worldPosition: {
                    x: worldPosition.x, y: worldPosition.y, z: worldPosition.z
                },
                worldRotation: {
                    x: worldQuaternion.x, y: worldQuaternion.y, z: worldQuaternion.z, w: worldQuaternion.w
                },
                worldScale: {
                    x: worldScale.x, y: worldScale.y, z: worldScale.z
                },
                // 烘焙后的全局几何顶点快照：每项 = { array: 全局坐标顶点（JSON 安全纯数组） }，
                // 用于烘焙后精确还原几何形状
                worldGeometry: this._captureWorldGeometry(model.mesh)
            };
        });
        const info = this.historyManager.record(state);
        this.updateUndoRedoButtons();
        return info;
    }

    // 把模型所有子网格的 position 顶点烘焙成全局坐标的快照。
    // 返回 JSON 安全的纯 JS 数组（HistoryManager.record 会 JSON 序列化，不能存 TypedArray）。
    _captureWorldGeometry(mesh) {
        mesh.updateMatrixWorld(true);
        const list = [];
        mesh.traverse((child) => {
            if (!child.geometry || !child.geometry.attributes || !child.geometry.attributes.position) return;
            const posAttr = child.geometry.attributes.position;
            const src = posAttr.array;
            if (!(src instanceof Float32Array)) return; // 非 Float32 缓冲区走旧的 transform-only 路径
            const tmp = new THREE.BufferGeometry();
            tmp.setAttribute('position', new THREE.BufferAttribute(new Float32Array(src), posAttr.itemSize));
            tmp.applyMatrix4(child.matrixWorld);
            const out = tmp.attributes.position.array;
            list.push({ array: Array.prototype.slice.call(out) });
            tmp.dispose();
        });
        return list;
    }

    restoreState(result) {
        if (!result || !result.state) return;
        const state = result.state;
        this.isUndoRedo = true;

        this.models.forEach((model, id) => {
            if (!state.models || !state.models[id]) return;
            const modelState = state.models[id];
            if (!model._accumRotation) model._accumRotation = new THREE.Euler(0, 0, 0, 'XYZ');
            if (modelState.accumRotation) {
                model._accumRotation.set(modelState.accumRotation.x || 0, modelState.accumRotation.y || 0, modelState.accumRotation.z || 0);
            } else if (!Array.isArray(modelState.worldGeometry) || !modelState.worldGeometry.length) {
                model._accumRotation.set(modelState.rotation.x || 0, modelState.rotation.y || 0, modelState.rotation.z || 0);
            }

            if (Array.isArray(modelState.worldGeometry) && modelState.worldGeometry.length) {
                // 新快照：还原烘焙后的全局几何，并按全局坐标放置
                this._applySnapshot(model, modelState);
            } else {
                // 旧快照（无 geometry 快照）：走原来的 transform-only 兼容路径
                const meshOffset = modelState.meshOffset || { x: 0, y: 0, z: 0 };
                if (model.selected && model._transformProxy) {
                    model._transformProxy.position.set(modelState.position.x, modelState.position.y, modelState.position.z);
                    model._transformProxy.rotation.set(modelState.rotation.x, modelState.rotation.y, modelState.rotation.z);
                    model._transformProxy.scale.set(modelState.scale.x, modelState.scale.y, modelState.scale.z);
                    model.mesh.position.set(meshOffset.x, meshOffset.y, meshOffset.z);
                    model.mesh.quaternion.identity();
                    model.mesh.scale.set(1, 1, 1);
                    model.mesh.updateMatrix();
                    model._transformProxy.updateMatrixWorld(true);
                } else {
                    model.mesh.position.set(modelState.position.x, modelState.position.y, modelState.position.z);
                    model.mesh.rotation.set(modelState.rotation.x, modelState.rotation.y, modelState.rotation.z);
                    model.mesh.scale.set(modelState.scale.x, modelState.scale.y, modelState.scale.z);
                    model.mesh.updateMatrixWorld(true);
                }
            }
        });

        // lockZAxis 会再调 mesh.position.z 贴底，需在顶点快照恢复之后执行
        this.lockZAxis();
        this.updateTransformInputs();
        this.updateSelectionBoxes();
        this.isUndoRedo = false;
        
        return result.info;
    }

    // 按快照还原模型：写回烘焙后的全局几何顶点 + 放到全局坐标
    _applySnapshot(model, modelState) {
        const mesh = model.mesh;

        // 1) 从 proxy / 盘板容器中脱离，回到全局自由区（场景）以保持“全局坐标”语义
        if (this.transformControls && this.transformControls.object === model._transformProxy) {
            this.transformControls.detach();
        }
        if (model._transformProxy) {
            if (mesh.parent === model._transformProxy) model._transformProxy.remove(mesh);
            if (model._transformProxy.parent) model._transformProxy.parent.remove(model._transformProxy);
            model._transformProxy = null;
        }
        const parent = mesh.parent;
        const host = this.freePlateGroup || this.scene;
        if (parent && parent !== this.scene && parent !== this.freePlateGroup) {
            parent.remove(mesh);
        }
        if (mesh.parent !== host) host.add(mesh);

        // 2) 写回全局顶点快照（遍历顺序与 _captureWorldGeometry 一致）
        const snaps = modelState.worldGeometry || [];
        let snapIdx = 0;
        mesh.traverse((child) => {
            if (!child.geometry || !child.geometry.attributes || !child.geometry.attributes.position) return;
            const snap = snaps[snapIdx++];
            if (!snap || !snap.array) return;
            const posAttr = child.geometry.attributes.position;
            if (!(posAttr.array instanceof Float32Array)) return;
            const n = Math.min(posAttr.count * posAttr.itemSize, snap.array.length);
            if (n <= 0) return;
            for (let i = 0; i < n; i++) posAttr.array[i] = snap.array[i];
            posAttr.needsUpdate = true;
            child.geometry.attributes.position = posAttr;
            child.geometry.computeBoundingBox();
            child.geometry.computeBoundingSphere();
        });

        // 3) 置网格变换为恒等：顶点已含全局坐标，不需额外位移
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);

        // 4) 归属盘按模型全局中心重算（只改逻辑 plateId，不重挂父节点）
        this._assignModelToPlateByPosition(model);

        // 5) 几何已重排，凸包缓存失效
        this._invalidateHullCache(model);

        // 6) 若该模型仍处于选中态，重建 proxy/selectionBox 使 gizmo 跟随
        if (model.selected && this.selectedModels.has(model.id)) {
            this.selectModelInternal(model);
        }
    }

    undo() {
        const state = this.historyManager.undo();
        if (state) {
            this.restoreState(state);
            this.updateUndoRedoButtons();
        }
    }

    redo() {
        const state = this.historyManager.redo();
        if (state) {
            this.restoreState(state);
            this.updateUndoRedoButtons();
        }
    }

    updateUndoRedoButtons() {
        const undoBtn = document.getElementById('btn-undo');
        const redoBtn = document.getElementById('btn-redo');
        if (undoBtn) undoBtn.style.opacity = this.historyManager.canUndo() ? '1' : '0.3';
        if (redoBtn) redoBtn.style.opacity = this.historyManager.canRedo() ? '1' : '0.3';
    }

    copyModel() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        // 获取世界坐标（避免选中状态下 mesh.position 是代理空间下的局部偏移）
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        model.mesh.getWorldPosition(worldPos);
        model.mesh.getWorldQuaternion(worldQuat);
        model.mesh.getWorldScale(worldScale);

        this.clipboard = {
            sourceModelId: modelId,
            position: worldPos,
            quaternion: worldQuat,
            scale: worldScale
        };
    }

    pasteModel() {
        if (!this.clipboard) return;

        const sourceModel = this.models.get(this.clipboard.sourceModelId);
        if (!sourceModel) return;

        this.saveState('粘贴模型');

        // 克隆源模型（深拷贝 geometry 避免共享引用导致变换相互影响）
        const newMesh = sourceModel.mesh.clone();
        newMesh.traverse((child) => {
            if (child.isMesh) {
                if (child.geometry) {
                    child.geometry = child.geometry.clone();
                }
                if (child.material) {
                    // 若源材质处于“不可打印”灰化状态，克隆其已保存的原始材质作为副本底材
                    const srcMat = child.material;
                    const saved = this._savedPrintMaterials.get(srcMat);
                    child.material = (saved || srcMat).clone();
                }
            }
        });

        const newModelId = this.nextModelId++;
        const newName = `${sourceModel.name} (副本)`;
        const newModelObj = new ModelObject(newMesh, newName, newModelId);
        // 继承源模型的可打印状态与所属盘，避免副本状态与外观/控件不一致
        newModelObj.printable = sourceModel.printable;
        newModelObj.plateId = sourceModel.plateId;

        // 更新 userData.modelId，避免点击选中母本
        newMesh.traverse((child) => {
            if (child.isMesh || child.userData.isModel) {
                child.userData.modelId = newModelId;
            }
        });

        // 使用剪贴板中的世界坐标 + 偏移
        newMesh.position.copy(this.clipboard.position);
        newMesh.position.x += 20;
        newMesh.position.y += 20;
        if (this.clipboard.quaternion) {
            newMesh.quaternion.copy(this.clipboard.quaternion);
        } else {
            newMesh.rotation.copy(this.clipboard.rotation);
        }
        newMesh.scale.copy(this.clipboard.scale);

        this.models.set(newModelId, newModelObj);
        this.scene.add(newMesh);
        // 仅当副本为不可打印时重设灰色外观并登记副本自身的原始材质，保证后续切换能正确还原
        if (!newModelObj.printable) this._updateModelPrintAppearance(newModelObj);

        const filePath = this.modelFilePaths.get(this.clipboard.sourceModelId);
        if (filePath) {
            this.modelFilePaths.set(newModelId, filePath);
        }

        this.selectModelById(newModelId, true);
        this.updateObjectList();
        this.saveState('粘贴模型');
    }

    selectAll() {
        this.models.forEach((model, id) => {
            if (!model.selected) {
                model.selected = true;
                this.selectedModels.add(id);
                this.selectModelInternal(model);
            }
        });
        this.updateObjectList();
        this.updateTransformPanel();
    }

    deleteSelectedModels() {
        if (this.selectedModels.size === 0) return;
        this.saveState();

        const idsToDelete = Array.from(this.selectedModels);
        idsToDelete.forEach(id => {
            this.deleteModelById(id);
        });
    }

    // ---------- 组合 / 解组 ----------
    groupSelected() {
        if (this.selectedModels.size < 2) {
            this.showToast('请至少选中两个模型进行组合', 'warning');
            return;
        }

        this.saveState('组合对象');

        const selectedModelIds = Array.from(this.selectedModels);

        // 1. 计算组中心（所有选中模型世界包围盒的中心）
        const groupBox = new THREE.Box3();
        selectedModelIds.forEach(id => {
            const model = this.models.get(id);
            if (!model) return;
            model.mesh.updateMatrixWorld(true);
            groupBox.union(new THREE.Box3().setFromObject(model.mesh));
        });
        const groupCenter = groupBox.getCenter(new THREE.Vector3());
        const groupCenterMatrix = new THREE.Matrix4().makeTranslation(groupCenter.x, groupCenter.y, groupCenter.z);
        const invGroupCenter = new THREE.Matrix4().copy(groupCenterMatrix).invert();

        // 2. 遍历每个模型，收集子网格、记录解组信息（保留各自的几何/材质/贴图）
        const groupDataParts = [];
        const groupMeshes = [];   // 组合体内的子网格：几何 + 材质 + 贴图原样保留

        selectedModelIds.forEach(modelId => {
            const model = this.models.get(modelId);
            if (!model) return;

            model.mesh.updateMatrixWorld(true);

            const subMeshData = [];
            model.mesh.traverse((child) => {
                if (child.isMesh && child.geometry && child.geometry.attributes.position) {
                    // 计算该子网格相对组中心的局部变换
                    const localMatrix = new THREE.Matrix4().multiplyMatrices(invGroupCenter, child.matrixWorld);

                    // 复刻一个子网格：几何 + 材质 + 贴图原样保留，定位到组内局部坐标
                    const partMesh = new THREE.Mesh(child.geometry.clone(), child.material);
                    partMesh.applyMatrix4(localMatrix);
                    partMesh.castShadow = true;
                    partMesh.receiveShadow = true;
                    groupMeshes.push(partMesh);

                    // 保存原始几何体和局部变换，用于解组
                    subMeshData.push({
                        geometry: child.geometry.clone(),
                        material: child.material,
                        localMatrix: localMatrix.clone(),
                    });
                }
            });

            // 正确取消选中（清理 selection box 和 proxy），再从场景和 models 移除
            if (model.selected) {
                this.deselectModelInternal(model);
            }
            this.scene.remove(model.mesh);
            this.selectedModels.delete(modelId);
            this.models.delete(modelId);

            groupDataParts.push({
                name: model.name,
                subMeshes: subMeshData,
            });
        });

        // 3. 组合体 = 一个 THREE.Group，原点置于组中心；子网格各保留材质/贴图，不再强行合并几何体
        //    （这避免了合并丢失 UV 和贴图导致纹理错乱）
        const groupRoot = new THREE.Group();
        groupMeshes.forEach((m) => groupRoot.add(m));
        groupRoot.position.copy(groupCenter);
        groupRoot.userData.isGroupRoot = true;

        const modelId = this.nextModelId++;
        groupRoot.userData.modelId = modelId;

        this.scene.add(groupRoot);

        const modelObj = new ModelObject(groupRoot, `组合体 ${modelId}`, modelId);
        modelObj._groupData = {
            center: groupCenter.clone(),
            parts: groupDataParts,
        };
        this.models.set(modelId, modelObj);

        // 5. 选中新组合体
        this.selectedModels.add(modelId);
        modelObj.selected = true;
        this.selectModelInternal(modelObj);

        this.updateObjectList();
        this.updateTransformPanel();
    }

    _mergeGeometries(geometries) {
        let totalVertices = 0;
        for (const geo of geometries) {
            totalVertices += geo.attributes.position.count;
        }

        const positions = new Float32Array(totalVertices * 3);
        let offset = 0;

        for (const geo of geometries) {
            const posArray = geo.attributes.position.array;
            positions.set(posArray, offset * 3);
            offset += geo.attributes.position.count;
        }

        const merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        // 焊接重复顶点建立索引，使 computeVertexNormals 产生平滑法线
        this._weldVertices(merged);

        merged.computeVertexNormals();
        merged.computeBoundingBox();
        merged.computeBoundingSphere();

        return merged;
    }

    _weldVertices(geometry) {
        const posAttr = geometry.attributes.position;
        const positions = posAttr.array;
        const count = posAttr.count;

        const posHash = new Map();
        const uniquePositions = [];
        const indices = [];

        for (let i = 0; i < count; i++) {
            const x = positions[i * 3];
            const y = positions[i * 3 + 1];
            const z = positions[i * 3 + 2];
            // 四舍五入到 3 位小数作为焊接容差
            const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

            if (posHash.has(key)) {
                indices.push(posHash.get(key));
            } else {
                const idx = uniquePositions.length / 3;
                uniquePositions.push(x, y, z);
                posHash.set(key, idx);
                indices.push(idx);
            }
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(uniquePositions), 3));
        geometry.setIndex(indices);
    }

    ungroupSelected() {
        // 查找选中的组合体（带有 _groupData 的模型）
        let targetModel = null;
        let targetId = null;
        for (const id of this.selectedModels) {
            const model = this.models.get(id);
            if (model && model._groupData) {
                targetModel = model;
                targetId = id;
                break;
            }
        }

        if (!targetModel) {
            this.showToast('请选中一个组合体进行解组', 'warning');
            return;
        }

        this.saveState('解组对象');

        const groupData = targetModel._groupData;
        const mergedMesh = targetModel.mesh;
        mergedMesh.updateMatrixWorld(true);
        const mergedWorldMatrix = mergedMesh.matrixWorld.clone();

        // 为每个原始模型重建网格
        groupData.parts.forEach((part, idx) => {
            const partGroup = new THREE.Group();

            part.subMeshes.forEach(sub => {
                // 计算子网格的新世界矩阵 = 合并mesh当前世界矩阵 × 组内局部矩阵
                const newWorldMatrix = new THREE.Matrix4().multiplyMatrices(mergedWorldMatrix, sub.localMatrix);

                const childMesh = new THREE.Mesh(sub.geometry, sub.material);
                const pos = new THREE.Vector3();
                const quat = new THREE.Quaternion();
                const scale = new THREE.Vector3();
                newWorldMatrix.decompose(pos, quat, scale);
                childMesh.position.copy(pos);
                childMesh.quaternion.copy(quat);
                childMesh.scale.copy(scale);
                childMesh.castShadow = true;
                childMesh.receiveShadow = true;

                partGroup.add(childMesh);
            });

            this.scene.add(partGroup);

            const modelId = this.nextModelId++;
            partGroup.userData.modelId = modelId;

            const modelName = part.name || `零件 ${idx + 1}`;
            const modelObj = new ModelObject(partGroup, modelName, modelId);
            this.models.set(modelId, modelObj);
        });

        // 移除合并后的 mesh
        if (targetModel.selected) {
            this.deselectModelInternal(targetModel);
        }
        this.selectedModels.delete(targetId);
        this.scene.remove(mergedMesh);
        this.models.delete(targetId);

        this.saveState('解组对象');
        this.updateObjectList();
        this.updateTransformPanel();
    }

    fitCameraToModel(mesh) {
        if (!mesh) return;
        const box = new THREE.Box3().setFromObject(mesh);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const bedCenter = new THREE.Vector3(this.bedSize.x / 2, this.bedSize.y / 2, 0);

        if (this.camera.isOrthographicCamera) {
            // 正交相机：调整 zoom 级别而非相机距离
            const padding = 1.5;
            const halfSizeFromModel = maxDim * padding;
            const halfSizeFromBed = Math.max(this.bedSize.x, this.bedSize.y) * 0.55;
            this._orthoHalfSize = Math.max(halfSizeFromModel, halfSizeFromBed);

            // 更新投影矩阵
            const aspect = this.container.clientWidth / this.container.clientHeight;
            this.camera.left = -this._orthoHalfSize * aspect;
            this.camera.right = this._orthoHalfSize * aspect;
            this.camera.top = this._orthoHalfSize;
            this.camera.bottom = -this._orthoHalfSize;
            this.camera.updateProjectionMatrix();

            // 从斜上方俯视，X 对齐床中心使地平线与 X 轴（Y=0 线）平行
            const dist = Math.max(this.bedSize.x, this.bedSize.y) * 0.85;
            const angle = Math.PI / 4;
            this.camera.position.set(
                bedCenter.x,
                bedCenter.y - dist * Math.cos(angle),
                bedCenter.z + dist * Math.sin(angle)
            );
        } else {
            // 透视相机：按 FOV 计算合适距离
            const fov = this.camera.fov * (Math.PI / 180);
            let cameraDist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 2.5;
            const minDistance = Math.max(this.bedSize.x, this.bedSize.y) * 0.8;
            const maxDistance = Math.max(this.bedSize.x, this.bedSize.y) * 3;
            cameraDist = Math.max(cameraDist, minDistance);
            cameraDist = Math.min(cameraDist, maxDistance);

            const angle = Math.PI / 4;
            const horizontalDist = cameraDist * Math.cos(angle);
            const verticalDist = cameraDist * Math.sin(angle);
            this.camera.position.set(
                bedCenter.x,
                bedCenter.y - horizontalDist,
                bedCenter.z + verticalDist
            );
        }

        this.camera.lookAt(bedCenter);
        this.orbitControls.target.copy(bedCenter);
        this.orbitControls.update();
    }

    resetView() {
        this.camera.position.set(this.bedSize.x / 2, this.bedSize.y / 2, 400);
        this.camera.lookAt(this.bedSize.x / 2, this.bedSize.y / 2, 0);
        this.orbitControls.target.set(this.bedSize.x / 2, this.bedSize.y / 2, 0);
        this.orbitControls.update();
    }

    setMode(mode) {
        // 校准模型只允许旋转
        if (mode !== 'rotate' && this.selectedModels.size === 1) {
            const modelId = Array.from(this.selectedModels)[0];
            const model = this.models.get(modelId);
            if (model && model._isCalibration) {
                this.showToast('校准模型只允许旋转，不可移动或缩放', 'warning');
                return;
            }
        }

        if (this.currentMode === mode) {
            this.currentMode = null;
            this.transformControls.detach();
        } else {
            this.currentMode = mode;
            switch (mode) {
                case 'rotate':
                    this.transformControls.setMode('rotate');
                    break;
                case 'pan':
                    this.transformControls.setMode('translate');
                    break;
                case 'scale':
                    this.transformControls.setMode('scale');
                    break;
            }
            if (this.selectedModels.size === 1) {
                const modelId = Array.from(this.selectedModels)[0];
                const model = this.models.get(modelId);
                if (model && model._transformProxy) {
                    this.transformControls.attach(model._transformProxy);
                }
            }
        }
        this.updateModeButtons();
        this.switchTransformContent();
        this.updateTransformPanel();
    }

    toggleLayOnFaceMode() {
        this.isLayOnFaceMode = !this.isLayOnFaceMode;
        if (this.isLayOnFaceMode) {
            this.currentMode = null;
            this.transformControls.detach();
            // 点亮整体模型的明亮三角面
            this._rebuildTriangulationOverlay();
        } else {
            this._clearFaceHighlight();
            this._clearTriangulationOverlay();
        }
        this.updateModeButtons();
        this.switchTransformContent();
        this.updateTransformPanel();
    }

    onMouseMove(event) {
        if (!this.isLayOnFaceMode) {
            this._clearFaceHighlight();
            this._clearTriangulationOverlay();
            return;
        }
        // 模型/三角面层在任何状态变化后自动补齐
        if (!this._triangulationOverlay) {
            this._rebuildTriangulationOverlay();
        }

        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const mouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), this.camera);

        const objectsToTest = [];
        this.models.forEach(model => {
            if (model.mesh) {
                model.mesh.traverse((child) => {
                    if (child.isMesh) objectsToTest.push(child);
                });
            }
        });

        const intersects = this.raycaster.intersectObjects(objectsToTest);
        if (intersects.length > 0) {
            // 检查点击的面是否属于组合体
            let targetMesh = intersects[0].object;
            let modelId = null;
            while (targetMesh) {
                if (targetMesh.userData.modelId !== undefined) {
                    modelId = targetMesh.userData.modelId;
                    break;
                }
                targetMesh = targetMesh.parent;
            }
            if (modelId !== null && this.models.has(modelId)) {
                this._highlightFaceRegion(intersects[0]);
            } else {
                this._clearFaceHighlight();
            }
        } else {
            this._clearFaceHighlight();
        }
    }

    _extractFacePositions(mesh, faceIndices) {
        const geometry = mesh.geometry;
        const pos = geometry.attributes.position;
        const vertices = [];
        if (geometry.index) {
            const idx = geometry.index;
            for (const fi of faceIndices) {
                const i0 = idx.getX(fi * 3);
                const i1 = idx.getX(fi * 3 + 1);
                const i2 = idx.getX(fi * 3 + 2);
                vertices.push(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
                vertices.push(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
                vertices.push(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
            }
        } else {
            for (const fi of faceIndices) {
                const i0 = fi * 3;
                const i1 = fi * 3 + 1;
                const i2 = fi * 3 + 2;
                vertices.push(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
                vertices.push(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
                vertices.push(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
            }
        }
        return new Float32Array(vertices);
    }

    // 生成一个圆角三角形的轮廓顶点（按边界顺序，三个角用圆弧过渡而非锐利尖角）
    _roundedTriangleOutline(vArr, base, cornerSegs, radiusRatio, out) {
        const a = new THREE.Vector3(vArr[base], vArr[base + 1], vArr[base + 2]);
        const b = new THREE.Vector3(vArr[base + 3], vArr[base + 4], vArr[base + 5]);
        const c = new THREE.Vector3(vArr[base + 6], vArr[base + 7], vArr[base + 8]);
        const corners = [a, b, c];
        // 每条边的单位方向：edgeDir[i] 从 corners[i] 指向 corners[(i+1)%3]
        const edgeDir = [];
        const edgeLen = [];
        for (let i = 0; i < 3; i++) {
            const nxt = corners[(i + 1) % 3];
            const d = new THREE.Vector3().subVectors(nxt, corners[i]);
            edgeLen.push(d.length());
            if (edgeLen[i] > 1e-9) d.divideScalar(edgeLen[i]);
            edgeDir.push(d);
        }
        // 每个角点到其两侧切点的距离 t[i]
        const t = [];
        for (let i = 0; i < 3; i++) {
            const prevEdge = edgeDir[(i + 2) % 3];
            const nextEdge = edgeDir[i];
            const half = prevEdge.clone().add(nextEdge);
            const halfLen = half.length();
            if (halfLen < 1e-9) { t.push(0); continue; }
            half.divideScalar(halfLen);
            const cosHalf = half.dot(nextEdge);
            const r = Math.min(edgeLen[(i + 2) % 3], edgeLen[i]) * radiusRatio;
            t.push(Math.min(Math.abs(r / (cosHalf || 1e-9)), edgeLen[(i + 2) % 3] * 0.5, edgeLen[i] * 0.5));
        }
        // 圆角三角形中心点（重心），用于内部扇形三角化
        const segs = Math.max(2, cornerSegs);
        // 先为每个角算好 entry（沿上一边进入角）、leave（沿当前边离开角）两个切点，以及圆弧圆心/半径
        const arcInfo = [];
        for (let i = 0; i < 3; i++) {
            const v = corners[i];
            const e0 = edgeDir[(i + 2) % 3]; // 进入边方向：prev->v
            const e1 = edgeDir[i];           // 离开边方向：v->next
            const tIn = t[i];
            const entry = v.clone().addScaledVector(e0, -tIn);
            const leave = v.clone().addScaledVector(e1, tIn);
            const half = e0.clone().add(e1);
            const halfLen = half.length();
            if (halfLen < 1e-9 || tIn < 1e-9) {
                arcInfo.push({ entry, leave, center: null, rEff: 0, aStart: 0, sweep: 0, degenerate: true });
                continue;
            }
            half.divideScalar(halfLen);
            const cosHalf = half.dot(e1) || 1e-9;
            const center = v.clone().addScaledVector(half, -(tIn / cosHalf));
            const rEff = entry.distanceTo(center);
            const sDir = new THREE.Vector3().subVectors(entry, center);
            const eDir3 = new THREE.Vector3().subVectors(leave, center);
            const aStart = Math.atan2(sDir.y, sDir.x);
            const aEnd = Math.atan2(eDir3.y, eDir3.x);
            let sweep = aEnd - aStart;
            while (sweep > Math.PI) sweep -= Math.PI * 2;
            while (sweep < -Math.PI) sweep += Math.PI * 2;
            arcInfo.push({ entry, leave, center, rEff, aStart, sweep, degenerate: false });
        }
        // 按逆时针（A→B→C→A）拼出闭合轮廓：直边 + 角圆弧，首尾去重
        const boundary = [];
        for (let i = 0; i < 3; i++) {
            const info = arcInfo[i];
            const nextEntry = arcInfo[(i + 1) % 3].entry;
            // 沿当前角圆弧从 entry 转到 leave（到达角的弧）
            if (!info.degenerate) {
                for (let s = 0; s <= segs; s++) {
                    const ang = info.aStart + info.sweep * (s / segs);
                    boundary.push(new THREE.Vector3(
                        info.center.x + Math.cos(ang) * info.rEff,
                        info.center.y + Math.sin(ang) * info.rEff,
                        info.center.z
                    ));
                }
            } else {
                boundary.push(info.leave.clone());
            }
            // 直边：从当前角的 leave 连到下一个角的 entry（都在同一网格边上）
            boundary.push(nextEntry.clone());
        }
        // 闭合并去重首尾（首尾会在同一直边上重合）
        const tolerance = 1e-6;
        if (boundary.length > 1) {
            const first = boundary[0];
            const last = boundary[boundary.length - 1];
            if (first.distanceTo(last) < tolerance) boundary.pop();
        }
        const centroid = new THREE.Vector3().copy(a).add(b).add(c).multiplyScalar(1 / 3);
        out.push(centroid.x, centroid.y, centroid.z);
        for (const p of boundary) {
            out.push(p.x, p.y, p.z);
        }
    }

    // 用重心扇形法把圆角三角形轮廓三角化（质心 + 每段轮廓顶点）
    _buildFaceHighlightOverlay(mesh, faceIndices, style) {
        const opts = style || {};
        const vertexArray = this._extractFacePositions(mesh, faceIndices);
        const triCount = faceIndices.length;
        const group = new THREE.Group();

        // 把每个三角面替换成圆角三角（三个角圆弧过渡），合并成一个几何体绘制。
        // 视觉上就是一个一个边缘圆润的三角形片；全部面合成单个 BufferGeometry，
        // 只需一次 draw call，性能好
        const cornerSegs = opts.cornerSegs !== undefined ? opts.cornerSegs : 6;
        const radiusRatio = opts.radiusRatio !== undefined ? opts.radiusRatio : 0.45;
        const polygonVerts = [];
        for (let f = 0; f < triCount; f++) {
            const outline = [];
            this._roundedTriangleOutline(vertexArray, f * 9, cornerSegs, radiusRatio, outline);
            // outline[0] 是质心，其余按边界顺序
            const n = (outline.length - 1) / 3;
            const cx = outline[0], cy = outline[1], cz = outline[2];
            for (let k = 1; k < n; k++) {
                polygonVerts.push(
                    cx, cy, cz,
                    outline[k * 3], outline[k * 3 + 1], outline[k * 3 + 2],
                    outline[(k + 1) * 3], outline[(k + 1) * 3 + 1], outline[(k + 1) * 3 + 2]
                );
            }
        }

        const triGeom = new THREE.BufferGeometry();
        triGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(polygonVerts), 3));
        triGeom.computeVertexNormals();

        const fillMat = new THREE.MeshBasicMaterial({
            color: opts.fillColor !== undefined ? opts.fillColor : 0x00d94f,
            transparent: opts.opacity !== undefined,
            opacity: opts.opacity !== undefined ? opts.opacity : 1,
            side: THREE.DoubleSide,
            depthTest: opts.depthTest !== undefined ? opts.depthTest : true,
            polygonOffset: opts.polyOffset !== false,
            polygonOffsetFactor: 4,
            polygonOffsetUnits: 4
        });
        const fill = new THREE.Mesh(triGeom, fillMat);
        fill.renderOrder = opts.renderOrder !== undefined ? opts.renderOrder : 1;
        group.add(fill);

        group.applyMatrix4(mesh.matrixWorld);
        return group;
    }

    _clearFaceHighlight() {
        if (this._faceHighlight) {
            this.scene.remove(this._faceHighlight);
            this._disposeGroup(this._faceHighlight);
            this._faceHighlight = null;
        }
    }

    _disposeGroup(group) {
        group.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }

    _clearTriangulationOverlay() {
        if (this._triangulationOverlay) {
            this.scene.remove(this._triangulationOverlay);
            this._disposeGroup(this._triangulationOverlay);
            this._triangulationOverlay = null;
        }
    }

    _rebuildTriangulationOverlay() {
        this._clearTriangulationOverlay();
        const group = new THREE.Group();
        // 每个模型：只点亮其凸包上合并出的"平面"（同法线相邻三角合并成一块），不渲染内部网格面
        this.models.forEach(model => {
            const planes = this._computeHullPlanes(model);
            if (!planes || planes.length === 0) return;
            const indices = [];
            for (let i = 0; i < planes.length; i++) indices.push(i);
            const ov = this._buildPlaneOverlay(model, indices, {
                fillColor: 0xffffff,
                opacity: 0.3,
                outlineColor: 0xffffff,
                outlineOpacity: 0.7,
                outlineWidth: 2,
                renderOrder: 1,
                depthTest: true   // 参与深度测试：被模型自身遮挡的背面凸包面不显示，避免隔着物体看到对面
            });
            if (ov) group.add(ov);
        });
        if (group.children.length > 0) {
            this._triangulationOverlay = group;
            this.scene.add(group);
        }
    }

    _highlightFaceRegion(intersect) {
        // 按面放平 = 用凸包合并出的"平面"逼近模型。
        // 悬停时只让命中的凸包平面更亮；未命中任何凸包平面则保持当前高亮（不退回原始网格面，
        // 否则会混入模型自身的不规则小面）。
        const mesh = intersect.object;
        let targetMesh = mesh;
        let modelId = null;
        while (targetMesh) {
            if (targetMesh.userData && targetMesh.userData.modelId !== undefined) {
                modelId = targetMesh.userData.modelId;
                break;
            }
            targetMesh = targetMesh.parent;
        }
        const model = (modelId !== null && this.models.has(modelId)) ? this.models.get(modelId) : null;
        if (model) {
            try {
                const planeIdx = this._pickPlane(model, this.raycaster);
                if (planeIdx >= 0) {
                    const ov = this._buildPlaneOverlay(model, [planeIdx], {
                        fillColor: 0xffffff,
                        opacity: 0.8,
                        outlineColor: 0xffffff,
                        outlineOpacity: 1,
                        outlineWidth: 3,
                        renderOrder: 10,
                        depthTest: false
                    });
                    if (ov) {
                        this._clearFaceHighlight();
                        this._faceHighlight = ov;
                        this.scene.add(ov);
                    }
                }
            } catch (e) {
                console.warn('plane highlight failed:', e);
            }
        }
    }

    _getCoplanarRegion(mesh, faceIndex) {
        const geometry = mesh.geometry;
        if (!geometry.index) {
            return { faceIndices: [faceIndex] };
        }

        const pos = geometry.attributes.position;
        const idx = geometry.index;
        const faceCount = idx.count / 3;

        // 获取点击面的法线
        const getFaceNormal = (fi) => {
            const i0 = idx.getX(fi * 3);
            const i1 = idx.getX(fi * 3 + 1);
            const i2 = idx.getX(fi * 3 + 2);
            const p0 = new THREE.Vector3(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
            const p1 = new THREE.Vector3(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
            const p2 = new THREE.Vector3(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
            const e1 = new THREE.Vector3().copy(p1).sub(p0);
            const e2 = new THREE.Vector3().copy(p2).sub(p0);
            return new THREE.Vector3().crossVectors(e1, e2).normalize();
        };

        // 获取面的三个顶点索引
        const getFaceVerts = (fi) => {
            return [idx.getX(fi * 3), idx.getX(fi * 3 + 1), idx.getX(fi * 3 + 2)];
        };

        const referenceNormal = getFaceNormal(faceIndex);

        // 构建边到面的映射（邻接表）
        const edgeToFaces = new Map();
        for (let f = 0; f < faceCount; f++) {
            const verts = getFaceVerts(f);
            for (let j = 0; j < 3; j++) {
                const v0 = verts[j];
                const v1 = verts[(j + 1) % 3];
                const key = Math.min(v0, v1) + '_' + Math.max(v0, v1);
                if (!edgeToFaces.has(key)) edgeToFaces.set(key, []);
                const faces = edgeToFaces.get(key);
                if (!faces.includes(f)) faces.push(f);
            }
        }

        // BFS 查找所有共面相邻面
        const visited = new Set();
        const regionFaces = [];
        const queue = [faceIndex];
        visited.add(faceIndex);

        const dotThreshold = Math.cos(THREE.MathUtils.degToRad(5));

        while (queue.length > 0) {
            const currentFace = queue.shift();
            regionFaces.push(currentFace);
            const verts = getFaceVerts(currentFace);

            // 遍历三条边
            for (let j = 0; j < 3; j++) {
                const v0 = verts[j];
                const v1 = verts[(j + 1) % 3];
                const key = Math.min(v0, v1) + '_' + Math.max(v0, v1);
                const adjacentFaces = edgeToFaces.get(key) || [];

                for (const adjFace of adjacentFaces) {
                    if (visited.has(adjFace)) continue;
                    const adjNormal = getFaceNormal(adjFace);
                    if (referenceNormal.dot(adjNormal) > dotThreshold) {
                        visited.add(adjFace);
                        queue.push(adjFace);
                    }
                }
            }
        }

        // 收集所有顶点
        const vertexSet = new Set();
        for (const f of regionFaces) {
            const verts = getFaceVerts(f);
            verts.forEach(v => vertexSet.add(v));
        }

        const vertexPositions = [];
        vertexSet.forEach(vIdx => {
            vertexPositions.push(new THREE.Vector3(pos.getX(vIdx), pos.getY(vIdx), pos.getZ(vIdx)));
        });

        return {
            faceIndices: regionFaces,
            vertices: vertexPositions
        };
    }

    layOnFaceModel(modelId, intersect) {
        const model = this.models.get(modelId);
        if (!model || !model.mesh) return;

        // 组合体（合并后）不支持按面放平，请先解组
        if (model._groupData) {
            this.showToast('组合体不支持按面放平，请先解组', 'warning');
            return;
        }

        this._clearFaceHighlight();

        // 取消选中，直接操作 mesh，避免 proxy 的偏移导致定位错误
        if (model.selected && model._transformProxy) {
            this.deselectModelInternal(model);
            this.selectedModels.delete(model.id);
            model.selected = false;
            model._transformProxy = null;
        }

        const meshToUse = intersect.object;
        meshToUse.updateMatrixWorld(true);

        // 优先用凸包合并出的"平面"放平：命中该平面并让平面法线朝上
        const tryHull = (() => {
            const modelHull = this.models.get(modelId) || model;
            const planeIdx = this._pickPlane(modelHull, this.raycaster);
            if (planeIdx < 0) return null;
            const planes = this._computeHullPlanes(modelHull);
            if (!planes || !planes[planeIdx]) return null;
            const plane = planes[planeIdx];
            // 平面几何顶点（世界坐标，已抬升 0.1）用于求最低点
            const pos = plane.geometry.attributes.position;
            const verts = [];
            for (let i = 0; i < pos.count; i++) {
                verts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
            }
            return { planeIdx, normal: plane.normal.clone().normalize(), verts, lift: 0.1 };
        })();

        let avgNormal;
        let regionVerts = null;
        if (tryHull) {
            // 用该平面的法线放平，并用其顶点求最低点贴床
            avgNormal = tryHull.normal;
            regionVerts = { geometry: tryHull, faceIndices: null, minZFrom: 'hull' };
        } else {
            // 展开共面区域（回退到原始网格）
            const region = this._getCoplanarRegion(meshToUse, intersect.faceIndex);
            if (!region) return;
            // 计算区域的平均法线（统一转到世界空间）
            if (!meshToUse.geometry.index) {
                avgNormal = intersect.face.normal.clone();
                avgNormal.transformDirection(meshToUse.matrixWorld);
            } else {
                avgNormal = new THREE.Vector3();
                const geometry = meshToUse.geometry;
                const pos = geometry.attributes.position;
                const idx = geometry.index;
                for (const fi of region.faceIndices) {
                    const i0 = idx.getX(fi * 3);
                    const i1 = idx.getX(fi * 3 + 1);
                    const i2 = idx.getX(fi * 3 + 2);
                    const p0 = new THREE.Vector3(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
                    const p1 = new THREE.Vector3(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
                    const p2 = new THREE.Vector3(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
                    const e1 = new THREE.Vector3().copy(p1).sub(p0);
                    const e2 = new THREE.Vector3().copy(p2).sub(p0);
                    const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
                    avgNormal.add(n);
                }
                avgNormal.normalize();
                avgNormal.transformDirection(meshToUse.matrixWorld);
            }
            regionVerts = { geometry: meshToUse.geometry, faceIndices: region.faceIndices, minZFrom: 'mesh' };
        }

        // 用平均法线做旋转
        const up = new THREE.Vector3(0, 0, -1);
        const quat = new THREE.Quaternion();
        quat.setFromUnitVectors(avgNormal, up);

        const worldQuat = new THREE.Quaternion();
        model.mesh.getWorldQuaternion(worldQuat);
        worldQuat.premultiply(quat);
        model.mesh.quaternion.copy(worldQuat);
        model.mesh.updateMatrixWorld(true);

        // 贴床：用模型整体包围盒，把最低点落到 z=0，避免用世界顶点旋转导致的坐标爆炸
        model.mesh.updateMatrixWorld(true);
        let box = new THREE.Box3().setFromObject(model.mesh);
        if (isFinite(box.min.z)) {
            const liftBottom = box.min.z; // 通常为负或 0，抬到 z=0 即最低点贴床
            model.mesh.position.z -= liftBottom;
            model.mesh.updateMatrixWorld(true);
        }

        // 放平后让模型在床面范围内：先贴底，再水平约束到 [0, bedSize]
        this.updateSelectionBoxes();
        this.updateTransformInputs();

        // 烘焙变换到几何体，避免后续矩阵链漂移
        this.geometryOnlyBake(model);
        this._invalidateHullCache(model);

        // 把模型放进 [0, bedSize] 的打印区域内（需在烘焙后按包围盒精确落位）
        this._seatModelInBed(model);
        this._invalidateHullCache(model);
        this.updateSelectionBoxes();
        this.updateTransformInputs();

        this.isLayOnFaceMode = false;
        this._clearFaceHighlight();
        this._clearTriangulationOverlay();
        this.updateModeButtons();

        // 烘焙 + 落床完成后存稳定快照，撤销/重做都回到完整的放平后状态
        this.saveState('按面放平');
    }

    // 仅把当前世界变换烘焙到几何顶点（不触发 proxy 搬运/再贴床，避免二次漂移）
    geometryOnlyBake(model) {
        const mesh = model.mesh;
        mesh.updateMatrixWorld(true);
        mesh.traverse((child) => {
            if (child.geometry && child.geometry.attributes.position) {
                child.geometry.applyMatrix4(child.matrixWorld);
                child.geometry.computeBoundingBox();
            }
        });
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
        mesh.updateMatrixWorld(true);
        this._invalidateHullCache(model);
    }

    // 把模型整体放进所属盘范围内（世界坐标），并贴床（z 最低=0）
    _seatModelInBed(model, bound) {
        if (!model || !model.mesh) return;
        const bed = bound !== undefined ? bound : 270;
        const mesh = model.mesh;
        const box = new THREE.Box3().setFromObject(mesh);
        // 贴床：最低点 z=0
        mesh.position.z -= box.min.z;
        mesh.updateMatrixWorld(true);
        const box2 = new THREE.Box3().setFromObject(mesh);
        // 所属盘的世界范围（以盘中心为基准）
        const pc = this._getPlateWorldPos(model.plateId || this.freePlateId);
        const half = bed / 2;
        const pMinX = pc.x - half, pMaxX = pc.x + half;
        const pMinY = pc.y - half, pMaxY = pc.y + half;
        // 水平放到所属盘中心
        const cx = (box2.min.x + box2.max.x) / 2;
        const cy = (box2.min.y + box2.max.y) / 2;
        mesh.position.x += pc.x - cx;
        mesh.position.y += pc.y - cy;
        mesh.updateMatrixWorld(true);
        // 终检：确保所有顶点都在所属盘内
        const box3 = new THREE.Box3().setFromObject(mesh);
        let minX = box3.min.x, minY = box3.min.y, minZ3 = box3.min.z;
        let maxX = box3.max.x, maxY = box3.max.y, maxZ3 = box3.max.z;
        if (minX < pMinX) mesh.position.x += (pMinX - minX);
        if (minY < pMinY) mesh.position.y += (pMinY - minY);
        if (minZ3 < 0) mesh.position.z += (-minZ3);
        if (maxX > pMaxX) mesh.position.x -= (maxX - pMaxX);
        if (maxY > pMaxY) mesh.position.y -= (maxY - pMaxY);
        mesh.updateMatrixWorld(true);
        if (model._transformProxy) {
            model._transformProxy.position.copy(mesh.position);
            model._transformProxy.updateMatrixWorld(true);
        }
    }

    updateModeButtons() {
        document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
        if (this.currentMode) {
            document.getElementById('tool-' + this.currentMode)?.classList.add('active');
        }
        if (this.isLayOnFaceMode) {
            document.getElementById('tool-layonface')?.classList.add('active');
        }
    }

    switchTransformContent() {
        document.getElementById('transform-content-scale').classList.add('hidden');
        document.getElementById('transform-content-translate').classList.add('hidden');
        document.getElementById('transform-content-rotate').classList.add('hidden');
        if (this.currentMode) {
            const contentId = this.currentMode === 'pan' ? 'translate' : this.currentMode;
            document.getElementById('transform-content-' + contentId)?.classList.remove('hidden');
        }
    }

    resetScale() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model || model._isCalibration) return;

        model.mesh.updateMatrixWorld(true);
        model.mesh.scale.set(1, 1, 1);
        model.mesh.updateMatrixWorld(true);

        if (model._transformProxy && model.selected) {
            model._transformProxy.scale.set(1, 1, 1);
            model._transformProxy.updateMatrixWorld(true);
        }

        document.getElementById('scale-x').value = '100.00';
        document.getElementById('scale-y').value = '100.00';
        document.getElementById('scale-z').value = '100.00';

        this.lockZAxis();
        if (!model._groupData) this.bakeTransform(model);
        this.updateSelectionBoxes();
        this.saveState('重置缩放');
    }

    resetPosition() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model || model._isCalibration) return;

        const transformSource = model._transformProxy || model.mesh;
        transformSource.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model.mesh);
        const center = box.getCenter(new THREE.Vector3());

        transformSource.position.x += this.bedSize.x / 2 - center.x;
        transformSource.position.y += this.bedSize.y / 2 - center.y;
        transformSource.updateMatrixWorld(true);

        this.lockZAxis();
        if (!model._groupData) this.bakeTransform(model);
        this.updateSelectionBoxes();
        this.updateTransformInputs();
        this.saveState('重置位置');
    }

    resetRotation() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        if (!model._accumRotation) model._accumRotation = new THREE.Euler(0, 0, 0, 'XYZ');
        model._accumRotation.set(0, 0, 0);
        const transformSource = model._transformProxy || model.mesh;
        transformSource.rotation.set(0, 0, 0);

        document.getElementById('rot-x').value = '0.00';
        document.getElementById('rot-y').value = '0.00';
        document.getElementById('rot-z').value = '0.00';

        this.lockZAxis();
        if (!model._groupData) this.bakeTransform(model);
        this.updateSelectionBoxes();
        this.saveState('重置旋转');
    }

    applyScaleFromInputs() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model || model._isCalibration) return;

        const isUniform = document.getElementById('uniform-scale').checked;
        let sx = parseFloat(document.getElementById('scale-x').value) || 100;
        let sy = parseFloat(document.getElementById('scale-y').value) || 100;
        let sz = parseFloat(document.getElementById('scale-z').value) || 100;
        sx /= 100; sy /= 100; sz /= 100;

        const scaleTarget = model._transformProxy || model.mesh;

        if (isUniform) {
            // 用世界缩放做均匀缩放基准，避免 _transformProxy/mesh 局部值不一致
            const ws = new THREE.Vector3();
            model.mesh.getWorldScale(ws);
            const diffs = [Math.abs(sx - ws.x), Math.abs(sy - ws.y), Math.abs(sz - ws.z)];
            const uniformScale = diffs[0] >= diffs[1] && diffs[0] >= diffs[2] ? sx : diffs[1] >= diffs[2] ? sy : sz;
            sx = sy = sz = uniformScale;
        }

        // 先刷数字：把目标缩放% 与换算出的目标大小mm 同步写入两个框（数字先变，均立即反映）
        document.getElementById('scale-x').value = (sx * 100).toFixed(2);
        document.getElementById('scale-y').value = (sy * 100).toFixed(2);
        document.getElementById('scale-z').value = (sz * 100).toFixed(2);
        const curWorld = new THREE.Vector3();
        model.mesh.getWorldScale(curWorld);
        const curSize = new THREE.Box3().setFromObject(model.mesh).getSize(new THREE.Vector3());
        const wxs = curWorld.x || 1, wys = curWorld.y || 1, wzs = curWorld.z || 1;
        document.getElementById('size-x').value = (curSize.x * sx / wxs).toFixed(2);
        document.getElementById('size-y').value = (curSize.y * sy / wys).toFixed(2);
        document.getElementById('size-z').value = (curSize.z * sz / wzs).toFixed(2);

        // 再放大：同步施加缩放后模型在下一帧渲染体现（数字先变、图后放大，同帧完成）
        scaleTarget.scale.set(sx, sy, sz);
        this.lockZAxis();
        this.updateSelectionBoxes();
        this.saveState('缩放');
    }

    applySizeFromInputs() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model || model._isCalibration) return;

        const sx = parseFloat(document.getElementById('size-x').value) || 0;
        const sy = parseFloat(document.getElementById('size-y').value) || 0;
        const sz = parseFloat(document.getElementById('size-z').value) || 0;

        const box = new THREE.Box3().setFromObject(model.mesh);
        const currentSize = box.getSize(new THREE.Vector3());
        const transformSource = model._transformProxy || model.mesh;
        const currentScale = transformSource.scale;

        const baseX = currentSize.x / currentScale.x;
        const baseY = currentSize.y / currentScale.y;
        const baseZ = currentSize.z / currentScale.z;

        let newScaleX = baseX > 0 ? sx / baseX : 1;
        let newScaleY = baseY > 0 ? sy / baseY : 1;
        let newScaleZ = baseZ > 0 ? sz / baseZ : 1;

        const isUniform = document.getElementById('uniform-scale').checked;
        if (isUniform) {
            const newScale = Math.max(newScaleX, newScaleY, newScaleZ);
            newScaleX = newScaleY = newScaleZ = newScale;
            document.getElementById('size-x').value = (baseX * newScale).toFixed(2);
            document.getElementById('size-y').value = (baseY * newScale).toFixed(2);
            document.getElementById('size-z').value = (baseZ * newScale).toFixed(2);
        }

        // 有 _transformProxy 时修改 proxy 的 scale，否则修改 mesh（不烘焙，与缩放输入一致）
        const scaleTarget = model._transformProxy || model.mesh;

        // 先刷数字：把换算出的目标缩放% 同步写入框里（数字先变，立即反映）
        document.getElementById('scale-x').value = (newScaleX * 100).toFixed(2);
        document.getElementById('scale-y').value = (newScaleY * 100).toFixed(2);
        document.getElementById('scale-z').value = (newScaleZ * 100).toFixed(2);

        // 再放大：同步施加缩放后模型在下一帧渲染体现（数字先变、图后放大，同帧完成）
        scaleTarget.scale.set(newScaleX, newScaleY, newScaleZ);
        this.lockZAxis();
        this.updateSelectionBoxes();
        this.saveState('尺寸');
    }

    applyPositionFromInputs() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model || model._isCalibration) return;

        const x = parseFloat(document.getElementById('pos-x').value) || 0;
        const y = parseFloat(document.getElementById('pos-y').value) || 0;

        if (model._transformProxy) {
            model._transformProxy.position.x = x;
            model._transformProxy.position.y = y;
            // 关键：赋值后立即刷新 proxy 的 matrix 与 matrixWorld，
            // 否则 bakeTransform 用 mesh.updateMatrixWorld 时读到的是陈旧的 proxy.matrixWorld，
            // 用户设置的位置不会烤进顶点，模型就不会移动（Gizmo 因内部实时刷新而不受影响）。
            model._transformProxy.updateMatrix();
            model._transformProxy.updateMatrixWorld(true);
        } else {
            model.mesh.position.x = x;
            model.mesh.position.y = y;
            model.mesh.updateMatrix();
        }
        this.lockZAxis();
        if (!model._groupData) this.bakeTransform(model);
        this.updateSelectionBoxes();
        this.saveState('移动');
    }

    applyRotationFromInputs() {
        if (this.selectedModels.size !== 1) return;
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        const x = (parseFloat(document.getElementById('rot-x').value) || 0) * Math.PI / 180;
        const y = (parseFloat(document.getElementById('rot-y').value) || 0) * Math.PI / 180;
        const z = (parseFloat(document.getElementById('rot-z').value) || 0) * Math.PI / 180;

        if (!model._accumRotation) model._accumRotation = new THREE.Euler(0, 0, 0, 'XYZ');
        const dx = x - model._accumRotation.x;
        const dy = y - model._accumRotation.y;
        const dz = z - model._accumRotation.z;
        if (model._transformProxy) {
            model._transformProxy.rotation.set(dx, dy, dz);
            // 与位置输入同理：赋值后立即刷新 proxy 矩阵，确保旋转烤进顶点
            model._transformProxy.updateMatrix();
            model._transformProxy.updateMatrixWorld(true);
        } else {
            model.mesh.rotation.set(dx, dy, dz);
            model.mesh.updateMatrix();
        }
        this.lockZAxis();
        if (!model._groupData) this.bakeTransform(model);
        this.updateSelectionBoxes();
        this.saveState('旋转');
    }

    onMouseClick(event) {
        if (this.isDraggingModel) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        // 屏幕坐标命中检测盘操作按钮（不被 3D 面方向影响）
        const hitAction = this._hitTestPlateAction(event.clientX, event.clientY);
        if (hitAction) {
            this._handlePlateActionClick(hitAction.action, hitAction.plateId, event);
            return;
        }

        this.raycaster.setFromCamera(this.mouse, this.camera);

        const objectsToTest = [];
        // 盘板本体（点击可切换当前盘 + 创建控件到该板）
        if (this.plateBoards) {
            this.plateBoards.forEach((group) => {
                group.traverse((child) => {
                    if (child.isMesh) objectsToTest.push(child);
                });
            });
        }
        this.models.forEach(model => {
            if (model.visible) {
                model.mesh.traverse((child) => {
                    if (child.isMesh) objectsToTest.push(child);
                });
            }
        });
        // 添加组合体中的模型到检测对象（已合并为单一 mesh，在 models 中）

        // 添加热床和网格到检测对象
        if (this.bedMesh) objectsToTest.push(this.bedMesh);
        if (this.gridHelper) {
            this.gridHelper.traverse((child) => {
                if (child.isMesh || child.isLine) objectsToTest.push(child);
            });
        }

        const intersects = this.raycaster.intersectObjects(objectsToTest);
        // 按距离排序：模型在盘板上方时优先命中模型，避免盘板挡住模型点击
        if (intersects.length > 1) intersects.sort((a, b) => a.distance - b.distance);

        if (intersects.length > 0) {
            let targetMesh = intersects[0].object;

        // 点击擦料塔：选中整座塔（外观两色、实质一个对象，像模型一样拖拽移动，禁止缩放旋转）
        if (targetMesh.userData && targetMesh.userData.isTower) {
            this.clearSelection();
            // 解析到塔对象（group）：整塔一体，不区分左右半块
            const towerGroup = targetMesh.userData.towerGroup || targetMesh;
            this._selectedTower = towerGroup;
            this._showTowerSelection(towerGroup);
            return;
        }

            // 点击盘板本体：只有点到"非当前激活"的板才切换盘；
            // 点到当前激活板视为点击板上的模型（不拦截，继续走模型命中）。
            let hitPlateId = null;
            while (targetMesh) {
                if (targetMesh.userData && targetMesh.userData.plateId !== undefined) {
                    hitPlateId = targetMesh.userData.plateId;
                    break;
                }
                targetMesh = targetMesh.parent;
            }
            if (hitPlateId !== null && this.plates.has(hitPlateId) && hitPlateId !== this.currentPlateId) {
                this.setCurrentPlate(hitPlateId);
                return;
            }

            let modelId = null;
            targetMesh = intersects[0].object;

            while (targetMesh) {
                if (targetMesh.userData.modelId !== undefined) {
                    modelId = targetMesh.userData.modelId;
                    break;
                }
                targetMesh = targetMesh.parent;
            }

            if (modelId !== null) {
                if (this.models.has(modelId)) {
                    if (this.isLayOnFaceMode) {
                        this.layOnFaceModel(modelId, intersects[0]);
                    } else {
                        this.selectModelById(modelId, !event.ctrlKey && !event.metaKey);
                    }
                } else {
                    this.clearSelection();
                }
            } else {
                // 点击了热床或网格，解除选中
                this.clearSelection();
            }
        } else {
            this.clearSelection();
        }
    }

    // 处理盘操作 3D 按钮点击
    // 屏幕范围命中检测盘操作按钮：把每个按钮的世界坐标投影到屏幕，用矩形区域判定
    _hitTestPlateAction(clientX, clientY) {
        const btn = this._hitTestPlateButtonMesh(clientX, clientY);
        if (!btn) return null;
        return { action: btn.userData.action, plateId: btn.userData.plateId };
    }

    _hitTestPlateButtonMesh(clientX, clientY) {
        if (!this.plateActions || this.plateActions.length === 0) return null;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const size = 40; // 按钮在屏幕上的命中半径（像素）
        let best = null;
        let bestDist = size;
        for (let i = 0; i < this.plateActions.length; i++) {
            const btn = this.plateActions[i];
            const v = new THREE.Vector3();
            btn.getWorldPosition(v);
            v.project(this.camera);
            const sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
            const sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
            const d = Math.hypot(clientX - sx, clientY - sy);
            if (d <= bestDist) {
                bestDist = d;
                best = btn;
            }
        }
        return best;
    }

    _handlePlateActionClick(action, plateId, event) {
        if (action === 'add') {
            this.addPlate();
        } else if (action === 'lock') {
            this.toggleLockPlate(plateId);
        } else if (action === 'front') {
            this.movePlateToFront(plateId);
        } else if (action === 'del') {
            // 先清掉选中，避免删除盘时残留选中导致列表异常
            this.clearSelection();
            this.deletePlate(plateId);
        }
        if (event && event.stopPropagation) event.stopPropagation();
    }

    // 鼠标悬停/按下的按钮高亮反馈：放大(hover) + 缩小(press)
    _curPlateHoverBtn = null;

    _setPlateButtonHover(btn, on) {
        if (!btn) return;
        const base = 1;
        if (on) {
            btn.scale.set(1.12, 1.12, 1.12);
            this._curPlateHoverBtn = btn;
        } else {
            btn.scale.set(base, base, base);
            if (this._curPlateHoverBtn === btn) this._curPlateHoverBtn = null;
        }
    }

    _setPlateButtonPress(btn, on) {
        if (!btn) return;
        if (on) {
            btn.scale.set(0.85, 0.85, 0.85);
        } else {
            btn.scale.set(1.12, 1.12, 1.12);
        }
    }

    clearSelection() {
        this.selectedModels.forEach(id => {
            const model = this.models.get(id);
            if (model) {
                model.selected = false;
                this.deselectModelInternal(model);
            }
        });
        this.selectedModels.clear();
        this.currentMode = null;
        this.transformControls.detach();
        this.updateModeButtons();
        this.switchTransformContent();
        this.updateObjectList();
        this.updateTransformPanel();
    }

    onWindowResize() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        if (this.camera.isOrthographicCamera) {
            const aspect = width / height;
            const halfHeight = this._orthoHalfSize;
            this.camera.left = -halfHeight * aspect;
            this.camera.right = halfHeight * aspect;
            this.camera.top = halfHeight;
            this.camera.bottom = -halfHeight;
            this.camera.updateProjectionMatrix();
        } else {
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
        }

        this.renderer.setSize(width, height);
    }

    updateCameraInfo() {
        const distance = this.camera.position.distanceTo(this.orbitControls.target);
        const camDistanceEl = document.getElementById('cam-distance');
        if (camDistanceEl) {
            camDistanceEl.textContent = distance.toFixed(1) + ' mm';
        }
    }

    setupEventListeners() {
        document.getElementById('tool-import').addEventListener('click', () => this.loadModelFromBackend());
        document.getElementById('tool-rotate').addEventListener('click', () => this.setMode('rotate'));
        document.getElementById('tool-layonface').addEventListener('click', () => this.toggleLayOnFaceMode());
        document.getElementById('tool-pan').addEventListener('click', () => this.setMode('pan'));
        document.getElementById('tool-scale').addEventListener('click', () => this.setMode('scale'));
        document.getElementById('tool-reset').addEventListener('click', () => this.resetView());

        // 组合 / 解组
        document.getElementById('tool-group').addEventListener('click', () => this.groupSelected());
        document.getElementById('tool-ungroup').addEventListener('click', () => this.ungroupSelected());

        // 自动摆放按钮
        document.getElementById('tool-auto-arrange').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleArrangeCard();
        });

        document.getElementById('clear-all-models')?.addEventListener('click', () => this.clearAllModels());

        this.renderPlates();

        document.getElementById('btn-save')?.addEventListener('click', () => this.saveProject());
        document.getElementById('btn-undo')?.addEventListener('click', () => this.undo());
        document.getElementById('btn-redo')?.addEventListener('click', () => this.redo());
        document.getElementById('btn-calibrate')?.addEventListener('click', () => this.loadCalibrationModel());

        // 设置按钮
        document.getElementById('btn-settings')?.addEventListener('click', () => this.openSettingsDialog());

        // 窗口控制按钮（最小化/最大化/关闭）
        const updateMaximizeIcon = (isMaximized) => {
            const btn = document.getElementById('btn-maximize');
            if (!btn) return;
            if (isMaximized) {
                // 还原图标
                btn.title = '还原';
                btn.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12">
                    <rect x="0" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/>
                    <rect x="3" y="0" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/>
                </svg>`;
            } else {
                // 最大化图标
                btn.title = '最大化';
                btn.innerHTML = `<svg viewBox="0 0 12 12" width="12" height="12">
                    <rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.2"/>
                </svg>`;
            }
        };

        document.getElementById('btn-minimize')?.addEventListener('click', () => {
            window.pywebview?.api?.window_minimize();
        });
        document.getElementById('btn-maximize')?.addEventListener('click', async () => {
            const result = await window.pywebview?.api?.window_toggle_maximize();
            updateMaximizeIcon(result);
        });
        document.getElementById('btn-close')?.addEventListener('click', () => {
            window.pywebview?.api?.window_close();
        });

        // 关闭到托盘确认弹窗按钮
        document.getElementById('tray-close-minimize')?.addEventListener('click', () => {
            document.getElementById('tray-close-overlay')?.classList.add('hidden');
            window.pywebview?.api?.tray_confirm_close('minimize');
        });
        document.getElementById('tray-close-exit')?.addEventListener('click', () => {
            document.getElementById('tray-close-overlay')?.classList.add('hidden');
            window.pywebview?.api?.tray_confirm_close('exit');
        });

        // 暴露全局函数供 Python evaluate_js 调用
        // canMinimize: true 显示"最小化到托盘"按钮; false 只显示"退出"
        window.showCloseTrayDialog = (canMinimize = true) => {
            const minimizeBtn = document.getElementById('tray-close-minimize');
            if (minimizeBtn) {
                minimizeBtn.style.display = canMinimize ? '' : 'none';
            }
            document.getElementById('tray-close-overlay')?.classList.remove('hidden');
        };

        // 标题栏拖拽（仅在非按钮区域触发手动窗口拖拽）
        const titleBar = document.getElementById('title-bar');
        if (titleBar) {
            titleBar.addEventListener('mousedown', async (e) => {
                // 如果点击的是按钮或交互元素，不触发拖拽
                if (e.target.closest('button, input, select, .title-bar-left, .title-bar-right')) {
                    return;
                }
                // 只响应左键
                if (e.button !== 0) return;

                try {
                    await window.pywebview?.api?.start_drag(e.clientX, e.clientY);
                } catch (err) {
                    console.error('Drag error:', err);
                }
            });
        }

        // 导航切换
        document.getElementById('nav-home')?.addEventListener('click', () => this.switchToHome());
        document.getElementById('nav-prepare')?.addEventListener('click', () => this.switchToPrepare());
        document.getElementById('nav-preview')?.addEventListener('click', () => this.switchToPreview());
        document.getElementById('nav-flat')?.addEventListener('click', () => this.switchToFlat());
        document.getElementById('nav-device')?.addEventListener('click', () => this.switchToDevice());
        document.getElementById('nav-calibrate')?.addEventListener('click', () => this.switchToCalibrate());

        // 首页侧边栏导航
        document.getElementById('sidebar-nav-home')?.addEventListener('click', () => this.switchToHome());
        document.getElementById('sidebar-nav-prepare')?.addEventListener('click', () => this.switchToPrepare());
        document.getElementById('sidebar-nav-flat')?.addEventListener('click', () => this.switchToFlat());
        document.getElementById('sidebar-nav-device')?.addEventListener('click', () => this.switchToDevice());
        document.getElementById('sidebar-nav-calibrate')?.addEventListener('click', () => this.switchToCalibrate());
        document.getElementById('sidebar-import-file')?.addEventListener('click', () => this._triggerHomeImport());
        document.getElementById('sidebar-open-project')?.addEventListener('click', () => {
            this.switchToPrepare();
            setTimeout(() => this.openProject(), 100);
        });
        document.getElementById('sidebar-settings')?.addEventListener('click', () => this.openSettingsDialog());
        document.getElementById('sidebar-about')?.addEventListener('click', () => {
            document.getElementById('about-dialog')?.classList.remove('hidden');
        });
        // 复制后处理命令（静默复制，优先 textarea 回退方案，兼容 WebView2）
        document.getElementById('btn-copy-postprocess')?.addEventListener('click', () => {
            const cmd = document.getElementById('postprocess-cmd')?.textContent || '';
            const ta = document.createElement('textarea');
            ta.value = cmd;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
            } catch (_) {
                // execCommand 不可用时尝试 clipboard API
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(cmd).catch(() => {});
                }
            }
            document.body.removeChild(ta);
        });
        document.getElementById('postprocess-cmd')?.addEventListener('click', () => {
            document.getElementById('btn-copy-postprocess')?.click();
        });

        if (window.pywebview && window.pywebview.api) {
            this.refreshPostprocessCommand();
        } else {
            window.addEventListener('pywebviewready', () => {
                this.refreshPostprocessCommand();
            });
        }
        document.getElementById('about-close')?.addEventListener('click', () => {
            document.getElementById('about-dialog')?.classList.add('hidden');
        });
        document.getElementById('about-dialog')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.classList.add('hidden');
            }
        });

        // 校准页面交互
        this._initCalibrateUI();

        // 模型切片按钮
        document.getElementById('btn-model-slice')?.addEventListener('click', () => this.doModelSlice());
        // 重试切片按钮（不唤起新的 Orca，仅重建 pending_slice 并开始轮询）
        document.getElementById('btn-model-retry')?.addEventListener('click', () => this.retrySlice());
        // 立即打印按钮
        document.getElementById('btn-print-gcode')?.addEventListener('click', () => {
            this.startPrint();
            this.switchToDevice();
        });
        // 取消切片按钮
        document.getElementById('btn-cancel-slice')?.addEventListener('click', () => this._cancelSlicing());

        // 自动摆放卡片按钮
        document.getElementById('arrange-cancel')?.addEventListener('click', () => this.hideArrangeCard());
        document.getElementById('arrange-confirm')?.addEventListener('click', () => this.doAutoArrange());

        // 新建项目：若已有模型则需确认，否则直接重置盘面并进入准备页
        document.getElementById('home-new-project')?.addEventListener('click', () => this.newProject());
        document.getElementById('home-open-project')?.addEventListener('click', () => {
            this.switchToPrepare();
            setTimeout(() => this.openProject(), 100);
        });

        // 清空最近项目
        document.getElementById('home-clear-recent')?.addEventListener('click', async () => {
            if (!window.pywebview || !window.pywebview.api) return;
            try {
                await window.pywebview.api.clear_recent_projects();
                this.loadRecentProjects();
            } catch (e) {
                console.error('清空最近项目失败:', e);
            }
        });

        // 拖拽导入文件（仅当拖拽内容包含文件时才拦截；文本/内部拖拽放行默认行为）
        const hasFiles = (e) => {
            if (!e.dataTransfer) return false;
            const types = e.dataTransfer.types;
            for (let i = 0; i < types.length; i++) {
                if (types[i] === 'Files') return true;
            }
            return false;
        };

        document.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            document.getElementById('drop-overlay')?.classList.remove('hidden');
        });

        document.addEventListener('dragleave', (e) => {
            if (!hasFiles(e)) return;
            if (e.relatedTarget === null || e.clientX === 0) {
                document.getElementById('drop-overlay')?.classList.add('hidden');
            }
        });

        document.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            document.getElementById('drop-overlay')?.classList.add('hidden');
            this._handleDrop(e);
        });

        // 文件菜单
        this.setupFileMenu();

        // 变换还原按钮
        const resetButtons = [
            { id: 'reset-scale', handler: 'resetScale' },
            { id: 'reset-position', handler: 'resetPosition' },
            { id: 'reset-rotation', handler: 'resetRotation' },
        ];
        resetButtons.forEach(({ id, handler }) => {
            document.getElementById(id)?.addEventListener('click', () => this[handler]());
        });

        // 变换输入框回车/失焦确认（回车、NumpadEnter、change、blur 均提交，贴近 Orca/Bambu 行为）
        // 用捕获阶段的委托确保 WebView2/中文输入法下 Enter 也能截获
        const transformInputMap = {
            'size-x': 'applySizeFromInputs', 'size-y': 'applySizeFromInputs', 'size-z': 'applySizeFromInputs',
            'scale-x': 'applyScaleFromInputs', 'scale-y': 'applyScaleFromInputs', 'scale-z': 'applyScaleFromInputs',
            'pos-x': 'applyPositionFromInputs', 'pos-y': 'applyPositionFromInputs',
            'rot-x': 'applyRotationFromInputs', 'rot-y': 'applyRotationFromInputs', 'rot-z': 'applyRotationFromInputs',
        };
        const _transformIds = new Set(Object.keys(transformInputMap));
        const _commitTransform = (id) => {
            if (!id || !_transformIds.has(id)) return;
            if (this.selectedModels.size !== 1) {
                // 未单选时不提交（多选/无选中场景下的输入回车不应误改任何模型）
                return;
            }
            this[transformInputMap[id]]();
        };
        // 捕获阶段拦截 Enter，小键盘回车用 code 判定，WebView2 下 key 可能为空故补充 keyCode
        document.addEventListener('keydown', (e) => {
            const tid = e.target && e.target.id;
            if (!tid || !_transformIds.has(tid)) return;
            if (e.key === 'Enter' || e.code === 'NumpadEnter' || e.keyCode === 13) {
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                _commitTransform(tid);
                // 延迟失焦，避免与 change/blur 时序冲突；失焦后焦点保护会放开
                setTimeout(() => { try { e.target.blur(); } catch (_) {} }, 0);
            }
        }, true);
        document.addEventListener('keyup', (e) => {
            const tid = e.target && e.target.id;
            if (!tid || !_transformIds.has(tid)) return;
            if (e.key === 'Enter' || e.code === 'NumpadEnter' || e.keyCode === 13) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
        // change/blur 仍作为键盘外的兜底（鼠标点别处、滚轮改值等）
        const _attachBlurChange = () => {
            Object.keys(transformInputMap).forEach(id => {
                const el = document.getElementById(id);
                if (!el || el._mkpBound) return;
                el._mkpBound = true;
                let _pending = false;
                const once = () => {
                    if (_pending) return;
                    _pending = true;
                    _commitTransform(id);
                    setTimeout(() => { _pending = false; }, 0);
                };
                el.addEventListener('change', once);
                el.addEventListener('blur', once);
            });
        };
        _attachBlurChange();
        // 面板显隐后可能重建，延迟再绑一次兜底
        setTimeout(_attachBlurChange, 800);

        // 使用 click 事件直接处理点击
        this.renderer.domElement.addEventListener('click', (e) => {
            // 只有当不是拖拽操作时才处理点击
            if (!this.isDraggingModel && !this.isFreeDragging && !this.justFinishedTransform) {
                this.onMouseClick(e);
            }
        });

        this.renderer.domElement.addEventListener('mousemove', (e) => {
            if (this.isDraggingModel) {
                this.updateTransformInputs();
                this.updateSelectionBoxes();
            }
            if (this.isFreeDragging || this._towerDrag) {
                this.handleFreeDrag(e);
            }
            // 盘操作按钮悬停高亮
            if (this.plateActions) {
                const hit = this._hitTestPlateButtonMesh(e.clientX, e.clientY);
                const prev = this._curPlateHoverBtn;
                if (hit) {
                    if (prev && prev !== hit) this._setPlateButtonHover(prev, false);
                    this._setPlateButtonHover(hit, true);
                } else if (prev) {
                    this._setPlateButtonHover(prev, false);
                }
            }
        });

        this.renderer.domElement.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                // 盘操作按钮按下反馈
                if (this.plateActions) {
                    const hit = this._hitTestPlateButtonMesh(e.clientX, e.clientY);
                    if (hit) this._setPlateButtonPress(hit, true);
                }
                this.handleMouseDown(e);
            }
        });

        this.renderer.domElement.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                // 释放按钮按下反馈
                if (this.plateActions) {
                    this.plateActions.forEach((b) => {
                        if (this._curPlateHoverBtn === b) this._setPlateButtonHover(b, true);
                        else b.scale.set(1, 1, 1);
                    });
                }
                this.handleMouseUp(e);
            }
        });

        document.addEventListener('keydown', (e) => {
            // 焦点在输入框/文本域时，放行默认行为（粘贴/全选等）
            const tag = document.activeElement ? document.activeElement.tagName : '';
            const isInput = tag === 'INPUT' || tag === 'TEXTAREA' ||
                            document.activeElement?.isContentEditable;
            if (isInput) return;

            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            }
            if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
                e.preventDefault();
                this.redo();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                e.preventDefault();
                this.copyModel();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                e.preventDefault();
                this.pasteModel();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                e.preventDefault();
                this.selectAll();
            }
            if (e.key === 'Delete') {
                e.preventDefault();
                this.deleteSelectedModels();
            }
        });

        this.updateUndoRedoButtons();
    }

    handleMouseDown(e) {
        if (this.currentMode !== null) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        // 擦料塔：直接命中任意塔即可拖拽（像拖动模型一样，禁止缩放旋转）—— 已锁定的盘禁止编辑塔位置
        if (this.plateBoards) {
            const towerMeshes = [];
            this.plateBoards.forEach((group) => {
                group.traverse((o) => { if (o.isMesh && o.userData && o.userData.isTower) towerMeshes.push(o); });
            });
            if (towerMeshes.length) {
                const hits = this.raycaster.intersectObjects(towerMeshes, false);
                if (hits.length > 0) {
                    const hitMesh = hits[0].object;
                    // 解析到塔对象（group）——整塔一体
                    const tower = hitMesh.userData.towerGroup || hitMesh;
                    const towerPlateId = tower.userData ? tower.userData.plateId : null;
                    if (towerPlateId != null && this.isPlateLocked(towerPlateId)) {
                        const plateName = this.plates.get(towerPlateId)?.name || `盘 ${towerPlateId}`;
                        this.showToast(`「${plateName}」已锁定，无法移动擦嘴塔`, 'warning');
                        // 已锁定时不选中也不进入拖拽，避免后续可拖动
                        if (this._selectedTower) {
                            this._selectedTower = null;
                            this._hideTowerSelection();
                        }
                        return;
                    }
                    this._selectedTower = tower;
                    this._showTowerSelection(tower);
                    this._towerDrag = {
                        tower,
                        plateId: tower.userData.plateId,
                        baseX: tower.position.x,
                        baseY: tower.position.y,
                    };
                    this.orbitControls.enabled = false;
                    return;
                }
            }
        }

        // 选中的擦料塔（若上一步没命中，则取消选中）
        if (this._selectedTower && this._towerDrag === null) {
            const box = new THREE.Box3().setFromObject(this._selectedTower);
            const hit = this.raycaster.ray.intersectBox(box, new THREE.Vector3());
            if (hit === null) {
                this._selectedTower = null;
                this._hideTowerSelection();
            }
        }

        if (this.selectedModels.size === 1) {
            const selectedModelId = Array.from(this.selectedModels)[0];
            const model = this.models.get(selectedModelId);
            if (model && model.visible && !this.isModelLocked(selectedModelId)) {
                const box = new THREE.Box3().setFromObject(model.mesh);
                const intersects = this.raycaster.ray.intersectBox(box, new THREE.Vector3());

                if (intersects !== null) {
                    this.isFreeDragging = true;
                    this.freeDragModel = model;
                    this.saveState();
                    this.orbitControls.enabled = false;
                }
            }
        }
    }

    handleFreeDrag(e) {
        // 擦料塔拖拽：在塔当前高度平面移动 —— 已锁盘禁止拖动
        if (this._towerDrag && this._towerDrag.tower) {
            const dragPlateId = this._towerDrag.plateId;
            if (dragPlateId != null && this.isPlateLocked(dragPlateId)) {
                this._towerDrag = null;
                if (this._selectedTower) { this._selectedTower = null; this._hideTowerSelection(); }
                return;
            }
            const rect = this.renderer.domElement.getBoundingClientRect();
            const mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            const mouseY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            const ray = new THREE.Raycaster();
            ray.setFromCamera(new THREE.Vector2(mouseX, mouseY), this.camera);
            const tower = this._towerDrag.tower;
            const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -tower.position.z);
            const inter = new THREE.Vector3();
            if (ray.ray.intersectPlane(plane, inter)) {
                const center = this._getPlateWorldPos(this._towerDrag.plateId);
                // 限制在盘内
                const halfW = this.bedSize.x / 2;
                const halfD = this.bedSize.y / 2;
                tower.position.x = Math.max(center.x - halfW, Math.min(center.x + halfW, inter.x));
                tower.position.y = Math.max(center.y - halfD, Math.min(center.y + halfD, inter.y));
                tower.updateMatrixWorld(true);
                if (this._towerSelHelper) this._towerSelHelper.update();
            }
            return;
        }
        if (!this.isFreeDragging || !this.freeDragModel) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const mouseY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), this.camera);

        const transformSource = this.freeDragModel._transformProxy || this.freeDragModel.mesh;

        const modelWorldPos = new THREE.Vector3();
        transformSource.getWorldPosition(modelWorldPos);

        // 在模型当前Z高度创建一个水平面，将鼠标射线与平面求交
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -modelWorldPos.z);
        const intersection = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, intersection);

        if (intersection) {
            // 交点是世界坐标，需转成 transformSource 父级（盘容器/自由区）的局部坐标
            const parentObj = transformSource.parent;
            if (parentObj) {
                parentObj.updateMatrixWorld(true);
                const local = parentObj.worldToLocal(intersection.clone());
                transformSource.position.x = local.x;
                transformSource.position.y = local.y;
            } else {
                transformSource.position.x = intersection.x;
                transformSource.position.y = intersection.y;
            }
        }

        transformSource.updateMatrixWorld(true);
        this.lockZAxis();
        this.updateSelectionBoxes();
        this.updateTransformInputs();
    }

    handleMouseUp(e) {
        if (this._towerDrag && this._towerDrag.tower) {
            const dragPlateId = this._towerDrag.plateId;
            if (dragPlateId != null && this.isPlateLocked(dragPlateId)) {
                // 已锁定时撤销拖动，不保存位置
                this._towerDrag = null;
                if (this._selectedTower) { this._selectedTower = null; this._hideTowerSelection(); }
            } else {
                // 把塔当前位置存入该盘的塔偏移（相对盘中心），供 wipe_tower 用
                const center = this._getPlateWorldPos(this._towerDrag.plateId);
                const tower = this._towerDrag.tower;
                const ox = tower.position.x - center.x;
                const oy = tower.position.y - center.y;
                tower.userData.offset = { x: ox, y: oy };
                const plate = this.plates.get(this._towerDrag.plateId);
                if (plate) plate.towerOffset = { x: ox, y: oy };
                this._towerDrag = null;
                this.saveState('调整擦料塔位置');
            }
        }
        if (this.isFreeDragging) {
            this.isFreeDragging = false;
            // 拖动后按位置归属：模型中心落入某个盘→归属该盘；否则回自由区
            const dragged = this.freeDragModel;
            this.freeDragModel = null;
            if (dragged) this._assignModelToPlateByPosition(dragged);
            this.saveState();
        }

        this.orbitControls.enabled = true;
    }

    setupContextMenu() {
        this.contextMenu = document.getElementById('context-menu');
        this.mirrorSubmenu = document.getElementById('mirror-submenu');
        this.exportModelSubmenu = document.getElementById('export-model-submenu');

        this.renderer.domElement.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.handleContextMenu(e);
        });

        document.querySelectorAll('#context-menu .context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const action = item.dataset.action;
                if (action === 'mirror') {
                    this.showMirrorSubmenu(e);
                } else if (action === 'export-model') {
                    this.showExportModelSubmenu(e);
                } else {
                    this.handleContextMenuAction(action);
                    this.hideContextMenu();
                }
            });

            item.addEventListener('mouseenter', (e) => {
                if (item.dataset.action === 'mirror') {
                    this.showMirrorSubmenu(e);
                } else if (item.dataset.action === 'export-model') {
                    this.showExportModelSubmenu(e);
                } else {
                    this.hideMirrorSubmenu();
                    this.hideExportModelSubmenu();
                }
            });
        });

        document.querySelectorAll('#mirror-submenu .context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const action = item.dataset.action;
                this.handleContextMenuAction(action);
                this.hideContextMenu();
            });
        });

        if (this.exportModelSubmenu) {
            this.exportModelSubmenu.querySelectorAll('.context-menu-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const action = item.dataset.action;
                    this.handleContextMenuAction(action);
                    this.hideContextMenu();
                });
            });
        }

        document.addEventListener('click', (e) => {
            const inCtx = this.contextMenu.contains(e.target);
            const inMirror = this.mirrorSubmenu && this.mirrorSubmenu.contains(e.target);
            const inExport = this.exportModelSubmenu && this.exportModelSubmenu.contains(e.target);
            if (!inCtx && !inMirror && !inExport) {
                this.hideContextMenu();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideContextMenu();
            }
        });
    }

    handleContextMenu(e) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        const objectsToTest = [];
        this.models.forEach(model => {
            if (model.visible) {
                model.mesh.traverse((child) => {
                    if (child.isMesh) objectsToTest.push(child);
                });
            }
        });

        const intersects = this.raycaster.intersectObjects(objectsToTest);

        if (intersects.length > 0) {
            let targetMesh = intersects[0].object;
            let modelId = null;

            while (targetMesh) {
                if (targetMesh.userData.modelId !== undefined) {
                    modelId = targetMesh.userData.modelId;
                    break;
                }
                targetMesh = targetMesh.parent;
            }

            if (modelId !== null && this.models.has(modelId)) {
                this.contextMenuTarget = modelId;
                this.showContextMenu(e.clientX, e.clientY);
            }
        }
    }

    showContextMenu(x, y) {
        this.contextMenu.style.left = `${x}px`;
        this.contextMenu.style.top = `${y}px`;
        this.contextMenu.classList.remove('hidden');
        this.hideMirrorSubmenu();
        this.hideExportModelSubmenu();

        // 条件显示组合/解组
        const groupBtn = document.getElementById('ctx-group');
        const ungroupBtn = document.getElementById('ctx-ungroup');
        const groupSep = this.contextMenu.querySelector('.ctx-group-sep');

        if (groupBtn && ungroupBtn && groupSep) {
            const targetModel = this.models.get(this.contextMenuTarget);
            const isGroup = targetModel && !!targetModel._groupData;
            const multiSelected = this.selectedModels.size > 1;

            if (multiSelected && !isGroup) {
                // 多选且不是组合 → 显示「组合」
                groupBtn.classList.remove('hidden');
                ungroupBtn.classList.add('hidden');
                groupSep.classList.remove('hidden');
            } else if (isGroup) {
                // 右击组合体 → 显示「解组」
                groupBtn.classList.add('hidden');
                ungroupBtn.classList.remove('hidden');
                groupSep.classList.remove('hidden');
            } else {
                // 其他情况 → 都隐藏
                groupBtn.classList.add('hidden');
                ungroupBtn.classList.add('hidden');
                groupSep.classList.add('hidden');
            }
        }

        const rect = this.contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.contextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.contextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
        }
    }

    hideContextMenu() {
        this.contextMenu.classList.add('hidden');
        this.hideMirrorSubmenu();
        this.hideExportModelSubmenu();
        this.contextMenuTarget = null;
    }

    showMirrorSubmenu(e) {
        const mirrorItem = this.contextMenu.querySelector('[data-action="mirror"]');
        const rect = mirrorItem.getBoundingClientRect();

        this.mirrorSubmenu.style.left = `${rect.right + 4}px`;
        this.mirrorSubmenu.style.top = `${rect.top}px`;
        this.mirrorSubmenu.classList.remove('hidden');

        const submenuRect = this.mirrorSubmenu.getBoundingClientRect();
        if (submenuRect.right > window.innerWidth) {
            this.mirrorSubmenu.style.left = `${rect.left - submenuRect.width - 4}px`;
        }
        if (submenuRect.bottom > window.innerHeight) {
            this.mirrorSubmenu.style.top = `${window.innerHeight - submenuRect.height - 10}px`;
        }
    }

    hideMirrorSubmenu() {
        this.mirrorSubmenu.classList.add('hidden');
    }

    showExportModelSubmenu(e) {
        if (!this.exportModelSubmenu) return;
        const anchor = this.contextMenu.querySelector('[data-action="export-model"]');
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        this.hideMirrorSubmenu();
        this.exportModelSubmenu.style.left = `${rect.right + 4}px`;
        this.exportModelSubmenu.style.top = `${rect.top}px`;
        this.exportModelSubmenu.classList.remove('hidden');
        const r2 = this.exportModelSubmenu.getBoundingClientRect();
        if (r2.right > window.innerWidth) this.exportModelSubmenu.style.left = `${rect.left - r2.width - 4}px`;
        if (r2.bottom > window.innerHeight) this.exportModelSubmenu.style.top = `${window.innerHeight - r2.height - 10}px`;
    }

    hideExportModelSubmenu() {
        if (this.exportModelSubmenu) this.exportModelSubmenu.classList.add('hidden');
    }

    handleContextMenuAction(action) {
        if (!this.contextMenuTarget) return;

        switch (action) {
            case 'clone':
                this.cloneTargetId = this.contextMenuTarget;
                this.openCloneDialog();
                break;
            case 'delete':
                this.deleteModelById(this.contextMenuTarget);
                break;
            case 'reload':
                this.reloadModelFromDisk(this.contextMenuTarget);
                break;
            case 'group':
                this.groupSelected();
                break;
            case 'ungroup':
                // 确保右键点击的组合体在选中列表中
                if (this.contextMenuTarget && !this.selectedModels.has(this.contextMenuTarget)) {
                    this.selectedModels.add(this.contextMenuTarget);
                }
                this.ungroupSelected();
                break;
            case 'mirror-x':
                this.mirrorModel(this.contextMenuTarget, 'x');
                break;
            case 'mirror-y':
                this.mirrorModel(this.contextMenuTarget, 'y');
                break;
            case 'mirror-z':
                this.mirrorModel(this.contextMenuTarget, 'z');
                break;
            case 'toggle_printable':
                this.toggleModelPrintable(this.contextMenuTarget);
                break;
            case 'export-glb':
                this.exportSelectedModelAsGLB(this.contextMenuTarget);
                break;
            case 'export-obj':
                this.exportSelectedModelAsOBJ(this.contextMenuTarget);
                break;
        }
    }

    _getBakedExportBaseName(model) {
        const raw = (model && model.name) ? model.name : 'model';
        return raw.replace(/\.[^.]+$/, '') || 'model';
    }

    _buildBakedOBJPayload(model) {
        const meshes = [];
        const texMap = {};
        let textureCounter = 0;

        model.mesh.updateWorldMatrix(true, true);
        const invModelWorld = model.mesh.matrixWorld.clone().invert();
        model.mesh.traverse((child) => {
            if (!child.isMesh) return;
            const geo = child.geometry.clone();
            geo.applyMatrix4(child.matrixWorld);
            geo.applyMatrix4(invModelWorld);
            geo.computeVertexNormals();
            let textureName = null;
            let textureFlipY = true;
            if (child.material && child.material.map && child.material.map.image) {
                textureFlipY = child.material.map.flipY !== false;
                const b64 = this._textureToBase64(child.material.map.image);
                if (b64) {
                    textureName = `tex_${textureCounter}.png`;
                    textureCounter++;
                    texMap[textureName] = b64;
                }
            }
            meshes.push({ geometry: geo, textureName, textureFlipY });
        });

        if (meshes.length === 0) return null;

        const modelBase = this._getBakedExportBaseName(model);
        let objStr = '# Baked by MKPSpectrum\n';
        const hasTextures = Object.keys(texMap).length > 0;
        if (hasTextures) objStr += `mtllib ${modelBase}.mtl\n\n`;

        let mtlStr = '# MTL generated by MKPSpectrum\n';
        let vertexOffset = 0;
        const usedMatNames = new Set();

        for (const { geometry, textureName, textureFlipY } of meshes) {
            const pos = geometry.getAttribute('position');
            const uv = geometry.getAttribute('uv');
            const norm = geometry.getAttribute('normal');
            const index = geometry.index;
            if (!pos || pos.count === 0) continue;

            const matName = textureName ? textureName.replace('.png', '_mat') : 'default_mat';
            if (!usedMatNames.has(matName)) {
                usedMatNames.add(matName);
                mtlStr += `\nnewmtl ${matName}\n`;
                mtlStr += 'Kd 0.8 0.8 0.8\nKs 0.0 0.0 0.0\nNs 0\nd 1.0\nillum 2\n';
                if (textureName) {
                    mtlStr += `map_Kd ${textureName}\n`;
                    mtlStr += `MKP_flipY ${textureFlipY ? 1 : 0}\n`;
                }
            }
            objStr += `usemtl ${matName}\n`;

            for (let i = 0; i < pos.count; i++) {
                objStr += `v ${pos.getX(i).toFixed(6)} ${pos.getY(i).toFixed(6)} ${pos.getZ(i).toFixed(6)}\n`;
            }
            const hasUv = uv && uv.count > 0;
            if (hasUv) {
                for (let i = 0; i < uv.count; i++) objStr += `vt ${uv.getX(i).toFixed(6)} ${uv.getY(i).toFixed(6)}\n`;
            }
            const hasNorm = norm && norm.count > 0;
            if (hasNorm) {
                for (let i = 0; i < norm.count; i++) objStr += `vn ${norm.getX(i).toFixed(6)} ${norm.getY(i).toFixed(6)} ${norm.getZ(i).toFixed(6)}\n`;
            }
            const faceCount = index ? index.count : pos.count;
            for (let i = 0; i < faceCount; i += 3) {
                let a, b, c;
                if (index) {
                    a = index.getX(i) + 1 + vertexOffset;
                    b = index.getX(i + 1) + 1 + vertexOffset;
                    c = index.getX(i + 2) + 1 + vertexOffset;
                } else {
                    a = i + 1 + vertexOffset;
                    b = i + 2 + vertexOffset;
                    c = i + 3 + vertexOffset;
                }
                if (hasUv && hasNorm) objStr += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
                else if (hasUv) objStr += `f ${a}/${a} ${b}/${b} ${c}/${c}\n`;
                else objStr += `f ${a} ${b} ${c}\n`;
            }
            vertexOffset += pos.count;
        }

        return { obj: objStr, mtl: hasTextures ? mtlStr : '', textures: texMap, name: model.name };
    }

    async exportSelectedModelAsOBJ(modelId) {
        const model = this.models.get(modelId);
        if (!model) { this.showToast('未找到所选模型', 'error'); return; }
        const payload = this._buildBakedOBJPayload(model);
        if (!payload) { this.showToast('没有可导出的网格', 'warning'); return; }
        try {
            const result = await window.pywebview.api.save_baked_obj_bundle(JSON.stringify(payload));
            if (!result) { this.showToast('导出已取消或后端无响应', 'warning'); return; }
            if (result.error === '已取消') return;
            if (!result.success) { this.showToast('导出失败：' + (result.error || '未知错误'), 'error'); return; }
            this.showToast('已导出：' + (result.path || ''), 'success');
        } catch (e) {
            console.error('[导出OBJ] 异常:', e);
            this.showToast('导出失败：' + (e.message || String(e)), 'error');
        }
    }

    async _buildBakedGLBArrayBuffer(model) {
        // 把当前在场景中的变换烘焙到顶点后的克隆体导出为 GLB（保留贴图）
        model.mesh.updateWorldMatrix(true, true);
        const invModelWorld = model.mesh.matrixWorld.clone().invert();
        const exportRoot = new THREE.Group();
        exportRoot.name = this._getBakedExportBaseName(model);
        model.mesh.traverse((child) => {
            if (!child.isMesh) return;
            const geo = child.geometry.clone();
            geo.applyMatrix4(child.matrixWorld);
            geo.applyMatrix4(invModelWorld);
            geo.computeVertexNormals();
            const mat = child.material ? child.material.clone() : new THREE.MeshStandardMaterial({ color: 0xcccccc });
            // 关键：GLTFExporter 会从 material.map.image 抽贴图并内嵌到 GLB；clone 的材质仍保留贴图引用
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = child.name || 'mesh';
            exportRoot.add(mesh);
        });
        if (exportRoot.children.length === 0) return null;

        const exporter = new GLTFExporter();
        const glb = await new Promise((resolve, reject) => {
            exporter.parse(exportRoot, (result) => resolve(result), (err) => reject(err), { binary: true });
        });
        // exporter binary:true 返回 ArrayBuffer
        if (glb instanceof ArrayBuffer) return glb;
        if (glb && glb.buffer instanceof ArrayBuffer) return glb.buffer;
        return glb;
    }

    _arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    async exportSelectedModelAsGLB(modelId) {
        const model = this.models.get(modelId);
        if (!model) { this.showToast('未找到所选模型', 'error'); return; }
        let buffer = null;
        try {
            buffer = await this._buildBakedGLBArrayBuffer(model);
        } catch (e) {
            console.error('[导出GLB] 烘焙失败:', e);
            this.showToast('导出失败：' + (e.message || String(e)), 'error');
            return;
        }
        if (!buffer || buffer.byteLength === 0) { this.showToast('没有可导出的网格', 'warning'); return; }
        const b64 = this._arrayBufferToBase64(buffer);
        const dataUrl = 'data:application/octet-stream;base64,' + b64;
        try {
            const result = await window.pywebview.api.save_baked_glb(dataUrl, model.name || 'model');
            if (!result) { this.showToast('导出已取消或后端无响应', 'warning'); return; }
            if (result.error === '已取消') return;
            if (!result.success) { this.showToast('导出失败：' + (result.error || '未知错误'), 'error'); return; }
            this.showToast('已导出：' + (result.path || ''), 'success');
        } catch (e) {
            console.error('[导出GLB] 保存失败:', e);
            this.showToast('导出失败：' + (e.message || String(e)), 'error');
        }
    }

    /**
     * 在物体列表上右键显示上下文菜单
     */
    _showListContextMenu(e, model) {
        const menu = document.getElementById('context-menu');
        if (!menu) return;
        this.contextMenuTarget = model.id;
        // 更新菜单项文字
        const toggleItem = document.getElementById('ctx-toggle-printable');
        if (toggleItem) {
            toggleItem.textContent = model.printable ? '设为不可打印' : '设为可打印';
        }

        // 条件显示组合/解组
        const groupBtn = document.getElementById('ctx-group');
        const ungroupBtn = document.getElementById('ctx-ungroup');
        const groupSep = menu.querySelector('.ctx-group-sep');

        if (groupBtn && ungroupBtn && groupSep) {
            const isGroup = !!model._groupData;
            const multiSelected = this.selectedModels.size > 1;

            if (multiSelected && !isGroup) {
                groupBtn.classList.remove('hidden');
                ungroupBtn.classList.add('hidden');
                groupSep.classList.remove('hidden');
            } else if (isGroup) {
                groupBtn.classList.add('hidden');
                ungroupBtn.classList.remove('hidden');
                groupSep.classList.remove('hidden');
            } else {
                groupBtn.classList.add('hidden');
                ungroupBtn.classList.add('hidden');
                groupSep.classList.add('hidden');
            }
        }

        // 定位
        const rect = e.target.closest('.object-item')?.getBoundingClientRect();
        if (rect) {
            menu.style.left = (e.clientX - rect.left) + 'px';
            menu.style.top = (e.clientY - rect.top) + 'px';
            menu.style.position = 'fixed';
        } else {
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.style.position = 'fixed';
        }
        menu.classList.remove('hidden');
    }

    toggleModelPrintable(modelId) {
        const model = this.models.get(modelId);
        if (!model) return;
        model.printable = !model.printable;

        // 更新 3D 场景中的外观
        this._updateModelPrintAppearance(model);

        this.updateObjectList();
        this.saveState();
    }

    /** 根据 printable 状态更新模型外观：不可打印 = 灰色半透明；保存的原始材质放在 WeakMap，避免克隆时被 JSON 破坏 */
    _updateModelPrintAppearance(model) {
        model.mesh.traverse((child) => {
            if (!child.isMesh) return;
            const mat = child.material;
            if (!mat) return;

            if (model.printable) {
                // 恢复原始材质（从 WeakMap 取；取不到说明没有灰化过，就地还原透明度即可）
                const saved = this._savedPrintMaterials.get(mat);
                if (saved) {
                    child.material = saved;
                    this._savedPrintMaterials.delete(mat);
                } else {
                    mat.transparent = false;
                    mat.opacity = 1.0;
                    mat.needsUpdate = true;
                }
            } else {
                // 保存原始材质（仅首次）
                if (!this._savedPrintMaterials.has(mat)) {
                    this._savedPrintMaterials.set(mat, mat.clone());
                    mat.userData._origColorHex = mat.color.getHex().toString(16);
                }
                // 设为灰色半透明
                mat.transparent = true;
                mat.opacity = 0.35;
                mat.color.setHex(0x888888);
                mat.needsUpdate = true;
            }
        });
    }

    cloneModel(modelId, count = 1) {
        const model = this.models.get(modelId);
        if (!model || count < 1) return;

        this.saveState();

        // 获取源模型的世界变换（避免选中状态下 _transformProxy 导致的丢失缩放/旋转问题）
        const srcWorldPos = new THREE.Vector3();
        model.mesh.getWorldPosition(srcWorldPos);
        const srcWorldQuat = new THREE.Quaternion();
        model.mesh.getWorldQuaternion(srcWorldQuat);
        const srcWorldScale = new THREE.Vector3();
        model.mesh.getWorldScale(srcWorldScale);

        for (let i = 1; i <= count; i++) {
            const newMesh = model.mesh.clone();
            newMesh.traverse((child) => {
                if (child.isMesh) {
                    if (child.geometry) {
                        child.geometry = child.geometry.clone();
                    }
                    if (child.material) {
                        // 若源材质处于“不可打印”灰化状态，克隆其已保存的原始材质作为副本底材
                        const srcMat = child.material;
                        const saved = this._savedPrintMaterials.get(srcMat);
                        child.material = (saved || srcMat).clone();
                    }
                }
            });

            const newModelId = this.nextModelId++;
            const newName = count > 1 ? `${model.name} (副本${i})` : `${model.name} (副本)`;
            const newModelObj = new ModelObject(newMesh, newName, newModelId);
            // 继承源模型的可打印状态与所属盘，避免副本状态与外观/控件不一致；随后重设外观以登记副本自身的原始材质
            newModelObj.printable = model.printable;
            newModelObj.plateId = model.plateId;
            if (model._accumRotation) newModelObj._accumRotation.copy(model._accumRotation);

            // 更新克隆体所有子节点的 userData.modelId，否则点击会选中母本
            newMesh.traverse((child) => {
                if (child.isMesh || child.userData.isModel) {
                    child.userData.modelId = newModelId;
                }
            });

            // 应用源模型的世界变换到克隆体（位置 + 偏移、旋转、缩放）
            newMesh.position.copy(srcWorldPos);
            newMesh.quaternion.copy(srcWorldQuat);
            newMesh.scale.copy(srcWorldScale);
            newMesh.position.x += 20 * i;
            newMesh.position.y += 20 * i;

            this.models.set(newModelId, newModelObj);
            this.scene.add(newMesh);
            // 仅当副本为不可打印时重设灰色外观并登记副本自身的原始材质，保证后续切换能正确还原
            if (!newModelObj.printable) this._updateModelPrintAppearance(newModelObj);

            const filePath = this.modelFilePaths.get(modelId);
            if (filePath) {
                this.modelFilePaths.set(newModelId, filePath);
            }

            if (i === count) {
                this.selectModelById(newModelId, true);
            }
        }
        this.updateObjectList();
        this.saveState();
    }

    openCloneDialog() {
        const dialog = document.getElementById('clone-dialog');
        const input = document.getElementById('clone-count');
        if (!dialog || !input) return;

        input.value = 1;
        dialog.classList.remove('hidden');
        input.focus();
        input.select();
    }

    closeCloneDialog() {
        const dialog = document.getElementById('clone-dialog');
        if (dialog) dialog.classList.add('hidden');
        this.cloneTargetId = null;
    }

    setupCloneDialog() {
        const closeBtn = document.getElementById('clone-close');
        const cancelBtn = document.getElementById('clone-cancel');
        const confirmBtn = document.getElementById('clone-confirm');
        const input = document.getElementById('clone-count');

        if (closeBtn) closeBtn.addEventListener('click', () => this.closeCloneDialog());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeCloneDialog());

        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                const count = parseInt(input.value) || 1;
                if (this.cloneTargetId !== null) {
                    this.cloneModel(this.cloneTargetId, Math.max(1, count));
                    this.cloneTargetId = null;
                    // 勾选「克隆后自动排列」时，克隆完成后对当前盘自动摆放
                    if (document.getElementById('clone-arrange')?.checked) {
                        this.doAutoArrange();
                    }
                }
                this.closeCloneDialog();
            });
        }

        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmBtn.click();
                }
            });
        }

        const dialog = document.getElementById('clone-dialog');
        if (dialog) {
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) {
                    this.closeCloneDialog();
                }
            });
        }
    }

    _initCalibrateUI() {
        // ---------- 状态 ----------
        const S = {
            imageLoaded: false,
            imgNat: { w: 0, h: 0 },
            imgDisp: { w: 0, h: 0 },    // 未缩放时的显示尺寸
            scenePos: { x: 0, y: 0 },    // scene CSS left/top
            zoom: 1,
            drawMode: null,              // 'blue' | 'red' | null
            dragMode: null,              // 'draw' | 'move' | 'resize'
            dragRect: null,              // 当前拖拽的 rect key
            dragHandle: null,            // handle class
            dragStart: { x: 0, y: 0 },
            dragOrig: null,              // rect 原始尺寸
            rects: { blue: null, red: null },
            selected: null,              // 'blue' | 'red'
            blueLocked: false,           // 绘制红色框后蓝色框锁定，不可移动/缩放
            correction: null,            // 待应用的偏移差值 {x, y}，未点击确定前不生效
            panOffset: { x: 0, y: 0 },   // 右键拖拽平移量（缩放后可平移查看图片）
        };

        const scene = document.getElementById('cal-scene');
        const viewport = document.getElementById('cal-viewport');
        const img = document.getElementById('cal-image');
        const placeholder = document.getElementById('cal-placeholder');
        const fileInput = document.getElementById('cal-image-input');
        const rectBlue = document.getElementById('cal-rect-blue');
        const rectRed = document.getElementById('cal-rect-red');
        const zoomLabel = document.getElementById('cal-zoom-label');
        const statusEl = document.getElementById('cal-result-status');
        const offsetXEl = document.getElementById('cal-img-offset-x');
        const offsetYEl = document.getElementById('cal-img-offset-y');

        const BLUE_SIZE = 40;  // mm
        const RED_SIZE = 10;   // mm

        // ---------- 坐标转换 ----------
        function getScenePos(e) {
            const rect = scene.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) / S.zoom,
                y: (e.clientY - rect.top) / S.zoom
            };
        }

        // ---------- 更新 scene 位置/缩放 ----------
        function updateScene() {
            const vpRect = viewport.getBoundingClientRect();
            const sw = S.imgDisp.w * S.zoom;
            const sh = S.imgDisp.h * S.zoom;
            // 居中 + 右键拖拽平移（限制在可视范围内，避免拖出空白）
            const cx = (vpRect.width - sw) / 2;
            const cy = (vpRect.height - sh) / 2;
            const maxX = Math.max(0, (sw - vpRect.width) / 2);
            const maxY = Math.max(0, (sh - vpRect.height) / 2);
            S.panOffset.x = Math.max(-maxX, Math.min(maxX, S.panOffset.x));
            S.panOffset.y = Math.max(-maxY, Math.min(maxY, S.panOffset.y));
            S.scenePos.x = cx + S.panOffset.x;
            S.scenePos.y = cy + S.panOffset.y;
            scene.style.left = S.scenePos.x + 'px';
            scene.style.top = S.scenePos.y + 'px';
            scene.style.width = S.imgDisp.w + 'px';
            scene.style.height = S.imgDisp.h + 'px';
            scene.style.transform = 'scale(' + S.zoom + ')';
            zoomLabel.textContent = Math.round(S.zoom * 100) + '%';
        }

        // ---------- 放置图片 ----------
        function layoutImage() {
            const vpRect = viewport.getBoundingClientRect();
            const vpW = vpRect.width;
            const vpH = vpRect.height;
            const scale = Math.min(vpW / S.imgNat.w, vpH / S.imgNat.h) * 0.92;
            S.imgDisp.w = S.imgNat.w * scale;
            S.imgDisp.h = S.imgNat.h * scale;
            img.style.width = '100%';
            img.style.height = '100%';
            img.classList.remove('cal-image-hidden');
            placeholder.style.display = 'none';
            S.zoom = 1;
            S.panOffset = { x: 0, y: 0 };
            S.imageLoaded = true;
            updateScene();
        }

        // ---------- 加载图片 ----------
        document.getElementById('cal-load-img').addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) return;
            const url = URL.createObjectURL(file);
            img.onload = () => {
                S.imgNat.w = img.naturalWidth;
                S.imgNat.h = img.naturalHeight;
                layoutImage();
                // 清除旧框
                clearRects();
                updateResult();
                URL.revokeObjectURL(url);
            };
            img.src = url;
        });

        // ---------- 缩放 ----------
        document.getElementById('cal-zoom-in').addEventListener('click', () => {
            if (!S.imageLoaded) return;
            S.zoom = Math.min(S.zoom * 1.25, 8);
            updateScene();
        });
        document.getElementById('cal-zoom-out').addEventListener('click', () => {
            if (!S.imageLoaded) return;
            S.zoom = Math.max(S.zoom / 1.25, 0.125);
            updateScene();
        });
        document.getElementById('cal-zoom-reset').addEventListener('click', () => {
            if (!S.imageLoaded) return;
            S.zoom = 1;
            updateScene();
        });

        // ---------- 矩形绘制/控制 ----------
        function getRectEl(key) {
            return key === 'blue' ? rectBlue : rectRed;
        }

        function getRectData(key) {
            return S.rects[key];
        }

        function setRectData(key, data) {
            S.rects[key] = data;
        }

        function applyRectDOM(key) {
            const data = getRectData(key);
            const el = getRectEl(key);
            if (!data) {
                el.classList.remove('active');
                return;
            }
            el.classList.add('active');
            el.style.left = data.x + 'px';
            el.style.top = data.y + 'px';
            el.style.width = data.w + 'px';
            el.style.height = data.h + 'px';
        }

        function selectRect(key) {
            S.selected = key;
            rectBlue.classList.toggle('selected', key === 'blue');
            rectRed.classList.toggle('selected', key === 'red');
        }

        function clearRects() {
            S.rects.blue = null;
            S.rects.red = null;
            S.selected = null;
            S.drawMode = null;
            S.blueLocked = false;
            S.correction = null;
            rectBlue.classList.remove('active', 'selected', 'locked');
            rectRed.classList.remove('active', 'selected');
            document.querySelectorAll('.cal-draw-btn').forEach(b => b.classList.remove('active'));
            scene.classList.remove('drawing');
            updateResult();
        }

        // ---------- 绘制按钮 ----------
        function enterDrawMode(color) {
            if (!S.imageLoaded) return;
            // 如果已有该框则不允许重绘
            if (S.rects[color]) return;

            // 退出另一种绘制模式
            if (S.drawMode && S.drawMode !== color) {
                document.getElementById('btn-draw-' + S.drawMode).classList.remove('active');
            }
            S.drawMode = color;
            scene.classList.add('drawing');
        }

        document.getElementById('btn-draw-blue').addEventListener('click', function () {
            if (S.rects.blue) return;
            enterDrawMode('blue');
            this.classList.add('active');
            document.getElementById('btn-draw-red').classList.remove('active');
        });

        document.getElementById('btn-draw-red').addEventListener('click', function () {
            if (S.rects.red) return;
            // 开始画红色框后，蓝色定位框固定，不允许再移动/缩放
            if (S.rects.blue) {
                S.blueLocked = true;
                rectBlue.classList.add('locked');
                rectBlue.classList.remove('selected');
                statusEl.textContent = '蓝色框已固定，画错了请点击「清除」重新框选';
            }
            enterDrawMode('red');
            this.classList.add('active');
            document.getElementById('btn-draw-blue').classList.remove('active');
        });

        document.getElementById('btn-clear-rects').addEventListener('click', clearRects);

        // ---------- 鼠标事件 ----------
        function onMouseDown(e) {
            if (!S.imageLoaded) return;
            // 右键：按住拖拽平移图片（缩放后可平移查看）
            if (e.button === 2) {
                S.dragMode = 'pan';
                S.dragStart = { x: e.clientX, y: e.clientY };
                e.preventDefault();
                return;
            }
            if (e.button !== 0) return;

            const sp = getScenePos(e);
            const target = e.target;

            // 绘制模式优先：不触发移动/选中已有框
            if (S.drawMode) {
                S.dragMode = 'draw';
                S.dragRect = S.drawMode;
                setRectData(S.dragRect, { x: sp.x, y: sp.y, w: 0, h: 0 });
                applyRectDOM(S.dragRect);
                S.dragStart = { x: sp.x, y: sp.y };
                return;
            }

            // 检查是否点击了 handle（调整尺寸）
            if (target.classList.contains('cal-rect-handle')) {
                const rectEl = target.closest('.cal-rect');
                const key = rectEl.id === 'cal-rect-blue' ? 'blue' : 'red';
                if (key === 'blue' && S.blueLocked) return;  // 蓝色框已锁定，不允许调整尺寸
                selectRect(key);
                S.dragMode = 'resize';
                S.dragRect = key;
                S.dragHandle = Array.from(rectEl.querySelectorAll('.cal-rect-handle')).indexOf(target);
                S.dragStart = { x: sp.x, y: sp.y };
                S.dragOrig = { ...getRectData(key) };
                return;
            }

            // 检查是否点击了矩形
            const rectKey = hitTestRect(sp);
            if (rectKey) {
                selectRect(rectKey);
                S.dragMode = 'move';
                S.dragRect = rectKey;
                S.dragStart = { x: sp.x, y: sp.y };
                S.dragOrig = { ...getRectData(rectKey) };
                return;
            }

            // 取消选中
            S.selected = null;
            rectBlue.classList.remove('selected');
            rectRed.classList.remove('selected');
        }

        function onMouseMove(e) {
            if (!S.imageLoaded || !S.dragMode) return;
            const sp = getScenePos(e);

            if (S.dragMode === 'draw') {
                const d = getRectData(S.dragRect);
                const nx = Math.min(sp.x, S.dragStart.x);
                const ny = Math.min(sp.y, S.dragStart.y);
                const nw = Math.abs(sp.x - S.dragStart.x);
                const nh = Math.abs(sp.y - S.dragStart.y);
                d.x = nx;
                d.y = ny;
                d.w = nw;
                d.h = nh;
                applyRectDOM(S.dragRect);
            } else if (S.dragMode === 'move') {
                const d = getRectData(S.dragRect);
                const dx = sp.x - S.dragStart.x;
                const dy = sp.y - S.dragStart.y;
                d.x = S.dragOrig.x + dx;
                d.y = S.dragOrig.y + dy;
                // 限制在图片内
                d.x = Math.max(0, Math.min(S.imgDisp.w - d.w, d.x));
                d.y = Math.max(0, Math.min(S.imgDisp.h - d.h, d.y));
                applyRectDOM(S.dragRect);
            } else if (S.dragMode === 'resize') {
                const d = getRectData(S.dragRect);
                const orig = S.dragOrig;
                const dx = sp.x - S.dragStart.x;
                const dy = sp.y - S.dragStart.y;
                const handleIdx = S.dragHandle;

                let newX = orig.x, newY = orig.y, newW = orig.w, newH = orig.h;

                // handle order: nw, ne, sw, se
                if (handleIdx === 0) { // nw
                    newX = orig.x + dx; newW = orig.w - dx;
                    newY = orig.y + dy; newH = orig.h - dy;
                } else if (handleIdx === 1) { // ne
                    newW = orig.w + dx;
                    newY = orig.y + dy; newH = orig.h - dy;
                } else if (handleIdx === 2) { // sw
                    newX = orig.x + dx; newW = orig.w - dx;
                    newH = orig.h + dy;
                } else if (handleIdx === 3) { // se
                    newW = orig.w + dx;
                    newH = orig.h + dy;
                }

                // 最小尺寸
                if (newW < 20) { newW = 20; if (handleIdx === 0 || handleIdx === 2) newX = orig.x + orig.w - 20; }
                if (newH < 20) { newH = 20; if (handleIdx === 0 || handleIdx === 1) newY = orig.y + orig.h - 20; }

                // 限制在图片内
                newX = Math.max(0, newX);
                newY = Math.max(0, newY);
                if (newX + newW > S.imgDisp.w) newW = S.imgDisp.w - newX;
                if (newY + newH > S.imgDisp.h) newH = S.imgDisp.h - newY;

                d.x = newX; d.y = newY; d.w = newW; d.h = newH;
                applyRectDOM(S.dragRect);
            } else if (S.dragMode === 'pan') {
                // 右键拖拽平移图片
                S.panOffset.x += e.clientX - S.dragStart.x;
                S.panOffset.y += e.clientY - S.dragStart.y;
                S.dragStart = { x: e.clientX, y: e.clientY };
                updateScene();
            }

            if (S.dragMode !== 'draw') updateResult();
        }

        function onMouseUp(e) {
            if (!S.imageLoaded || !S.dragMode) return;

            if (S.dragMode === 'draw') {
                const d = getRectData(S.dragRect);
                // 太小的框视为取消
                if (d.w < 10 || d.h < 10) {
                    setRectData(S.dragRect, null);
                    applyRectDOM(S.dragRect);
                } else {
                    // 绘制完成，退出绘制模式
                    document.getElementById('btn-draw-' + S.dragRect).classList.remove('active');
                    S.drawMode = null;
                    scene.classList.remove('drawing');
                    selectRect(S.dragRect);
                    updateResult();
                }
            }

            if (S.dragMode === 'move' || S.dragMode === 'resize') {
                updateResult();
            }

            S.dragMode = null;
            S.dragRect = null;
            S.dragHandle = null;
            S.dragOrig = null;
        }

        function hitTestRect(sp) {
            for (const key of ['blue', 'red']) {
                if (key === 'blue' && S.blueLocked) continue;  // 蓝色框已锁定，不允许移动
                const d = getRectData(key);
                if (!d) continue;
                if (sp.x >= d.x && sp.x <= d.x + d.w &&
                    sp.y >= d.y && sp.y <= d.y + d.h) {
                    return key;
                }
            }
            return null;
        }

        scene.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        // 屏蔽右键菜单：右键用于拖拽平移图片
        scene.addEventListener('contextmenu', (e) => e.preventDefault());

        // ---------- 偏移计算 ----------
        const self = this;
        function updateResult() {
            const b = S.rects.blue;
            const r = S.rects.red;

            if (!b || !r) {
                offsetXEl.textContent = 'X: ---';
                offsetYEl.textContent = 'Y: ---';
                S.correction = null;
                if (!b && !r) statusEl.textContent = '请绘制校准卡范围(蓝)和色块位置(红)';
                else if (!b) statusEl.textContent = '请先绘制校准卡范围(蓝)';
                else statusEl.textContent = '请再绘制色块位置(红)';
                return;
            }

            const bcx = b.x + b.w / 2;
            const bcy = b.y + b.h / 2;
            const rcx = r.x + r.w / 2;
            const rcy = r.y + r.h / 2;

            const scaleX = BLUE_SIZE / b.w;
            const scaleY = BLUE_SIZE / b.h;

            // 测量红框中心相对蓝框中心的偏移后换算为修正量：
            // 偏右 → X 减；偏上 → Y 减（偏下 → Y 加）
            const corrX = -(rcx - bcx) * scaleX;
            const corrY = (rcy - bcy) * scaleY;
            // 只保存差值，不直接写入偏移，等待点击[确定]再叠加到现有偏移上
            S.correction = { x: corrX, y: corrY };

            offsetXEl.textContent = 'X: ' + (corrX >= 0 ? '+' : '') + corrX.toFixed(2) + ' mm';
            offsetYEl.textContent = 'Y: ' + (corrY >= 0 ? '+' : '') + corrY.toFixed(2) + ' mm';
            const sx = (corrX >= 0 ? '加' : '减') + Math.abs(corrX).toFixed(2);
            const sy = (corrY >= 0 ? '加' : '减') + Math.abs(corrY).toFixed(2);
            statusEl.textContent = 'X方向' + sx + '，Y方向' + sy + '，点击[确定]叠加到当前偏移(X:' +
                self.calibrateOffset.x.toFixed(2) + ' Y:' + self.calibrateOffset.y.toFixed(2) + ')';
        }

        // ---------- 窗口 resize 时重排 ----------
        const ro = new ResizeObserver(() => {
            if (S.imageLoaded) {
                const vpRect = viewport.getBoundingClientRect();
                if (vpRect.width === 0 || vpRect.height === 0) return;
                const scale = Math.min(vpRect.width / S.imgNat.w, vpRect.height / S.imgNat.h) * 0.92;
                S.imgDisp.w = S.imgNat.w * scale;
                S.imgDisp.h = S.imgNat.h * scale;
                img.style.width = '100%';
                img.style.height = '100%';
                S.zoom = Math.min(S.zoom, 8);
                updateScene();
            }
        });
        ro.observe(viewport);

        // 步进选择
        document.querySelectorAll('.step-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.calibrateStep = parseFloat(btn.dataset.step);
            });
        });

        // 更新喷墨偏移值显示
        const _updateOffsetDisplay = () => {
            const xEl = document.getElementById('offset-x');
            const yEl = document.getElementById('offset-y');
            if (xEl) xEl.value = this.calibrateOffset.x.toFixed(2);
            if (yEl) yEl.value = this.calibrateOffset.y.toFixed(2);
        };

        // 输入框变更 → 同步到变量
        const _readOffsetInputsToVars = () => {
            const xEl = document.getElementById('offset-x');
            const yEl = document.getElementById('offset-y');
            if (xEl) this.calibrateOffset.x = parseFloat(xEl.value) || 0;
            if (yEl) this.calibrateOffset.y = parseFloat(yEl.value) || 0;
        };
        ['offset-x', 'offset-y'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => _readOffsetInputsToVars());
        });

        // ---------- 确定按钮：把测量差值叠加到当前偏移上 ----------
        const applyOffsetBtn = document.getElementById('cal-apply-offset');
        if (applyOffsetBtn) {
            applyOffsetBtn.addEventListener('click', () => {
                if (!S.correction) {
                    statusEl.textContent = '请先绘制校准卡范围(蓝)和色块位置(红)，再点击确定';
                    return;
                }
                const dx = S.correction.x;
                const dy = S.correction.y;
                self.calibrateOffset.x += dx;
                self.calibrateOffset.y += dy;
                _updateOffsetDisplay();
                statusEl.textContent = '已应用：X' + (dx >= 0 ? '加' : '减') + Math.abs(dx).toFixed(2) +
                    '，Y' + (dy >= 0 ? '加' : '减') + Math.abs(dy).toFixed(2) +
                    ' → 当前偏移 X:' + self.calibrateOffset.x.toFixed(2) +
                    ' Y:' + self.calibrateOffset.y.toFixed(2);
                // 差值已消费，防止重复叠加
                S.correction = null;
                offsetXEl.textContent = 'X: ---';
                offsetYEl.textContent = 'Y: ---';
                // 自动保存到当前配置
                if (typeof self._saveCurrentConfig === 'function') self._saveCurrentConfig();
            });
        }

        // ---------- 使用说明弹窗 ----------
        const helpOverlay = document.getElementById('cal-help-overlay');
        const helpBtn = document.getElementById('cal-help-btn');
        if (helpOverlay && helpBtn) {
            helpBtn.addEventListener('click', () => helpOverlay.classList.remove('hidden'));
            const closeHelp = () => helpOverlay.classList.add('hidden');
            document.getElementById('cal-help-close')?.addEventListener('click', closeHelp);
            helpOverlay.addEventListener('click', (e) => {
                if (e.target === helpOverlay) closeHelp();
            });
        }

        // 方向键（D-Pad）
        document.getElementById('cal-up')?.addEventListener('click', () => {
            this.calibrateOffset.y += this.calibrateStep;
            _updateOffsetDisplay();
        });
        document.getElementById('cal-down')?.addEventListener('click', () => {
            this.calibrateOffset.y -= this.calibrateStep;
            _updateOffsetDisplay();
        });
        document.getElementById('cal-left')?.addEventListener('click', () => {
            this.calibrateOffset.x -= this.calibrateStep;
            _updateOffsetDisplay();
        });
        document.getElementById('cal-right')?.addEventListener('click', () => {
            this.calibrateOffset.x += this.calibrateStep;
            _updateOffsetDisplay();
        });
        document.getElementById('cal-home')?.addEventListener('click', () => {
            this.calibrateOffset.x = 0;
            this.calibrateOffset.y = 0;
            _updateOffsetDisplay();
        });

        // ---------- 喷墨配置下拉框 ----------
        this._setupPrintConfigSelect();

        // ---------- 喷墨参数联动 ----------
        document.getElementById('inkjet-density').addEventListener('input', function () {
            document.getElementById('inkjet-density-val').textContent = this.value;
        });
        document.getElementById('inkjet-speed').addEventListener('input', function () {
            document.getElementById('inkjet-speed-val').textContent = this.value;
        });
        document.getElementById('inkjet-contrast').addEventListener('input', function () {
            document.getElementById('inkjet-contrast-val').textContent = parseFloat(this.value).toFixed(1);
        });
        this._getRepeatCount = () => {
            const sel = document.querySelector('#inkjet-repeat-select .select-option.selected');
            return sel ? parseInt(sel.dataset.value) || 1 : 1;
        };
        this._setRepeatCount = (val) => {
            const opts = document.querySelectorAll('#inkjet-repeat-select .select-option');
            const valDisplay = document.querySelector('#inkjet-repeat-select .select-value');
            opts.forEach(o => {
                o.classList.toggle('selected', parseInt(o.dataset.value) === val);
                if (parseInt(o.dataset.value) === val && valDisplay) valDisplay.textContent = o.textContent;
            });
        };
        // CMY 色调调节联动
        ['cmy-c', 'cmy-m', 'cmy-y', 'cmy-saturation', 'cmy-brightness'].forEach(id => {
            document.getElementById(id).addEventListener('input', function () {
                const v = parseFloat(this.value);
                const isSigned = id === 'cmy-saturation' || id === 'cmy-brightness';
                document.getElementById(id + '-val').textContent =
                    isSigned ? (v >= 0 ? '+' : '') + v.toFixed(2) : v.toFixed(2);
            });
        });
        // CMY 对话框 打开/关闭
        document.getElementById('btn-cmy-open').addEventListener('click', () => {
            document.getElementById('cmy-dialog').classList.remove('hidden');
        });
        const _closeCmy = () => {
            document.getElementById('cmy-dialog').classList.add('hidden');
            // 联动保存
            const name = this._configValueDisplay?.textContent;
            if (name && name !== '未配置' && window.pywebview?.api) {
                window.pywebview.api.save_print_setting(name, JSON.stringify(collectData())).catch(() => {});
            }
        };
        document.getElementById('cmy-close').addEventListener('click', _closeCmy);
        document.getElementById('cmy-done').addEventListener('click', _closeCmy);
        // 点击遮罩也关闭
        document.getElementById('cmy-dialog').addEventListener('click', function (e) {
            if (e.target === this) _closeCmy();
        });
        // CMY 复位按钮
        document.querySelectorAll('.cmy-reset').forEach(btn => {
            btn.addEventListener('click', function () {
                const targetId = this.dataset.target;
                const defaultVal = this.dataset.default;
                const slider = document.getElementById(targetId);
                if (slider) {
                    slider.value = defaultVal;
                    const isSigned = targetId === 'cmy-saturation' || targetId === 'cmy-brightness';
                    const v = parseFloat(defaultVal);
                    document.getElementById(targetId + '-val').textContent =
                        isSigned ? (v >= 0 ? '+' : '') + v.toFixed(2) : v.toFixed(2);
                }
            });
        });

        // ---------- 宏名称修改按钮 ----------
        this._grabMacro = 'GRAB_INKJET_HEAD';
        this._releaseMacro = 'RELEASE_INKJET_HEAD';
        this._towerPosX = 10;
        this._towerPosY = 220;
        document.getElementById('btn-macro-edit').addEventListener('click', async () => {
            const result = await this._showMacroDialog();
            if (result) {
                this._grabMacro = result.grab;
                this._releaseMacro = result.release;
                // 自动保存到当前配置
                const name = this._configValueDisplay?.textContent;
                if (name && name !== '未配置' && window.pywebview?.api) {
                    const data = {
                        inkjet: {
                            offset: { ...this.calibrateOffset },
                            step: this.calibrateStep,
                            imageOffset: (() => {
                                const xEl = document.getElementById('cal-img-offset-x');
                                const yEl = document.getElementById('cal-img-offset-y');
                                return { x: xEl ? xEl.textContent : '---', y: yEl ? yEl.textContent : '---' };
                            })(),
                            density: parseFloat(document.getElementById('inkjet-density').value) || 0.5,
                            speed: parseInt(document.getElementById('inkjet-speed').value) || 50,
                            repeat_count: this._getRepeatCount(),
                            dry_time: parseInt(document.getElementById('inkjet-dry-time').value) || 3,
                            contrast: parseFloat(document.getElementById('inkjet-contrast').value) || 1.0,
                            shear_mm: parseFloat(document.getElementById('shear-mm').value) || 0,
                            grab_macro: this._grabMacro || 'GRAB_INKJET_HEAD',
                            release_macro: this._releaseMacro || 'RELEASE_INKJET_HEAD',
                            cmy: {
                                c: parseFloat(document.getElementById('cmy-c').value) || 1.0,
                                m: parseFloat(document.getElementById('cmy-m').value) || 1.0,
                                y: parseFloat(document.getElementById('cmy-y').value) || 1.0,
                                saturation: parseFloat(document.getElementById('cmy-saturation').value) || 0.0,
                                brightness: parseFloat(document.getElementById('cmy-brightness').value) || 0.0
                            }
                        },
                        wipe_tower: this._getCurrentPlateTowerPos()
                    };
                    window.pywebview.api.save_print_setting(name, JSON.stringify(data));
                }
            }
        });

        // ---------- 擦嘴塔位置修改按钮（已取消，改由每盘中心方块决定） ----------
        document.getElementById('btn-tower-pos-edit')?.addEventListener('click', async () => {
            if (this.currentPlateId != null && this.isPlateLocked(this.currentPlateId)) {
                const plateName = this.plates.get(this.currentPlateId)?.name || `盘 ${this.currentPlateId}`;
                this.showToast(`「${plateName}」已锁定，无法修改擦嘴塔位置`, 'warning');
                return;
            }
            const result = await this._showTowerPosDialog();
            if (result) {
                this._towerPosX = result.x;
                this._towerPosY = result.y;
                // 自动保存到当前配置
                const name = this._configValueDisplay?.textContent;
                if (name && name !== '未配置' && window.pywebview?.api) {
                    const data = {
                        inkjet: {
                            offset: { ...this.calibrateOffset },
                            step: this.calibrateStep,
                            imageOffset: (() => {
                                const xEl = document.getElementById('cal-img-offset-x');
                                const yEl = document.getElementById('cal-img-offset-y');
                                return { x: xEl ? xEl.textContent : '---', y: yEl ? yEl.textContent : '---' };
                            })(),
                            density: parseFloat(document.getElementById('inkjet-density').value) || 0.5,
                            speed: parseInt(document.getElementById('inkjet-speed').value) || 50,
                            repeat_count: this._getRepeatCount(),
                            dry_time: parseInt(document.getElementById('inkjet-dry-time').value) || 3,
                            contrast: parseFloat(document.getElementById('inkjet-contrast').value) || 1.0,
                            shear_mm: parseFloat(document.getElementById('shear-mm').value) || 0,
                            grab_macro: this._grabMacro || 'GRAB_INKJET_HEAD',
                            release_macro: this._releaseMacro || 'RELEASE_INKJET_HEAD',
                            cmy: {
                                c: parseFloat(document.getElementById('cmy-c').value) || 1.0,
                                m: parseFloat(document.getElementById('cmy-m').value) || 1.0,
                                y: parseFloat(document.getElementById('cmy-y').value) || 1.0,
                                saturation: parseFloat(document.getElementById('cmy-saturation').value) || 0.0,
                                brightness: parseFloat(document.getElementById('cmy-brightness').value) || 0.0
                            }
                        },
                        wipe_tower: this._getCurrentPlateTowerPos()
                    };
                    window.pywebview.api.save_print_setting(name, JSON.stringify(data));
                }
            }
        });

        // ---------- 预览层数滑块 ----------
        this._setupLayerSlider();
    }

    // ---- 自定义对话框 ----
    _showDialog(title, desc, placeholder) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('cal-dialog-overlay');
            const titleEl = overlay.querySelector('.dialog-title');
            const descEl = overlay.querySelector('.dialog-desc');
            const inputEl = document.getElementById('cal-dialog-input');
            const confirmBtn = document.getElementById('cal-dialog-confirm');
            const cancelBtn = document.getElementById('cal-dialog-cancel');

            titleEl.textContent = title;
            descEl.textContent = desc;
            inputEl.value = '';
            inputEl.placeholder = placeholder || '';
            overlay.classList.remove('hidden');
            inputEl.focus();

            const cleanup = () => {
                overlay.classList.add('hidden');
                confirmBtn.removeEventListener('click', onConfirm);
                cancelBtn.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onOverlay);
                inputEl.removeEventListener('keydown', onKey);
            };

            const onConfirm = () => {
                cleanup();
                resolve(inputEl.value.trim());
            };
            const onCancel = () => {
                cleanup();
                resolve(null);
            };
            const onOverlay = (e) => {
                if (e.target === overlay) { cleanup(); resolve(null); }
            };
            const onKey = (e) => {
                if (e.key === 'Enter') onConfirm();
                if (e.key === 'Escape') onCancel();
            };

            confirmBtn.addEventListener('click', onConfirm);
            cancelBtn.addEventListener('click', onCancel);
            overlay.addEventListener('click', onOverlay);
            inputEl.addEventListener('keydown', onKey);
        });
    }

    // ---------- 修改宏名称弹窗 ----------
    async _showMacroDialog() {
        const overlay = document.getElementById('cal-dialog-overlay');
        const contentRoot = overlay?.querySelector('.dialog-box');
        if (!overlay || !contentRoot) return null;

        // 尝试从已保存的配置中读取，避免硬编码默认值覆盖
        let grabVal = this._grabMacro || 'GRAB_INKJET_HEAD';
        let releaseVal = this._releaseMacro || 'RELEASE_INKJET_HEAD';
        const configName = this._configValueDisplay?.textContent;
        if (configName && configName !== '未配置' && window.pywebview?.api) {
            try {
                const res = await window.pywebview.api.load_print_setting(configName);
                if (res?.success && res.data?.inkjet) {
                    const ij = res.data.inkjet;
                    if (ij.grab_macro) grabVal = ij.grab_macro;
                    if (ij.release_macro) releaseVal = ij.release_macro;
                }
            } catch (e) { /* ignore */ }
        }
        // 同步实例变量
        this._grabMacro = grabVal;
        this._releaseMacro = releaseVal;

        return new Promise((resolve) => {
            const origHtml = contentRoot.innerHTML;

            contentRoot.innerHTML = `
                <div class="dialog-title" style="font-size:16px;font-weight:500;color:#e0e0e0;margin-bottom:4px;">修改喷墨宏名称</div>
                <div class="dialog-desc" style="font-size:13px;color:#888;margin-bottom:12px;">设定在 GCode 中插入的取得/放回喷墨模块宏命令</div>
                <div style="display:flex;flex-direction:column;gap:10px;width:100%;">
                    <div style="display:flex;flex-direction:column;gap:4px;">
                        <label style="font-size:13px;color:#ccc;">取得宏</label>
                        <textarea id="macro-dlg-grab" rows="3" style="width:100%;box-sizing:border-box;background:#2a2a3a;border:1px solid #444;border-radius:6px;padding:8px 10px;color:#ccc;font-size:13px;outline:none;font-family:Consolas,monospace;resize:vertical;">${this._escapeHtml(grabVal)}</textarea>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:4px;">
                        <label style="font-size:13px;color:#ccc;">放回宏</label>
                        <textarea id="macro-dlg-release" rows="3" style="width:100%;box-sizing:border-box;background:#2a2a3a;border:1px solid #444;border-radius:6px;padding:8px 10px;color:#ccc;font-size:13px;outline:none;font-family:Consolas,monospace;resize:vertical;">${this._escapeHtml(releaseVal)}</textarea>
                    </div>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
                    <button class="btn-secondary" id="macro-dlg-cancel" style="padding:6px 16px;">取消</button>
                    <button class="btn-primary" id="macro-dlg-confirm" style="padding:6px 16px;">保存</button>
                </div>
            `;
            // 让 dialog-box 自适应内容宽度
            contentRoot.style.width = 'auto';
            contentRoot.style.minWidth = '500px';
            // 不要全局灰色遮罩
            const origOverlayBg = overlay.style.background;
            overlay.style.background = 'transparent';
            overlay.classList.remove('hidden');
            overlay.querySelector('#macro-dlg-grab').focus();

            // 阻止点击 dialog-box 内容区冒泡到 overlay 导致误关闭
            const stopBubble = (e) => e.stopPropagation();
            contentRoot.addEventListener('click', stopBubble);
            contentRoot.addEventListener('mousedown', stopBubble);

            const cleanup = () => {
                overlay.classList.add('hidden');
                overlay.style.background = origOverlayBg;
                contentRoot.style.width = '';
                contentRoot.style.minWidth = '';
                contentRoot.innerHTML = origHtml;
                contentRoot.removeEventListener('click', stopBubble);
                contentRoot.removeEventListener('mousedown', stopBubble);
                overlay.querySelector('#macro-dlg-cancel')?.removeEventListener('click', onCancel);
                overlay.querySelector('#macro-dlg-confirm')?.removeEventListener('click', onConfirm);
                overlay.removeEventListener('mousedown', onOverlay);
            };
            const onConfirm = () => {
                const g = overlay.querySelector('#macro-dlg-grab');
                const r = overlay.querySelector('#macro-dlg-release');
                const result = {
                    grab: (g ? g.value.trim() : '') || 'GRAB_INKJET_HEAD',
                    release: (r ? r.value.trim() : '') || 'RELEASE_INKJET_HEAD',
                };
                cleanup();
                resolve(result);
            };
            const onCancel = () => { cleanup(); resolve(null); };
            const onOverlay = (e) => { if (e.target === overlay) onCancel(); };
            overlay.querySelector('#macro-dlg-cancel').addEventListener('click', onCancel);
            overlay.querySelector('#macro-dlg-confirm').addEventListener('click', onConfirm);
            // 用 mousedown 而非 click，防止 focus 导致的误触发
            setTimeout(() => {
                overlay.addEventListener('mousedown', onOverlay);
            }, 100);
            overlay.querySelector('#macro-dlg-grab').addEventListener('keydown', (e) => {
                if (e.key === 'Escape') onCancel();
            });
            overlay.querySelector('#macro-dlg-release').addEventListener('keydown', (e) => {
                if (e.key === 'Escape') onCancel();
            });
        });
    }

    _setupRepeatSelect(onChange) {
        const customSelect = document.getElementById('inkjet-repeat-select');
        if (!customSelect) return;

        const trigger = customSelect.querySelector('.select-trigger');
        const optionsContainer = customSelect.querySelector('.select-options');
        const valueDisplay = customSelect.querySelector('.select-value');
        const options = customSelect.querySelectorAll('.select-option');

        if (trigger) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = !optionsContainer.classList.contains('hidden');
                this.closeAllSelects();
                if (!isOpen) {
                    optionsContainer.classList.remove('hidden');
                    trigger.classList.add('open');
                }
            });
        }

        options.forEach(opt => {
            opt.addEventListener('click', () => {
                options.forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                if (valueDisplay) valueDisplay.textContent = opt.textContent;
                optionsContainer.classList.add('hidden');
                trigger.classList.remove('open');
                // 吹干行可见性
                const dryRow = document.getElementById('inkjet-dry-row');
                if (dryRow) dryRow.style.display = this._getRepeatCount() > 1 ? '' : 'none';
                // 自动保存
                if (onChange) onChange();
            });
        });
    }

    // ---------- 擦嘴塔位置修改弹窗 ----------
    async _showTowerPosDialog() {
        const overlay = document.getElementById('cal-dialog-overlay');
        const contentRoot = overlay?.querySelector('.dialog-box');
        if (!overlay || !contentRoot) return null;

        let xVal = this._towerPosX;
        let yVal = this._towerPosY;
        // 尝试从已保存的配置读取
        const configName = this._configValueDisplay?.textContent;
        if (configName && configName !== '未配置' && window.pywebview?.api) {
            try {
                const res = await window.pywebview.api.load_print_setting(configName);
                if (res?.success && res.data?.wipe_tower) {
                    const wt = res.data.wipe_tower;
                    if (wt.x !== undefined && wt.x !== null) xVal = parseFloat(wt.x) || 10;
                    if (wt.y !== undefined && wt.y !== null) yVal = parseFloat(wt.y) || 220;
                }
            } catch (e) { /* ignore */ }
        }
        this._towerPosX = xVal;
        this._towerPosY = yVal;

        return new Promise((resolve) => {
            const origHtml = contentRoot.innerHTML;

            contentRoot.innerHTML = `
                <div class="dialog-title" style="font-size:16px;font-weight:500;color:#e0e0e0;margin-bottom:4px;">擦嘴塔位置修改</div>
                <div class="dialog-desc" style="font-size:13px;color:#888;margin-bottom:12px;">设置擦嘴塔左下角在热床上的 X / Y 位置 (mm)</div>
                <div style="display:flex;flex-direction:column;gap:10px;width:100%;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <label style="font-size:13px;color:#ccc;width:24px;">X</label>
                        <input type="number" id="tower-dlg-x" step="0.1" value="${xVal}" style="flex:1;box-sizing:border-box;background:#2a2a3a;border:1px solid #444;border-radius:6px;padding:6px 10px;color:#ccc;font-size:13px;outline:none;">
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <label style="font-size:13px;color:#ccc;width:24px;">Y</label>
                        <input type="number" id="tower-dlg-y" step="0.1" value="${yVal}" style="flex:1;box-sizing:border-box;background:#2a2a3a;border:1px solid #444;border-radius:6px;padding:6px 10px;color:#ccc;font-size:13px;outline:none;">
                    </div>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
                    <button class="btn-secondary" id="tower-dlg-cancel" style="padding:6px 16px;">取消</button>
                    <button class="btn-primary" id="tower-dlg-confirm" style="padding:6px 16px;">保存</button>
                </div>
            `;
            contentRoot.style.width = 'auto';
            contentRoot.style.minWidth = '320px';
            const origOverlayBg = overlay.style.background;
            overlay.style.background = 'transparent';
            overlay.classList.remove('hidden');
            overlay.querySelector('#tower-dlg-x').focus();

            const stopBubble = (e) => e.stopPropagation();
            contentRoot.addEventListener('click', stopBubble);
            contentRoot.addEventListener('mousedown', stopBubble);

            const cleanup = () => {
                overlay.classList.add('hidden');
                overlay.style.background = origOverlayBg;
                contentRoot.style.width = '';
                contentRoot.style.minWidth = '';
                contentRoot.innerHTML = origHtml;
                contentRoot.removeEventListener('click', stopBubble);
                contentRoot.removeEventListener('mousedown', stopBubble);
                overlay.querySelector('#tower-dlg-cancel')?.removeEventListener('click', onCancel);
                overlay.querySelector('#tower-dlg-confirm')?.removeEventListener('click', onConfirm);
                overlay.removeEventListener('mousedown', onOverlay);
            };
            const onConfirm = () => {
                const xEl = overlay.querySelector('#tower-dlg-x');
                const yEl = overlay.querySelector('#tower-dlg-y');
                const result = {
                    x: parseFloat(xEl?.value) || 10,
                    y: parseFloat(yEl?.value) || 220,
                };
                cleanup();
                resolve(result);
            };
            const onCancel = () => { cleanup(); resolve(null); };
            const onOverlay = (e) => { if (e.target === overlay) onCancel(); };
            overlay.querySelector('#tower-dlg-cancel').addEventListener('click', onCancel);
            overlay.querySelector('#tower-dlg-confirm').addEventListener('click', onConfirm);
            setTimeout(() => { overlay.addEventListener('mousedown', onOverlay); }, 100);
            overlay.querySelector('#tower-dlg-x').addEventListener('keydown', (e) => {
                if (e.key === 'Escape') onCancel();
            });
            overlay.querySelector('#tower-dlg-y').addEventListener('keydown', (e) => {
                if (e.key === 'Escape') onCancel();
            });
        });
    }

    _escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    async refreshPostprocessCommand() {
        const cmdEl = document.getElementById('postprocess-cmd');
        if (!cmdEl) return;
        if (window.pywebview && window.pywebview.api) {
            try {
                const configName = document.querySelector('#print-setting-select .select-value')?.textContent || 'MKP standard';
                const result = await window.pywebview.api.get_gcode_generator_path(configName);
                if (result && result.success && result.command) {
                    cmdEl.textContent = result.command;
                    return;
                }
            } catch (e) {
                console.warn('获取后处理命令失败', e);
            }
        }
        // 无后端时占位
        cmdEl.textContent = 'python MKPSpectrum.py --Config "MKP standard" --Gcode';
    }

    async _setupPrintConfigSelect() {
        const customSelect = document.getElementById('print-setting-select');
        if (!customSelect) return;

        const trigger = customSelect.querySelector('.select-trigger');
        const optionsContainer = customSelect.querySelector('.select-options');
        const valueDisplay = customSelect.querySelector('.select-value');
        this._configValueDisplay = valueDisplay;
        const statusEl = document.getElementById('config-status');

        // 收集当前所有参数
        const collectData = () => ({
            inkjet: {
                offset: { ...this.calibrateOffset },
                step: this.calibrateStep,
                imageOffset: (() => {
                    const xEl = document.getElementById('cal-img-offset-x');
                    const yEl = document.getElementById('cal-img-offset-y');
                    return {
                        x: xEl ? xEl.textContent : '---',
                        y: yEl ? yEl.textContent : '---'
                    };
                })(),
                density: parseFloat(document.getElementById('inkjet-density').value) || 0.5,
                speed: parseInt(document.getElementById('inkjet-speed').value) || 50,
                repeat_count: this._getRepeatCount(),
                dry_time: parseInt(document.getElementById('inkjet-dry-time').value) || 3,
                contrast: parseFloat(document.getElementById('inkjet-contrast').value) || 1.0,
                shear_mm: parseFloat(document.getElementById('shear-mm').value) || 0,
                grab_macro: this._grabMacro || 'GRAB_INKJET_HEAD',
                release_macro: this._releaseMacro || 'RELEASE_INKJET_HEAD',
                cmy: {
                    c: parseFloat(document.getElementById('cmy-c').value) || 1.0,
                    m: parseFloat(document.getElementById('cmy-m').value) || 1.0,
                    y: parseFloat(document.getElementById('cmy-y').value) || 1.0,
                    saturation: parseFloat(document.getElementById('cmy-saturation').value) || 0.0,
                    brightness: parseFloat(document.getElementById('cmy-brightness').value) || 0.0
                }
            },
            wipe_tower: this._getCurrentPlateTowerPos()
        });

        // 应用配置到 UI
        const applyData = (data) => {
            // 喷墨偏移与参数
            if (data.inkjet) {
                const ij = data.inkjet;
                if (ij.offset) {
                    const x = (ij.offset.x !== undefined && ij.offset.x !== null) ? parseFloat(ij.offset.x) : 0;
                    const y = (ij.offset.y !== undefined && ij.offset.y !== null) ? parseFloat(ij.offset.y) : 0;
                    this.calibrateOffset.x = isNaN(x) ? 0 : x;
                    this.calibrateOffset.y = isNaN(y) ? 0 : y;
                    const xEl = document.getElementById('offset-x');
                    const yEl = document.getElementById('offset-y');
                    if (xEl) xEl.value = this.calibrateOffset.x.toFixed(2);
                    if (yEl) yEl.value = this.calibrateOffset.y.toFixed(2);
                }
                if (ij.step !== undefined && ij.step !== null) {
                    this.calibrateStep = parseFloat(ij.step) || 0.1;
                    document.querySelectorAll('.step-btn').forEach(b => {
                        b.classList.toggle('active', parseFloat(b.dataset.step) === this.calibrateStep);
                    });
                }
                const densityEl = document.getElementById('inkjet-density');
                const speedEl = document.getElementById('inkjet-speed');
                if (ij.density !== undefined && ij.density !== null && densityEl) {
                    densityEl.value = ij.density;
                    document.getElementById('inkjet-density-val').textContent = ij.density;
                }
                if (ij.speed !== undefined && ij.speed !== null && speedEl) {
                    speedEl.value = ij.speed;
                    document.getElementById('inkjet-speed-val').textContent = ij.speed;
                }
                if (ij.repeat_count !== undefined && ij.repeat_count !== null) {
                    this._setRepeatCount(parseInt(ij.repeat_count) || 1);
                }
                if (ij.dry_time !== undefined && ij.dry_time !== null) {
                    const dryEl = document.getElementById('inkjet-dry-time');
                    const dryValEl = document.getElementById('inkjet-dry-time-val');
                    if (dryEl) dryEl.value = ij.dry_time;
                    if (dryValEl) dryValEl.textContent = ij.dry_time;
                }
                if (ij.contrast !== undefined && ij.contrast !== null) {
                    const contrastEl = document.getElementById('inkjet-contrast');
                    const contrastValEl = document.getElementById('inkjet-contrast-val');
                    if (contrastEl) contrastEl.value = ij.contrast;
                    if (contrastValEl) contrastValEl.textContent = parseFloat(ij.contrast).toFixed(1);
                }
                if (ij.shear_mm !== undefined && ij.shear_mm !== null) {
                    const shearEl = document.getElementById('shear-mm');
                    if (shearEl) shearEl.value = ij.shear_mm;
                }
                // 吹干行可见性
                const dryRowEl = document.getElementById('inkjet-dry-row');
                if (dryRowEl) {
                    dryRowEl.style.display = (ij.repeat_count || 1) > 1 ? '' : 'none';
                }
                // CMY 色调调节
                if (ij.cmy) {
                    const setCmy = (id, val) => {
                        const el = document.getElementById(id);
                        if (el) {
                            el.value = val;
                            document.getElementById(id + '-val').textContent = parseFloat(val).toFixed(2);
                        }
                    };
                    setCmy('cmy-c', ij.cmy.c !== undefined ? ij.cmy.c : 1.0);
                    setCmy('cmy-m', ij.cmy.m !== undefined ? ij.cmy.m : 1.0);
                    setCmy('cmy-y', ij.cmy.y !== undefined ? ij.cmy.y : 1.0);
                    setCmy('cmy-saturation', ij.cmy.saturation !== undefined ? ij.cmy.saturation : 0.0);
                    setCmy('cmy-brightness', ij.cmy.brightness !== undefined ? ij.cmy.brightness : 0.0);
                }
                if (ij.grab_macro) this._grabMacro = ij.grab_macro;
                if (ij.release_macro) this._releaseMacro = ij.release_macro;
            }
            // 擦嘴塔位置
            if (data.wipe_tower) {
                const wt = data.wipe_tower;
                if (wt.x !== undefined && wt.x !== null) this._towerPosX = parseFloat(wt.x) || 10;
                if (wt.y !== undefined && wt.y !== null) this._towerPosY = parseFloat(wt.y) || 220;
            }
        };

        // 监听外部重新加载配置的事件（如 switchToCalibrate 触发）
        document.addEventListener('mkp-reload-config', (e) => {
            if (e.detail) applyData(e.detail);
        });

        // 加载配置列表
        const refreshList = async (selectName) => {
            if (!window.pywebview || !window.pywebview.api) return;
            try {
                const result = await window.pywebview.api.list_print_settings();
                if (!result || !result.success) return;
                const current = valueDisplay.textContent;
                optionsContainer.innerHTML = '<div class="select-option" data-value="__new__">+ 新建配置...</div>';
                result.files.forEach(f => {
                    const opt = document.createElement('div');
                    opt.className = 'select-option' + (f.name === selectName || f.name === current ? ' selected' : '');
                    opt.dataset.value = f.name;
                    opt.textContent = f.name;
                    optionsContainer.appendChild(opt);
                });
                optionsContainer.querySelectorAll('.select-option').forEach(opt => {
                    opt.addEventListener('click', () => {
                        const val = opt.dataset.value;
                        if (val === '__new__') {
                            this._showDialog('新建配置', '请输入喷墨配置名称：', '例如：材料A 精细模式').then(name => {
                                if (!name) return;
                                valueDisplay.textContent = name;
                                if (window.pywebview && window.pywebview.api) {
                                    window.pywebview.api.save_print_setting(name, JSON.stringify(collectData()));
                                }
                                refreshList(name);
                                this.refreshPostprocessCommand();
                                if (statusEl) {
                                    statusEl.textContent = '已切换: ' + name;
                                    statusEl.className = 'cal-config-status success';
                                }
                            });
                            return;
                        }
                        optionsContainer.querySelectorAll('.select-option').forEach(o => o.classList.remove('selected'));
                        opt.classList.add('selected');
                        valueDisplay.textContent = opt.textContent;
                        optionsContainer.classList.add('hidden');
                        trigger.classList.remove('open');
                        loadConfig(opt.textContent);
                        this.refreshPostprocessCommand();
                    });
                });
            } catch (e) {
                console.warn('刷新配置列表失败', e);
            }
        };

        const loadConfig = async (name) => {
            if (!window.pywebview || !window.pywebview.api) return;
            try {
                const result = await window.pywebview.api.load_print_setting(name);
                if (!result || !result.success) return;
                applyData(result.data);
                this.refreshPostprocessCommand();
                if (statusEl) {
                    statusEl.textContent = '已加载: ' + name;
                    statusEl.className = 'cal-config-status success';
                    setTimeout(() => { statusEl.className = 'cal-config-status'; statusEl.textContent = ''; }, 3000);
                }
            } catch (e) {
                console.warn('加载配置失败', e);
            }
        };

        // 下拉交互
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !optionsContainer.classList.contains('hidden');
            document.querySelectorAll('.custom-select .select-options').forEach(el => {
                if (el !== optionsContainer) el.classList.add('hidden');
            });
            if (!isOpen) {
                optionsContainer.classList.remove('hidden');
                trigger.classList.add('open');
                refreshList(valueDisplay.textContent);
            } else {
                optionsContainer.classList.add('hidden');
                trigger.classList.remove('open');
            }
        });

        document.addEventListener('click', () => {
            optionsContainer.classList.add('hidden');
            trigger.classList.remove('open');
        });

        // 保存按钮
        document.getElementById('btn-save-config').addEventListener('click', async () => {
            if (!window.pywebview || !window.pywebview.api) {
                if (statusEl) { statusEl.textContent = '后端不可用'; statusEl.className = 'cal-config-status'; }
                return;
            }
            const name = valueDisplay.textContent;
            if (!name || name === '未配置') {
                this._showDialog('保存配置', '请输入配置名称：', '例如：材料A 精细模式').then(async (newName) => {
                    if (!newName) return;
                    valueDisplay.textContent = newName;
                    try {
                        await window.pywebview.api.save_print_setting(newName, JSON.stringify(collectData()));
                        if (statusEl) { statusEl.textContent = '已保存: ' + newName; statusEl.className = 'cal-config-status success'; }
                        refreshList(newName);
                        this.refreshPostprocessCommand();
                    } catch (e) {
                        if (statusEl) { statusEl.textContent = '保存失败'; statusEl.className = 'cal-config-status'; }
                    }
                });
                return;
            }
            try {
                await window.pywebview.api.save_print_setting(name, JSON.stringify(collectData()));
                if (statusEl) { statusEl.textContent = '已保存: ' + name; statusEl.className = 'cal-config-status success'; }
                setTimeout(() => { statusEl.className = 'cal-config-status'; statusEl.textContent = ''; }, 3000);
            } catch (e) {
                if (statusEl) { statusEl.textContent = '保存失败'; statusEl.className = 'cal-config-status'; }
            }
        });

        // 浓度/速度滑块自动保存（change 事件：松手时触发）
        this._saveCurrentConfig = () => {
            const name = valueDisplay.textContent;
            if (!name || name === '未配置' || !window.pywebview?.api) return;
            window.pywebview.api.save_print_setting(name, JSON.stringify(collectData())).catch(() => {});
        };
        const autoSaveSlider = this._saveCurrentConfig;
        document.getElementById('inkjet-density').addEventListener('change', autoSaveSlider);
        document.getElementById('inkjet-speed').addEventListener('change', autoSaveSlider);
        // 重复喷墨 自定义下拉
        this._setupRepeatSelect(autoSaveSlider);
        document.getElementById('inkjet-dry-time').addEventListener('input', function () {
            document.getElementById('inkjet-dry-time-val').textContent = this.value;
        });
        document.getElementById('inkjet-dry-time').addEventListener('change', autoSaveSlider);
        document.getElementById('inkjet-contrast').addEventListener('change', autoSaveSlider);
        document.getElementById('shear-mm').addEventListener('change', autoSaveSlider);
        // 还原按钮
        document.getElementById('btn-reset-config').addEventListener('click', () => {
            this.calibrateOffset.x = 0;
            this.calibrateOffset.y = 0;
            document.getElementById('offset-x').textContent = '0.00';
            document.getElementById('offset-y').textContent = '0.00';
            this.calibrateStep = 0.1;
            document.querySelectorAll('.step-btn').forEach(b => {
                b.classList.toggle('active', parseFloat(b.dataset.step) === 0.1);
            });
            document.getElementById('inkjet-density').value = 0.5;
            document.getElementById('inkjet-density-val').textContent = '0.5';
            document.getElementById('inkjet-speed').value = 50;
            document.getElementById('inkjet-speed-val').textContent = '50';
            this._setRepeatCount(1);
            document.getElementById('inkjet-dry-time').value = 3;
            document.getElementById('inkjet-dry-time-val').textContent = '3';
            document.getElementById('inkjet-dry-row').style.display = 'none';
            document.getElementById('inkjet-contrast').value = 1.0;
            document.getElementById('inkjet-contrast-val').textContent = '1.0';
            document.getElementById('shear-mm').value = 0;
            // 还原后自动保存
            const name = valueDisplay.textContent;
            if (name && name !== '未配置' && window.pywebview?.api) {
                window.pywebview.api.save_print_setting(name, JSON.stringify(collectData())).catch(() => {});
            }
            if (statusEl) { statusEl.textContent = '已还原为默认值'; statusEl.className = 'cal-config-status success'; }
            setTimeout(() => { statusEl.className = 'cal-config-status'; statusEl.textContent = ''; }, 3000);
        });

        // 初始加载 - 自动检查配置
        this._initPrintConfig(trigger, valueDisplay, optionsContainer, statusEl, refreshList, loadConfig);
    }

    async _initPrintConfig(trigger, valueDisplay, optionsContainer, statusEl, refreshList, loadConfig) {
        if (!window.pywebview || !window.pywebview.api) return;

        try {
            const result = await window.pywebview.api.list_print_settings();
            if (result.success && result.files && result.files.length > 0) {
                // 有配置 → 自动选择并加载第一个
                const first = result.files[0].name;
                valueDisplay.textContent = first;
                trigger.classList.remove('no-config');
                loadConfig(first);
            } else {
                // 无配置 → 提示用户创建
                trigger.classList.add('no-config');
                valueDisplay.textContent = '未配置';
                const wantCreate = await this._showConfirm(
                    '未找到喷墨配置',
                    '尚未创建任何喷墨配置文件，是否立即创建一个？'
                );
                if (wantCreate) {
                    const name = await this._showDialog('新建配置', '请输入喷墨配置名称：', '例如：材料A 精细模式');
                    if (name) {
                        valueDisplay.textContent = name;
                        const data = {
                            inkjet: { offset: { x: 0, y: 0 }, step: 0.1, imageOffset: { x: '---', y: '---' }, density: 0.5, speed: 50, repeat_count: 1, dry_time: 3, contrast: 1.0, shear_mm: 0 },
                            wipe_tower: this._getCurrentPlateTowerPos()
                        };
                        await window.pywebview.api.save_print_setting(name, JSON.stringify(data));
                        refreshList(name);
                        if (statusEl) {
                            statusEl.textContent = '已创建: ' + name;
                            statusEl.className = 'cal-config-status success';
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('初始化喷墨配置失败', e);
        }
    }

    /** 显示确认对话框，返回 true/false */
    _showConfirm(title, message) {
        return new Promise((resolve) => {
            // 复用 input 对话框改造为确认框
            const overlay = document.getElementById('dialog-overlay');
            const content = document.getElementById('dialog-content');
            if (!overlay || !content) { resolve(false); return; }

            overlay.classList.remove('hidden');
            content.innerHTML = `
                <h3>${title}</h3>
                <p style="color:#aaa;margin:12px 0;">${message}</p>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
                    <button class="btn-secondary" id="dlg-cancel" style="padding:6px 16px;">取消</button>
                    <button class="btn-primary" id="dlg-confirm" style="padding:6px 16px;">创建</button>
                </div>
            `;
            const cancelBtn = content.querySelector('#dlg-cancel');
            const confirmBtn = content.querySelector('#dlg-confirm');

            const cleanup = () => {
                overlay.classList.add('hidden');
                cancelBtn.removeEventListener('click', onCancel);
                confirmBtn.removeEventListener('click', onConfirm);
            };
            const onCancel = () => { cleanup(); resolve(false); };
            const onConfirm = () => { cleanup(); resolve(true); };

            setTimeout(() => {
                cancelBtn.addEventListener('click', onCancel);
                confirmBtn.addEventListener('click', onConfirm);
                // 点击遮罩取消
                overlay.addEventListener('click', onCancel, { once: true });
            }, 0);
            // 阻止点击内容区关闭
            content.addEventListener('click', (e) => e.stopPropagation(), { once: true });
        });
    }

    // ---------- 预览层数滑块 ----------
    _setupLayerSlider() {
        const slider = document.getElementById('layer-slider');
        const layerNum = document.getElementById('layer-info-num');
        const layerZ = document.getElementById('layer-info-z');
        const infoBox = document.getElementById('layer-info-box');
        if (!slider) return;

        const positionInfoBox = (pct) => {
            if (infoBox) {
                infoBox.style.bottom = pct + '%';
            }
        };

        const updateLayerDisplay = () => {
            const pct = parseFloat(slider.value);

            const container = document.getElementById('slice-images-container');
            const totalLayers = this._lastGcode ? this._countGcodeLayers(this._lastGcode) : 0;
            const totalImages = (this._previewImageCount > 0)
                ? this._previewImageCount
                : (container ? container.querySelectorAll('.slice-image-item').length : 0);
            const total = Math.max(totalLayers, totalImages);

            if (total === 0) {
                if (layerNum) layerNum.textContent = '0层';
                if (layerZ) layerZ.textContent = 'Z: 0.00 mm';
                positionInfoBox(100);
                return;
            }

            const showLayers = Math.max(1, Math.round(total * pct / 100));

            if (layerNum) layerNum.textContent = `${showLayers}层`;
            if (layerZ) layerZ.textContent = `Z: ${(showLayers * 0.2).toFixed(2)} mm`;
            positionInfoBox(pct);
            this._showSliceImage(showLayers - 1);

            this._updateGcode3DLayers();
        };

        slider.addEventListener('input', updateLayerDisplay);

        // 鼠标滚轮控制滑块 - 仅当鼠标悬停在层滑块区域时才切层，
        // 避免在 3D 视口内滚轮缩放时同步带动滑块
        const sliderBar = document.querySelector('.preview-slider-bar');
        const sliderFooter = document.querySelector('.preview-footer');
        const wheelTargets = [slider, sliderBar, sliderFooter].filter(Boolean);
        const isOnSlider = (target) => target.closest('.preview-footer') || target.closest('#layer-slider');
        const onSliderWheel = (e) => {
            if (!isOnSlider(e.target)) return;
            // 在滑块上滚动时只切层，不让事件冒泡到 3D 视口做缩放
            e.preventDefault();
            e.stopPropagation();
            const step = parseFloat(slider.step) || 1;
            const min = parseFloat(slider.min) || 1;
            const max = parseFloat(slider.max) || 100;
            let val = parseFloat(slider.value);
            val += e.deltaY > 0 ? -step : step;
            val = Math.max(min, Math.min(max, val));
            slider.value = val;
            slider.dispatchEvent(new Event('input'));
        };
        wheelTargets.forEach(el => el.addEventListener('wheel', onSliderWheel, { passive: false }));
        // 阻断 3D 视口的滚轮冒泡到预览页，避免误触发切层
        const gcodeContainer = document.getElementById('gcode-3d-container');
        if (gcodeContainer) {
            gcodeContainer.addEventListener('wheel', (e) => {
                e.stopPropagation();
            }, { passive: true });
        }

        const origDisplayImages = this.displaySliceImages.bind(this);
        this.displaySliceImages = (images) => {
            origDisplayImages(images);
            setTimeout(() => {
                this._updateLayerSlider();
            }, 0);
        };

        this._updateLayerSlider();
    }

    _updateLayerSlider() {
        // 防重入：_showSliceImage → _showSliceImageByIndex → _updateLayerSlider → _showSliceImage
        // 会无限递归（RangeError）。用标志切断这个环。
        if (this._updatingLayerSlider) return;
        this._updatingLayerSlider = true;
        try {
            this._updateLayerSliderInner();
        } finally {
            this._updatingLayerSlider = false;
        }
    }

    _updateLayerSliderInner() {
        const slider = document.getElementById('layer-slider');
        const layerNum = document.getElementById('layer-info-num');
        const layerZ = document.getElementById('layer-info-z');
        const infoBox = document.getElementById('layer-info-box');
        if (!slider) return;

        const totalLayers = this._lastGcode ? this._countGcodeLayers(this._lastGcode) : 0;
        const totalImages = (this._previewImageCount > 0)
            ? this._previewImageCount
            : document.querySelectorAll('#slice-images-container .slice-image-item').length;
        const total = Math.max(totalLayers, totalImages);

        if (total === 0) {
            slider.value = 100;
            slider.max = 100;
            if (layerNum) layerNum.textContent = '0层';
            if (layerZ) layerZ.textContent = 'Z: 0.00 mm';
            if (infoBox) infoBox.style.bottom = '100%';
            return;
        }

        slider.max = 100;
        const pct = parseFloat(slider.value);
        const showLayers = Math.max(1, Math.round(total * pct / 100));

        if (layerNum) layerNum.textContent = `${showLayers}层`;
        if (layerZ) layerZ.textContent = `Z: ${(showLayers * 0.2).toFixed(2)} mm`;
        if (infoBox) infoBox.style.bottom = pct + '%';
        this._showSliceImage(showLayers - 1);

        this._updateGcode3DLayers();
    }

    _countGcodeLayers(gcode) {
        if (!gcode || typeof gcode !== 'string') return 0;
        // 优先从 GCode 头部注释读取总层数：; total layer number: 43
        const headerMatch = gcode.match(/;\s*total\s*layer\s*number\s*:\s*(\d+)/i);
        if (headerMatch) {
            const n = parseInt(headerMatch[1], 10);
            if (n > 0) return n;
        }
        // 匹配 ;LAYER_CHANGE 标记（OrcaSlicer 格式）
        const layerChangeMatches = gcode.match(/;LAYER_CHANGE/gi);
        if (layerChangeMatches) return layerChangeMatches.length;
        // 匹配常见的层标记：;LAYER:0 或 ;LAYER: 0
        const layerMatches = gcode.match(/;?\s*LAYER\s*:\s*\d+/gi);
        if (layerMatches) return layerMatches.length;
        // 按 Z 高度变化估算
        const zMatches = gcode.match(/G1\s+Z[\d.]+\s*/gi);
        if (zMatches && zMatches.length > 1) return zMatches.length;
        // 以换行行数为保守估计
        const lines = gcode.split('\n').filter(l => l.trim());
        return Math.max(1, Math.round(lines.length / 20));
    }

    _splitGcodeByLayers(gcode) {
        if (!gcode || typeof gcode !== 'string') return [gcode || ''];
        // 按 ;LAYER_CHANGE 分割（OrcaSlicer 格式）
        const lcParts = gcode.split(/(?=;LAYER_CHANGE)/gi);
        if (lcParts.length > 1) return lcParts;
        // 按 ;LAYER: 分割
        const parts = gcode.split(/(?=;?\s*LAYER\s*:\s*\d+)/gi);
        if (parts.length > 1) return parts;
        // 按 G1 Z 分割
        const zParts = gcode.split(/(?=G1\s+Z[\d.]+)/gi);
        if (zParts.length > 1) return zParts;
        return [gcode];
    }

    async reloadModelFromDisk(modelId) {
        const model = this.models.get(modelId);
        if (!model) return;

        const filePath = this.modelFilePaths.get(modelId);
        if (!filePath) {
            this.showToast('无法找到原始文件路径', 'error');
            return;
        }

        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        try {
            const result = await window.pywebview.api.load_model_by_path(filePath);
            if (!result || !result.success) {
                this.showToast('重新加载失败: ' + (result ? result.error : '无返回'), 'error');
                return;
            }

            this.saveState();

            const oldMesh = model.mesh;
            if (!oldMesh) return;

            if (model.selected && model._transformProxy) {
                this.deselectModelInternal(model);
                model.selected = false;
            }

            // 记录当前（含已烘焙进几何的）世界包围盒中心、大小与原根旋转，
            // 重新加载后据此重建相同变换（而不是完全重置回原文件变换）
            oldMesh.updateMatrixWorld(true);
            const oldBox = new THREE.Box3().setFromObject(oldMesh);
            const bounds = {
                center: oldBox.getCenter(new THREE.Vector3()),
                size: oldBox.getSize(new THREE.Vector3()),
                rotation: oldMesh.rotation.clone(),
            };

            this.scene.remove(oldMesh);

            switch (result.type) {
                case 'stl':
                    this.loadSTLAndReplace(result.data, modelId, bounds);
                    break;
                case 'obj':
                    this.loadOBJAndReplace(result, modelId, bounds);
                    break;
                case 'gltf':
            case 'glb':
                this.loadGLTFAndReplace(result.data, modelId, bounds);
                break;
            case 'fbx':
                this.loadFBXAndReplace(result.data, modelId, bounds);
                break;
            }
        } catch (e) {
            console.error('重新加载模型异常:', e);
            this.showToast('重新加载异常: ' + e.message, 'error');
        }
    }

    loadSTLAndReplace(dataUrl, modelId, bounds) {
        const loader = new STLLoader();
        loader.load(dataUrl, (geometry) => {
            this.replaceModelMesh(modelId, geometry, bounds);
        });
    }

    loadGLTFAndReplace(dataUrl, modelId, bounds) {
        const loader = new GLTFLoader();
        loader.load(dataUrl, (gltf) => {
            this.replaceModelObject(modelId, gltf.scene, bounds);
        });
    }

    loadFBXAndReplace(dataUrl, modelId, bounds) {
        const loader = new FBXLoader();
        loader.load(dataUrl, (fbx) => {
            this.replaceModelObject(modelId, fbx, bounds);
        });
    }

    loadOBJAndReplace(result, modelId, bounds) {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
            const cleanUrl = url.split('/').pop().split('\\').pop();
            return result.textures[cleanUrl] || url;
        });
        const objLoader = new OBJLoader(manager);
        objLoader.load(result.obj, (object) => {
            if (result.mtl) {
                const mtlLoader = new MTLLoader(manager);
                mtlLoader.load(result.mtl, (materials) => {
                    materials.preload();
                    object.traverse((child) => {
                        if (child.isMesh) {
                            const matName = child.material.name;
                            if (materials.materials[matName]) {
                                child.material = materials.materials[matName];
                            }
                        }
                    });
                    this.replaceModelObject(modelId, object, bounds);
                }, undefined, () => {
                    this.replaceModelObject(modelId, object, bounds);
                });
            } else {
                this.replaceModelObject(modelId, object, bounds);
            }
        });
    }

    // 用旧的包围盒中心 + 大小 + 根旋转，把新加载的 model（object）统一缩放、旋转并定位回原位置
    _applyReplacedBounds(ref, center, size, rotation) {
        const box = new THREE.Box3().setFromObject(ref);
        const srcCenter = box.getCenter(new THREE.Vector3());
        const srcSize = box.getSize(new THREE.Vector3());
        const k = (srcSize.x > 0.001) ? (size.x / srcSize.x) : 1;
        // 统一缩放使包围盒尺寸与旧的一致（若新旧宽高比不同，仍以 X 方向为准近似）
        ref.scale.multiplyScalar(k);
        // 平移使包围盒中心对齐到旧中心（注意缩放围绕对象原点进行）
        ref.position.x = center.x - srcCenter.x * k;
        ref.position.y = center.y - srcCenter.y * k;
        ref.position.z = center.z - srcCenter.z * k;
        // 恢复旧的根旋转
        if (rotation) ref.rotation.copy(rotation);
        ref.updateMatrixWorld(true);
    }

    replaceModelMesh(modelId, geometry, bounds) {
        const model = this.models.get(modelId);
        if (!model) return;

        const material = new THREE.MeshStandardMaterial({
            color: 0x4a9eff,
            metalness: 0.3,
            roughness: 0.4,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.isModel = true;
        mesh.userData.modelId = modelId;

        this._applyReplacedBounds(mesh, bounds.center, bounds.size, bounds.rotation);

        if (model.selected && model._transformProxy) {
            this.deselectModelInternal(model);
        }

        this.scene.remove(model.mesh);
        model.mesh = mesh;
        this.scene.add(mesh);

        if (model.selected) {
            this.selectModelInternal(model);
        }

        this.updateSelectionBoxes();
        this.saveState();
    }

    replaceModelObject(modelId, object, bounds) {
        const model = this.models.get(modelId);
        if (!model) return;

        object.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                child.userData.isModel = true;
                child.userData.modelId = modelId;
            }
        });

        this._applyReplacedBounds(object, bounds.center, bounds.size, bounds.rotation);

        if (model.selected && model._transformProxy) {
            this.deselectModelInternal(model);
        }

        this.scene.remove(model.mesh);
        model.mesh = object;
        this.scene.add(object);

        if (model.selected) {
            this.selectModelInternal(model);
        }

        this.updateSelectionBoxes();
        this.saveState();
    }

    mirrorModel(modelId, axis) {
        const model = this.models.get(modelId);
        if (!model) return;

        const transformSource = model._transformProxy || model.mesh;

        switch (axis) {
            case 'x':
                transformSource.scale.x *= -1;
                break;
            case 'y':
                transformSource.scale.y *= -1;
                break;
            case 'z':
                transformSource.scale.z *= -1;
                break;
        }

        transformSource.updateMatrixWorld(true);
        this.lockZAxis();
        // 镜像后烘焙，把负 scale 写进顶点，避免变换链累积；烘焙后重算法线防止里外翻
        if (!model._groupData) {
            this.bakeTransform(model);
            model.mesh.traverse((child) => {
                if (child.isMesh && child.geometry) {
                    child.geometry.computeVertexNormals();
                }
            });
        }
        this.updateSelectionBoxes();
        this.updateTransformInputs();
        this.saveState('镜像模型');
    }

    // 文件菜单
    setupFileMenu() {
        const menuFile = document.getElementById('menu-file');
        const fileMenu = document.getElementById('file-menu');

        if (!menuFile || !fileMenu) return;

        menuFile.addEventListener('click', (e) => {
            e.stopPropagation();
            fileMenu.classList.toggle('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!fileMenu.contains(e.target) && e.target !== menuFile) {
                fileMenu.classList.add('hidden');
            }
        });

        fileMenu.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                fileMenu.classList.add('hidden');
                this.handleFileMenuAction(action);
            });
        });
    }

    handleFileMenuAction(action) {
        switch (action) {
            case 'new-project':
                this.newProject();
                break;
            case 'open-project':
                this.openProject();
                break;
            case 'save-project':
                this.saveProject();
                break;
            case 'save-project-as':
                this.saveProjectAs();
                break;
            case 'import-file':
                this.loadModelFromBackend();
                break;
            case 'export-file':
                this.exportFile();
                break;
        }
    }

    // 打开项目
    async openProject() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        try {
            const result = await window.pywebview.api.open_mkp_project();
            if (!result) return; // 用户取消了对话框
            if (!result.success) {
                this.showToast('打开项目失败: ' + (result.error || '未知错误'), 'error');
                return;
            }
            this.loadProject(result.project);
            // 记录当前项目路径，后续保存时直接保存到此路径
            const projectPath = result.project?._mkpPath;
            if (projectPath) {
                this._currentMkpPath = projectPath;
                window.pywebview.api.add_recent_project(projectPath).catch(() => {});
            }
        } catch (error) {
            console.error('打开项目异常:', error);
            this.showToast('打开项目异常: ' + error.message, 'error');
        }
    }

    // 保存项目
    async saveProject() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        // 空项目不允许保存
        if (this.models.size === 0) {
            this.showToast('项目为空，请先加载模型', 'warning');
            return;
        }

        const project = await this.exportProject();
        try {
            // 如果已有保存路径则直接保存，否则弹出保存对话框
            // 从未保存过则用第一个模型名作为默认文件名
            let defaultName = null;
            if (!this._currentMkpPath && this.models.size > 0) {
                const firstModel = this.models.values().next().value;
                defaultName = firstModel.name.replace(/\.[^.]+$/, ''); // 去扩展名
            }
            const result = await window.pywebview.api.save_mkp_project(
                JSON.stringify(project),
                this._currentMkpPath || null,
                defaultName
            );
            if (result.success) {
                // 记录保存路径，下次直接保存到这里
                this._currentMkpPath = result.path;
                // 保存缩略图
                const thumb = this.captureThumbnail();
                if (thumb) {
                    await window.pywebview.api.save_project_thumbnail(result.path, thumb);
                }
                // 添加到最近项目
                await window.pywebview.api.add_recent_project(result.path);
                this.showToast('项目已保存', 'success');
            } else if (result.error !== '未选择保存路径') {
                this.showToast('保存失败: ' + (result.error || '未知错误'), 'error');
            }
        } catch (error) {
            console.error('保存项目异常:', error);
            this.showToast('保存项目异常: ' + error.message, 'error');
        }
    }

    async saveProjectAs() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        // 空项目不允许保存
        if (this.models.size === 0) {
            this.showToast('项目为空，请先加载模型', 'warning');
            return;
        }

        const project = await this.exportProject();
        try {
            // 强制弹出保存对话框，不传入现有路径
            let defaultName = null;
            if (this.models.size > 0) {
                const firstModel = this.models.values().next().value;
                defaultName = firstModel.name.replace(/\.[^.]+$/, '');
            }
            const result = await window.pywebview.api.save_mkp_project(
                JSON.stringify(project),
                null,
                defaultName
            );
            if (result.success) {
                this._currentMkpPath = result.path;
                const thumb = this.captureThumbnail();
                if (thumb) {
                    await window.pywebview.api.save_project_thumbnail(result.path, thumb);
                }
                await window.pywebview.api.add_recent_project(result.path);
                this.showToast('项目已另存为', 'success');
            } else if (result.error !== '未选择保存路径') {
                this.showToast('保存失败: ' + (result.error || '未知错误'), 'error');
            }
        } catch (error) {
            console.error('另存为项目异常:', error);
            this.showToast('另存为项目异常: ' + error.message, 'error');
        }
    }

    // 导出项目数据：项目保存保留原始模型格式，不改 UV、不改贴图、不做格式转换。
    async exportProject() {
        const project = {
            version: '1.0',
            timestamp: new Date().toISOString(),
            bedSize: { ...this.bedSize },
            gridSize: this.gridSize,
            showGrid: this.showGrid,
            models: [],
            plates: Array.from(this.plates.values()).map(p => ({
                id: p.id,
                name: p.name,
                locked: p.locked,
                order: p.order
            })),
            currentPlateId: this.currentPlateId,
            gcode: this._lastGcode || null
        };

        for (const [id, model] of this.models) {
            // 保存 MKP 时必须打包当前场景中的烘焙几何。
            // 交互变换会被 bakeTransform 写入顶点，根对象 scale/rotation 可能已回到 1/0；
            // 若继续打包原始 filePath，重开项目会丢失缩放/旋转/镜像等已烘焙变换。
            const bakeResult = await this._bakeSingleModelToOBJ(model);
            let filePath = bakeResult && bakeResult.success ? bakeResult.path : null;
            let assetMode = filePath ? 'baked-obj' : 'missing';
            if (!filePath) {
                filePath = this.modelFilePaths.get(id) || null;
                assetMode = filePath ? 'source' : 'missing';
            }

            // 统一记录模型相对所属盘左下角(0,0)的局部坐标与变换。
            const worldPos = new THREE.Vector3();
            const worldQuat = new THREE.Quaternion();
            const worldScale = new THREE.Vector3();
            model.mesh.getWorldPosition(worldPos);
            model.mesh.getWorldQuaternion(worldQuat);
            model.mesh.getWorldScale(worldScale);
            const c = this._getPlateWorldPos(model.plateId || this.freePlateId);
            const lx = worldPos.x - (c.x - this.bedSize.x / 2);
            const ly = worldPos.y - (c.y - this.bedSize.y / 2);
            const accum = model._accumRotation || new THREE.Euler(0, 0, 0, 'XYZ');
            const worldRot = new THREE.Euler().setFromQuaternion(worldQuat);
            const pos = { x: lx, y: ly, z: worldPos.z };
            const rot = { x: accum.x + worldRot.x, y: accum.y + worldRot.y, z: accum.z + worldRot.z };
            const scl = { x: worldScale.x, y: worldScale.y, z: worldScale.z };

            project.models.push({
                id: id,
                name: model.name,
                printable: model.printable,
                plateId: model.plateId ?? null,
                filePath,
                assetMode,
                position: pos,
                rotation: rot,
                scale: scl
            });
            console.log('[exportProject] 模型:', model.name,
                'assetMode:', assetMode,
                'pos:', JSON.stringify(pos));
        }

        return project;
    }

    // 加载项目
    loadProject(project) {
        // 清除现有模型
        this.clearAllModels();

        // 恢复盘（构建板），缺省时保留默认盘
        if (project.plates && Array.isArray(project.plates) && project.plates.length > 0) {
            this.plates.clear();
            let maxId = 0;
            project.plates.forEach(p => {
                this.plates.set(p.id, { id: p.id, name: p.name || `盘 ${p.id}`, locked: !!p.locked, order: p.order != null ? p.order : p.id });
                if (p.id > maxId) maxId = p.id;
            });
            this.nextPlateId = maxId + 1;
            this.currentPlateId = (project.currentPlateId && this.plates.has(project.currentPlateId))
                ? project.currentPlateId : this.defaultPlateId();
        }

        // 设置热床尺寸
        if (project.bedSize) {
            this.bedSize = { ...project.bedSize };
            this.updateBedSize();
        }

        // 设置网格
        if (project.gridSize !== undefined) {
            this.gridSize = project.gridSize;
        }
        if (project.showGrid !== undefined) {
            this.showGrid = project.showGrid;
        }
        this.updateGrid();

        // 先按项目盘信息重建盘板容器，再加载模型。
        // 否则模型恢复 plateId 时找不到目标盘容器，会临时进入自由区，导致重开后位置漂移。
        this.rebuildAllPlateBoards();
        this.renderPlates();
        this.buildActivePlateActions();

        // 加载模型
        if (project.models && project.models.length > 0) {
            project.models.forEach(modelData => {
                if (modelData._modelData) {
                    // MKP 格式：嵌入模型数据，直接加载
                    this._loadModelFromProjectData(modelData);
                } else if (modelData.filePath) {
                    // 旧格式：通过文件路径从后端加载
                    this.loadModelByPath(modelData.filePath, modelData);
                }
            });
        }

        // 记录临时目录路径，用于后续清理
        this._extractDir = project._extractDir || null;

        // 按当前盘调整各模型显隐并刷新盘 tab 与对象列表
        this.applyCurrentPlateVisibility();
        // 异步模型加载完成前先刷新当前盘 UI；模型加载回调会继续更新对象列表。
        this.updatePlateBoardOpacity();

        this.saveState('加载项目');
    }

    // 应用当前盘的显隐规则并刷新列表
    applyCurrentPlateVisibility() {
        // 所有模型一直可见（不跨盘隐藏），仅刷新对象列表
        this.models.forEach((model) => {
            model.mesh.visible = true;
            if (model._transformProxy) model._transformProxy.visible = true;
        });
        this.updateObjectList();
    }

    // 从项目嵌入的模型数据加载（MKP格式）
    _loadModelFromProjectData(modelData) {
        const data = modelData._modelData;
        if (!data) {
            console.error('[loadProject] 模型数据为空，跳过:', modelData.name);
            return;
        }

        // GLTF / GLB 格式
        if (data.gltf) {
            console.log('[loadProject] 正在加载 GLTF 模型:', modelData.name);
            const loader = new GLTFLoader();
            loader.load(data.gltf,
                (gltf) => {
                    console.log('[loadProject] GLTF加载成功:', modelData.name);
                    this._addModelFromProject(gltf.scene, modelData);
                },
                undefined,
                (err) => {
                    console.error('[loadProject] GLTF加载失败:', modelData.name, err);
                    this.showToast('加载模型失败: ' + modelData.name, 'error');
                }
            );
            return;
        }

        // OBJ 格式
        if (!data.obj) {
            console.error('[loadProject] 模型数据无 OBJ/GLTF 内容，跳过:', modelData.name);
            return;
        }
        console.log('[loadProject] 正在加载 OBJ 模型:', modelData.name);

        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
            const cleanUrl = url.split('/').pop().split('\\').pop();
            return data.textures[cleanUrl] || url;
        });
        const objLoader = new OBJLoader(manager);
        objLoader.load(data.obj,
            (object) => {
                console.log('[loadProject] OBJ加载成功:', modelData.name);
                if (data.mtl) {
                    const mtlLoader = new MTLLoader(manager);
                    mtlLoader.load(data.mtl, (materials) => {
                        materials.preload();
                        object.traverse((child) => {
                            if (child.isMesh) {
                                const matName = child.material.name;
                                if (materials.materials[matName]) {
                                    child.material = materials.materials[matName];
                                }
                            }
                        });
                        this._addModelFromProject(object, modelData);
                    }, undefined, (err) => {
                        console.warn('[loadProject] MTL加载失败，仅加载OBJ:', modelData.name, err);
                        this._addModelFromProject(object, modelData);
                    });
                } else {
                    this._addModelFromProject(object, modelData);
                }
            },
            (progress) => {
                // 仅用于调试，不需要处理
            },
            (err) => {
                console.error('[loadProject] OBJ加载失败:', modelData.name, err);
                this.showToast('加载模型失败: ' + modelData.name, 'error');
            }
        );
    }

    _addModelFromProject(object, modelData) {
        console.log('[loadProject] 应用变换前 - modelData.scale:', JSON.stringify(modelData.scale),
            'modelData.position:', JSON.stringify(modelData.position));
        const isSourceAsset = modelData.assetMode === 'source';
        this.addModelObject(object, modelData.name, modelData._modelFilePath || null, {
            preserveProjectTransform: !isSourceAsset,
            projectLoad: true
        });
        // 应用保存的变换
        const model = this.models.get(this.nextModelId - 1);
        if (model) {
            // 恢复所属盘
            if (modelData.plateId != null && this.plates.has(modelData.plateId)) {
                model.plateId = modelData.plateId;
            }
            // 恢复可打印状态
            if (modelData.printable !== undefined) {
                model.printable = modelData.printable;
            }
            // 根据 printable 更新外观
            if (!model.printable) {
                // 延迟一帧等材质渲染完成后更新外观
                requestAnimationFrame(() => this._updateModelPrintAppearance(model));
            }
            const transformSource = model._transformProxy || model.mesh;
            if (!model._accumRotation) model._accumRotation = new THREE.Euler(0, 0, 0, 'XYZ');
            if (modelData.rotation) {
                transformSource.rotation.set(modelData.rotation.x || 0, modelData.rotation.y || 0, modelData.rotation.z || 0);
                model._accumRotation.set(0, 0, 0);
            }
            if (modelData.position) {
                // 保存的是相对所属盘左下角的局部坐标 → 转回世界坐标
                const pc = this._getPlateWorldPos(model.plateId || this.freePlateId);
                transformSource.position.set(
                    (modelData.position.x || 0) + (pc.x - this.bedSize.x / 2),
                    (modelData.position.y || 0) + (pc.y - this.bedSize.y / 2),
                    modelData.position.z || 0
                );
            }
            if (modelData.scale) {
                const sx = (modelData.scale.x != null) ? modelData.scale.x : 1;
                const sy = (modelData.scale.y != null) ? modelData.scale.y : 1;
                const sz = (modelData.scale.z != null) ? modelData.scale.z : 1;
                console.log('[loadProject] 设置scale:', sx, sy, sz);
                transformSource.scale.set(sx, sy, sz);
            } else {
                console.warn('[loadProject] modelData.scale 为空，使用默认值 1,1,1:', modelData.name);
            }
            transformSource.updateMatrixWorld(true);
            this.lockZAxis();
            this.updateSelectionBoxes();
            // 归位到所属盘容器（保存的 position 是相对该盘的局部坐标）
            this._reparentModelToPlate(model, model.plateId || this.freePlateId);
        }
    }

    // 从路径加载模型（需要后端支持）
    async loadModelByPath(filePath, modelData) {
        try {
            if (window.pywebview && window.pywebview.api) {
                const result = await window.pywebview.api.load_model_by_path(filePath);
                if (result.success) {
                    // 加载成功后应用变换
                    setTimeout(() => {
                        const model = this.models.get(this.nextModelId - 1);
                        if (model && modelData) {
                            if (modelData.plateId != null && this.plates.has(modelData.plateId)) {
                                model.plateId = modelData.plateId;
                            }
                            const transformSource = model._transformProxy || model.mesh;
                            if (!model._accumRotation) model._accumRotation = new THREE.Euler(0, 0, 0, 'XYZ');
                            if (modelData.rotation) {
                                transformSource.rotation.set(modelData.rotation.x || 0, modelData.rotation.y || 0, modelData.rotation.z || 0);
                                model._accumRotation.set(0, 0, 0);
                            }
                            // 保存的是相对所属盘左下角的局部坐标 → 转回世界坐标（与直接嵌入数据的流程一致）
                            const pc = this._getPlateWorldPos(model.plateId || this.freePlateId);
                            transformSource.position.set(
                                (modelData.position.x || 0) + (pc.x - this.bedSize.x / 2),
                                (modelData.position.y || 0) + (pc.y - this.bedSize.y / 2),
                                modelData.position.z || 0
                            );
                            transformSource.scale.set(modelData.scale.x, modelData.scale.y, modelData.scale.z);
                            transformSource.updateMatrixWorld(true);
                            this.lockZAxis();
                            this.updateSelectionBoxes();
                        }
                    }, 100);
                }
            }
        } catch (error) {
            console.error('从路径加载模型失败:', error);
        }
    }

    // 导出文件
    async exportFile() {
        if (this.selectedModels.size === 0) {
            this.showToast('请先选择要导出的模型', 'info');
            return;
        }

        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        // 获取选中模型的文件路径
        const modelId = Array.from(this.selectedModels)[0];
        const filePath = this.modelFilePaths.get(modelId);
        if (!filePath) {
            this.showToast('无法找到原始文件路径，请重新加载模型', 'error');
            return;
        }

        try {
            const result = await window.pywebview.api.export_model_files(filePath);
            if (result.success) {
                this.showToast('导出成功', 'success');
            } else {
                this.showToast('导出失败: ' + (result.error || '未知错误'), 'error');
            }
        } catch (e) {
            console.error('导出模型异常:', e);
            this.showToast('导出异常: ' + e.message, 'error');
        }
    }

    // 设置对话框
    async openSettingsDialog() {
        const dialog = document.getElementById('settings-dialog');
        if (!dialog) return;

        // 从后端加载已保存的设置
        if (window.pywebview && window.pywebview.api) {
            try {
                const result = await window.pywebview.api.load_settings();
                if (result.success && result.settings) {
                    const s = result.settings;
                    if (s.maxHistory) this.historyManager.setMaxSize(s.maxHistory);
                    if (s.showGrid !== undefined) this.showGrid = s.showGrid;
                    if (s.gridSize) this.gridSize = s.gridSize;
                    if (s.gridTheme) this.gridTheme = s.gridTheme;
                    if (s.cameraMode) {
                        this.cameraMode = s.cameraMode;
                        const width = this.container.clientWidth;
                        const height = this.container.clientHeight;
                        this._createCamera(width, height);
                        this.createBed();
                    }
                    if (s.orcaSlicerPath !== undefined) this.orcaSlicerPath = s.orcaSlicerPath;
                    if (s.snapmakerOrcaPath !== undefined) this.snapmakerOrcaPath = s.snapmakerOrcaPath;
                    if (s.gcodeSlicerType !== undefined) this.gcodeSlicerType = s.gcodeSlicerType;
                    if (s.textureResolution !== undefined) this.textureResolution = s.textureResolution;
                }
            } catch (e) {
                console.error('加载设置失败:', e);
            }
        }
        // 从后端加载打印机设置
        if (window.pywebview && window.pywebview.api) {
            try {
                const result = await window.pywebview.api.load_printer_settings();
                if (result.success && result.settings) {
                    const s = result.settings;
                    if (s.bedSize) {
                        if (s.bedSize.x) this.bedSize.x = s.bedSize.x;
                        if (s.bedSize.y) this.bedSize.y = s.bedSize.y;
                        if (s.bedSize.z) this.bedSize.z = s.bedSize.z;
                    }
                    if (s.printerAddress !== undefined) this.printerAddress = s.printerAddress;
                    if (s.headAddress !== undefined) this.headAddress = s.headAddress;
                }
            } catch (e) {
                console.error('加载打印机设置失败:', e);
            }
        }

        this.updateSettingsDialog();
        dialog.classList.remove('hidden');
    }

    closeSettingsDialog() {
        const dialog = document.getElementById('settings-dialog');
        if (dialog) {
            dialog.classList.add('hidden');
        }
    }

    updateSettingsDialog() {
        const maxHistoryInput = document.getElementById('max-history-setting');
        if (maxHistoryInput) {
            maxHistoryInput.value = this.historyManager.maxSize;
        }

        const showGrid = document.getElementById('show-grid-setting');
        if (showGrid) showGrid.checked = this.showGrid;

        this._setSettingsSelectValue('grid-theme-select', this.gridTheme);
        this._setSettingsSelectValue('camera-mode-select', this.cameraMode);
        this._setSettingsSelectValue('gcode-slicer-select', this.gcodeSlicerType);

        const pathInput = document.getElementById('orcaslicer-path');
        if (pathInput) {
            pathInput.value = this._getCurrentSlicerPath() || '';
        }
        const resolutionInput = document.getElementById('texture-resolution');
        if (resolutionInput) {
            resolutionInput.value = this.textureResolution || 4000;
        }
    }

    async applySettings() {
        const maxHistoryInput = document.getElementById('max-history-setting');
        const showGrid = document.getElementById('show-grid-setting');

        if (maxHistoryInput) {
            this.historyManager.setMaxSize(parseInt(maxHistoryInput.value) || 20);
        }
        if (showGrid) {
            const newShowGrid = showGrid.checked;
            if (newShowGrid !== this.showGrid) {
                this.showGrid = newShowGrid;
                this.createGrid();
            }
        }

        // 读取网格配色
        const gridThemeVal = this._getSettingsSelectValue('grid-theme-select');
        if (gridThemeVal && gridThemeVal !== this.gridTheme) {
            this.gridTheme = gridThemeVal;
            this.createBed();
            this.createGrid();
        }

        // 读取相机视图
        const camModeVal = this._getSettingsSelectValue('camera-mode-select');
        if (camModeVal) {
            this.switchCameraMode(camModeVal);
        }

        // 读取 Gcode 切片器类型
        const slicerTypeVal = this._getSettingsSelectValue('gcode-slicer-select');
        if (slicerTypeVal && slicerTypeVal !== this.gcodeSlicerType) {
            this.gcodeSlicerType = slicerTypeVal;
        }

        // 读取纹理分辨率
        const resolutionInput = document.getElementById('texture-resolution');
        if (resolutionInput) {
            this.textureResolution = parseInt(resolutionInput.value) || 4000;
        }

        this.closeSettingsDialog();
        this.saveState('修改设置');

        // 保存设置到后端
        if (window.pywebview && window.pywebview.api) {
            try {
                const settings = {
                    maxHistory: this.historyManager.maxSize,
                    showGrid: this.showGrid,
                    gridTheme: this.gridTheme,
                    gridSize: this.gridSize,
                    cameraMode: this.cameraMode,
                    orcaSlicerPath: this.orcaSlicerPath || '',
                    snapmakerOrcaPath: this.snapmakerOrcaPath || '',
                    gcodeSlicerType: this.gcodeSlicerType || 'orcaslicer',
                    textureResolution: this.textureResolution || 4000,
                };
                const result = await window.pywebview.api.save_settings(JSON.stringify(settings));
                if (!result.success) {
                    console.error('保存设置失败:', result.error);
                }
            } catch (e) {
                console.error('保存设置异常:', e);
            }
        }
    }

    setupSettingsDialog() {
        const closeBtn = document.getElementById('settings-close');
        const cancelBtn = document.getElementById('settings-cancel');
        const applyBtn = document.getElementById('settings-apply');

        if (closeBtn) closeBtn.addEventListener('click', () => this.closeSettingsDialog());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeSettingsDialog());
        if (applyBtn) applyBtn.addEventListener('click', () => this.applySettings());

        // 初始化自定义下拉框
        this._setupSettingsSelect('grid-theme-select');
        this._setupSettingsSelect('camera-mode-select');
        this._setupSettingsSelect('gcode-slicer-select');

        // Gcode 切片器下拉切换时刷新路径显示
        const slicerSelectTrigger = document.querySelector('#gcode-slicer-select .select-trigger');
        if (slicerSelectTrigger) {
            slicerSelectTrigger.addEventListener('click', () => {
                // 延迟更新，等待选择完成
                setTimeout(() => {
                    const newType = this._getSettingsSelectValue('gcode-slicer-select');
                    this._onSlicerTypeChanged(newType);
                }, 100);
            });
        }
        const slicerOptions = document.querySelectorAll('#gcode-slicer-select .select-option');
        slicerOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                const newType = opt.dataset.value;
                this._onSlicerTypeChanged(newType);
            });
        });

        // 注册 MKP 文件关联
        const regBtn = document.getElementById('btn-register-mkp');
        if (regBtn) {
            regBtn.addEventListener('click', async () => {
                if (!window.pywebview || !window.pywebview.api) {
                    this.showToast('后端API不可用', 'error');
                    return;
                }
                try {
                    regBtn.disabled = true;
                    regBtn.textContent = '注册中...';
                    const result = await window.pywebview.api.register_mkp_association();
                    if (result.success) {
                        this.showToast('MKP 文件关联已注册', 'success');
                    } else {
                        this.showToast('注册失败: ' + (result.error || '未知错误'), 'error');
                    }
                } catch (e) {
                    this.showToast('注册异常: ' + e.message, 'error');
                } finally {
                    regBtn.disabled = false;
                    regBtn.textContent = '注册';
                }
            });
        }

        // 切片器路径：自动检测
        const detectBtn = document.getElementById('btn-detect-orcaslicer');
        if (detectBtn) {
            detectBtn.addEventListener('click', async () => {
                if (!window.pywebview || !window.pywebview.api) {
                    this.showToast('后端API不可用', 'error');
                    return;
                }
                try {
                    detectBtn.disabled = true;
                    detectBtn.textContent = '检测中...';
                    const currentType = this._getSettingsSelectValue('gcode-slicer-select') || 'orcaslicer';
                    const apiMethod = currentType === 'snapmaker_orca'
                        ? () => window.pywebview.api.resolve_snapmaker_orca()
                        : () => window.pywebview.api.resolve_orca_slicer();
                    const result = await apiMethod();
                    if (result.success && result.path) {
                        if (currentType === 'snapmaker_orca') {
                            this.snapmakerOrcaPath = result.path;
                        } else {
                            this.orcaSlicerPath = result.path;
                        }
                        const pathInput = document.getElementById('orcaslicer-path');
                        if (pathInput) pathInput.value = result.path;
                    } else {
                        this.showToast('未找到切片器快捷方式，请手动选择', 'warning');
                    }
                } catch (e) {
                    this.showToast('检测异常: ' + e.message, 'error');
                } finally {
                    detectBtn.disabled = false;
                    detectBtn.textContent = '自动检测';
                }
            });
        }

        // 切片器路径：手动浏览
        const browseBtn = document.getElementById('btn-select-orcaslicer');
        if (browseBtn) {
            browseBtn.addEventListener('click', async () => {
                if (!window.pywebview || !window.pywebview.api) {
                    this.showToast('后端API不可用', 'error');
                    return;
                }
                try {
                    const result = await window.pywebview.api.select_orca_slicer();
                    if (result.success && result.path) {
                        const currentType = this._getSettingsSelectValue('gcode-slicer-select') || 'orcaslicer';
                        if (currentType === 'snapmaker_orca') {
                            this.snapmakerOrcaPath = result.path;
                        } else {
                            this.orcaSlicerPath = result.path;
                        }
                        const pathInput = document.getElementById('orcaslicer-path');
                        if (pathInput) pathInput.value = result.path;
                    }
                } catch (e) {
                    this.showToast('选择文件异常: ' + e.message, 'error');
                }
            });
        }

        // 点击对话框外部关闭
        const dialog = document.getElementById('settings-dialog');
        if (dialog) {
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) {
                    this.closeSettingsDialog();
                }
            });
        }
    }

    setupPrinterSelect() {
        const customSelect = document.getElementById('printer-select');
        if (!customSelect) return;

        const trigger = customSelect.querySelector('.select-trigger');
        const optionsContainer = customSelect.querySelector('.select-options');
        const valueDisplay = customSelect.querySelector('.select-value');
        const options = customSelect.querySelectorAll('.select-option');

        if (trigger) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = !optionsContainer.classList.contains('hidden');
                this.closeAllSelects();
                if (!isOpen) {
                    optionsContainer.classList.remove('hidden');
                    trigger.classList.add('open');
                }
            });
        }

        options.forEach(opt => {
            opt.addEventListener('click', () => {
                options.forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                if (valueDisplay) valueDisplay.textContent = opt.textContent;
                optionsContainer.classList.add('hidden');
                trigger.classList.remove('open');
            });
        });

        document.addEventListener('click', () => {
            this.closeAllSelects();
        });
    }

    closeAllSelects() {
        document.querySelectorAll('.custom-select').forEach(sel => {
            const opts = sel.querySelector('.select-options');
            const trig = sel.querySelector('.select-trigger');
            if (opts) opts.classList.add('hidden');
            if (trig) trig.classList.remove('open');
        });
    }

    _setupSettingsSelect(selectId) {
        const customSelect = document.getElementById(selectId);
        if (!customSelect) return;

        const trigger = customSelect.querySelector('.select-trigger');
        const optionsContainer = customSelect.querySelector('.select-options');
        const valueDisplay = customSelect.querySelector('.select-value');
        const options = customSelect.querySelectorAll('.select-option');

        if (trigger) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = !optionsContainer.classList.contains('hidden');
                this.closeAllSelects();
                if (!isOpen) {
                    optionsContainer.classList.remove('hidden');
                    trigger.classList.add('open');
                }
            });
        }

        options.forEach(opt => {
            opt.addEventListener('click', () => {
                options.forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                if (valueDisplay) valueDisplay.textContent = opt.textContent;
                optionsContainer.classList.add('hidden');
                trigger.classList.remove('open');
            });
        });
    }

    _setSettingsSelectValue(selectId, value) {
        const customSelect = document.getElementById(selectId);
        if (!customSelect) return;
        const valueDisplay = customSelect.querySelector('.select-value');
        const options = customSelect.querySelectorAll('.select-option');
        options.forEach(opt => {
            const isSelected = opt.dataset.value === value;
            opt.classList.toggle('selected', isSelected);
            if (isSelected && valueDisplay) {
                valueDisplay.textContent = opt.textContent;
            }
        });
    }

    _getSettingsSelectValue(selectId) {
        const customSelect = document.getElementById(selectId);
        if (!customSelect) return null;
        const selected = customSelect.querySelector('.select-option.selected');
        return selected ? selected.dataset.value : null;
    }

    /** 根据当前选中的切片器类型返回对应的路径 */
    _getCurrentSlicerPath() {
        if (this.gcodeSlicerType === 'snapmaker_orca') {
            return this.snapmakerOrcaPath || '';
        }
        return this.orcaSlicerPath || '';
    }

    /** 切片器类型切换后刷新路径显示 */
    _onSlicerTypeChanged(newType) {
        if (!newType) return;
        this.gcodeSlicerType = newType;
        const pathInput = document.getElementById('orcaslicer-path');
        if (pathInput) {
            pathInput.value = this._getCurrentSlicerPath() || '';
        }
    }

    setupPrinterDialog() {
        const editBtn = document.getElementById('printer-edit-btn');
        const closeBtn = document.getElementById('printer-close');
        const cancelBtn = document.getElementById('printer-cancel');
        const saveBtn = document.getElementById('printer-save');
        const testPrinterBtn = document.getElementById('test-printer-btn');
        const testHeadBtn = document.getElementById('test-head-btn');
        const installPluginBtn = document.getElementById('install-plugin-btn');

        if (editBtn) {
            editBtn.addEventListener('click', () => {
                this.loadPrinterSettingsToDialog();
                this.openPrinterDialog();
            });
        }
        if (closeBtn) closeBtn.addEventListener('click', () => this.closePrinterDialog());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.closePrinterDialog());
        if (saveBtn) saveBtn.addEventListener('click', () => this.savePrinterSettings());

        if (testPrinterBtn) {
            testPrinterBtn.addEventListener('click', () => this.testConnection('printer-address', 'printer-status', 'printer'));
        }
        if (testHeadBtn) {
            testHeadBtn.addEventListener('click', () => this.testConnection('head-address', 'head-status', 'head'));
        }
        if (installPluginBtn) {
            installPluginBtn.addEventListener('click', () => this.installPrinterPlugin());
        }

        const dialog = document.getElementById('printer-dialog');
        if (dialog) {
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) {
                    this.closePrinterDialog();
                }
            });
        }
    }

    openPrinterDialog() {
        const dialog = document.getElementById('printer-dialog');
        if (dialog) dialog.classList.remove('hidden');
    }

    closePrinterDialog() {
        const dialog = document.getElementById('printer-dialog');
        if (dialog) dialog.classList.add('hidden');
    }

    loadPrinterSettingsToDialog() {
        const bedX = document.getElementById('printer-bed-x');
        const bedY = document.getElementById('printer-bed-y');
        const bedZ = document.getElementById('printer-bed-z');
        const printerAddr = document.getElementById('printer-address');
        const headAddr = document.getElementById('head-address');

        if (bedX) bedX.value = this.bedSize.x;
        if (bedY) bedY.value = this.bedSize.y;
        if (bedZ) bedZ.value = this.bedSize.z;
        if (printerAddr) printerAddr.value = this.printerAddress || '';
        if (headAddr) headAddr.value = this.headAddress || '';

        // 清除测试状态
        const printerStatus = document.getElementById('printer-status');
        const headStatus = document.getElementById('head-status');
        if (printerStatus) printerStatus.textContent = '';
        if (printerStatus) printerStatus.className = 'test-status';
        if (headStatus) headStatus.textContent = '';
        if (headStatus) headStatus.className = 'test-status';
    }

    savePrinterSettings() {
        const bedX = document.getElementById('printer-bed-x');
        const bedY = document.getElementById('printer-bed-y');
        const bedZ = document.getElementById('printer-bed-z');
        const printerAddr = document.getElementById('printer-address');
        const headAddr = document.getElementById('head-address');

        if (bedX) this.bedSize.x = parseFloat(bedX.value) || 270;
        if (bedY) this.bedSize.y = parseFloat(bedY.value) || 270;
        if (bedZ) this.bedSize.z = parseFloat(bedZ.value) || 270;
        if (printerAddr) this.printerAddress = printerAddr.value.trim();
        if (headAddr) this.headAddress = headAddr.value.trim();

        this.updateBedSize();
        this.closePrinterDialog();
        this.saveState('修改打印机设置');

        if (window.pywebview && window.pywebview.api) {
            try {
                const settings = {
                    bedSize: { ...this.bedSize },
                    printerAddress: this.printerAddress || '',
                    headAddress: this.headAddress || ''
                };
                window.pywebview.api.save_printer_settings(JSON.stringify(settings));
            } catch (e) {
                console.error('保存打印机设置异常:', e);
            }
        }
    }

    async testConnection(addressId, statusId, role) {
        const addressInput = document.getElementById(addressId);
        const statusEl = document.getElementById(statusId);
        const testBtn = addressId === 'printer-address'
            ? document.getElementById('test-printer-btn')
            : document.getElementById('test-head-btn');

        if (!addressInput || !statusEl || !testBtn) return;

        const address = addressInput.value.trim();
        if (!address) {
            statusEl.textContent = '请输入地址';
            statusEl.className = 'test-status fail';
            return;
        }

        testBtn.disabled = true;
        testBtn.textContent = '...';
        statusEl.textContent = '';

        try {
            let result;
            if (window.pywebview && window.pywebview.api) {
                if (role === 'printer') {
                    result = await window.pywebview.api.test_printer_fluidd(address);
                } else {
                    result = await window.pywebview.api.test_head_mbrush(address);
                }
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
                result = { success: true, message: 'OK' };
            }

            if (result.success) {
                testBtn.textContent = 'OK';
                testBtn.classList.add('test-ok');
                testBtn.classList.remove('test-fail');
                if (role === 'printer') this._printerTestPassed = true;
                else this._headTestPassed = true;
            } else {
                testBtn.textContent = result.message;
                testBtn.classList.add('test-fail');
                testBtn.classList.remove('test-ok');
                if (role === 'printer') this._printerTestPassed = false;
                else this._headTestPassed = false;
            }

            this._updatePluginInstallBtn();
        } catch (e) {
            statusEl.textContent = '失败';
            statusEl.className = 'test-status fail';
        } finally {
            testBtn.disabled = false;
        }
    }

    _updatePluginInstallBtn() {
        const btn = document.getElementById('install-plugin-btn');
        if (!btn) return;

        const passed = this._printerTestPassed;
        if (!passed) {
            btn.disabled = true;
            btn.classList.remove('ready', 'installed');
            btn.textContent = '安装插件';
            return;
        }

        // 显示检测中，同时 SSH 检查
        btn.disabled = true;
        btn.classList.remove('ready', 'installed');
        btn.textContent = '检测中...';

        if (window.pywebview && window.pywebview.api) {
            const printerAddr = document.getElementById('printer-address');
            if (printerAddr) {
                window.pywebview.api.check_printer_plugin_installed(printerAddr.value.trim())
                    .then(result => {
                        if (result.success && result.installed) {
                            btn.classList.add('installed');
                            btn.textContent = '已安装';
                        } else {
                            btn.disabled = false;
                            btn.classList.add('ready');
                            btn.textContent = '安装插件';
                        }
                    })
                    .catch(() => {
                        btn.classList.remove('ready', 'installed');
                        btn.textContent = '安装插件';
                    });
            }
        }
    }

    async installPrinterPlugin() {
        const btn = document.getElementById('install-plugin-btn');
        const printerAddr = document.getElementById('printer-address');
        if (!btn || !printerAddr) return;

        const address = printerAddr.value.trim();
        if (!address) return;

        btn.disabled = true;
        btn.textContent = '安装中...';

        try {
            let result;
            if (window.pywebview && window.pywebview.api) {
                result = await window.pywebview.api.install_printer_plugin(address);
            } else {
                result = { success: false, message: 'API不可用' };
            }

            if (result.success) {
                btn.classList.add('installed');
                btn.classList.remove('ready');
                btn.textContent = '已安装';
            } else {
                btn.disabled = false;
                btn.classList.add('ready');
                btn.classList.remove('installed');
                btn.textContent = '安装插件';
            }
        } catch (e) {
            btn.disabled = false;
            btn.classList.add('ready');
            btn.classList.remove('installed');
            btn.textContent = '安装插件';
        }
    }

    // ===== 切片功能 =====

    // 计算切片聚焦区：当前盘上可见可打印模型的 X/Y 包围盒（OBJ 空间），外扩 20mm padding。
    // 返回 {x, y, w, h} 单位 mm；无可用模型返回 null。用于后端生成"预览图缩放指导"。
    _computeSliceFocusMm() {
        const PAD = 20;
        const off = this._getPlateExportOffset();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let found = false;
        this.models.forEach((model) => {
            if (!model.mesh || !model.visible || !model.printable) return;
            if (!this._isOnCurrentPlate(model)) return;
            model.mesh.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(model.mesh);
            // Must match _exportOBJWithPlanes(): exported OBJ coords are world + off.
            minX = Math.min(minX, box.min.x + off.x);
            minY = Math.min(minY, box.min.y + off.y);
            maxX = Math.max(maxX, box.max.x + off.x);
            maxY = Math.max(maxY, box.max.y + off.y);
            found = true;
        });
        if (!found || maxX - minX <= 0 || maxY - minY <= 0) return null;
        return {
            x: minX - PAD,
            y: minY - PAD,
            w: (maxX - minX) + PAD * 2,
            h: (maxY - minY) + PAD * 2,
        };
    }

    async doSlicing() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        // 防止重复启动
        if (this._sliceRunning) {
            this.showToast('纹理切片正在进行中', 'info');
            return;
        }

        if (this.models.size === 0) {
            this.showToast('请先导入模型', 'info');
            return;
        }

        // ★ 模型切片必须先于纹理切片 —— 必须有 gcode 文件才能获取层高/空驶速度/加速度等参数
        if (!this._testGcodePath || !this._lastGcode) {
            this.showToast('请先执行模型切片并载入 GCode 文件', 'warning');
            return;
        }

        // 检查 gcode 文件是否存在
        try {
            const gcodeCheck = await window.pywebview.api.load_gcode_file(this._testGcodePath);
            if (!gcodeCheck || !gcodeCheck.success) {
                this.showToast('GCode 文件不存在，请重新执行模型切片', 'warning');
                return;
            }
        } catch (e) {
            this.showToast('GCode 文件读取失败，请重新执行模型切片', 'warning');
            return;
        }

        // ★ 每次激活纹理切片自动锁定当前盘，防止模型与 Orca 位置不一致
        {
            const _activePlateId = this.currentPlateId;
            if (_activePlateId != null && !this.isPlateLocked(_activePlateId)) {
                const _name = this.plates.get(_activePlateId)?.name || `盘 ${_activePlateId}`;
                if (this._lockPlateInternal(_activePlateId)) {
                    this.showToast(`已自动锁定「${_name}」，防止模型位移`, 'info');
                }
            }
        }

        // 1. 先导出带纹理的 OBJ（模型 + 四角定位面 + MTL + 贴图）
        let exportResult;
        try {
            exportResult = await this._exportOBJWithPlanes();
        } catch (e) {
            console.error('导出纹理 OBJ 异常:', e);
            this.showToast('导出纹理 OBJ 失败: ' + e.message, 'error');
            return;
        }
        if (!exportResult || !exportResult.success) {
            this.showToast('导出纹理 OBJ 失败: ' + (exportResult ? exportResult.error : ''), 'error');
            return;
        }
        const objPath = exportResult.path;
        if (!objPath) {
            this.showToast('导出路径为空', 'error');
            return;
        }

        // 2. 从 gcode 中获取切片参数（空驶速度/加速度/层高等）
        const inkjetSpeedEl = document.getElementById('inkjet-speed');
        const inkjetSpeed = inkjetSpeedEl ? parseInt(inkjetSpeedEl.value) || 50 : 50;
        let sliceParams = null;
        try {
            const extractResult = await window.pywebview.api.extract_gcode_params(
                this._testGcodePath, inkjetSpeed
            );
            if (extractResult && extractResult.success && extractResult.params) {
                sliceParams = extractResult.params;
                this._lastSliceParams = sliceParams;
                // 打印预估信息
                console.log('[GCode参数] 层高={}mm 层数={} 空驶速度={}mm/s 加速度={}mm/s² 预估时长={}'.format(
                    sliceParams.layer_height, sliceParams.total_layers,
                    sliceParams.travel_speed, sliceParams.travel_accel,
                    sliceParams.estimated_time
                ));
            } else {
                console.warn('[GCode参数] 提取失败:', extractResult?.error);
            }
        } catch (e) {
            console.warn('[GCode参数] 提取异常:', e);
        }

        // 3. 层高参数 —— 优先使用从 gcode 中读取的值
        const layerHeight = (sliceParams && sliceParams.layer_height)
            ? sliceParams.layer_height
            : 0.2;

        // 4. 获取纹理分辨率设置
        const resolution = this.textureResolution || 4000;

        // 5. 启动子进程切片（非阻塞）
        this._sliceRunning = true;
        this._sliceCancelled = false;
        this._pollTimer = null;

        // 清空上一次切片的预览缓存
        this._sliceImages = [];
        this._previewImageCount = 0;
        const imgContainer = document.getElementById('slice-images-container');
        if (imgContainer) {
            imgContainer.innerHTML = '<div class="slice-images-empty">切片进行中，请稍候...</div>';
        }
        this._updateLayerSlider();

        // 锁定预览选项卡
        this._setPreviewTabDisabled(true);

        // 显示进度条
        const progressEl = document.getElementById('slice-progress');
        const progressFill = document.getElementById('slice-progress-fill');
        const progressText = document.getElementById('slice-progress-text');
        if (progressEl) {
            progressEl.classList.remove('hidden');
            progressFill.style.width = '0%';
            progressText.textContent = '0 / 0 层';
        }

        try {
            const config = {
                obj_path: objPath,
                layer_height: layerHeight,
                resolution: resolution,
            };
            // ★ 传模型聚焦区（OBJ 空间 bbox + padding，mm）→ 后端换算成预览图缩放指导
            const focusMm = this._computeSliceFocusMm();
            if (focusMm) config.focus_mm = focusMm;
            // ★ 将切片参数传递到后端纹理切片，用于运动规划和时间预测
            if (sliceParams) {
                config.travel_speed = sliceParams.travel_speed;
                config.travel_accel = sliceParams.travel_accel;
                config.print_speed = Math.max(
                    sliceParams.inner_wall_speed || 300,
                    sliceParams.outer_wall_speed || 200
                );
                config.inkjet_speed = inkjetSpeed;
            }
            const startResult = await window.pywebview.api.texture_slice_start(JSON.stringify(config));
            if (!startResult || !startResult.success) {
                this.showToast('纹理切片启动失败: ' + (startResult ? startResult.error : '无返回'), 'error');
                this._hideSliceProgress();
                this._setPreviewTabDisabled(false);
                return;
            }

            // 6. 轮询进度
            await this._pollSliceProgress(progressEl, progressFill, progressText);
        } catch (e) {
            console.error('纹理切片异常:', e);
            this.showToast('纹理切片异常: ' + e.message, 'error');
            this._hideSliceProgress();
            this._setPreviewTabDisabled(false);
        }
    }

    async _pollSliceProgress(progressEl, progressFill, progressText) {
        return new Promise((resolve) => {
            const poll = async () => {
                if (this._sliceCancelled) {
                    this._hideSliceProgress();
                    this._setPreviewTabDisabled(false);
                    this.showToast('纹理切片已取消', 'info');
                    resolve();
                    return;
                }

                try {
                    const status = await window.pywebview.api.texture_slice_get_status();

                    if (status.state === 'cancelled') {
                        this._hideSliceProgress();
                        this._setPreviewTabDisabled(false);
                        this.showToast('纹理切片已取消', 'info');
                        resolve();
                        return;
                    }

                    if (status.state === 'error') {
                        this._hideSliceProgress();
                        this._setPreviewTabDisabled(false);
                        this.showToast('切片+后处理失败: ' + (status.error || '未知错误'), 'error');
                        resolve();
                        return;
                    }

                    // 更新进度条
                    if (status.total > 0) {
                        const pct = Math.round((status.progress / status.total) * 100);
                        if (progressFill) progressFill.style.width = pct + '%';
                        const done = status.progress >= status.total;
                        const stageText = done ? '分配纹理块中' :
                                          status.stage === 'postprocess' ? '后处理中' :
                                          status.stage === 'strip' ? '条带切割中' :
                                          '切片中';
                        if (progressText) progressText.textContent = done ? '分配纹理块中' : `${stageText} ${status.progress} / ${status.total} 层`;
                    }

                    // 一体化完成：切片 + 条带 + 后处理全部完成
                    if (status.state === 'complete') {
                        this._hideSliceProgress();
                        this._setPreviewTabDisabled(false);

                        // 标记切片已完成
                        this._sliceCompleted = true;

                        // 立即上传后处理 GCode 到打印机（不启动打印）
                        if (status.gcode_path) {
                            try {
                                const uploadResult = await window.pywebview.api.upload_gcode_to_printer();
                                if (uploadResult && uploadResult.success) {
                                    this.showToast('GCode 已上传至打印机，等待用户启动打印', 'success');
                                } else {
                                    console.warn('[SlicePoll] 上传 GCode 失败:', uploadResult?.error);
                                    this.showToast('GCode 上传失败: ' + (uploadResult?.error || '未知错误'), 'warning');
                                }
                            } catch (e) {
                                console.error('[SlicePoll] 上传 GCode 异常:', e);
                            }
                        }

                        // 加载切片预览图 — 先存图片再切换页面，避免 switchToPreview
                        // 中的异步 _loadPreviewFolderImages 覆盖切片结果（竞态条件）
                        const imgResult = await window.pywebview.api.texture_slice_load_images();
                        if (imgResult && imgResult.success && imgResult.files && imgResult.files.length > 0) {
                            this.showToast(`切片+后处理完成，共 ${imgResult.count} 层`, 'success');
                            this.displaySliceImages(imgResult);
                            this.switchToPreview();
                        }

                        // 加载最终 GCode 到预览
                        if (status.gcode_path) {
                            try {
                                const gcodeResult = await window.pywebview.api.load_gcode_file(status.gcode_path);
                                if (gcodeResult && gcodeResult.success) {
                                    console.log('[SlicePoll] 加载后处理 GCode 成功:', status.gcode_path);
                                    this._lastGcode = gcodeResult.gcode;
                                    this._testGcodePath = status.gcode_path;
                                    this._updatePrintStatusText();
                                    // 隐藏占位符
                                    const placeholder = document.getElementById('gcode-drop-placeholder');
                                    if (placeholder) placeholder.style.display = 'none';
                                    // 渲染 3D 轨迹
                                    setTimeout(() => {
                                        if (this._gcode3DRenderer) this._renderToolpath3D();
                                    }, 200);
                                }
                            } catch (e) {
                                console.error('[SlicePoll] 加载后处理 GCode 失败:', e);
                            }

                            resolve();
                            return;
                        }
                    }

                    // 继续轮询（done / strips_done 状态也继续等待 postprocess 完成）
                    this._pollTimer = setTimeout(poll, 500);
                } catch (e) {
                    console.error('轮询切片状态异常:', e);
                    this._hideSliceProgress();
                    this._setPreviewTabDisabled(false);
                    this.showToast('查询切片状态失败: ' + e.message, 'error');
                    resolve();
                }
            };

            poll();
        });
    }

    _cancelSlicing() {
        this._sliceCancelled = true;
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
        // 立即隐藏进度条
        this._hideSliceProgress();
        this._setPreviewTabDisabled(false);
        if (window.pywebview && window.pywebview.api) {
            window.pywebview.api.texture_slice_cancel().catch(e => console.error('取消切片失败:', e));
        }
    }

    /** 开始轮询头样子进程（Orca 调起的后处理）进度 */
    _startHeadlessPolling() {
        // 如果已有内部切片在运行，不启动
        if (this._sliceRunning) {
            console.log('[HeadlessPoll] 内部切片运行中，跳过启动');
            return;
        }
        // 如果已经在轮询，不重复启动
        if (this._headlessPollTimer) {
            console.log('[HeadlessPoll] 已在轮询，跳过重复启动');
            return;
        }
        console.log('[HeadlessPoll] 启动轮询');

        const poll = async () => {
            // 已取消切片，停止轮询
            if (this._sliceCancelled) {
                console.log('[HeadlessPoll] 切片已取消，停止头状轮询');
                this._stopHeadlessPolling();
                return;
            }
            // 内部切片开始了，停止本轮询
            if (this._sliceRunning) {
                console.log('[HeadlessPoll] 内部切片启动，停止头状轮询');
                this._stopHeadlessPolling();
                return;
            }
            try {
                const status = await window.pywebview.api.texture_slice_get_status();
                console.log('[HeadlessPoll] 收到状态:', JSON.stringify(status));
                // API 调用期间可能已取消，再次检查
                if (this._sliceCancelled) {
                    console.log('[HeadlessPoll] 切片已取消（API 返回后检出），停止头状轮询');
                    this._stopHeadlessPolling();
                    return;
                }
                if (!status || status.state === 'idle') {
                    // 未检测到头样子进程，继续轮询
                    this._headlessPollTimer = setTimeout(poll, 2000);
                    return;
                }

                // 如果已经处理过完成/错误状态，不再重复处理
                if (this._headlessDone && (status.state === 'complete' || status.state === 'error')) {
                    this._hideSliceProgress();
                    return;
                }

                console.log('[HeadlessPoll] 状态:', status.state, status.stage);

                if (status.state === 'complete') {
                    console.log('[HeadlessPoll] 头样子进程完成');
                    this._headlessDone = true;
                    this._headlessPollTimer = null;
                    this._hideSliceProgress();
                    this._sliceCompleted = true;

                    // 加载预览图和 GCode，完成后跳转预览页
                    const imgResult = await window.pywebview.api.texture_slice_load_images();
                    if (imgResult && imgResult.success && imgResult.files && imgResult.files.length > 0) {
                        this.showToast(`后处理完成，共 ${imgResult.count} 层`, 'success');
                        this.displaySliceImages(imgResult);
                    }
                    if (status.gcode_path) {
                        try {
                            const gcodeResult = await window.pywebview.api.load_gcode_file(status.gcode_path);
                            if (gcodeResult && gcodeResult.success) {
                                this._lastGcode = gcodeResult.gcode;
                                this._testGcodePath = status.gcode_path;
                                this._updatePrintStatusText();
                                const placeholder = document.getElementById('gcode-drop-placeholder');
                                if (placeholder) placeholder.style.display = 'none';
                                setTimeout(() => {
                                    if (this._gcode3DRenderer) this._renderToolpath3D();
                                }, 200);
                            }
                        } catch (e) {
                            console.error('[HeadlessPoll] 加载 GCode 失败:', e);
                        }
                        // 自动上传后处理好的 GCode 到打印机
                        try {
                            const uploadResult = await window.pywebview.api.upload_gcode_to_printer();
                            if (uploadResult && uploadResult.success) {
                                this.showToast('GCode 已上传至打印机', 'success');
                            } else {
                                console.warn('[HeadlessPoll] 上传失败:', uploadResult?.error);
                            }
                        } catch (e) {
                            console.error('[HeadlessPoll] 上传异常:', e);
                        }
                    }
                    // 自动跳转预览页
                    this.switchToPreview();
                    return;
                }

                if (status.state === 'error') {
                    this._headlessDone = true;
                    this._headlessPollTimer = null;
                    this._hideSliceProgress();
                    this.showToast('后处理失败: ' + (status.error || '未知错误'), 'error');
                    return;
                }

                // 运行中：在所有页面显示进度条（不仅限预览页）
                const progressEl = document.getElementById('slice-progress');
                const progressFill = document.getElementById('slice-progress-fill');
                const progressText = document.getElementById('slice-progress-text');
                if (progressEl) progressEl.classList.remove('hidden');
                const done = status.total > 0 && status.progress >= status.total;
                const stageText = done ? '分配纹理块中' :
                                  status.stage === 'postprocess' ? '分配纹理块中' :
                                  status.stage === 'texture' ? '切片中' : '准备中';
                if (status.total > 0) {
                    progressFill && progressFill.classList.remove('indeterminate');
                    const pct = Math.round((status.progress / status.total) * 100);
                    if (progressFill) progressFill.style.width = pct + '%';
                    if (progressText) progressText.textContent = done ? '分配纹理块中' : `${stageText} ${status.progress} / ${status.total} 层`;
                } else {
                    // 未知总量时显示滑动动画（indeterminate）
                    progressFill && progressFill.classList.add('indeterminate');
                    if (progressText) progressText.textContent = `${stageText}...`;
                }

                this._headlessPollTimer = setTimeout(poll, 1000);
            } catch (e) {
                console.error('[HeadlessPoll] 轮询异常:', e);
                this._headlessPollTimer = setTimeout(poll, 2000);
            }
        };

        poll();
    }

    /** 停止头样子进程进度轮询 */
    _stopHeadlessPolling() {
        if (this._headlessPollTimer) {
            clearTimeout(this._headlessPollTimer);
            this._headlessPollTimer = null;
        }
    }

    _hideSliceProgress() {
        this._sliceRunning = false;
        this._sliceCancelled = true; // 确保轮询不再继续
        this._stopHeadlessPolling();
        const progressEl = document.getElementById('slice-progress');
        if (progressEl) progressEl.classList.add('hidden');
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _setPreviewTabDisabled(disabled) {
        const previewBtn = document.getElementById('nav-preview');
        if (previewBtn) {
            if (disabled) {
                previewBtn.classList.add('disabled');
            } else {
                previewBtn.classList.remove('disabled');
            }
        }
    }

    /** 模型切片：导出 STL 并用 OrcaSlicer 打开 */
    async doModelSlice() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }
        if (this.models.size === 0) {
            this.showToast('场景中没有模型', 'warning');
            return;
        }

        // 1. 导出 STL
        const stlResult = await this._exportSTLWithPlanes();
        if (!stlResult || !stlResult.success) {
            this.showToast('STL 导出失败: ' + (stlResult ? stlResult.error : ''), 'error');
            return;
        }

        // 2. 获取切片器路径
        let slicerPath = this._getCurrentSlicerPath();
        if (!slicerPath) {
            try {
                const currentType = this.gcodeSlicerType || 'orcaslicer';
                const apiMethod = currentType === 'snapmaker_orca'
                    ? () => window.pywebview.api.resolve_snapmaker_orca()
                    : () => window.pywebview.api.resolve_orca_slicer();
                const detectResult = await apiMethod();
                if (detectResult.success && detectResult.path) {
                    slicerPath = detectResult.path;
                    if (currentType === 'snapmaker_orca') {
                        this.snapmakerOrcaPath = slicerPath;
                    } else {
                        this.orcaSlicerPath = slicerPath;
                    }
                }
            } catch (_) {}
        }

        if (!slicerPath) {
            this.showToast('未找到切片器，请在设置中配置路径', 'warning');
            // 打开设置对话框
            const settingsBtn = document.getElementById('btn-show-settings');
            if (settingsBtn) settingsBtn.click();
            return;
        }

        // 3. 导出纹理 OBJ 到固定路径，写入 pending_slice.json 供 Orca 调起的子进程读取
        try {
            const objExportResult = await this._exportOBJWithPlanes();
            if (objExportResult && objExportResult.success && objExportResult.path) {
                const objPath = objExportResult.path;
                const resolution = this.textureResolution || 4000;
                // 一并传入聚焦区（模型包围盒+padding），让后端写 pending 时同步算好聚焦指导
                const focusMm = this._computeSliceFocusMm();
                const writeResult = await window.pywebview.api.write_pending_slice(
                    objPath, 0.2, resolution, focusMm
                );
                console.log('[Slice] write_pending_slice OK, obj:', objPath, writeResult);
            } else {
                console.warn('[Slice] OBJ 导出失败，子进程无法执行纹理切片');
            }
        } catch (e) {
            console.error('[Slice] write_pending_slice 失败:', e);
        }

        // 3.5 ★ 打开 Orca 前锁定当前盘，防止 Orca 中与本地位置不一致
        {
            const _pid = this.currentPlateId;
            if (_pid != null && !this.isPlateLocked(_pid)) {
                const _name = this.plates.get(_pid)?.name || `盘 ${_pid}`;
                if (this._lockPlateInternal(_pid)) {
                    this.showToast(`已自动锁定「${_name}」，防止模型位移`, 'info');
                }
            }
        }

        // 4. 打开 OrcaSlicer GUI 并加载 STL
        try {
            const openResult = await window.pywebview.api.open_with_orca_slicer(stlResult.path, slicerPath);
            if (openResult.success) {
                this.showToast('已打开 OrcaSlicer，请在 Orca 中切片并执行后处理', 'success');
                // 启动后台轮询，监听 Orca 调起的后处理进度
                this._stopHeadlessPolling();
                this._sliceRunning = false;
                this._sliceCancelled = false;
                this._headlessDone = false;
                this._startHeadlessPolling();
            } else {
                this.showToast('打开 OrcaSlicer 失败: ' + (openResult.error || ''), 'error');
            }
        } catch (e) {
            this.showToast('打开 OrcaSlicer 异常: ' + e.message, 'error');
        }
    }

    /** 重试切片：不重新唤起 OrcaSlicer，仅重建 pending_slice 并开始轮询 */
    async retrySlice() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }
        if (this.models.size === 0) {
            this.showToast('场景中没有模型', 'warning');
            return;
        }

        // 重新导出纹理 OBJ 并写入 pending_slice.json
        try {
            const objExportResult = await this._exportOBJWithPlanes();
            if (objExportResult && objExportResult.success && objExportResult.path) {
                const objPath = objExportResult.path;
                const resolution = this.textureResolution || 4000;
                // 一并传入聚焦区，让后端写 pending 时同步算好聚焦指导
                const focusMm = this._computeSliceFocusMm();
                const writeResult = await window.pywebview.api.write_pending_slice(
                    objPath, 0.2, resolution, focusMm
                );
                console.log('[Retry] write_pending_slice OK, obj:', objPath, writeResult);
            } else {
                this.showToast('OBJ 导出失败，无法重试', 'error');
                return;
            }
        } catch (e) {
            console.error('[Retry] write_pending_slice 失败:', e);
            this.showToast('重试准备失败: ' + e.message, 'error');
            return;
        }

        this.showToast('请在 OrcaSlicer 中重新切片', 'success');
        // 重置状态并启动头状轮询
        this._stopHeadlessPolling();
        this._sliceRunning = false;
        this._sliceCancelled = false;
        this._headlessDone = false;
        this._startHeadlessPolling();
    }

    /** 开始打印（简化版：失败直接显示无法连接） */
    async startPrint() {
        const el = document.getElementById('print-status-text');
        if (!el || !window.pywebview || !window.pywebview.api) return;
        try {
            el.textContent = '正在打印...';
            el.disabled = true;
            const result = await window.pywebview.api.start_print();
            if (result && result.success) {
                el.textContent = '立即打印';
                this.showToast('打印已启动', 'success');
            } else {
                el.textContent = '无法连接';
                this.showToast('打印失败: ' + (result?.error || '无法连接'), 'error');
            }
        } catch (e) {
            el.textContent = '无法连接';
            this.showToast('打印异常: ' + e.message, 'error');
        } finally {
            el.disabled = false;
        }
    }

    /** 更新打印状态按钮（导航栏"立即打印"按钮）。
     *  仅当处于预览页且有 GCode 时才显示，避免在其他标签页提前出现。 */
    _updatePrintStatusText() {
        const btn = document.getElementById('btn-print-gcode');
        if (!btn) return;
        const previewPage = document.getElementById('preview-page');
        const onPreview = !(previewPage && previewPage.classList.contains('hidden'));
        if (this._lastGcode && onPreview) {
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
        }
    }

    /** 开始打印（导航栏"立即打印"按钮） */
    async startPrint() {
        const btn = document.getElementById('btn-print-gcode');
        if (!btn || !window.pywebview || !window.pywebview.api) return;
        try {
            btn.textContent = '正在打印...';
            btn.disabled = true;
            const result = await window.pywebview.api.start_print();
            if (result && result.success) {
                btn.textContent = '立即打印';
                this.showToast('打印已启动', 'success');
            } else {
                btn.textContent = '无法连接';
                this.showToast('打印失败: ' + (result?.error || '无法连接'), 'error');
            }
        } catch (e) {
            btn.textContent = '无法连接';
            this.showToast('打印异常: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
        }
    }

    // ---------- 自动摆放 ----------
    toggleArrangeCard() {
        const card = document.getElementById('arrange-card');
        if (card.classList.contains('hidden')) {
            card.classList.remove('hidden');
            // 点击其他区域关闭
            this._arrangeOutsideHandler = (e) => {
                if (!card.contains(e.target) && e.target.id !== 'tool-auto-arrange') {
                    this.hideArrangeCard();
                }
            };
            setTimeout(() => document.addEventListener('click', this._arrangeOutsideHandler), 0);
        } else {
            this.hideArrangeCard();
        }
    }

    hideArrangeCard() {
        document.getElementById('arrange-card')?.classList.add('hidden');
        if (this._arrangeOutsideHandler) {
            document.removeEventListener('click', this._arrangeOutsideHandler);
            this._arrangeOutsideHandler = null;
        }
    }

    doAutoArrange() {
        const spacing = parseFloat(document.getElementById('arrange-spacing')?.value || '5');
        // 距打印板边界的留白（边界边距），独立于模型间距
        const margin = parseFloat(document.getElementById('arrange-margin')?.value);
        const pad = Number.isFinite(margin) ? Math.max(0, Math.min(margin, 50)) : 5;
        this.hideArrangeCard();

        const modelCount = this.models.size;
        if (modelCount === 0) {
            this.showToast('场景中没有模型', 'warning');
            return;
        }

        // 操作前取消所有选中：deselectModelInternal 会把 proxy 子级偏移折叠回 mesh 世界
        // position 并销毁 proxy，避免下面直接写 item.mesh.position 时改的是 proxy 局部偏移
        if (this.selectedModels.size > 0) {
            this.clearSelection();
        }

        // 获取当前盘的世界方位：自动摆放在「当前盘」范围内部署，而不是床面原点
        const plateCy = this._getPlateWorldPos(this.currentPlateId);
        const plateOx = plateCy.x - this.bedSize.x / 2;
        const plateOy = plateCy.y - this.bedSize.y / 2;

        // 仅排列当前盘上的模型；用世界包围盒求真实尺寸与中心（含已烘焙/缩放），保证居中
        const items = [];
        this.models.forEach((modelObj) => {
            if (!this._isOnCurrentPlate(modelObj)) return;
            modelObj.mesh.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(modelObj.mesh);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            if (size.x > 0 && size.y > 0) {
                items.push({ model: modelObj, size, center, area: size.x * size.y });
            }
        });

        if (items.length === 0) return;

        // 从大到小排序
        items.sort((a, b) => b.area - a.area);

        const bedW = this.bedSize.x;
        const bedH = this.bedSize.y;
        const cols = Math.ceil(Math.sqrt(items.length));

        // 计算网格列宽行高
        const colW = [];
        const rowH = [];
        items.forEach((item, i) => {
            const c = i % cols;
            const r = Math.floor(i / cols);
            colW[c] = Math.max(colW[c] || 0, item.size.x);
            rowH[r] = Math.max(rowH[r] || 0, item.size.y);
        });

        // 网格尺寸
        const gridW = colW.reduce((a, b) => a + b, 0) + (colW.length - 1) * spacing;
        const gridH = rowH.reduce((a, b) => a + b, 0) + (rowH.length - 1) * spacing;

        // 热床允许的安全范围
        const bedMaxX = bedW - pad;
        const bedMaxY = bedH - pad;

        // 网格起始 XY（尽可能居中于盘内，且至少留 pad 边距）
        const originX = Math.max(pad, (bedW - gridW) / 2);
        const originY = Math.max(pad, (bedH - gridH) / 2);

        // 计算每个格子中心（盘内局部坐标）
        const gxc = [];
        let cx = originX;
        for (let c = 0; c < colW.length; c++) {
            gxc[c] = cx + colW[c] / 2;
            cx += colW[c] + spacing;
        }
        const gyc = [];
        let cy = originY;
        for (let r = 0; r < rowH.length; r++) {
            gyc[r] = cy + rowH[r] / 2;
            cy += rowH[r] + spacing;
        }

        // 擦料塔避让：以塔的 XY 包围盒为禁区，模型格子中心不得落入塔盒
        let towerBox = null;
        {
            const towerPos = this._getCurrentPlateTowerPos();
            const towerSize = 32;
            const thw = towerSize / 2, thd = towerSize / 2;
            // 塔盒（世界坐标 XY），留出 spacing 作为额外间隙
            towerBox = {
                minX: towerPos.x - thw - spacing,
                maxX: towerPos.x + thw + spacing,
                minY: towerPos.y - thd - spacing,
                maxY: towerPos.y + thd + spacing,
            };
        }
        const _intersectsTower = (cx, cy, hw, hh) => {
            const minX = cx - hw, maxX = cx + hw, minY = cy - hh, maxY = cy + hh;
            return !(maxX < towerBox.minX || minX > towerBox.maxX || maxY < towerBox.minY || minY > towerBox.maxY);
        };

        // 摆放：把每个模型的世界包围盒中心移动到对应格子中心（盘内相对坐标 + 盘原点），避让擦料塔
        items.forEach((item, i) => {
            const c = i % cols;
            const r = Math.floor(i / cols);

            let tx = gxc[c];
            let ty = gyc[r];

            // 确保整模型在盘内
            const hw = item.size.x / 2;
            const hh = item.size.y / 2;
            tx = Math.max(pad + hw, Math.min(bedMaxX - hw, tx));
            ty = Math.max(pad + hh, Math.min(bedMaxY - hh, ty));

            let targetWorldX = plateOx + tx;
            let targetWorldY = plateOy + ty;

            // 若与擦料塔相交，沿 +X 方向逐格右移寻找空位；不行再沿 +Y 上移
            if (_intersectsTower(targetWorldX, targetWorldY, hw, hh)) {
                let placed = false;
                // 优先在同行向右扫
                for (let cc = c + 1; cc < colW.length && !placed; cc++) {
                    let ntx = gxc[cc];
                    ntx = Math.max(pad + hw, Math.min(bedMaxX - hw, ntx));
                    const nx = plateOx + ntx;
                    if (!_intersectsTower(nx, targetWorldY, hw, hh)) {
                        targetWorldX = nx; placed = true;
                    }
                }
                // 再尝试下一行行首开始扫
                if (!placed) {
                    for (let rr = r + 1; rr < rowH.length && !placed; rr++) {
                        for (let cc = 0; cc < colW.length && !placed; cc++) {
                            let ntx = gxc[cc], nty = gyc[rr];
                            ntx = Math.max(pad + hw, Math.min(bedMaxX - hw, ntx));
                            nty = Math.max(pad + hh, Math.min(bedMaxY - hh, nty));
                            const nx = plateOx + ntx, ny = plateOy + nty;
                            if (!_intersectsTower(nx, ny, hw, hh)) {
                                targetWorldX = nx; targetWorldY = ny; placed = true;
                            }
                        }
                    }
                }
                // 仍无空位则贴塔边缘推开（取塔盒外最近点）
                if (!placed) {
                    const candX = towerBox.maxX + hw + 1;
                    const candY = towerBox.maxY + hh + 1;
                    // 选更近且仍在盘内的候选
                    const inX = candX >= plateOx + pad + hw && candX <= plateOx + bedMaxX - hw;
                    const inY = candY >= plateOy + pad + hh && candY <= plateOy + bedMaxY - hh;
                    if (inX && (!inY || Math.abs(candX - targetWorldX) <= Math.abs(candY - targetWorldY))) {
                        targetWorldX = Math.max(plateOx + pad + hw, Math.min(plateOx + bedMaxX - hw, candX));
                    } else if (inY) {
                        targetWorldY = Math.max(plateOy + pad + hh, Math.min(plateOy + bedMaxY - hh, candY));
                    }
                }
            }

            // 以“中心对齐”方式移动，而不是硬设 position，避免模型原点不在几何中心时整体偏移
            item.model.mesh.position.x += targetWorldX - item.center.x;
            item.model.mesh.position.y += targetWorldY - item.center.y;
            item.model.mesh.position.z = item.size.z / 2;
            item.model.mesh.updateMatrixWorld(true);

            console.log(`[auto-arrange] model#${i}: size(${item.size.x.toFixed(1)},${item.size.y.toFixed(1)}) target(${targetWorldX.toFixed(1)},${targetWorldY.toFixed(1)})`);
        });

        this.saveState('自动摆放');
    }

    /** 启动时从配置文件加载已保存的偏好设置并应用到场景 */
    async _loadAndApplySettings() {
        // 等待 pywebview API 就绪（最多重试 10 次 × 500ms = 5s）
        for (let retry = 0; retry < 10; retry++) {
            if (window.pywebview && window.pywebview.api) break;
            await new Promise(r => setTimeout(r, 500));
        }
        if (!window.pywebview || !window.pywebview.api) return;

        try {
            const result = await window.pywebview.api.load_settings();
            if (!result.success || !result.settings) return;
            const s = result.settings;

            let needsUpdate = false;

            // 应用网格配色
            if (s.gridTheme && s.gridTheme !== this.gridTheme) {
                this.gridTheme = s.gridTheme;
                needsUpdate = true;
            }

            // 应用相机模式（仅在值不同时切换）
            if (s.cameraMode && s.cameraMode !== this.cameraMode) {
                this.cameraMode = s.cameraMode;
                const width = this.container.clientWidth;
                const height = this.container.clientHeight;
                this._createCamera(width, height);
                needsUpdate = true;
            }

            // 应用显示网格
            if (s.showGrid !== undefined && s.showGrid !== this.showGrid) {
                this.showGrid = s.showGrid;
                needsUpdate = true;
            }

            if (needsUpdate) {
                this.createBed();
                this.createGrid();
            }

            console.log('已加载偏好设置:', s);
        } catch (e) {
            console.error('加载偏好设置失败:', e);
        }

        // 独立加载打印机设置
        try {
            const pResult = await window.pywebview.api.load_printer_settings();
            if (pResult.success && pResult.settings) {
                const ps = pResult.settings;
                let bedChanged = false;
                if (ps.bedSize) {
                    if (ps.bedSize.x && ps.bedSize.x !== this.bedSize.x) {
                        this.bedSize.x = ps.bedSize.x; bedChanged = true;
                    }
                    if (ps.bedSize.y && ps.bedSize.y !== this.bedSize.y) {
                        this.bedSize.y = ps.bedSize.y; bedChanged = true;
                    }
                    if (ps.bedSize.z && ps.bedSize.z !== this.bedSize.z) {
                        this.bedSize.z = ps.bedSize.z; bedChanged = true;
                    }
                }
                if (ps.printerAddress !== undefined) this.printerAddress = ps.printerAddress;
                if (ps.headAddress !== undefined) this.headAddress = ps.headAddress;
                if (bedChanged) {
                    this.createBed();
                    this.createGrid();
                }
            }
        } catch (e) {
            console.error('加载打印机设置失败:', e);
        }
    }

    /** 启动时自动检测外部工具路径（OrcaSlicer），仅当设置中未配置时 */
    async _autoDetectExternalTools() {
        // 等待 pywebview API 就绪（最多重试 10 次 × 500ms = 5s）
        for (let retry = 0; retry < 10; retry++) {
            if (window.pywebview && window.pywebview.api) break;
            await new Promise(r => setTimeout(r, 500));
        }
        if (!window.pywebview || !window.pywebview.api) {
            console.warn('pywebview API 不可用，跳过自动检测');
            return;
        }

        // 先加载已保存的设置
        let savedSettings = null;
        try {
            const settingsResult = await window.pywebview.api.load_settings();
            if (settingsResult.success && settingsResult.settings) {
                savedSettings = settingsResult.settings;
            }
        } catch (_) {}

        // 自动检测 OrcaSlicer
        if (!this.orcaSlicerPath) {
            if (savedSettings && savedSettings.orcaSlicerPath) {
                this.orcaSlicerPath = savedSettings.orcaSlicerPath;
                console.log('OrcaSlicer 路径已从配置加载:', this.orcaSlicerPath);
            } else {
                await this._detectSingleTool(
                    'OrcaSlicer',
                    () => window.pywebview.api.resolve_orca_slicer(),
                    'orcaSlicerPath'
                );
            }
        }

        // 自动检测 Snapmaker Orca
        if (!this.snapmakerOrcaPath) {
            if (savedSettings && savedSettings.snapmakerOrcaPath) {
                this.snapmakerOrcaPath = savedSettings.snapmakerOrcaPath;
                console.log('Snapmaker Orca 路径已从配置加载:', this.snapmakerOrcaPath);
            } else {
                await this._detectSingleTool(
                    'Snapmaker Orca',
                    () => window.pywebview.api.resolve_snapmaker_orca(),
                    'snapmakerOrcaPath'
                );
            }
        }

        // 加载切片器类型偏好
        if (savedSettings && savedSettings.gcodeSlicerType) {
            this.gcodeSlicerType = savedSettings.gcodeSlicerType;
        }
    }

    /** 检测单个工具路径并保存到设置 */
    async _detectSingleTool(name, detectFn, settingKey) {
        try {
            console.log(`${name} 未配置，开始自动检测...`);
            const result = await detectFn();
            if (result.success && result.path) {
                this[settingKey] = result.path;
                console.log(`自动检测到 ${name}:`, result.path);
                // 保存到设置
                try {
                    const settings = {
                        maxHistory: this.historyManager.maxSize,
                        showGrid: this.showGrid,
                        gridTheme: this.gridTheme,
                        gridSize: this.gridSize,
                        cameraMode: this.cameraMode,
                        orcaSlicerPath: this.orcaSlicerPath || '',
                        snapmakerOrcaPath: this.snapmakerOrcaPath || '',
                        gcodeSlicerType: this.gcodeSlicerType || 'orcaslicer',
                        textureResolution: this.textureResolution || 4000
                    };
                    await window.pywebview.api.save_settings(JSON.stringify(settings));
                } catch (saveErr) {
                    console.error(`保存 ${name} 路径到设置失败:`, saveErr);
                }
            } else {
                console.log(`未检测到 ${name}，用户可以稍后在设置中手动配置`);
            }
        } catch (e) {
            console.error(`自动检测 ${name} 异常:`, e);
        }
    }

    /**
     * 将单个模型的当前几何体烘焙为临时 OBJ 文件
     * 克隆所有子 mesh，应用世界矩阵到顶点，导出为 OBJ 并保存到后端临时目录
     * @param {Object} model - 模型对象
     * @returns {{ success: boolean, path?: string, error?: string }}
     */
    async _bakeSingleModelToOBJ(model) {
        const meshes = [];
        const texMap = {};
        let textureCounter = 0;

        model.mesh.updateWorldMatrix(true, true);
        // 烘焙到“模型自身局部空间”：仅保留模型局部变换，去掉盘/世界偏移，
        // 使烘焙结果与未烘焙的文件一致，配合保存的“盘相对位置”在加载时统一换算。
        const invModelWorld = model.mesh.matrixWorld.clone().invert();
        model.mesh.traverse((child) => {
            if (!child.isMesh) return;
            const geo = child.geometry.clone();
            geo.applyMatrix4(child.matrixWorld);
            geo.applyMatrix4(invModelWorld);
            geo.computeVertexNormals();

            let materialName = 'default';
            let textureUrl = null;
            let textureName = null;
            let textureFlipY = true;

            if (child.material) {
                materialName = child.material.name || 'default';
                if (child.material.map && child.material.map.image) {
                    textureFlipY = child.material.map.flipY !== false;
                    const b64 = this._textureToBase64(child.material.map.image);
                    if (b64) {
                        textureName = `tex_${textureCounter}.png`;
                        textureCounter++;
                        texMap[textureName] = b64;
                        textureUrl = textureName;
                    }
                }
            }

            meshes.push({ geometry: geo, materialName, textureUrl, textureName, textureFlipY });
        });

        if (meshes.length === 0) return { success: false, error: '没有可导出的网格' };

        // 生成 OBJ 内容（mtllib 引用需与后端保存的文件名一致）
        const modelBase = model.name ? model.name.replace(/\.[^.]+$/, '') : 'model';
        let objStr = '# Baked by MKPSpectrum\n';
        const hasTextures = Object.keys(texMap).length > 0;
        if (hasTextures) {
            objStr += `mtllib ${modelBase}.mtl\n\n`;
        }

        let mtlStr = '# MTL generated by MKPSpectrum\n';
        let vertexOffset = 0;
        const usedMatNames = new Set();

        for (const { geometry, materialName, textureUrl, textureName, textureFlipY } of meshes) {
            const pos = geometry.getAttribute('position');
            const uv = geometry.getAttribute('uv');
            const norm = geometry.getAttribute('normal');
            const index = geometry.index;

            if (!pos || pos.count === 0) continue;

            let matName;
            if (textureName) {
                matName = textureName.replace('.png', '_mat');
            } else {
                matName = 'default_mat';
            }

            if (!usedMatNames.has(matName)) {
                usedMatNames.add(matName);
                mtlStr += `\nnewmtl ${matName}\n`;
                mtlStr += 'Kd 0.8 0.8 0.8\n';
                mtlStr += 'Ks 0.0 0.0 0.0\n';
                mtlStr += 'Ns 0\n';
                mtlStr += 'd 1.0\n';
                mtlStr += 'illum 2\n';
                if (textureName) {
                    mtlStr += `map_Kd ${textureName}\n`;
                    mtlStr += `MKP_flipY ${textureFlipY ? 1 : 0}\n`;
                }
            }
            objStr += `usemtl ${matName}\n`;

            // 写顶点
            for (let i = 0; i < pos.count; i++) {
                objStr += `v ${pos.getX(i).toFixed(6)} ${pos.getY(i).toFixed(6)} ${pos.getZ(i).toFixed(6)}\n`;
            }
            // 写 UV
            const hasUv = uv && uv.count > 0;
            if (hasUv) {
                for (let i = 0; i < uv.count; i++) {
                    objStr += `vt ${uv.getX(i).toFixed(6)} ${uv.getY(i).toFixed(6)}\n`;
                }
            }
            // 写法线
            const hasNorm = norm && norm.count > 0;
            if (hasNorm) {
                for (let i = 0; i < norm.count; i++) {
                    objStr += `vn ${norm.getX(i).toFixed(6)} ${norm.getY(i).toFixed(6)} ${norm.getZ(i).toFixed(6)}\n`;
                }
            }

            // 写面
            const faceCount = index ? index.count : pos.count;
            for (let i = 0; i < faceCount; i += 3) {
                let a, b, c;
                if (index) {
                    a = index.getX(i) + 1 + vertexOffset;
                    b = index.getX(i + 1) + 1 + vertexOffset;
                    c = index.getX(i + 2) + 1 + vertexOffset;
                } else {
                    a = i + 1 + vertexOffset;
                    b = i + 2 + vertexOffset;
                    c = i + 3 + vertexOffset;
                }
                if (hasUv && hasNorm) {
                    objStr += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
                } else if (hasUv) {
                    objStr += `f ${a}/${a} ${b}/${b} ${c}/${c}\n`;
                } else {
                    objStr += `f ${a} ${b} ${c}\n`;
                }
            }

            vertexOffset += pos.count;
        }

        // 发送到后端保存
        const payload = {
            obj: objStr,
            mtl: hasTextures ? mtlStr : '',
            textures: texMap,
            name: model.name,
        };

        try {
            const result = await window.pywebview.api.save_baked_model_to_temp(JSON.stringify(payload));
            return result || { success: false, error: '后端返回空' };
        } catch (e) {
            console.error('烘焙模型保存失败:', e);
            return { success: false, error: e.message };
        }
    }

    /**
     * 导出 STL（模型 + 四角定位平面）到 Documents/MKPSpectrum/Temp/
     * 网格本身不会被导出，只导出模型和四个 1mm×1mm 的定位平面
     */
    async _exportSTLWithPlanes() {
        const geometries = [];

        // 0. 当前盘原点偏移：导出时把当前盘对齐到床面原点，且只导出当前盘上的模型
        const off = this._getPlateExportOffset();
        const normalT = new THREE.Matrix4().makeTranslation(off.x, off.y, 0);

        // 1. 只收集当前盘上的可打印模型几何体（应用世界变换，不混入其他盘的模型）
        this.models.forEach((model) => {
            if (!model.visible || !model.printable) return;
            if (!this._isOnCurrentPlate(model)) return;
            // 确保世界矩阵是最新的（处理近期变换操作后未刷新矩阵的情况）
            model.mesh.updateWorldMatrix(true, true);
            model.mesh.traverse((child) => {
                if (child.isMesh) {
                    const geo = child.geometry.clone();
                    geo.applyMatrix4(child.matrixWorld);
                    geo.applyMatrix4(normalT);
                    geo.computeVertexNormals();
                    geometries.push(geo);
                }
            });
        });

        if (geometries.length === 0) {
            this.showToast('没有可见模型可供导出', 'warning');
            return;
        }

        // 2. 在网格四个角创建 1mm×1mm 的定位平面（内缩 0.5mm，确保不超出边界）
        const half = 0.5;
        const inset = half;
        const corners = [
            { x: inset, y: inset },                                           // 左下角
            { x: this.bedSize.x - inset, y: inset },                          // 右下角
            { x: inset, y: this.bedSize.y - inset },                          // 左上角
            { x: this.bedSize.x - inset, y: this.bedSize.y - inset }          // 右上角
        ];

        for (const c of corners) {
            geometries.push(this._createPlaneGeometry(c.x, c.y, half));
        }

        // 3. 将所有几何体直接写入 ASCII STL（不合并，避免属性不一致问题）
        let stlStr = 'solid MKPSpectrum_Model\n';
        for (const geo of geometries) {
            stlStr += this._geometryToSTLFaces(geo);
        }
        stlStr += 'endsolid MKPSpectrum_Model\n';

        // 4. 发送到后端保存到 Documents/MKPSpectrum/Temp/
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `model_${timestamp}.stl`;
        const saveResult = await window.pywebview.api.save_stl_to_temp(stlStr, filename);
        if (saveResult && !saveResult.success) {
            this.showToast('STL 导出失败: ' + (saveResult ? saveResult.error : '未知错误'), 'error');
        }
        return saveResult;
    }

    /**
     * 提取 Three.js 材质贴图为 base64 PNG 数据 URL
     */
    _textureToBase64(image) {
        if (!image) return null;
        // 如果已经是 Canvas，直接导出
        if (image instanceof HTMLCanvasElement) {
            return image.toDataURL('image/png');
        }
        // HTMLImageElement
        if (image instanceof HTMLImageElement) {
            const c = document.createElement('canvas');
            c.width = image.naturalWidth || image.width;
            c.height = image.naturalHeight || image.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(image, 0, 0);
            return c.toDataURL('image/png');
        }
        // ImageBitmap
        if (image instanceof ImageBitmap) {
            const c = document.createElement('canvas');
            c.width = image.width;
            c.height = image.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(image, 0, 0);
            return c.toDataURL('image/png');
        }
        return null;
    }

    /**
     * 导出带纹理的 OBJ（模型 + 四角定位平面 + MTL + 贴图）
     * 类似 _exportSTLWithPlanes 但是输出 OBJ 格式
     * @returns {{ success: boolean, path?: string, error?: string }}
     */
    async _exportOBJWithPlanes() {
        const meshes = [];       // { geometry, materialName, textureUrl, textureName }
        const texMap = {};       // textureName → base64 data URL (去重)
        let textureCounter = 0;

        // 0. 当前盘原点偏移：导出时把当前盘对齐到床面原点，且只导出当前盘上的模型
        const off = this._getPlateExportOffset();
        const normalT = new THREE.Matrix4().makeTranslation(off.x, off.y, 0);

        // 1. 只收集当前盘上的可打印模型的几何体 + 材质贴图（不混入其他盘的模型）
        this.models.forEach((model) => {
            if (!model.visible || !model.printable) return;
            if (!this._isOnCurrentPlate(model)) return;
            model.mesh.updateWorldMatrix(true, true);
            model.mesh.traverse((child) => {
                if (!child.isMesh) return;
                const geo = child.geometry.clone();
                geo.applyMatrix4(child.matrixWorld);
                geo.applyMatrix4(normalT);
                geo.computeVertexNormals();

                let materialName = 'default';
                let textureUrl = null;
                let textureName = null;
                let textureFlipY = true;

                if (child.material) {
                    materialName = child.material.name || 'default';
                    // 提取贴图
                    if (child.material.map && child.material.map.image) {
                        textureFlipY = child.material.map.flipY !== false;
                        const b64 = this._textureToBase64(child.material.map.image);
                        if (b64) {
                            textureName = `tex_${textureCounter}.png`;
                            textureCounter++;
                            texMap[textureName] = b64;
                            textureUrl = textureName;
                        }
                    }
                }

                meshes.push({ geometry: geo, materialName, textureUrl, textureName, textureFlipY });
            });
        });

        if (meshes.length === 0) {
            this.showToast('没有可见模型可供导出', 'warning');
            return { success: false, error: '没有可见模型' };
        }

        // 2. 添加四角定位平面（1mm×1mm，无贴图）
        const half = 0.5;
        const inset = half;
        const corners = [
            { x: inset, y: inset },
            { x: this.bedSize.x - inset, y: inset },
            { x: inset, y: this.bedSize.y - inset },
            { x: this.bedSize.x - inset, y: this.bedSize.y - inset },
        ];
        for (const c of corners) {
            const planeGeo = this._createPlaneGeometry(c.x, c.y, half);
            meshes.push({
                geometry: planeGeo,
                materialName: 'corner_plane',
                textureUrl: null,
                textureName: null,
                textureFlipY: true,
            });
        }

        // 3. 生成 OBJ 内容（所有几何体合并在一个文件中，材质按 mesh 切分）
        let objStr = '# Exported by MKPSpectrum\n';
        objStr += 'mtllib model.mtl\n\n';

        // MTL 内容
        let mtlStr = '# MTL generated by MKPSpectrum\n';

        let vertexOffset = 0;
        let usedMatNames = new Set();
        let totalFaces = 0;

        for (const { geometry, materialName, textureUrl, textureName, textureFlipY } of meshes) {
            const pos = geometry.getAttribute('position');
            const uv = geometry.getAttribute('uv');
            const norm = geometry.getAttribute('normal');
            const index = geometry.index;

            if (!pos || pos.count === 0) continue;

            // 确定材质名（有贴图用贴图材质名，否则用 default）
            let matName;
            if (textureName) {
                matName = textureName.replace('.png', '_mat');
            } else if (materialName === 'corner_plane') {
                matName = 'corner_plane_mat';
            } else {
                matName = 'default_mat';
            }

            // 每个新 mesh 标记材质切换
            if (!usedMatNames.has(matName)) {
                usedMatNames.add(matName);
                // 生成 MTL 条目
                mtlStr += `\nnewmtl ${matName}\n`;
                mtlStr += 'Kd 0.8 0.8 0.8\n';
                mtlStr += 'Ks 0.0 0.0 0.0\n';
                mtlStr += 'Ns 0\n';
                mtlStr += 'd 1.0\n';
                mtlStr += 'illum 2\n';
                if (textureName) {
                    mtlStr += `map_Kd ${textureName}\n`;
                    mtlStr += `MKP_flipY ${textureFlipY ? 1 : 0}\n`;
                }
            }
            objStr += `usemtl ${matName}\n`;

            // 写顶点
            for (let i = 0; i < pos.count; i++) {
                objStr += `v ${pos.getX(i).toFixed(6)} ${pos.getY(i).toFixed(6)} ${pos.getZ(i).toFixed(6)}\n`;
            }
            // 写 UV
            let hasUv = uv && uv.count > 0;
            if (hasUv) {
                for (let i = 0; i < uv.count; i++) {
                    objStr += `vt ${uv.getX(i).toFixed(6)} ${uv.getY(i).toFixed(6)}\n`;
                }
            }
            // 写法线
            let hasNorm = norm && norm.count > 0;
            if (hasNorm) {
                for (let i = 0; i < norm.count; i++) {
                    objStr += `vn ${norm.getX(i).toFixed(6)} ${norm.getY(i).toFixed(6)} ${norm.getZ(i).toFixed(6)}\n`;
                }
            }

            // 写面（支持 indexed 和 non-indexed 两种几何体）
            const faceCount = index ? index.count : pos.count;
            for (let i = 0; i < faceCount; i += 3) {
                let a, b, c;
                if (index) {
                    a = index.getX(i) + 1 + vertexOffset;
                    b = index.getX(i + 1) + 1 + vertexOffset;
                    c = index.getX(i + 2) + 1 + vertexOffset;
                } else {
                    a = i + 1 + vertexOffset;
                    b = i + 2 + vertexOffset;
                    c = i + 3 + vertexOffset;
                }
                if (hasUv && hasNorm) {
                    objStr += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
                } else if (hasUv) {
                    objStr += `f ${a}/${a} ${b}/${b} ${c}/${c}\n`;
                } else {
                    objStr += `f ${a} ${b} ${c}\n`;
                }
                totalFaces++;
            }

            vertexOffset += pos.count;
        }

        console.log(`[OBJ导出] ${meshes.length} 个 mesh, ${totalFaces} 个面, ${Object.keys(texMap).length} 张贴图`);
        console.log(`[OBJ导出] OBJ 大小: ${(objStr.length / 1024).toFixed(1)}KB`);

        // 4. 发送到后端保存
        const payload = {
            obj: objStr,
            mtl: mtlStr,
            textures: texMap,
        };
        const result = await window.pywebview.api.save_textured_obj_to_temp(JSON.stringify(payload));
        if (result && !result.success) {
            this.showToast('纹理 OBJ 导出失败: ' + (result ? result.error : '未知错误'), 'error');
        }
        return result;
    }

    /**
     * 创建一个 1mm×1mm 的正方形平面几何体（2个三角形）
     * @param {number} cx - 中心 X
     * @param {number} cy - 中心 Y
     * @param {number} half - 半边长 (0.5mm)
     */
    _createPlaneGeometry(cx, cy, half) {
        const geo = new THREE.BufferGeometry();
        const verts = new Float32Array([
            cx - half, cy - half, 0,
            cx + half, cy - half, 0,
            cx + half, cy + half, 0,
            cx - half, cy + half, 0,
        ]);
        const idx = [0, 2, 1, 0, 3, 2];
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        return geo;
    }

    /**
     * 将单个 BufferGeometry 的三角形面写入 STL facet 块
     * @param {THREE.BufferGeometry} geometry
     * @returns {string} 仅包含 facet 块，不含 solid/endsolid
     */
    _geometryToSTLFaces(geometry) {
        const pos = geometry.getAttribute('position');
        const index = geometry.index;
        let output = '';

        if (index) {
            const tri = new THREE.Triangle();
            const vA = new THREE.Vector3();
            const vB = new THREE.Vector3();
            const vC = new THREE.Vector3();
            const normal = new THREE.Vector3();

            for (let i = 0; i < index.count; i += 3) {
                const ia = index.getX(i);
                const ib = index.getX(i + 1);
                const ic = index.getX(i + 2);

                vA.set(pos.getX(ia), pos.getY(ia), pos.getZ(ia));
                vB.set(pos.getX(ib), pos.getY(ib), pos.getZ(ib));
                vC.set(pos.getX(ic), pos.getY(ic), pos.getZ(ic));

                tri.set(vA, vB, vC);
                tri.getNormal(normal);

                output += `  facet normal ${normal.x} ${normal.y} ${normal.z}\n`;
                output += `    outer loop\n`;
                output += `      vertex ${vA.x} ${vA.y} ${vA.z}\n`;
                output += `      vertex ${vB.x} ${vB.y} ${vB.z}\n`;
                output += `      vertex ${vC.x} ${vC.y} ${vC.z}\n`;
                output += `    endloop\n`;
                output += `  endfacet\n`;
            }
        } else {
            for (let i = 0; i < pos.count; i += 3) {
                const v0 = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
                const v1 = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
                const v2 = new THREE.Vector3(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));

                const e1 = new THREE.Vector3().copy(v1).sub(v0);
                const e2 = new THREE.Vector3().copy(v2).sub(v0);
                const normal = new THREE.Vector3().crossVectors(e1, e2).normalize();

                output += `  facet normal ${normal.x} ${normal.y} ${normal.z}\n`;
                output += `    outer loop\n`;
                output += `      vertex ${v0.x} ${v0.y} ${v0.z}\n`;
                output += `      vertex ${v1.x} ${v1.y} ${v1.z}\n`;
                output += `      vertex ${v2.x} ${v2.y} ${v2.z}\n`;
                output += `    endloop\n`;
                output += `  endfacet\n`;
            }
        }

        return output;
    }

    async _loadTestGcode() {
        if (!this._testGcodePath) return;
        if (!window.pywebview || !window.pywebview.api) {
            console.warn('[测试] pywebview 不可用，无法加载测试 GCode');
            return;
        }
        try {
            const result = await window.pywebview.api.load_gcode_file(this._testGcodePath);
            if (result && result.success && result.gcode) {
                console.log(`[测试] 已加载 GCode 文件: ${this._testGcodePath}, 大小: ${result.gcode.length} 字节`);
                this._lastGcode = result.gcode;
                this.switchToPreview();
                await this.displayGcode(result.gcode);
                // 加载完成后更新层数滑块信息
                setTimeout(() => this._updateLayerSlider(), 100);
            } else {
                console.warn('[测试] 加载 GCode 失败:', result?.error || '未知错误');
            }
        } catch (e) {
            console.warn('[测试] 加载 GCode 异常:', e);
        }
    }

    // ========== GCode 3D 轨迹可视化 ==========

    _parseGcodeToolpath(gcode) {
        if (!gcode) {
            console.log('[GCodeDrop] _parseGcodeToolpath: no gcode');
            return [];
        }
        const lines = gcode.split('\n');
        console.log('[GCodeDrop] _parseGcodeToolpath lines count:', lines.length);
        const layers = [];

        let currentLayer = null;
        let currentType = 'travel';
        let lastX = null, lastY = null, lastZ = 0;
        let lastE = 0;
        let currentSegPoints = [];
        let currentSegType = 'travel';

        const TYPE_MAP = {
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
        };

        const COLOR_MAP = {
            inner_wall: 0x4a9eff,
            outer_wall: 0xff6b6b,
            infill: 0x51cf66,
            solid: 0xffd43b,
            support: 0xcc9eff,
            travel: 0x666666,
        };

        const _flushSegment = () => {
            if (currentSegPoints.length >= 2 && currentLayer) {
                currentLayer.segments.push({
                    type: currentSegType,
                    points: currentSegPoints,
                    color: COLOR_MAP[currentSegType] || COLOR_MAP.travel,
                });
                currentSegPoints = [];
            }
        };

        const _startNewSegment = (type) => {
            _flushSegment();
            currentSegType = type;
            // keep last point for continuity
            if (lastX !== null && lastY !== null) {
                currentSegPoints = [{ x: lastX, y: lastY, z: lastZ }];
            } else {
                currentSegPoints = [];
            }
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith(';')) {
                // ;LAYER_CHANGE
                if (/^;LAYER_CHANGE/i.test(line)) {
                    _flushSegment();
                    currentLayer = { z: lastZ, segments: [] };
                    layers.push(currentLayer);
                    currentSegPoints = [];
                    currentSegType = 'travel';
                    lastE = 0;
                }
                // ;TYPE:
                const typeMatch = line.match(/^;TYPE:\s*(.+)/i);
                if (typeMatch) {
                    const rawType = typeMatch[1].trim().toLowerCase();
                    const mappedType = TYPE_MAP[rawType] || currentSegType;
                    _startNewSegment(mappedType);
                }
                // read Z from ;Z:X.XX
                const zMatch = line.match(/^;Z:\s*([\d.]+)/i);
                if (zMatch && currentLayer) {
                    currentLayer.z = parseFloat(zMatch[1]);
                }
                continue;
            }

            // Parse G-code command
            // Handle G0, G1, G2, G3
            const cmdMatch = line.match(/^(G[0-3])\s/i);
            if (!cmdMatch) continue;
            const cmd = cmdMatch[1];

            // Extract parameters
            const xMatch = line.match(/\bX([\d.-]+)\b/i);
            const yMatch = line.match(/\bY([\d.-]+)\b/i);
            const zMatchCmd = line.match(/\bZ([\d.-]+)\b/i);
            const eMatch = line.match(/\bE([\d.-]+)\b/i);
            const iMatch = line.match(/\bI([\d.-]+)\b/i);
            const jMatch = line.match(/\bJ([\d.-]+)\b/i);

            const x = xMatch ? parseFloat(xMatch[1]) : null;
            const y = yMatch ? parseFloat(yMatch[1]) : null;
            const z = zMatchCmd ? parseFloat(zMatchCmd[1]) : null;
            const e = eMatch ? parseFloat(eMatch[1]) : null;

            if (z !== null) lastZ = z;

            // Determine if this is an extrusion move
            let isExtrude = false;
            if (e !== null) {
                // With relative extrusion (M83), any E > 0.0001 means extrusion
                if (e > 0.0001) isExtrude = true;
                lastE = e;
            }

            if (x !== null && y !== null) {
                // Handle travel vs extrusion segment transition
                // If moving XY without positive extrusion → switch to travel
                if (!isExtrude && currentSegType !== 'travel') {
                    _startNewSegment('travel');
                    // add current point for continuity
                    currentSegPoints.push({ x, y, z: lastZ });
                }

                if (currentSegPoints.length === 0) {
                    currentSegPoints.push({ x, y, z: lastZ });
                }

                // Handle G2/G3 arc approximation with line segments
                // Must do this BEFORE updating lastX/lastY, since I,J are relative to start point
                if ((cmd === 'G2' || cmd === 'G3') && iMatch && jMatch) {
                    const cx = (lastX || 0) + parseFloat(iMatch[1]);
                    const cy = (lastY || 0) + parseFloat(jMatch[1]);
                    const rad = Math.sqrt(iMatch[1] ** 2 + jMatch[1] ** 2);
                    if (rad > 0.01) {
                        const startAngle = Math.atan2((lastY || 0) - cy, (lastX || 0) - cx);
                        const endAngle = Math.atan2(y - cy, x - cx);
                        const arcSegments = 16;
                        const ccw = cmd === 'G3';
                        for (let s = 1; s < arcSegments; s++) {
                            const t = s / arcSegments;
                            let angle = startAngle + (endAngle - startAngle) * t;
                            if (ccw && endAngle <= startAngle) angle = startAngle + (endAngle + 2 * Math.PI - startAngle) * t;
                            if (!ccw && endAngle > startAngle) angle = startAngle + (endAngle - 2 * Math.PI - startAngle) * t;
                            const ax = cx + rad * Math.cos(angle);
                            const ay = cy + rad * Math.sin(angle);
                            currentSegPoints.push({ x: ax, y: ay, z: lastZ });
                        }
                    }
                }

                currentSegPoints.push({ x, y, z: lastZ });
                lastX = x;
                lastY = y;
            }
        }

        _flushSegment();
        const totalSegments = layers.reduce((sum, l) => sum + l.segments.length, 0);
        console.log('[GCodeDrop] _parseGcodeToolpath returning layers:', layers.length, 'total segments:', totalSegments);
        return layers;
    }

    _getToolpathColor(type) {
        const colors = {
            inner_wall: 0x4a9eff,
            outer_wall: 0xff6b6b,
            infill: 0x51cf66,
            solid: 0xffd43b,
            support: 0xcc9eff,
            travel: 0x666666,
        };
        return colors[type] || 0x666666;
    }

    /** 销毁 3D 轨迹预览，释放 WebGL 资源 */
    _disposeGcode3DView() {
        // 取消动画循环
        if (this._gcode3DAnimId) {
            cancelAnimationFrame(this._gcode3DAnimId);
            this._gcode3DAnimId = null;
        }

        // 清理 OrbitControls
        if (this._gcode3DControls) {
            this._gcode3DControls.dispose();
            this._gcode3DControls = null;
        }

        // 清理 scene 中的物体
        if (this._gcode3DGroup) {
            this._gcode3DGroup.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            });
            if (this._gcode3DScene) {
                this._gcode3DScene.remove(this._gcode3DGroup);
            }
            this._gcode3DGroup = null;
            this._gcode3DLayerGroups = [];
        }

        // 移除 canvas
        if (this._gcode3DRenderer) {
            const container = document.getElementById('gcode-3d-container');
            if (container) {
                const canvas = container.querySelector('canvas');
                if (canvas) canvas.remove();
            }
            this._gcode3DRenderer.dispose();
            this._gcode3DRenderer = null;
        }

        this._gcode3DScene = null;
        this._gcode3DCamera = null;
        this._gcode3DGrid = null;
        this._gcode3DAxes = null;
        this._gcode3DBedOutline = null;
        this._gcode3DResizeHandler = null;
    }

    _setupGcode3DView() {
        const container = document.getElementById('gcode-3d-container');
        console.log('[GCodeDrop] _setupGcode3DView, container exists:', !!container);
        if (!container) {
            console.error('[GCodeDrop] _setupGcode3DView: container not found');
            return;
        }

        // Cancel previous animation loop
        if (this._gcode3DAnimId) {
            cancelAnimationFrame(this._gcode3DAnimId);
            this._gcode3DAnimId = null;
            console.log('[GCodeDrop] cancelled old animation frame');
        }

        // Dispose previous if exists
        if (this._gcode3DRenderer) {
            console.log('[GCodeDrop] disposing old renderer');
            this._gcode3DRenderer.dispose();
            const oldCanvas = container.querySelector('canvas');
            if (oldCanvas) {
                oldCanvas.remove();
                console.log('[GCodeDrop] removed old canvas');
            }
        }

        // Reset grid/axes/bed references so they get recreated for the new scene
        this._gcode3DGrid = null;
        this._gcode3DAxes = null;
        this._gcode3DBedOutline = null;

        const rect = container.getBoundingClientRect();
        const width = rect.width || 400;
        const height = rect.height || 300;
        console.log('[GCodeDrop] container size:', width, 'x', height);
        if (width <= 0 || height <= 0) {
            console.warn('[GCodeDrop] container has zero size, using fallback 400x300');
        }

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x111111);

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
        // 与主视口一致：Z 向上，XY 为床面。OrbitControls 的绕轴依赖 camera.up，
        // 若保持默认 Y-up，旋转轴和地平面都会与主窗口不一致，这就是前辈禁旋转的根因
        camera.up.set(0, 0, 1);

        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true });
            console.log('[GCodeDrop] WebGLRenderer created successfully');
        } catch (e) {
            console.error('[GCodeDrop] WebGLRenderer creation failed:', e);
            return;
        }
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.insertBefore(renderer.domElement, container.firstChild);
        console.log('[GCodeDrop] canvas inserted, size:', width, 'x', height, 'canvas element:', !!renderer.domElement);

        // Lighting
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambient);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
        dirLight.position.set(200, 200, 300);
        scene.add(dirLight);

        this._gcode3DScene = scene;
        this._gcode3DCamera = camera;
        this._gcode3DRenderer = renderer;
        this._gcode3DGroup = new THREE.Group();
        this._gcode3DLayerGroups = [];
        scene.add(this._gcode3DGroup);

        // OrbitControls for rotate/zoom/pan — 与主视口保持一致：左键旋转 / 中键平移 / 滚轮缩放
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.enableRotate = true;
        controls.enableZoom = true;
        controls.enablePan = true;
        controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: null
        };
        this._gcode3DControls = controls;

        // Animate the 3D view
        const animate = () => {
            if (!this._gcode3DRenderer) return;
            this._gcode3DAnimId = requestAnimationFrame(animate);
            if (this._gcode3DControls) this._gcode3DControls.update();
            this._gcode3DRenderer.render(this._gcode3DScene, this._gcode3DCamera);
        };
        animate();

        // Handle resize
        const onResize = () => {
            if (!this._gcode3DRenderer || !this._gcode3DCamera) return;
            const r = container.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                this._gcode3DCamera.aspect = r.width / r.height;
                this._gcode3DCamera.updateProjectionMatrix();
                this._gcode3DRenderer.setSize(r.width, r.height);
                // Update LineMaterial resolution for all Line2 objects
                if (this._gcode3DGroup) {
                    this._gcode3DGroup.traverse((obj) => {
                        if (obj.isLine2 && obj.material && obj.material.resolution) {
                            obj.material.resolution.set(r.width, r.height);
                        }
                    });
                }
            }
        };
        window.addEventListener('resize', onResize);
        this._gcode3DResizeHandler = onResize;
    }

    async _renderToolpath3D() {
        console.log('[GCodeDrop] _renderToolpath3D called');
        const scene = this._gcode3DScene;
        const group = this._gcode3DGroup;
        const renderer = this._gcode3DRenderer;
        console.log('[GCodeDrop] _renderToolpath3D scene/group/renderer exists:', !!scene, !!group, !!renderer);
        if (!scene || !group || !renderer) {
            console.error('[GCodeDrop] _renderToolpath3D: missing scene/group/renderer');
            return;
        }

        // Clear previous
        console.log('[GCodeDrop] clearing previous geometry, group children:', group.children.length);
        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
            group.remove(child);
        }
        this._gcode3DLayerGroups = [];

        // 通过 Python API 解析工具路径（避免 JS 主线程阻塞）
        let layers;
        try {
            const result = await window.pywebview.api.parse_gcode_toolpath();
            if (!result || !result.success) {
                console.log('[GCodeDrop] parse_gcode_toolpath failed or no gcode loaded');
                return;
            }
            layers = result.layers;
        } catch (e) {
            console.error('[GCodeDrop] parse_gcode_toolpath exception:', e);
            return;
        }
        console.log('[GCodeDrop] parsed layers count:', layers.length);
        if (layers.length === 0) {
            console.warn('[GCodeDrop] no layers found in gcode');
            return;
        }

        // Log first few layer segment types for debugging
        const firstLayerTypes = layers[0]?.segments?.slice(0, 5).map(s => s.type) || [];
        console.log('[GCodeDrop] first layer segment types:', firstLayerTypes);

        // Compute bounds for camera auto-fit
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        let totalSegments = 0;
        let totalPoints = 0;

        try {
            for (let li = 0; li < layers.length; li++) {
                const layer = layers[li];
                const layerGroup = new THREE.Group();
                for (const seg of layer.segments) {
                    if (seg.points.length < 2) continue;
                    totalSegments++;
                    totalPoints += seg.points.length;

                    // Python 返回 [[x,y,z], [x,y,z], ...] 格式
                    for (const p of seg.points) {
                        if (p[0] < minX) minX = p[0];
                        if (p[0] > maxX) maxX = p[0];
                        if (p[1] < minY) minY = p[1];
                        if (p[1] > maxY) maxY = p[1];
                        if (p[2] < minZ) minZ = p[2];
                        if (p[2] > maxZ) maxZ = p[2];
                    }

                    const positions = [];
                    for (const p of seg.points) {
                        positions.push(p[0], p[1], p[2]);
                    }

                    const geometry = new LineGeometry();
                    geometry.setPositions(positions);

                    const isTravel = seg.type === 'travel';
                    const material = new LineMaterial({
                        color: 0xffffff,
                        linewidth: isTravel ? 2 : 6,
                        transparent: true,
                        opacity: isTravel ? 0.04 : 0.22,
                        depthWrite: false,
                    });
                    if (this._gcode3DRenderer) {
                        const canvas = this._gcode3DRenderer.domElement;
                        material.resolution.set(canvas.width, canvas.height);
                    }

                    const line = new Line2(geometry, material);
                    layerGroup.add(line);
                }
                group.add(layerGroup);
                this._gcode3DLayerGroups.push(layerGroup);
            }
        } catch (e) {
            console.error('[GCodeDrop] _renderToolpath3D geometry creation exception:', e);
            return;
        }

        console.log('[GCodeDrop] total segments:', totalSegments, 'total points:', totalPoints);
        console.log('[GCodeDrop] bounds:', { minX, maxX, minY, maxY, minZ, maxZ });

        // Auto-fit camera using bounding sphere
        if (minX !== Infinity && maxX !== Infinity) {
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const cz = (minZ + maxZ) / 2;
            const bx = (maxX - minX) / 2;
            const by = (maxY - minY) / 2;
            const bz = (maxZ - minZ) / 2;
            const radius = Math.sqrt(bx * bx + by * by + bz * bz);
            const fov = this._gcode3DCamera.fov * (Math.PI / 180);
            const dist = Math.max(radius / Math.sin(fov / 2), 10);

            this._gcode3DCamera.position.set(cx, cy - dist, cz + dist);
            this._gcode3DCamera.lookAt(cx, cy, cz);
            if (this._gcode3DControls) {
                this._gcode3DControls.target.set(cx, cy, cz);
                this._gcode3DControls.update();
            }
            console.log('[GCodeDrop] camera positioned at:', this._gcode3DCamera.position.x, this._gcode3DCamera.position.y, this._gcode3DCamera.position.z, 'looking at:', cx, cy, cz);

            // Add grid and axes only when we have GCode to show
            // Large grid centered at origin, extending heavily in all directions
            if (!this._gcode3DGrid) {
                const gridSize = 5000;
                const gridDivisions = 500;
                const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0x444444, 0x333333);
                gridHelper.rotation.x = Math.PI / 2;
                scene.add(gridHelper);
                this._gcode3DGrid = gridHelper;

                const axesHelper = new THREE.AxesHelper(30);
                scene.add(axesHelper);
                this._gcode3DAxes = axesHelper;
            }

            // 不再添加床面方框轮廓（bed outline），仅保留网格和坐标轴
        }

        // Apply current slider
        setTimeout(() => this._updateGcode3DLayers(), 50);
    }

    _updateGcode3DLayers() {
        // 节流：400ms 内不重复更新，避免滑块拖动时 GCode 预览频繁刷新导致卡顿
        const now = performance.now();
        if (this._lastGcode3DUpdateTime && (now - this._lastGcode3DUpdateTime) < 400) {
            if (!this._gcode3DUpdatePending) {
                this._gcode3DUpdatePending = true;
                setTimeout(() => {
                    this._gcode3DUpdatePending = false;
                    this._lastGcode3DUpdateTime = null;
                    this._updateGcode3DLayers();
                }, 400 - (now - this._lastGcode3DUpdateTime));
            }
            return;
        }
        this._lastGcode3DUpdateTime = now;

        const layerGroups = this._gcode3DLayerGroups;
        if (!layerGroups || layerGroups.length === 0) {
            console.log('[GCodeDrop] _updateGcode3DLayers: no layer groups');
            return;
        }

        const slider = document.getElementById('layer-slider');
        const pct = slider ? parseFloat(slider.value) : 100;
        const total = layerGroups.length;
        const showCount = Math.max(1, Math.round(total * pct / 100));
        console.log('[GCodeDrop] _updateGcode3DLayers total:', total, 'showCount:', showCount, 'slider pct:', pct);

        layerGroups.forEach((lg, idx) => {
            lg.visible = idx < showCount;
        });
    }

    async displayGcode(gcode) {
        console.log('[GCodeDrop] displayGcode called, gcode length:', gcode?.length);
        this._lastGcode = gcode;
        // 重新渲染 3D 轨迹视图
        if (this._gcode3DRenderer) {
            console.log('[GCodeDrop] renderer exists, calling _renderToolpath3D');
            try {
                await this._renderToolpath3D();
            } catch (e) {
                console.error('[GCodeDrop] _renderToolpath3D error:', e);
            }
        } else {
            console.log('[GCodeDrop] renderer not exists, skip render');
        }
    }

    displaySliceImages(meta) {
        // 懒加载模式：存储元数据 + 缓存，按需从后端加载单张图片
        // meta: { count, output_dir, files: [filenames], focus_rect }
        // 清理旧缓存和 DOM（释放内存）
        this._previewImagesCache = null;
        this._sliceImagesCache = {};
        this._sliceFullImagesCache = {};
        this._sliceImages = null;
        this._sliceImagesCount = 0;
        this._sliceFocusRect = (meta && meta.focus_rect
            && meta.focus_rect.x != null && meta.focus_rect.w > 0)
            ? meta.focus_rect : null;
        this._sliceFocusApplied = false;
        // 清理容器内的旧 img 元素，释放 base64 data URL 引用
        const container = document.getElementById('slice-images-container');
        if (container) container.innerHTML = '';

        this._sliceImages = meta && meta.files ? meta.files : [];
        this._sliceImagesCount = (meta && meta.count) || 0;
        this._sliceZoomState = { scale: 1, panX: 0, panY: 0 };
        if (this._sliceFullLoadDebounce) { clearTimeout(this._sliceFullLoadDebounce); this._sliceFullLoadDebounce = null; }
        if (this._sliceImagesCount === 0) {
            this._showSliceImage(0);
            return;
        }
        
        // 先同步加载首张缩略图，再渲染（消除"加载中"闪烁）
        const loadFirstThenPreload = async () => {
            try {
                const result = await window.pywebview.api.texture_slice_load_single_image(0);
                if (result && result.success && result.image) {
                    this._sliceImagesCache[0] = result.image;
                }
            } catch (e) {
                console.error('[displaySliceImages] 首张加载失败:', e);
            }
            // 渲染首张（此时缓存已命中，秒出）
            this._showSliceImage(0);
            // 全部缩略图都要预加载（不论层数），保证翻层/缩放时立即可用，无需再逐张懒加载
            this._preloadAllThumbnails(this._sliceImagesCount);
        };
        loadFirstThenPreload();
    }

    async _preloadAllThumbnails(count) {
        // 批量并发预加载所有缩略图到 _sliceImagesCache（全部层都预加载，翻层/缩放立即可用）。
        const CONC = 8;  // 同时并发请求数，兼顾速度与后端压力
        for (let start = 0; start < count; start += CONC) {
            const batch = [];
            for (let i = start; i < Math.min(start + CONC, count); i++) {
                if (this._sliceImagesCache[i]) continue;
                batch.push((async () => {
                    try {
                        const result = await window.pywebview.api.texture_slice_load_single_image(i);
                        if (result && result.success && result.image) {
                            this._sliceImagesCache[i] = result.image;
                        }
                    } catch (e) {
                        console.error('[PreloadThumb] 预加载失败:', i, e);
                    }
                })());
            }
            await Promise.all(batch);
            // 每批后让出主线程，避免长时间阻塞 UI
            await new Promise(r => setTimeout(r, 0));
        }
        const loaded = Object.keys(this._sliceImagesCache).length;
        console.log(`[PreloadThumb] 预加载完成: ${loaded}/${count}`);
    }

    _showSliceImage(index) {
        if (this._previewImagesCache) {
            this._loadAndShowPreviewImage(index);
            return;
        }

        const container = document.getElementById('slice-images-container');
        if (!container) return;

        const images = this._sliceImages || [];
        if (images.length === 0) {
            container.innerHTML = '<div class="slice-images-empty">暂无切片图片数据。</div>';
            return;
        }

        const i = Math.max(0, Math.min(index, images.length - 1));
        this._currentSliceImageIndex = i;

        const cached = this._sliceImagesCache[i];
        if (cached) {
            this._renderSliceImageToContainer(container, i, cached);
        } else {
            container.innerHTML = `<div class="slice-image-item">
                <div class="slice-image-label">切片层 ${i + 1}</div>
                <div class="slice-image-zoom-wrapper">
                    <div class="slice-image-placeholder">加载中...</div>
                </div>
            </div>`;
            const reqId = ++this._sliceLoadRequestId;
            this._loadAndCacheSliceImage(i).then(imgData => {
                if (imgData && this._sliceLoadRequestId === reqId) {
                    this._renderSliceImageToContainer(container, i, imgData);
                }
            });
        }
    }

    async _loadAndCacheSliceImage(index) {
        try {
            const result = await window.pywebview.api.texture_slice_load_single_image(index);
            if (result && result.success && result.image) {
                this._sliceImagesCache[index] = result.image;
                return result.image;
            }
        } catch (e) {
            console.error('[SliceImage] 加载失败:', index, e);
        }
        return null;
    }

    // 缩放停稳 60ms 后换完整原图：直接替换 src，并立即"重放"一次当前的 scale/pan，
    // 强制这一帧按原图渲染且过渡关闭 -> 视觉不变但变清晰。
    // 加载完整原图并替换到 img 元素（内联在缩放 60ms 流程里，不脱离缩放状态机）。
    // 直接使用绑定的 img 引用；拿到源后立即替换 src 并保持当前 scale/pan，视觉不变只变清晰。
    async _loadFullApplied(imgEl, index, scale, panX, panY) {
        if (!window.pywebview || !window.pywebview.api || !imgEl) return;
        if (!document.body.contains(imgEl)) return;
        // 缓存命中直接换
        const cached = (this._sliceFullImagesCache && this._sliceFullImagesCache[index]) || null;
        if (cached) {
            this._applyFullSrc(imgEl, cached, scale, panX, panY);
            return;
        }
        let fullUrl = null;
        try {
            const result = await window.pywebview.api.texture_slice_load_full_image(index);
            if (!result || !result.success) return;
            // 后端已用 PIL 重压缩成小体积 base64 data URL：bridge 传输稳定、
            // 同源无跨源问题，图片不会因跨源加载失败而消失。
            fullUrl = result.image || null;
            if (!fullUrl) return;
        } catch (e) {
            console.error('[FullImage] 原图加载请求失败:', index, e);
            return;
        }
        if (!document.body.contains(imgEl)) return;
        if (!this._sliceFullImagesCache) this._sliceFullImagesCache = {};
        this._sliceFullImagesCache[index] = fullUrl;
        this._applyFullSrc(imgEl, fullUrl, scale, panX, panY);
    }

    // 换 src：直接用当前 scale/pan，保证这一帧马上升级为原图（清晰）。不脱离缩放流程。
    _applyFullSrc(img, fullSrc, scale, panX, panY) {
        if (!img || img.src === fullSrc) return;
        img.src = fullSrc;
        img.style.transition = 'none';
        img.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
    }

    // 缩放指导：把后端返回的聚焦归一化矩形（模型包围盒+padding，相对整张预览图）铺满当前视口。
    // 用测量的 wrapper/img 盒算出 scale 与 pan，保证聚焦区正好充满预览窗口。
    // 返回 {scale, panX, panY}；无法测量时返回 null。
    _applyPreviewFocusToZoom(wrapper, img) {
        const rect = this._sliceFocusRect;
        if (!rect || rect.w <= 0 || rect.h <= 0) return null;
        try {
            const wRect = wrapper.getBoundingClientRect();
            const iRect = img.getBoundingClientRect();
            if (wRect.width < 2 || wRect.height < 2 || iRect.width < 2 || iRect.height < 2) return null;
            // 缩放：让 rect 至少在某一轴铺满视口，两轴取大保证整体填满
            const sx = wRect.width / (rect.w * iRect.width);
            const sy = wRect.height / (rect.h * iRect.height);
            const scale = Math.max(sx, sy);
            const clamped = Math.max(1, Math.min(10, scale));
            // 聚焦区中心 -> 视口中心
            const rcX = rect.x + rect.w / 2;
            const rcY = rect.y + rect.h / 2;
            const imgCenterX = iRect.left + iRect.width / 2;
            const imgCenterY = iRect.top + iRect.height / 2;
            const wrapCenterX = wRect.left + wRect.width / 2;
            const wrapCenterY = wRect.top + wRect.height / 2;
            // 未变换时 rect 中心在屏幕上的位置
            const pX = iRect.left + rcX * iRect.width;
            const pY = iRect.top + rcY * iRect.height;
            // 变换 scale(s) translate(t)，原点在图片中心：screen = center + (P + t - center)*s
            // 令 P -> 视口中心，解得 t = (wrapCenter - imgCenter)/s - (P - imgCenter)
            const panX = (wrapCenterX - imgCenterX) / clamped - (pX - imgCenterX);
            const panY = (wrapCenterY - imgCenterY) / clamped - (pY - imgCenterY);
            return { scale: clamped, panX, panY };
        } catch (e) {
            return null;
        }
    }

    _renderSliceImageToContainer(container, i, imgData) {
        container.innerHTML = '';

        const item = document.createElement('div');
        item.className = 'slice-image-item';

        const label = document.createElement('div');
        label.className = 'slice-image-label';
        label.textContent = `切片层 ${i + 1}`;

        // 缩放/平移包装层
        const zoomWrapper = document.createElement('div');
        zoomWrapper.className = 'slice-image-zoom-wrapper';

        const img = document.createElement('img');
        img.src = imgData;
        img.alt = `切片层 ${i + 1}`;
        img.draggable = false;

        zoomWrapper.appendChild(img);
        item.appendChild(label);
        item.appendChild(zoomWrapper);
        container.appendChild(item);

        // 绑定缩放/平移事件，传入索引以支持放大时加载原图
        this._setupImageZoom(zoomWrapper, img, i);
    }

    _setupImageZoom(wrapper, img, index) {
        if (this._currentZoomCleanup) {
            this._currentZoomCleanup();
            this._currentZoomCleanup = null;
        }

        if (!this._sliceZoomState) this._sliceZoomState = { scale: 1, panX: 0, panY: 0 };
        let scale = this._sliceZoomState.scale || 1;
        let panX = this._sliceZoomState.panX || 0;
        let panY = this._sliceZoomState.panY || 0;
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let lastPanX = 0;
        let lastPanY = 0;
        let fullResLoaded = false;
        const thumbnailSrc = img.src;

        const MIN_SCALE = 1;
        const MAX_SCALE = 10;
        const ZOOM_STEP = 0.15;

        const syncState = () => {
            this._sliceZoomState.scale = scale;
            this._sliceZoomState.panX = panX;
            this._sliceZoomState.panY = panY;
        };

        const applyTransform = () => {
            // 全程关闭过渡：缩放/平移/切图都要即时生效，保证视觉连续（不做任何动画）
            img.style.transition = 'none';
            img.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
        };

        if (scale > 1) {
            wrapper.style.cursor = 'grab';
            requestAnimationFrame(() => applyTransform());
        }

        // 放大即立即加载完整原图（缓存命中立即换，未命中请求一次并存缓存）。
        // 不等待、不防抖 —— 无论是滚轮缩放操作中还是停留在放大视口，只要 scale>1 就换清晰原图。
        const loadFullResIfNeeded = async () => {
            if (scale > 1) {
                // 正在做缩放操作也要立即加载原图放大到这个大小，不需要等待。
                this._loadFullApplied(img, index, scale, panX, panY).then(() => {
                    fullResLoaded = true;
                });
            } else if (scale <= 1 && fullResLoaded) {
                // 缩回 1 倍时恢复缩略图
                fullResLoaded = false;
                if (this._sliceFullLoadDebounce) { clearTimeout(this._sliceFullLoadDebounce); this._sliceFullLoadDebounce = null; }
                img.src = thumbnailSrc;
                requestAnimationFrame(() => applyTransform());
            }
        };

        // 缩放指导：首次显示且尚未应用聚焦时，让模型聚焦区铺满视口。
        // 待图片完成布局后再测量并应用，避免 rect 尚未就绪时量到 0。
        // 聚焦即放大（scale>1），应用后进入 60ms 原图加载流程。
        // 用 try/catch 兜底：聚焦应用绝不因异常影响下方 wheel/mouse 的缩放监听绑定。
        let focusRanHere = false;
        try {
            if (this._sliceFocusRect && !this._sliceFocusApplied) {
                focusRanHere = true;
                const waitForLayout = (attempt) => {
                    try {
                        const z = this._applyPreviewFocusToZoom(wrapper, img);
                        if (z) {
                            scale = z.scale;
                            panX = z.panX;
                            panY = z.panY;
                            syncState();
                            applyTransform();
                            this._sliceFocusApplied = true;
                            loadFullResIfNeeded();
                        } else if (attempt < 12) {
                            setTimeout(() => waitForLayout(attempt + 1), 80);
                        }
                    } catch (e) {
                        console.error('[Focus] 聚焦应用出错:', e);
                    }
                };
                waitForLayout(0);
            }
        } catch (e) {
            console.error('[Focus] 聚焦块异常:', e);
        }

        // 切层/首次显示新图且当前已放大：立即按当前放大倍数加载原图，不等 60ms。
        // 这是"保持放大视口切下一张"的需求 —— 上一张放大到 1.5x 后翻层，
        // 新缩略图一显示就让原图按 1.5x 放大到这个大小。
        // 仅当本轮没有聚焦块抢先处理（聚焦已在上面用 debounce 安排过原图）时执行。
        if (scale > 1 && !focusRanHere) {
            const loadFullNow = () => {
                this._loadFullApplied(img, index, scale, panX, panY).then(() => {
                    fullResLoaded = true;
                });
            };
            // 等图片完成布局（完整尺寸已知）再接，避免 height 未定时换 src 跳动
            if (img.complete && img.naturalWidth > 0) {
                loadFullNow();
            } else {
                img.addEventListener('load', loadFullNow, { once: true });
            }
        }

        wrapper.addEventListener('wheel', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
            const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale + delta));

            if (newScale !== scale && scale >= MIN_SCALE) {
                const rect = wrapper.getBoundingClientRect();
                const mx = e.clientX - rect.left - rect.width / 2;
                const my = e.clientY - rect.top - rect.height / 2;
                const ratio = newScale / scale;
                panX = mx * (1 - ratio) / newScale + panX * ratio;
                panY = my * (1 - ratio) / newScale + panY * ratio;
            }
            scale = newScale;

            if (scale <= MIN_SCALE) {
                scale = MIN_SCALE;
                panX = 0;
                panY = 0;
                wrapper.style.cursor = 'default';
                if (this._sliceFullLoadDebounce) { clearTimeout(this._sliceFullLoadDebounce); this._sliceFullLoadDebounce = null; }
            } else {
                wrapper.style.cursor = 'grab';
            }
            syncState();
            applyTransform();
            loadFullResIfNeeded();
        });
        wrapper.addEventListener('mousedown', (e) => {
            if (scale <= MIN_SCALE || e.button !== 0) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            lastPanX = panX;
            lastPanY = panY;
            wrapper.style.cursor = 'grabbing';
            img.style.transition = 'none';
            e.preventDefault();
        });

        const onMouseMove = (e) => {
            if (!isDragging) return;
            panX = lastPanX + (e.clientX - startX) / scale;
            panY = lastPanY + (e.clientY - startY) / scale;
            img.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
            syncState();
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            wrapper.style.cursor = scale > MIN_SCALE ? 'grab' : 'default';
            img.style.transition = 'none';
            syncState();
            loadFullResIfNeeded();
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        this._currentZoomCleanup = () => {
            if (this._sliceFullLoadDebounce) { clearTimeout(this._sliceFullLoadDebounce); this._sliceFullLoadDebounce = null; }
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }

    async _saveGcodeToProject(gcode) {
        if (!window.pywebview || !window.pywebview.api) return;
        try {
            const project = await this.exportProject();
            project.gcode = gcode;
            const result = await window.pywebview.api.save_gcode_to_project(JSON.stringify(project));
            if (result && result.success) {
                this.showToast('Gcode 已保存至项目', 'success');
            }
        } catch (e) {
            console.error('保存 Gcode 到项目异常:', e);
        }
    }

    // ========== 平面打印（多图片画布） ==========

    /* ============================================================
       平面打印 — 多图片画布，原生 8 点控制框 + 旋转手柄
       ============================================================ */

    _initFlatPage() {
        const canvas = document.getElementById('flat-canvas');
        if (!canvas) return;
        this._flatCanvasCtx = canvas.getContext('2d');
        this._setupFlatControls();
        this._setupFlatSizeInput();
        if (this._flatImages.length > 0) {
            this._showFlatCanvas();
            this._sizeFlatCanvas();
            this._renderFlatCanvas();
        }
    }

    _showFlatCanvas() {
        document.getElementById('flat-canvas-placeholder').style.display = 'none';
        document.getElementById('flat-canvas').style.display = '';
    }

    _setupFlatControls() {
        if (this._flatControlsBound) return;
        this._flatControlsBound = true;

        document.getElementById('flat-upload-btn')?.addEventListener('click', () => {
            document.getElementById('flat-image-input')?.click();
        });
        document.getElementById('flat-image-input')?.addEventListener('change', (e) => {
            this._addFlatImage(e);
        });
        document.getElementById('flat-del-btn')?.addEventListener('click', () => {
            this._removeActiveFlatImage();
        });
        document.getElementById('flat-grid-btn')?.addEventListener('click', () => {
            this._flatGridOn = !this._flatGridOn;
            const btn = document.getElementById('flat-grid-btn');
            if (btn) btn.classList.toggle('active', this._flatGridOn);
            this._renderFlatCanvas();
        });
        document.getElementById('btn-flat-slice')?.addEventListener('click', () => {
            this._runFlatPrint();
        });

        // canvas 鼠标事件
        const canvas = document.getElementById('flat-canvas');
        if (canvas) {
            canvas.addEventListener('mousedown', (e) => this._flatMouseDown(e));
            window.addEventListener('mousemove', (e) => this._flatMouseMove(e));
            window.addEventListener('mouseup', () => this._flatMouseUp());
        }
    }

    _sizeFlatCanvas() {
        const area = document.querySelector('.flat-canvas-area');
        if (!area) return;
        const canvas = document.getElementById('flat-canvas');
        if (!canvas) return;
        // 实际分辨率取用户设定的 textureResolution（默认 4000），保证打印清晰度
        const res = this.textureResolution || 4000;
        canvas.width = res;
        canvas.height = res;
        // CSS 显示尺寸适配 UI 容器
        const displaySize = Math.min(area.clientWidth - 32, area.clientHeight - 32);
        canvas.style.width = displaySize + 'px';
        canvas.style.height = displaySize + 'px';
    }

    /* ---- 坐标转换 ---- */

    _flatMouseToCanvas(e) {
        const canvas = document.getElementById('flat-canvas');
        const rect = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (canvas.width / rect.width),
            y: (e.clientY - rect.top) * (canvas.height / rect.height)
        };
    }

    /* ---- 图片增删 ---- */

    _addFlatImage(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                this._showFlatCanvas();
                this._sizeFlatCanvas();
                const canvas = document.getElementById('flat-canvas');
                const size = canvas ? canvas.width : 540;
                const fit = Math.max(size / img.width, size / img.height);
                const initW = img.width * fit * 0.30;
                const initH = img.height * fit * 0.30;
                this._flatImages.push({
                    img, x: size / 2, y: size / 2,
                    w: initW, h: initH, rot: 0
                });
                this._flatActiveIdx = this._flatImages.length - 1;
                this._renderFlatCanvas();
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    }

    _removeActiveFlatImage() {
        if (this._flatActiveIdx < 0) return;
        this._flatImages.splice(this._flatActiveIdx, 1);
        this._flatActiveIdx = this._flatImages.length > 0 ? 0 : -1;
        if (this._flatImages.length === 0) {
            document.getElementById('flat-canvas-placeholder').style.display = '';
            document.getElementById('flat-canvas').style.display = 'none';
        }
        document.getElementById('flat-del-btn').classList.toggle('hidden', this._flatActiveIdx < 0);
        this._renderFlatCanvas();
    }

    /* ---- 命中检测 ---- */

    _flatHitTest(mx, my) {
        const canvas = document.getElementById('flat-canvas');
        const s = (canvas ? canvas.width : 4000) / 700;  // 控件尺寸缩放因子，基准 700px
        const HIT_R = 8 * s;          // 控制点半径
        const ROT_DIST = 28 * s;      // 旋转手柄离顶边距离
        const ROT_R = 9 * s;          // 旋转手柄半径

        // 从后往前查（上层优先）
        for (let i = this._flatImages.length - 1; i >= 0; i--) {
            const item = this._flatImages[i];
            const dx = mx - item.x;
            const dy = my - item.y;
            const cos = Math.cos(-item.rot * Math.PI / 180);
            const sin = Math.sin(-item.rot * Math.PI / 180);
            const lx = dx * cos - dy * sin;
            const ly = dx * sin + dy * cos;

            // 1) 旋转手柄
            const rdx = lx;
            const rdy = ly - (-item.h / 2 - ROT_DIST);
            if (Math.sqrt(rdx * rdx + rdy * rdy) <= ROT_R) {
                return { type: 'rotate', idx: i };
            }

            // 2) 8 个控制点
            const handles = [
                [-item.w / 2, -item.h / 2],
                [0, -item.h / 2],
                [item.w / 2, -item.h / 2],
                [item.w / 2, 0],
                [item.w / 2, item.h / 2],
                [0, item.h / 2],
                [-item.w / 2, item.h / 2],
                [-item.w / 2, 0]
            ];
            for (let h = 0; h < 8; h++) {
                if (this._flatSizeLocked && (h === 3 || h === 5)) continue;
                const hx = lx - handles[h][0];
                const hy = ly - handles[h][1];
                if (Math.sqrt(hx * hx + hy * hy) <= HIT_R) {
                    return { type: 'resize', idx: i, handle: h };
                }
            }

            // 3) 图片内部
            if (Math.abs(lx) <= item.w / 2 && Math.abs(ly) <= item.h / 2) {
                return { type: 'move', idx: i };
            }
        }
        return { type: 'none', idx: -1 };
    }

    /* ---- 鼠标事件 ---- */

    _flatMouseDown(e) {
        const pos = this._flatMouseToCanvas(e);
        const hit = this._flatHitTest(pos.x, pos.y);

        if (hit.type === 'none') {
            this._flatActiveIdx = -1;
            document.getElementById('flat-del-btn').classList.add('hidden');
            this._renderFlatCanvas();
            return;
        }

        this._flatActiveIdx = hit.idx;
        document.getElementById('flat-del-btn').classList.remove('hidden');

        const item = this._flatImages[hit.idx];
        const dx = pos.x - item.x;
        const dy = pos.y - item.y;
        const cos = Math.cos(-item.rot * Math.PI / 180);
        const sin = Math.sin(-item.rot * Math.PI / 180);
        this._flatDrag = {
            mode: hit.type,
            idx: hit.idx,
            startX: pos.x,
            startY: pos.y,
            startLocalX: dx * cos - dy * sin,
            startLocalY: dx * sin + dy * cos,
            startItem: { x: item.x, y: item.y, w: item.w, h: item.h, rot: item.rot },
            handle: hit.handle ?? -1
        };
        this._renderFlatCanvas();
    }

    _flatMouseMove(e) {
        if (!this._flatDrag || this._flatDrag.mode === 'none') return;
        const pos = this._flatMouseToCanvas(e);
        const d = this._flatDrag;
        const item = this._flatImages[d.idx];

        if (d.mode === 'move') {
            item.x = d.startItem.x + (pos.x - d.startX);
            item.y = d.startItem.y + (pos.y - d.startY);
            // 网格吸附：开启网格参考时，左上角吸附到最近的 10mm 网格点
            if (this._flatGridOn) {
                const canvas = document.getElementById('flat-canvas');
                const cellPx = canvas.width / 27;  // 270mm / 10mm = 27 cells
                const tlX = item.x - item.w / 2;
                const tlY = item.y - item.h / 2;
                const snapTLX = Math.round(tlX / cellPx) * cellPx;
                const snapTLY = Math.round(tlY / cellPx) * cellPx;
                item.x = snapTLX + item.w / 2;
                item.y = snapTLY + item.h / 2;
            }
        } else if (d.mode === 'rotate') {
            const dx = pos.x - item.x;
            const dy = pos.y - item.y;
            let angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
            item.rot = angle;
        } else if (d.mode === 'resize') {
            const dx = pos.x - item.x;
            const dy = pos.y - item.y;
            const cos = Math.cos(-item.rot * Math.PI / 180);
            const sin = Math.sin(-item.rot * Math.PI / 180);
            const lx = dx * cos - dy * sin;
            const ly = dx * sin + dy * cos;
            const deltaLx = lx - d.startLocalX;
            const deltaLy = ly - d.startLocalY;
            const h = d.handle;
            const si = d.startItem;

            if (h === 0 || h === 2 || h === 4 || h === 6) {
                let sx, sy;
                if (h === 0) { sx = (si.w / 2 - deltaLx) / (si.w / 2); sy = (si.h / 2 - deltaLy) / (si.h / 2); }
                else if (h === 2) { sx = (si.w / 2 + deltaLx) / (si.w / 2); sy = (si.h / 2 - deltaLy) / (si.h / 2); }
                else if (h === 4) { sx = (si.w / 2 + deltaLx) / (si.w / 2); sy = (si.h / 2 + deltaLy) / (si.h / 2); }
                else { sx = (si.w / 2 - deltaLx) / (si.w / 2); sy = (si.h / 2 + deltaLy) / (si.h / 2); }
                const scale = Math.max(sx, sy, 0.05);
                item.w = si.w * scale;
                item.h = si.h * scale;
            } else {
                let newW = si.w, newH = si.h;
                if (h === 7) newW = si.w - deltaLx * 2;
                if (h === 3) newW = si.w + deltaLx * 2;
                if (h === 1) newH = si.h - deltaLy * 2;
                if (h === 5) newH = si.h + deltaLy * 2;
                if (newW > 10) item.w = newW;
                if (newH > 10) item.h = newH;
            }
        }

        this._renderFlatCanvas();
    }

    _flatMouseUp() {
        this._flatDrag = null;
    }

    /* ---- 渲染 ---- */

    _renderFlatCanvas() {
        const canvas = document.getElementById('flat-canvas');
        const ctx = this._flatCanvasCtx;
        if (!canvas || !ctx) return;
        const size = canvas.width;
        ctx.clearRect(0, 0, size, size);

        // 网格（纯视觉辅助，不导出）
        if (this._flatGridOn && !this._flatSuppressGrid) {
            const BED_MM = 270;
            const CELL_MM = 10;
            const cellCount = BED_MM / CELL_MM;  // 27
            const cellPx = size / cellCount;
            ctx.strokeStyle = 'rgba(74, 158, 255, 0.30)';
            ctx.lineWidth = Math.max(1, size / 1000);
            ctx.beginPath();
            for (let i = 1; i < cellCount; i++) {
                const pos = i * cellPx;
                ctx.moveTo(pos, 0);
                ctx.lineTo(pos, size);
                ctx.moveTo(0, pos);
                ctx.lineTo(size, pos);
            }
            ctx.stroke();
        }

        for (let i = 0; i < this._flatImages.length; i++) {
            const item = this._flatImages[i];
            ctx.save();
            ctx.translate(item.x, item.y);
            ctx.rotate(item.rot * Math.PI / 180);
            ctx.drawImage(item.img, -item.w / 2, -item.h / 2, item.w, item.h);
            ctx.restore();
        }

        // 绘制选中框
        if (this._flatActiveIdx >= 0) {
            this._drawFlatSelection(ctx, this._flatImages[this._flatActiveIdx]);
        }

        // 更新尺寸输入卡片
        this._updateFlatSizeCard();
    }

    _drawFlatSelection(ctx, item) {
        const canvas = document.getElementById('flat-canvas');
        const s = (canvas ? canvas.width : 4000) / 700;  // 控件尺寸缩放因子
        const ROT_DIST = 28 * s;
        const H_R = 5 * s;      // 控制点半径
        const ROT_R = 7 * s;    // 旋转手柄半径
        const LW = 1.5 * s;     // 线宽
        const dashLen = 5 * s;
        const dashGap = 3 * s;

        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.rotate(item.rot * Math.PI / 180);

        // 虚线边框
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = LW;
        ctx.setLineDash([dashLen, dashGap]);
        ctx.strokeRect(-item.w / 2, -item.h / 2, item.w, item.h);
        ctx.setLineDash([]);

        // 8 个控制点（3=右中、5=下中 为红色，锁定长宽比时隐藏红色控件）
        const pts = [
            [-item.w / 2, -item.h / 2], [0, -item.h / 2], [item.w / 2, -item.h / 2],
            [item.w / 2, 0], [item.w / 2, item.h / 2], [0, item.h / 2],
            [-item.w / 2, item.h / 2], [-item.w / 2, 0]
        ];
        for (let hi = 0; hi < pts.length; hi++) {
            const isRed = (hi === 3 || hi === 5);
            if (this._flatSizeLocked && isRed) continue;
            const p = pts[hi];
            ctx.beginPath();
            ctx.arc(p[0], p[1], H_R, 0, Math.PI * 2);
            ctx.fillStyle = isRed ? '#ff4444' : '#fff';
            ctx.fill();
            ctx.strokeStyle = isRed ? '#cc0000' : '#4a9eff';
            ctx.lineWidth = LW;
            ctx.stroke();
        }

        // 旋转手柄连接线
        ctx.beginPath();
        ctx.moveTo(0, -item.h / 2);
        ctx.lineTo(0, -item.h / 2 - ROT_DIST + ROT_R);
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 1 * s;
        ctx.stroke();

        // 旋转手柄圆点
        ctx.beginPath();
        ctx.arc(0, -item.h / 2 - ROT_DIST, ROT_R, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd700';
        ctx.fill();
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();
    }

    // ---- 尺寸输入卡片 ----

    _updateFlatSizeCard() {
        const card = document.getElementById('flat-size-card');
        const inputW = document.getElementById('flat-size-w');
        const inputH = document.getElementById('flat-size-h');
        const lockBtn = document.getElementById('flat-size-lock');
        const canvas = document.getElementById('flat-canvas');
        const wrap = document.getElementById('flat-canvas-wrap');
        if (!card || !inputW || !canvas || !wrap) return;

        if (this._flatActiveIdx < 0) {
            card.classList.remove('visible');
            return;
        }

        const item = this._flatImages[this._flatActiveIdx];
        const mmW = Math.round(item.w / canvas.width * 270 * 10) / 10;
        const mmH = Math.round(item.h / canvas.height * 270 * 10) / 10;
        const locked = this._flatSizeLocked;

        // 不在输入中时不刷新值
        if (document.activeElement !== inputW) {
            inputW.value = mmW;
        }
        if (inputH && document.activeElement !== inputH) {
            inputH.value = mmH;
        }

        // 锁定状态切换显示
        if (lockBtn) {
            lockBtn.classList.toggle('unlocked', !locked);
            lockBtn.title = locked ? '解除长宽比锁定' : '锁定长宽比';
            if (locked) {
                lockBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>';
            } else {
                lockBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h2c0-1.66 1.34-3 3-3s3 1.34 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>';
            }
        }

        // XY 位置同步：左上角像素 → 左下角原点 mm
        const inputX = document.getElementById('flat-pos-x');
        const inputY = document.getElementById('flat-pos-y');
        const tlCx = item.x - item.w / 2;
        const tlCy = item.y - item.h / 2;
        const mmX = Math.round(tlCx / canvas.width * 270 * 10) / 10;
        const mmY = Math.round((canvas.height - tlCy) / canvas.height * 270 * 10) / 10;
        if (inputX && document.activeElement !== inputX) {
            inputX.value = mmX;
        }
        if (inputY && document.activeElement !== inputY) {
            inputY.value = mmY;
        }

        // 定位：image 中心 → CSS 坐标
        const cRect = canvas.getBoundingClientRect();
        const wRect = wrap.getBoundingClientRect();
        const displayW = cRect.width;
        const scale = displayW / canvas.width;
        const imgCX = (cRect.left - wRect.left) + item.x * scale;
        const imgCY = (cRect.top - wRect.top) + item.y * scale;
        card.style.left = imgCX + 'px';
        card.style.top  = imgCY + 'px';
        card.classList.add('visible');
    }

    _setupFlatSizeInput() {
        const inputW = document.getElementById('flat-size-w');
        if (!inputW || this._flatSizeInputBound) return;
        this._flatSizeInputBound = true;

        const lockBtn = document.getElementById('flat-size-lock');
        const inputH = document.getElementById('flat-size-h');

        // 锁定按钮切换
        if (lockBtn) {
            lockBtn.addEventListener('click', () => {
                this._flatSizeLocked = !this._flatSizeLocked;
                // 切换锁定时，将 H 值同步回当前比例值
                if (this._flatSizeLocked) {
                    const item = this._flatImages[this._flatActiveIdx];
                    if (item && inputW) {
                        const canvas = document.getElementById('flat-canvas');
                        const mmW = item.w / (canvas ? canvas.width : 4000) * 270;
                        inputW.value = Math.round(mmW * 10) / 10;
                    }
                }
                this._renderFlatCanvas();
            });
        }

        // W 输入框按键处理
        if (inputW) {
            inputW.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.target.blur();
                }
            });
            inputW.addEventListener('blur', () => {
                this._applyFlatSizeInput('w');
            });
        }

        // H 输入框按键处理
        if (inputH) {
            inputH.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.target.blur();
                }
            });
            inputH.addEventListener('blur', () => {
                this._applyFlatSizeInput('h');
            });
        }

        // X 位置输入框
        const inputX = document.getElementById('flat-pos-x');
        if (inputX) {
            inputX.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.target.blur();
                }
            });
            inputX.addEventListener('blur', () => {
                this._applyFlatPosInput('x');
            });
        }

        // Y 位置输入框
        const inputY = document.getElementById('flat-pos-y');
        if (inputY) {
            inputY.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.target.blur();
                }
            });
            inputY.addEventListener('blur', () => {
                this._applyFlatPosInput('y');
            });
        }
    }

    _applyFlatSizeInput(source) {
        const inputW = document.getElementById('flat-size-w');
        const inputH = document.getElementById('flat-size-h');
        const canvas = document.getElementById('flat-canvas');
        if (!inputW || !canvas) return;
        if (this._flatActiveIdx < 0) return;
        const item = this._flatImages[this._flatActiveIdx];

        if (this._flatSizeLocked) {
            // 锁定模式：修改 W 或 H 时按比例同步另一方
            const ratio = item.h / item.w;
            if (source === 'h' && inputH) {
                let mmH = parseFloat(inputH.value);
                if (isNaN(mmH) || mmH <= 0) {
                    mmH = item.h / canvas.height * 270;
                    inputH.value = Math.round(mmH * 10) / 10;
                    return;
                }
                const newH = mmH / 270 * canvas.height;
                item.h = newH;
                item.w = newH / ratio;
            } else {
                let mmW = parseFloat(inputW.value);
                if (isNaN(mmW) || mmW <= 0) {
                    mmW = item.w / canvas.width * 270;
                    inputW.value = Math.round(mmW * 10) / 10;
                    return;
                }
                const newW = mmW / 270 * canvas.width;
                item.w = newW;
                item.h = newW * ratio;
            }
        } else {
            // 解锁模式：W 和 H 独立修改
            if (source === 'w') {
                let mmW = parseFloat(inputW.value);
                if (isNaN(mmW) || mmW <= 0) {
                    mmW = item.w / canvas.width * 270;
                    inputW.value = Math.round(mmW * 10) / 10;
                    return;
                }
                item.w = mmW / 270 * canvas.width;
            } else if (source === 'h' && inputH) {
                let mmH = parseFloat(inputH.value);
                if (isNaN(mmH) || mmH <= 0) {
                    mmH = item.h / canvas.height * 270;
                    inputH.value = Math.round(mmH * 10) / 10;
                    return;
                }
                item.h = mmH / 270 * canvas.height;
            }
        }
        this._renderFlatCanvas();
    }

    _applyFlatPosInput(source) {
        const inputX = document.getElementById('flat-pos-x');
        const inputY = document.getElementById('flat-pos-y');
        const canvas = document.getElementById('flat-canvas');
        if (!canvas) return;
        if (this._flatActiveIdx < 0) return;
        const item = this._flatImages[this._flatActiveIdx];

        if (source === 'x' && inputX) {
            let mmX = parseFloat(inputX.value);
            if (isNaN(mmX) || mmX < 0) {
                const tlCx = item.x - item.w / 2;
                mmX = Math.round(tlCx / canvas.width * 270 * 10) / 10;
                inputX.value = mmX;
                return;
            }
            const tlCx = mmX / 270 * canvas.width;
            item.x = tlCx + item.w / 2;
        } else if (source === 'y' && inputY) {
            let mmY = parseFloat(inputY.value);
            if (isNaN(mmY) || mmY < 0) {
                const tlCy = item.y - item.h / 2;
                mmY = Math.round((canvas.height - tlCy) / canvas.height * 270 * 10) / 10;
                inputY.value = mmY;
                return;
            }
            const tlCy = canvas.height - (mmY / 270 * canvas.height);
            item.y = tlCy + item.h / 2;
        }
        this._renderFlatCanvas();
    }

    /* ---- 生成 & 上传 ---- */

    async _runFlatPrint() {
        if (this._flatImages.length === 0) {
            this.showToast('请先添加图片', 'info');
            return;
        }
        this._renderFlatCanvas();
        const canvas = document.getElementById('flat-canvas');
        if (!canvas) return;

        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }

        try {
            // 临时失焦点，避免控点进入导出的 PNG；同时关闭网格
            const savedActive = this._flatActiveIdx;
            this._flatActiveIdx = -1;
            this._flatSuppressGrid = true;
            this._renderFlatCanvas();
            const pngBase64 = canvas.toDataURL('image/png');
            this._flatActiveIdx = savedActive;
            this._flatSuppressGrid = false;
            this._renderFlatCanvas();
            const zHeight = parseFloat(document.getElementById('flat-z-height')?.value) || 0;

            // ---- 显示进度浮层 ----
            const progressEl = document.getElementById('flat-progress-overlay');
            const progressFill = document.getElementById('flat-progress-fill');
            const progressText = document.getElementById('flat-progress-text');
            let progressVal = 0;
            let progressTimer = null;
            let progressDone = false;

            if (progressEl) {
                progressEl.classList.remove('hidden');
                progressFill.style.width = '0%';
                progressText.textContent = '正在准备...';
                progressTimer = setInterval(() => {
                    if (progressDone) return;
                    progressVal += 6 + Math.floor(Math.random() * 11);
                    if (progressVal > 95) progressVal = 95;
                    progressFill.style.width = progressVal + '%';
                }, 1000);
            }

            // 第1步：预览
            const preview = await window.pywebview.api.planar_strip_preview(pngBase64);
            if (!preview || !preview.success) {
                if (progressTimer) clearInterval(progressTimer);
                if (progressEl) progressEl.classList.add('hidden');
                this.showToast('预览失败: ' + (preview?.error || '未知错误'), 'error');
                return;
            }
            if (preview.blocks === 0) {
                if (progressTimer) clearInterval(progressTimer);
                if (progressEl) progressEl.classList.add('hidden');
                this.showToast('画布无可打印内容', 'warning');
                return;
            }

            // 第2步：切片+上传+打印
            if (progressText) progressText.textContent =
                `正在条带切割并上传 (${preview.blocks} 块)...`;
            const result = await window.pywebview.api.planar_strip_slice(pngBase64, zHeight);

            // ---- 隐藏进度条 ----
            progressDone = true;
            if (progressTimer) clearInterval(progressTimer);
            if (progressEl) {
                progressFill.style.width = '100%';
                if (result && result.success) {
                    progressText.textContent = '打印已启动';
                } else {
                    progressText.textContent = '上传失败';
                }
                setTimeout(() => progressEl.classList.add('hidden'), 1200);
            }

            if (result && result.success) {
                const msg = result.printer_result?.message || '上传成功';
                this.showToast(msg, 'success');
            } else {
                this.showToast('上传失败: ' + (result?.error || result?.detail || '未知错误'), 'error');
            }
        } catch (e) {
            console.error('平面打印异常:', e);
            this.showToast('平面打印异常: ' + e.message, 'error');
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // 当 3D 容器不可见时（display:none），跳过渲染以节省 GPU 资源。
        // 在 NVIDIA 硬件上持续渲染不可见画布会触发驱动层面资源累积，导致逐步卡顿。
        if (this.container.offsetWidth === 0 || this.container.offsetHeight === 0) return;

        this.orbitControls.update();
        // 渲染前统一矫正Z轴，确保与渲染原子化，无任何时序间隙
        this.lockZAxis();
        this.renderer.render(this.scene, this.camera);
        this.updateCameraInfo();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.bp = new BedPreview();
    window._app = window.bp;
});
