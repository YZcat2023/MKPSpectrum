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
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

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

        this.models = new Map();
        this.groups = new Map();
        this.selectedGroups = new Set();
        this.selectedModels = new Set();
        this.nextModelId = 1;
        this.nextGroupId = 1;
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
        this._extractDir = null;

        this.calibrateStep = 0.1;
        this.calibrateOffset = { x: 0, y: 0 };

        this.orcaSlicerPath = '';
        this.snapmakerOrcaPath = '';
        this.gcodeSlicerType = 'orcaslicer';
        this.textureResolution = 4000;
        this._sliceRunning = false;
        this._testGcodePath = 'C:\\Users\\Administrator\\Desktop\\plane_PLA_5m42s.gcode';

        this.init();
        this.setupEventListeners();
        this.setupContextMenu();
        this.setupSettingsDialog();
        this.setupCloneDialog();
        this.setupPrinterSelect();
        this.setupPrinterDialog();
        this.renderer.domElement.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.animate();
        // 默认显示首页
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        setTimeout(() => {
            this.switchToHome();
        }, 50);
        // 自动检测外部工具路径（方法内部有重试机制等待 pywebview API 就绪）
        this._autoDetectExternalTools();
        // 从配置文件加载已保存的偏好设置（相机模式、网格配色等）
        this._loadAndApplySettings();
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
        this.transformControls.addEventListener('dragging-changed', (event) => {
            this.orbitControls.enabled = !event.value;
            this.isDraggingModel = event.value;
        });
        this.transformControls.addEventListener('change', () => {
            this.lockZAxis();
            this.updateTransformInputs();
        });
        this.transformControls.addEventListener('mouseDown', () => {
            this.saveState('变换模型');
        });
        this.transformControls.addEventListener('mouseUp', () => {
            this.justFinishedTransform = true;
            setTimeout(() => {
                this.justFinishedTransform = false;
            }, 100);

            // X/Y 轴旋转后烘焙变换，避免边界框漂移（组合体跳过）
            if (this.currentMode === 'rotate') {
                this.selectedModels.forEach(id => {
                    const model = this.models.get(id);
                    if (!model || !model.mesh || model._groupData) return;
                    const src = model._transformProxy || model.mesh;
                    if (Math.abs(src.rotation.x) > 0.001 || Math.abs(src.rotation.y) > 0.001) {
                        this.bakeTransform(model);
                    }
                });
            }
        });
        this.scene.add(this.transformControls);

        this.setupLights();
        this.createBed();
        this.createGrid();

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
            // 初始位置：从斜上方俯视热床，避免 Z-up 与视线平行导致万向锁
            const cx = this.bedSize.x / 2;
            const cy = this.bedSize.y / 2;
            this.camera.position.set(cx * 1.3, cy * 1.3, 400);
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
        if (this.bedMesh) {
            this.scene.remove(this.bedMesh);
        }
        if (this.bedEdges) {
            this.scene.remove(this.bedEdges);
        }

        const isLight = this.gridTheme === 'light';
        const isOrtho = this.camera && this.camera.isOrthographicCamera;

        const geometry = new THREE.BoxGeometry(this.bedSize.x, this.bedSize.y, 5);
        const material = new THREE.MeshStandardMaterial({
            color: isLight ? 0x333333 : 0x000000,
            metalness: isOrtho ? 0.1 : 0.3,
            roughness: isOrtho ? 0.8 : 0.65,
        });

        this.bedMesh = new THREE.Mesh(geometry, material);
        this.bedMesh.position.set(this.bedSize.x / 2, this.bedSize.y / 2, -2.5);
        this.bedMesh.receiveShadow = true;
        this.scene.add(this.bedMesh);

        const edgeGeometry = new THREE.EdgesGeometry(geometry);
        const edgeMaterial = new THREE.LineBasicMaterial({ color: isLight ? 0xaaaaaa : 0x555555 });
        const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
        edges.position.set(this.bedSize.x / 2, this.bedSize.y / 2, -2.5);
        this.scene.add(edges);
        this.bedEdges = edges;
    }

    createGrid() {
        if (this.gridHelper) {
            this.scene.remove(this.gridHelper);
        }
        if (!this.showGrid) return;

        const isLight = this.gridTheme === 'light';
        const gridColor = isLight ? 0x999999 : 0x444444;
        const borderColor = isLight ? 0x777777 : 0x666666;

        const divisionsX = Math.ceil(this.bedSize.x / this.gridSize);
        const divisionsY = Math.ceil(this.bedSize.y / this.gridSize);
        const gridGroup = new THREE.Group();

        for (let i = 0; i <= divisionsY; i++) {
            const y = (i / divisionsY) * this.bedSize.y;
            const points = [new THREE.Vector3(0, y, 0), new THREE.Vector3(this.bedSize.x, y, 0)];
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({ color: gridColor });
            gridGroup.add(new THREE.Line(geometry, material));
        }

        for (let i = 0; i <= divisionsX; i++) {
            const x = (i / divisionsX) * this.bedSize.x;
            const points = [new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, this.bedSize.y, 0)];
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({ color: gridColor });
            gridGroup.add(new THREE.Line(geometry, material));
        }

        const borderPoints = [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(this.bedSize.x, 0, 0),
            new THREE.Vector3(this.bedSize.x, this.bedSize.y, 0),
            new THREE.Vector3(0, this.bedSize.y, 0),
            new THREE.Vector3(0, 0, 0)
        ];
        const borderGeometry = new THREE.BufferGeometry().setFromPoints(borderPoints);
        const borderMaterial = new THREE.LineBasicMaterial({ color: borderColor });
        gridGroup.add(new THREE.Line(borderGeometry, borderMaterial));

        this.gridHelper = gridGroup;
        this.gridHelper.position.z = 0.1;
        this.scene.add(this.gridHelper);
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
        geometry.translate(-center.x + this.bedSize.x / 2, -center.y + this.bedSize.y / 2, -minZ);

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

        this.models.set(modelId, modelObj);
        this.scene.add(mesh);

        if (filePath) {
            this.modelFilePaths.set(modelId, filePath);
        }

        this.updateObjectList();
        this.saveState('导入模型');
        this.fitCameraToModel(mesh);
    }

    addModelObject(object, name, filePath = null) {
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        object.position.x = this.bedSize.x / 2 - center.x;
        object.position.y = this.bedSize.y / 2 - center.y;
        object.position.z = (box.max.z - box.min.z) / 2 - center.z;

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

        this.models.set(modelId, modelObj);
        this.scene.add(object);

        if (filePath) {
            this.modelFilePaths.set(modelId, filePath);
        }

        this.updateObjectList();
        this.saveState('导入模型');
        this.fitCameraToModel(object);
    }

    updateObjectList() {
        const listContainer = document.getElementById('objects-list');
        const countElement = document.getElementById('object-count');
        const modelCountElement = document.getElementById('model-count');
        const selectionCountElement = document.getElementById('selection-count');

        const total = this.models.size;
        if (countElement) countElement.textContent = `${total} 个对象`;
        if (modelCountElement) modelCountElement.textContent = this.models.size;
        if (selectionCountElement) selectionCountElement.textContent = this.selectedModels.size;

        listContainer.innerHTML = '';
        
        if (total === 0) {
            listContainer.innerHTML = '<div class="objects-empty">暂无对象</div>';
            return;
        }

        // 渲染所有模型（包括组合体）
        this.models.forEach((model) => {
            const isGroup = !!model._groupData;
            const item = document.createElement('div');
            item.className = `object-item ${isGroup ? 'object-group' : ''} ${model.selected ? 'selected' : ''}`;
            item.dataset.id = model.id;
            
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

            // 点击打印按钮切换可打印状态
            const printBtn = item.querySelector('.object-printable-btn');
            if (printBtn) {
                printBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleModelPrintable(model.id);
                });
            }

            // 右键菜单
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // 选中该模型
                this.selectModelById(model.id, true);
                this._showListContextMenu(e, model);
            });

            item.querySelector('.object-delete').addEventListener('click', () => {
                this.deleteModelById(model.id);
            });

            // 解组按钮（仅组合体）
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

            listContainer.appendChild(item);
        });
    }

    selectModelById(modelId, clearOthers = true) {
        const model = this.models.get(modelId);
        if (!model) return;

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

        if (this.selectedModels.size === 1 && this.currentMode !== null) {
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
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
        const edges = new THREE.EdgesGeometry(geometry);
        const material = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2 });

        model.selectionBox = new THREE.LineSegments(edges, material);
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

        this.saveState();

        if (model.selected) {
            this.selectedModels.delete(modelId);
            this.deselectModelInternal(model);
        }

        this.removeSelectionBox(model);
        if (model._transformProxy) {
            this.scene.remove(model._transformProxy);
        }
        this.scene.remove(model.mesh);
        this.models.delete(modelId);

        this.updateObjectList();
        this.updateTransformPanel();
    }

    clearAllModels() {
        this.saveState();
        this.models.forEach((model) => {
            this.removeSelectionBox(model);
            if (model._transformProxy) {
                this.scene.remove(model._transformProxy);
            }
            this.scene.remove(model.mesh);
        });
        this.models.clear();
        this.selectedModels.clear();
        this.transformControls.detach();
        this.updateObjectList();
        this.updateTransformPanel();
        this.historyManager.clear();
        this.updateUndoRedoButtons();

        // 清理 MKP 临时目录
        this._cleanupExtractDir();

        // 重置项目路径，下次保存时弹出保存对话框
        this._currentMkpPath = null;
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

    _updateSidebarActive(activeId) {
        const ids = ['sidebar-nav-home', 'sidebar-nav-prepare', 'sidebar-nav-calibrate', 'sidebar-import-file', 'sidebar-open-project', 'sidebar-settings', 'sidebar-about'];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (id === activeId) el.classList.add('active');
            else el.classList.remove('active');
        }
    }

    switchToHome() {
        document.getElementById('nav-home')?.classList.add('active');
        document.getElementById('nav-prepare')?.classList.remove('active');
        document.getElementById('nav-preview')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.remove('active');
        document.getElementById('home-page')?.classList.remove('hidden');
        document.getElementById('home-sidebar')?.classList.remove('hidden');
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        document.getElementById('texture-slice-group')?.classList.add('hidden');
        document.getElementById('btn-model-slice')?.classList.add('hidden');
        document.getElementById('btn-start-print')?.classList.add('hidden');
        this._updateSidebarActive('sidebar-nav-home');
        this.loadRecentProjects();
    }

    switchToPrepare() {
        document.getElementById('nav-home')?.classList.remove('active');
        document.getElementById('nav-prepare')?.classList.add('active');
        document.getElementById('nav-preview')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.remove('active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('home-sidebar')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        document.getElementById('main-container')?.classList.remove('hidden');
        document.getElementById('texture-slice-group')?.classList.remove('hidden');
        document.getElementById('btn-model-slice')?.classList.remove('hidden');
        document.getElementById('btn-start-print')?.classList.add('hidden');
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
        // 切片进行中不允许切换到预览页
        if (this._sliceRunning) {
            this.showToast('纹理切片进行中，请等待完成', 'info');
            return;
        }
        document.getElementById('nav-home')?.classList.remove('active');
        document.getElementById('nav-prepare')?.classList.remove('active');
        document.getElementById('nav-preview')?.classList.add('active');
        document.getElementById('nav-calibrate')?.classList.remove('active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('home-sidebar')?.classList.add('hidden');
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.remove('hidden');
        document.getElementById('texture-slice-group')?.classList.add('hidden');
        document.getElementById('btn-model-slice')?.classList.add('hidden');
        document.getElementById('btn-start-print')?.classList.remove('hidden');

        // 自动加载预览文件夹中的切片图片
        this._loadPreviewFolderImages();

        // 自动初始化 3D 轨迹视图
        if (!this._gcode3DRenderer) {
            this._setupGcode3DView();
            this._renderToolpath3D();
        }
        // 触发 resize 以填充容器
        setTimeout(() => {
            if (this._gcode3DResizeHandler) this._gcode3DResizeHandler();
        }, 50);
    }

    async _loadPreviewFolderImages() {
        const container = document.getElementById('slice-images-container');
        if (!container) return;
        if (!window.pywebview || !window.pywebview.api) return;
        try {
            const result = await window.pywebview.api.load_preview_images();
            const count = (result && result.count) ? result.count : 0;
            // 始终更新图片总数（以 Preview 文件夹中的 PNG 数量为准）
            this._previewImageCount = count;

            if (result && result.success && result.images && result.images.length > 0) {
                this.displaySliceImages(result.images);
            } else {
                // 没有图片时也要更新层数滑块
                this._updateLayerSlider();
            }
        } catch (e) {
            console.error('加载预览图片失败:', e);
        }
    }

    switchToCalibrate() {
        document.getElementById('nav-home')?.classList.remove('active');
        document.getElementById('nav-prepare')?.classList.remove('active');
        document.getElementById('nav-preview')?.classList.remove('active');
        document.getElementById('nav-calibrate')?.classList.add('active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('home-sidebar')?.classList.add('hidden');
        document.getElementById('main-container')?.classList.add('hidden');
        document.getElementById('preview-page')?.classList.add('hidden');
        document.getElementById('calibrate-page')?.classList.remove('hidden');
        document.getElementById('texture-slice-group')?.classList.add('hidden');
        document.getElementById('btn-model-slice')?.classList.add('hidden');
        document.getElementById('btn-start-print')?.classList.add('hidden');
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
            if (ext === 'mkp') {
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

        if (scaleX) scaleX.value = (transformSource.scale.x * 100).toFixed(2);
        if (scaleY) scaleY.value = (transformSource.scale.y * 100).toFixed(2);
        if (scaleZ) scaleZ.value = (transformSource.scale.z * 100).toFixed(2);

        if (sizeX) sizeX.value = size.x.toFixed(2);
        if (sizeY) sizeY.value = size.y.toFixed(2);
        if (sizeZ) sizeZ.value = size.z.toFixed(2);

        if (posX) posX.value = center.x.toFixed(2);
        if (posY) posY.value = center.y.toFixed(2);
        if (posZ) posZ.value = center.z.toFixed(2);

        const euler = new THREE.Euler().setFromQuaternion(transformSource.quaternion, 'XYZ');
        if (rotX) rotX.value = (euler.x * 180 / Math.PI).toFixed(2);
        if (rotY) rotY.value = (euler.y * 180 / Math.PI).toFixed(2);
        if (rotZ) rotZ.value = (euler.z * 180 / Math.PI).toFixed(2);
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
                    model._transformProxy.position.z -= minZ;
                } else {
                    model.mesh.position.z -= minZ;
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

        // 记录烘焙前的世界 XY 中心位置
        const preBox = new THREE.Box3().setFromObject(mesh);
        const preCenter = preBox.getCenter(new THREE.Vector3());

        // 把世界矩阵应用到所有几何体顶点
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
    }

    saveState(description = '操作') {
        const state = {
            description: description,
            timestamp: new Date().toISOString(),
            models: {}
        };
        this.models.forEach((model, id) => {
            const transformSource = model._transformProxy || model.mesh;
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
                }
            };
        });
        const info = this.historyManager.record(state);
        this.updateUndoRedoButtons();
        return info;
    }

    restoreState(result) {
        if (!result || !result.state) return;
        const state = result.state;
        this.isUndoRedo = true;

        this.models.forEach((model, id) => {
            if (state.models && state.models[id]) {
                const modelState = state.models[id];

                if (model.selected && model._transformProxy) {
                    model._transformProxy.position.set(modelState.position.x, modelState.position.y, modelState.position.z);
                    model._transformProxy.rotation.set(modelState.rotation.x, modelState.rotation.y, modelState.rotation.z);
                    model._transformProxy.scale.set(modelState.scale.x, modelState.scale.y, modelState.scale.z);
                    model._transformProxy.updateMatrixWorld(true);
                } else {
                    model.mesh.position.set(modelState.position.x, modelState.position.y, modelState.position.z);
                    model.mesh.rotation.set(modelState.rotation.x, modelState.rotation.y, modelState.rotation.z);
                    model.mesh.scale.set(modelState.scale.x, modelState.scale.y, modelState.scale.z);
                    model.mesh.updateMatrixWorld(true);
                }
            }
        });

        this.lockZAxis();
        this.updateTransformInputs();
        this.updateSelectionBoxes();
        this.isUndoRedo = false;
        
        return result.info;
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
                    child.material = child.material.clone();
                }
            }
        });

        const newModelId = this.nextModelId++;
        const newName = `${sourceModel.name} (副本)`;
        const newModelObj = new ModelObject(newMesh, newName, newModelId);

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

        // 2. 遍历每个模型，收集子网格、记录解组信息
        const allGeometries = [];
        const groupDataParts = [];
        let firstMaterial = null;

        selectedModelIds.forEach(modelId => {
            const model = this.models.get(modelId);
            if (!model) return;

            model.mesh.updateMatrixWorld(true);

            const subMeshData = [];
            model.mesh.traverse((child) => {
                if (child.isMesh && child.geometry && child.geometry.attributes.position) {
                    // 计算该子网格在组内的局部变换
                    const localMatrix = new THREE.Matrix4().multiplyMatrices(invGroupCenter, child.matrixWorld);

                    // 克隆几何体并应用局部变换，用于合并
                    const clonedGeo = child.geometry.clone();
                    clonedGeo.applyMatrix4(localMatrix);
                    allGeometries.push(clonedGeo);

                    // 保存原始几何体和局部变换，用于解组
                    subMeshData.push({
                        geometry: child.geometry.clone(),
                        material: child.material,
                        localMatrix: localMatrix.clone(),
                    });

                    if (!firstMaterial && child.material) {
                        firstMaterial = child.material;
                    }
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

        // 3. 合并所有几何体
        const mergedGeo = this._mergeGeometries(allGeometries);

        // 4. 创建合并后的单一 mesh（保留第一个模型的材质外观）
        const mergedMaterial = firstMaterial
            ? firstMaterial.clone()
            : new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5, metalness: 0.1 });
        mergedMaterial.flatShading = false;
        const mergedMesh = new THREE.Mesh(mergedGeo, mergedMaterial);
        mergedMesh.position.copy(groupCenter);
        mergedMesh.castShadow = true;
        mergedMesh.receiveShadow = true;

        const modelId = this.nextModelId++;
        mergedMesh.userData.modelId = modelId;

        this.scene.add(mergedMesh);

        const modelObj = new ModelObject(mergedMesh, `组合体 ${modelId}`, modelId);
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
        this.showToast(`已组合 ${groupDataParts.length} 个对象`, 'success');
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
        this.showToast('已解组', 'success');
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

            // 从斜上方俯视
            const dist = Math.max(this.bedSize.x, this.bedSize.y) * 0.85;
            const angle = Math.PI / 4;
            this.camera.position.set(
                bedCenter.x + dist * Math.cos(angle),
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
                bedCenter.x + horizontalDist,
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
        } else {
            this._clearFaceHighlight();
        }
        this.updateModeButtons();
        this.switchTransformContent();
        this.updateTransformPanel();
    }

    onMouseMove(event) {
        if (!this.isLayOnFaceMode) {
            this._clearFaceHighlight();
            return;
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

    _highlightFaceRegion(intersect) {
        const mesh = intersect.object;
        // 确保矩阵最新
        mesh.updateMatrixWorld(true);

        const region = this._getCoplanarRegion(mesh, intersect.faceIndex);
        if (!region || region.faceIndices.length === 0) return;

        const geometry = mesh.geometry;
        const pos = geometry.attributes.position;

        // 合并区域所有三角面的顶点（支持索引/非索引几何体）
        const vertices = [];
        if (geometry.index) {
            const idx = geometry.index;
            for (const fi of region.faceIndices) {
                const i0 = idx.getX(fi * 3);
                const i1 = idx.getX(fi * 3 + 1);
                const i2 = idx.getX(fi * 3 + 2);
                vertices.push(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
                vertices.push(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
                vertices.push(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
            }
        } else {
            for (const fi of region.faceIndices) {
                const i0 = fi * 3;
                const i1 = fi * 3 + 1;
                const i2 = fi * 3 + 2;
                vertices.push(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
                vertices.push(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
                vertices.push(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
            }
        }

        const triGeom = new THREE.BufferGeometry();
        triGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
        triGeom.computeVertexNormals();

        const triMat = new THREE.MeshBasicMaterial({
            color: 0x4a9eff,
            transparent: true,
            opacity: 0.4,
            side: THREE.DoubleSide,
            depthTest: false
        });

        const highlight = new THREE.Mesh(triGeom, triMat);
        highlight.applyMatrix4(mesh.matrixWorld);

        this._clearFaceHighlight();
        this._faceHighlight = highlight;
        this.scene.add(highlight);
    }

    _clearFaceHighlight() {
        if (this._faceHighlight) {
            this.scene.remove(this._faceHighlight);
            this._faceHighlight.geometry.dispose();
            this._faceHighlight.material.dispose();
            this._faceHighlight = null;
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

        // 记录放平前的 XY 视觉中心
        const preLayBox = new THREE.Box3().setFromObject(model.mesh);
        const preLayCenter = preLayBox.getCenter(new THREE.Vector3());

        this.saveState('按面放平');

        this._clearFaceHighlight();

        // 取消选中，直接操作 mesh，避免 proxy 的偏移导致定位错误
        if (model.selected && model._transformProxy) {
            this.deselectModelInternal(model);
            this.selectedModels.delete(model.id);
            model.selected = false;
            model._transformProxy = null;
        }

        const meshToUse = intersect.object;

        // 确保 meshToUse 的 matrixWorld 是最新的（deselect 可能改变了父子关系）
        meshToUse.updateMatrixWorld(true);

        // 展开共面区域
        const region = this._getCoplanarRegion(meshToUse, intersect.faceIndex);
        if (!region) return;

        // 计算区域的平均法线（统一转到世界空间）
        let avgNormal;
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
            // 转世界空间，与 setFromUnitVectors(avgNormal, up) 中的 up 坐标系一致
            avgNormal.transformDirection(meshToUse.matrixWorld);
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

        // 将区域所有顶点转到世界坐标，找最低点
        const posAttr = meshToUse.geometry.attributes.position;
        let minZ = Infinity;
        const worldPos = new THREE.Vector3();
        for (const fi of region.faceIndices) {
            const verts = [];
            if (meshToUse.geometry.index) {
                const idx = meshToUse.geometry.index;
                verts.push(idx.getX(fi * 3), idx.getX(fi * 3 + 1), idx.getX(fi * 3 + 2));
            } else {
                verts.push(fi * 3, fi * 3 + 1, fi * 3 + 2);
            }
            for (const vi of verts) {
                worldPos.set(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi));
                worldPos.applyMatrix4(meshToUse.matrixWorld);
                if (worldPos.z < minZ) minZ = worldPos.z;
            }
        }

        if (isFinite(minZ) && Math.abs(minZ) > 0.001) {
            model.mesh.position.z -= minZ;
            model.mesh.updateMatrixWorld(true);
        }

        this.updateSelectionBoxes();
        this.updateTransformInputs();

        // 烘焙变换到几何体，避免后续矩阵链漂移
        this.bakeTransform(model);

        // 强制恢复放平前的 XY 视觉中心
        const postLayBox = new THREE.Box3().setFromObject(model.mesh);
        const postLayCenter = postLayBox.getCenter(new THREE.Vector3());
        model.mesh.position.x += (preLayCenter.x - postLayCenter.x);
        model.mesh.position.y += (preLayCenter.y - postLayCenter.y);
        model.mesh.updateMatrixWorld(true);

        this.isLayOnFaceMode = false;
        this._clearFaceHighlight();
        this.updateModeButtons();
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
        this.saveState();
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

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
        this.updateSelectionBoxes();
    }

    resetPosition() {
        if (this.selectedModels.size !== 1) return;
        this.saveState();
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        const transformSource = model._transformProxy || model.mesh;
        transformSource.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model.mesh);
        const center = box.getCenter(new THREE.Vector3());

        transformSource.position.x += this.bedSize.x / 2 - center.x;
        transformSource.position.y += this.bedSize.y / 2 - center.y;
        transformSource.updateMatrixWorld(true);

        this.lockZAxis();
        this.updateSelectionBoxes();
        this.updateTransformInputs();
    }

    resetRotation() {
        if (this.selectedModels.size !== 1) return;
        this.saveState();
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        const transformSource = model._transformProxy || model.mesh;
        transformSource.rotation.set(0, 0, 0);

        document.getElementById('rot-x').value = '0.00';
        document.getElementById('rot-y').value = '0.00';
        document.getElementById('rot-z').value = '0.00';

        this.lockZAxis();
        this.updateSelectionBoxes();
    }

    applyScaleFromInputs() {
        if (this.selectedModels.size !== 1) return;
        this.saveState();
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        const isUniform = document.getElementById('uniform-scale').checked;
        let sx = parseFloat(document.getElementById('scale-x').value) || 100;
        let sy = parseFloat(document.getElementById('scale-y').value) || 100;
        let sz = parseFloat(document.getElementById('scale-z').value) || 100;
        sx /= 100; sy /= 100; sz /= 100;

        if (isUniform) {
            // 用世界缩放做均匀缩放基准，避免 _transformProxy/mesh 局部值不一致
            const ws = new THREE.Vector3();
            model.mesh.getWorldScale(ws);
            const diffs = [Math.abs(sx - ws.x), Math.abs(sy - ws.y), Math.abs(sz - ws.z)];
            const uniformScale = diffs[0] >= diffs[1] && diffs[0] >= diffs[2] ? sx : diffs[1] >= diffs[2] ? sy : sz;
            sx = sy = sz = uniformScale;
            const displayValue = (uniformScale * 100).toFixed(2);
            document.getElementById('scale-x').value = displayValue;
            document.getElementById('scale-y').value = displayValue;
            document.getElementById('scale-z').value = displayValue;
        }

        // 有 _transformProxy 时修改 proxy 的 scale，否则修改 mesh
        const scaleTarget = model._transformProxy || model.mesh;
        scaleTarget.scale.set(sx, sy, sz);
        this.lockZAxis();
        this.updateSelectionBoxes();
    }

    applySizeFromInputs() {
        if (this.selectedModels.size !== 1) return;
        this.saveState();
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

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
            const newDisplayX = (baseX * newScale).toFixed(2);
            const newDisplayY = (baseY * newScale).toFixed(2);
            const newDisplayZ = (baseZ * newScale).toFixed(2);
            document.getElementById('size-x').value = newDisplayX;
            document.getElementById('size-y').value = newDisplayY;
            document.getElementById('size-z').value = newDisplayZ;
        }

        // 有 _transformProxy 时修改 proxy 的 scale，否则修改 mesh
        const scaleTarget = model._transformProxy || model.mesh;
        scaleTarget.scale.set(newScaleX, newScaleY, newScaleZ);
        this.lockZAxis();
        this.updateSelectionBoxes();
    }

    applyPositionFromInputs() {
        if (this.selectedModels.size !== 1) return;
        this.saveState();
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        const x = parseFloat(document.getElementById('pos-x').value) || 0;
        const y = parseFloat(document.getElementById('pos-y').value) || 0;

        if (model._transformProxy) {
            model._transformProxy.position.x = x;
            model._transformProxy.position.y = y;
        } else {
            model.mesh.position.x = x;
            model.mesh.position.y = y;
        }
        this.lockZAxis();
        this.updateSelectionBoxes();
    }

    applyRotationFromInputs() {
        if (this.selectedModels.size !== 1) return;
        this.saveState();
        const modelId = Array.from(this.selectedModels)[0];
        const model = this.models.get(modelId);
        if (!model) return;

        const x = (parseFloat(document.getElementById('rot-x').value) || 0) * Math.PI / 180;
        const y = (parseFloat(document.getElementById('rot-y').value) || 0) * Math.PI / 180;
        const z = (parseFloat(document.getElementById('rot-z').value) || 0) * Math.PI / 180;

        if (model._transformProxy) {
            model._transformProxy.rotation.set(x, y, z);
        } else {
            model.mesh.rotation.set(x, y, z);
        }
        this.lockZAxis();
        this.updateSelectionBoxes();
    }

    onMouseClick(event) {
        if (this.isDraggingModel) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        const objectsToTest = [];
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

        document.getElementById('btn-save')?.addEventListener('click', () => this.saveProject());
        document.getElementById('btn-undo')?.addEventListener('click', () => this.undo());
        document.getElementById('btn-redo')?.addEventListener('click', () => this.redo());

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
        document.getElementById('nav-calibrate')?.addEventListener('click', () => this.switchToCalibrate());

        // 首页侧边栏导航
        document.getElementById('sidebar-nav-home')?.addEventListener('click', () => this.switchToHome());
        document.getElementById('sidebar-nav-prepare')?.addEventListener('click', () => this.switchToPrepare());
        document.getElementById('sidebar-nav-calibrate')?.addEventListener('click', () => this.switchToCalibrate());
        document.getElementById('sidebar-import-file')?.addEventListener('click', () => this._triggerHomeImport());
        document.getElementById('sidebar-open-project')?.addEventListener('click', () => {
            this.switchToPrepare();
            setTimeout(() => this.openProject(), 100);
        });
        document.getElementById('sidebar-settings')?.addEventListener('click', () => {
            document.getElementById('settings-dialog')?.classList.remove('hidden');
        });
        document.getElementById('sidebar-about')?.addEventListener('click', () => {
            document.getElementById('about-dialog')?.classList.remove('hidden');
        });
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

        // 纹理切片按钮
        document.getElementById('btn-texture-slice')?.addEventListener('click', () => this.doSlicing());
        // 模型切片按钮
        document.getElementById('btn-model-slice')?.addEventListener('click', () => this.doModelSlice());
        // 取消切片按钮
        document.getElementById('btn-cancel-slice')?.addEventListener('click', () => this._cancelSlicing());

        // 开始打印按钮
        document.getElementById('btn-start-print')?.addEventListener('click', () => this.startPrint());

        // 自动摆放卡片按钮
        document.getElementById('arrange-cancel')?.addEventListener('click', () => this.hideArrangeCard());
        document.getElementById('arrange-confirm')?.addEventListener('click', () => this.doAutoArrange());

        // 首页按钮
        document.getElementById('home-new-project')?.addEventListener('click', () => this.switchToPrepare());
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

        // 拖拽导入文件
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.getElementById('drop-overlay')?.classList.remove('hidden');
        });

        document.addEventListener('dragleave', (e) => {
            if (e.relatedTarget === null || e.clientX === 0) {
                document.getElementById('drop-overlay')?.classList.add('hidden');
            }
        });

        document.addEventListener('drop', (e) => {
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

        // 变换输入框回车确认
        const transformInputIds = [
            { ids: ['size-x', 'size-y', 'size-z'], handler: 'applySizeFromInputs' },
            { ids: ['scale-x', 'scale-y', 'scale-z'], handler: 'applyScaleFromInputs' },
            { ids: ['pos-x', 'pos-y'], handler: 'applyPositionFromInputs' },
            { ids: ['rot-x', 'rot-y', 'rot-z'], handler: 'applyRotationFromInputs' },
        ];
        transformInputIds.forEach(group => {
            group.ids.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            this[group.handler]();
                        }
                    });
                }
            });
        });

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
            if (this.isFreeDragging) {
                this.handleFreeDrag(e);
            }
        });

        this.renderer.domElement.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                this.handleMouseDown(e);
            }
        });

        this.renderer.domElement.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                this.handleMouseUp(e);
            }
        });

        document.addEventListener('keydown', (e) => {
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

        if (this.selectedModels.size === 1) {
            const selectedModelId = Array.from(this.selectedModels)[0];
            const model = this.models.get(selectedModelId);
            if (model && model.visible) {
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
            transformSource.position.x = intersection.x;
            transformSource.position.y = intersection.y;
        }

        transformSource.updateMatrixWorld(true);
        this.lockZAxis();
        this.updateSelectionBoxes();
        this.updateTransformInputs();
    }

    handleMouseUp(e) {
        if (this.isFreeDragging) {
            this.isFreeDragging = false;
            this.freeDragModel = null;
            this.saveState();
        }

        this.orbitControls.enabled = true;
    }

    setupContextMenu() {
        this.contextMenu = document.getElementById('context-menu');
        this.mirrorSubmenu = document.getElementById('mirror-submenu');

        this.renderer.domElement.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.handleContextMenu(e);
        });

        document.querySelectorAll('#context-menu .context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const action = item.dataset.action;
                if (action === 'mirror') {
                    this.showMirrorSubmenu(e);
                } else {
                    this.handleContextMenuAction(action);
                    this.hideContextMenu();
                }
            });

            item.addEventListener('mouseenter', (e) => {
                if (item.dataset.action === 'mirror') {
                    this.showMirrorSubmenu(e);
                } else {
                    this.hideMirrorSubmenu();
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

        document.addEventListener('click', (e) => {
            if (!this.contextMenu.contains(e.target) && !this.mirrorSubmenu.contains(e.target)) {
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

        this.showToast(`${model.name} 已${model.printable ? '设为可打印' : '设为不可打印'}`, 'info');
        this.updateObjectList();
        this.saveState();
    }

    /** 根据 printable 状态更新模型外观：不可打印 = 灰色半透明 */
    _updateModelPrintAppearance(model) {
        const materials = [];

        model.mesh.traverse((child) => {
            if (!child.isMesh) return;
            const mat = child.material;
            if (!mat) return;

            if (model.printable) {
                // 恢复原始材质
                if (mat.userData._savedMaterial) {
                    child.material = mat.userData._savedMaterial;
                    delete mat.userData._savedMaterial;
                } else {
                    // 没有 savedMaterial 则只恢复透明度
                    mat.transparent = false;
                    mat.opacity = 1.0;
                    mat.color.setHex(parseInt(mat.userData._origColorHex || 'ffffff', 16));
                    mat.needsUpdate = true;
                }
            } else {
                // 保存原始材质（仅首次）
                if (!mat.userData._savedMaterial) {
                    mat.userData._savedMaterial = mat.clone();
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
                        child.material = child.material.clone();
                    }
                }
            });

            const newModelId = this.nextModelId++;
            const newName = count > 1 ? `${model.name} (副本${i})` : `${model.name} (副本)`;
            const newModelObj = new ModelObject(newMesh, newName, newModelId);

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
            // 居中
            const cx = (vpRect.width - S.imgDisp.w * S.zoom) / 2;
            const cy = (vpRect.height - S.imgDisp.h * S.zoom) / 2;
            S.scenePos.x = cx;
            S.scenePos.y = cy;
            scene.style.left = cx + 'px';
            scene.style.top = cy + 'px';
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
            rectBlue.classList.remove('active', 'selected');
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
            enterDrawMode('red');
            this.classList.add('active');
            document.getElementById('btn-draw-blue').classList.remove('active');
        });

        document.getElementById('btn-clear-rects').addEventListener('click', clearRects);

        // ---------- 鼠标事件 ----------
        function onMouseDown(e) {
            if (!S.imageLoaded) return;
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

        // ---------- 偏移计算 ----------
        function updateResult() {
            const b = S.rects.blue;
            const r = S.rects.red;

            if (!b || !r) {
                offsetXEl.textContent = 'X: ---';
                offsetYEl.textContent = 'Y: ---';
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

            const offX = (rcx - bcx) * scaleX;
            const offY = (rcy - bcy) * scaleY;

            offsetXEl.textContent = 'X: ' + offX.toFixed(2) + ' mm';
            offsetYEl.textContent = 'Y: ' + offY.toFixed(2) + ' mm';
            statusEl.textContent = '偏移值已计算：红框中心相对于蓝框中心的偏移';
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

        // 左侧方向键的同步
        const updateDisplay = () => {
            const xEl = document.getElementById('offset-x');
            const yEl = document.getElementById('offset-y');
            if (xEl) xEl.textContent = this.calibrateOffset.x.toFixed(2);
            if (yEl) yEl.textContent = this.calibrateOffset.y.toFixed(2);
        };

        document.getElementById('cal-up')?.addEventListener('click', () => {
            this.calibrateOffset.y += this.calibrateStep;
            updateDisplay();
        });
        document.getElementById('cal-down')?.addEventListener('click', () => {
            this.calibrateOffset.y -= this.calibrateStep;
            updateDisplay();
        });
        document.getElementById('cal-left')?.addEventListener('click', () => {
            this.calibrateOffset.x -= this.calibrateStep;
            updateDisplay();
        });
        document.getElementById('cal-right')?.addEventListener('click', () => {
            this.calibrateOffset.x += this.calibrateStep;
            updateDisplay();
        });
        document.getElementById('cal-home')?.addEventListener('click', () => {
            this.calibrateOffset.x = 0;
            this.calibrateOffset.y = 0;
            updateDisplay();
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

    async _setupPrintConfigSelect() {
        const customSelect = document.getElementById('print-setting-select');
        if (!customSelect) return;

        const trigger = customSelect.querySelector('.select-trigger');
        const optionsContainer = customSelect.querySelector('.select-options');
        const valueDisplay = customSelect.querySelector('.select-value');
        const statusEl = document.getElementById('config-status');

        // 收集当前所有参数
        const collectData = () => ({
            whiteInk: {
                offset: { ...this.calibrateOffset },
                step: this.calibrateStep
            },
            inkjet: {
                imageOffset: (() => {
                    const xEl = document.getElementById('cal-img-offset-x');
                    const yEl = document.getElementById('cal-img-offset-y');
                    return {
                        x: xEl ? xEl.textContent : '---',
                        y: yEl ? yEl.textContent : '---'
                    };
                })(),
                density: parseFloat(document.getElementById('inkjet-density').value) || 0.5,
                speed: parseInt(document.getElementById('inkjet-speed').value) || 50
            }
        });

        // 应用配置到 UI
        const applyData = (data) => {
            // 白墨偏移
            if (data.whiteInk) {
                const wo = data.whiteInk.offset || {};
                this.calibrateOffset.x = wo.x || 0;
                this.calibrateOffset.y = wo.y || 0;
                document.getElementById('offset-x').textContent = (wo.x || 0).toFixed(2);
                document.getElementById('offset-y').textContent = (wo.y || 0).toFixed(2);
                if (data.whiteInk.step) {
                    this.calibrateStep = data.whiteInk.step;
                    document.querySelectorAll('.step-btn').forEach(b => {
                        b.classList.toggle('active', parseFloat(b.dataset.step) === data.whiteInk.step);
                    });
                }
            }
            // 喷墨参数
            if (data.inkjet) {
                const ij = data.inkjet;
                const densityEl = document.getElementById('inkjet-density');
                const speedEl = document.getElementById('inkjet-speed');
                if (ij.density && densityEl) {
                    densityEl.value = ij.density;
                    document.getElementById('inkjet-density-val').textContent = ij.density;
                }
                if (ij.speed && speedEl) {
                    speedEl.value = ij.speed;
                    document.getElementById('inkjet-speed-val').textContent = ij.speed;
                }
            }
        };

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
            if (!name || name === '默认配置' || name === '未配置') {
                this._showDialog('保存配置', '请输入配置名称：', '例如：材料A 精细模式').then(async (newName) => {
                    if (!newName) return;
                    valueDisplay.textContent = newName;
                    try {
                        await window.pywebview.api.save_print_setting(newName, JSON.stringify(collectData()));
                        if (statusEl) { statusEl.textContent = '已保存: ' + newName; statusEl.className = 'cal-config-status success'; }
                        refreshList(newName);
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
                            whiteInk: { offset: { x: 0, y: 0 }, step: 0.1 },
                            inkjet: { imageOffset: { x: '---', y: '---' }, density: 0.5, speed: 50 }
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

        // 鼠标滚轮控制滑块 - 监听整个预览页面（图片区域除外）
        const previewPage = document.getElementById('preview-page');
        if (previewPage) {
            previewPage.addEventListener('wheel', (e) => {
                // 鼠标在切片图片区域内时，滚轮用于缩放图片，不切换层
                if (e.target.closest('#slice-images-container')) return;

                const step = parseFloat(slider.step) || 1;
                const min = parseFloat(slider.min) || 1;
                const max = parseFloat(slider.max) || 100;
                let val = parseFloat(slider.value);
                val += e.deltaY > 0 ? -step : step;
                val = Math.max(min, Math.min(max, val));
                slider.value = val;
                slider.dispatchEvent(new Event('input'));
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

            const oldPosition = oldMesh.position.clone();
            const oldRotation = oldMesh.rotation.clone();
            const oldScale = oldMesh.scale.clone();

            this.scene.remove(oldMesh);

            switch (result.type) {
                case 'stl':
                    this.loadSTLAndReplace(result.data, modelId, oldPosition, oldRotation, oldScale);
                    break;
                case 'obj':
                    this.loadOBJAndReplace(result, modelId, oldPosition, oldRotation, oldScale);
                    break;
                case 'gltf':
            case 'glb':
                this.loadGLTFAndReplace(result.data, modelId, oldPosition, oldRotation, oldScale);
                break;
            case 'fbx':
                this.loadFBXAndReplace(result.data, modelId, oldPosition, oldRotation, oldScale);
                break;
            }
        } catch (e) {
            console.error('重新加载模型异常:', e);
            this.showToast('重新加载异常: ' + e.message, 'error');
        }
    }

    loadSTLAndReplace(dataUrl, modelId, position, rotation, scale) {
        const loader = new STLLoader();
        loader.load(dataUrl, (geometry) => {
            this.replaceModelMesh(modelId, geometry, position, rotation, scale);
        });
    }

    loadGLTFAndReplace(dataUrl, modelId, position, rotation, scale) {
        const loader = new GLTFLoader();
        loader.load(dataUrl, (gltf) => {
            this.replaceModelObject(modelId, gltf.scene, position, rotation, scale);
        });
    }

    loadFBXAndReplace(dataUrl, modelId, position, rotation, scale) {
        const loader = new FBXLoader();
        loader.load(dataUrl, (fbx) => {
            this.replaceModelObject(modelId, fbx, position, rotation, scale);
        });
    }

    loadOBJAndReplace(result, modelId, position, rotation, scale) {
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
                    this.replaceModelObject(modelId, object, position, rotation, scale);
                }, undefined, () => {
                    this.replaceModelObject(modelId, object, position, rotation, scale);
                });
            } else {
                this.replaceModelObject(modelId, object, position, rotation, scale);
            }
        });
    }

    replaceModelMesh(modelId, geometry, position, rotation, scale) {
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

        mesh.position.copy(position);
        mesh.rotation.copy(rotation);
        mesh.scale.copy(scale);

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

    replaceModelObject(modelId, object, position, rotation, scale) {
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

        object.position.copy(position);
        object.rotation.copy(rotation);
        object.scale.copy(scale);

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

        this.saveState();

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

        const project = this.exportProject();
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

        const project = this.exportProject();
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

    // 导出项目数据
    exportProject() {
        const project = {
            version: '1.0',
            timestamp: new Date().toISOString(),
            bedSize: { ...this.bedSize },
            gridSize: this.gridSize,
            showGrid: this.showGrid,
            models: [],
            gcode: this._lastGcode || null
        };

        this.models.forEach((model, id) => {
            // 用 mesh.getWorld* 获取真正世界变换，避免 _transformProxy/mesh 局部值不一致导致丢失
            const worldPos = new THREE.Vector3();
            const worldQuat = new THREE.Quaternion();
            const worldScale = new THREE.Vector3();
            model.mesh.getWorldPosition(worldPos);
            model.mesh.getWorldQuaternion(worldQuat);
            model.mesh.getWorldScale(worldScale);
            const worldRot = new THREE.Euler().setFromQuaternion(worldQuat);

            project.models.push({
                id: id,
                name: model.name,
                printable: model.printable,
                filePath: this.modelFilePaths.get(id) || null,
                position: {
                    x: worldPos.x,
                    y: worldPos.y,
                    z: worldPos.z
                },
                rotation: {
                    x: worldRot.x,
                    y: worldRot.y,
                    z: worldRot.z
                },
                scale: {
                    x: worldScale.x,
                    y: worldScale.y,
                    z: worldScale.z
                }
            });
            console.log('[exportProject] 模型世界变换:', model.name,
                'scale:', JSON.stringify(worldScale),
                'pos:', JSON.stringify(worldPos));
        });

        return project;
    }

    // 加载项目
    loadProject(project) {
        // 清除现有模型
        this.clearAllModels();

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

        this.saveState('加载项目');
    }

    // 从项目嵌入的模型数据加载（MKP格式）
    _loadModelFromProjectData(modelData) {
        const data = modelData._modelData;
        if (!data || !data.obj) {
            console.error('[loadProject] 模型数据为空，跳过:', modelData.name);
            return;
        }
        console.log('[loadProject] 正在加载模型:', modelData.name);

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
        this.addModelObject(object, modelData.name);
        // 应用保存的变换
        const model = this.models.get(this.nextModelId - 1);
        if (model) {
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
            if (modelData.position) {
                transformSource.position.set(
                    modelData.position.x || 0, modelData.position.y || 0, modelData.position.z || 0
                );
            }
            if (modelData.rotation) {
                transformSource.rotation.set(
                    modelData.rotation.x || 0, modelData.rotation.y || 0, modelData.rotation.z || 0
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
                            const transformSource = model._transformProxy || model.mesh;
                            transformSource.position.set(modelData.position.x, modelData.position.y, modelData.position.z);
                            transformSource.rotation.set(modelData.rotation.x, modelData.rotation.y, modelData.rotation.z);
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
                    if (s.bedSize) {
                        if (s.bedSize.x) this.bedSize.x = s.bedSize.x;
                        if (s.bedSize.y) this.bedSize.y = s.bedSize.y;
                        if (s.bedSize.z) this.bedSize.z = s.bedSize.z;
                    }
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
                    if (s.printerAddress !== undefined) this.printerAddress = s.printerAddress;
                    if (s.headAddress !== undefined) this.headAddress = s.headAddress;
                    if (s.orcaSlicerPath !== undefined) this.orcaSlicerPath = s.orcaSlicerPath;
                    if (s.snapmakerOrcaPath !== undefined) this.snapmakerOrcaPath = s.snapmakerOrcaPath;
                    if (s.gcodeSlicerType !== undefined) this.gcodeSlicerType = s.gcodeSlicerType;
                    if (s.textureResolution !== undefined) this.textureResolution = s.textureResolution;
                }
            } catch (e) {
                console.error('加载设置失败:', e);
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
                    bedSize: { ...this.bedSize },
                    showGrid: this.showGrid,
                    gridTheme: this.gridTheme,
                    gridSize: this.gridSize,
                    cameraMode: this.cameraMode,
                    orcaSlicerPath: this.orcaSlicerPath || '',
                    snapmakerOrcaPath: this.snapmakerOrcaPath || '',
                    gcodeSlicerType: this.gcodeSlicerType || 'orcaslicer',
                    textureResolution: this.textureResolution || 4000
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
                        this.showToast(`已检测到: ${result.path}`, 'success');
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
                        this.showToast(`已选择: ${result.path}`, 'success');
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
            testPrinterBtn.addEventListener('click', () => this.testConnection('printer-address', 'printer-status'));
        }
        if (testHeadBtn) {
            testHeadBtn.addEventListener('click', () => this.testConnection('head-address', 'head-status'));
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
                window.pywebview.api.save_settings(JSON.stringify(settings));
            } catch (e) {
                console.error('保存打印机设置异常:', e);
            }
        }
    }

    async testConnection(addressId, statusId) {
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
        statusEl.textContent = '测试中...';
        statusEl.className = 'test-status testing';

        try {
            let result;
            if (window.pywebview && window.pywebview.api) {
                result = await window.pywebview.api.test_connection(address);
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
                result = { success: true, message: '连接成功' };
            }

            if (result.success) {
                statusEl.textContent = '连接成功';
                statusEl.className = 'test-status success';
            } else {
                statusEl.textContent = '无法连接';
                statusEl.className = 'test-status fail';
            }
        } catch (e) {
            statusEl.textContent = '测试失败';
            statusEl.className = 'test-status fail';
        } finally {
            testBtn.disabled = false;
        }
    }

    // ===== 切片功能 =====

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

        // 2. 层高参数（固定值）
        const layerHeight = 0.2;

        // 3. 获取纹理分辨率设置
        const resolution = this.textureResolution || 4000;

        // 4. 启动子进程切片（非阻塞）
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

        this.showToast('正在纹理切片中...', 'info');

        try {
            const config = {
                obj_path: objPath,
                layer_height: layerHeight,
                resolution: resolution,
            };
            const startResult = await window.pywebview.api.texture_slice_start(JSON.stringify(config));
            if (!startResult || !startResult.success) {
                this.showToast('纹理切片启动失败: ' + (startResult ? startResult.error : '无返回'), 'error');
                this._hideSliceProgress();
                this._setPreviewTabDisabled(false);
                return;
            }

            // 5. 轮询进度
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
                        this.showToast('纹理切片失败: ' + (status.error || '未知错误'), 'error');
                        resolve();
                        return;
                    }

                    // 更新进度条
                    if (status.total > 0) {
                        const pct = Math.round((status.progress / status.total) * 100);
                        if (progressFill) progressFill.style.width = pct + '%';
                        if (progressText) progressText.textContent = `${status.progress} / ${status.total} 层`;
                    }

                    if (status.state === 'done') {
                        // 加载生成的图片
                        const imgResult = await window.pywebview.api.texture_slice_load_images();
                        this._hideSliceProgress();
                        this._setPreviewTabDisabled(false);

                        if (imgResult && imgResult.success && imgResult.images && imgResult.images.length > 0) {
                            this.showToast(`纹理切片完成，共 ${imgResult.count} 层`, 'success');
                            this.switchToPreview();
                            this.displaySliceImages(imgResult.images);
                        } else {
                            this.showToast('纹理切片完成，但未生成图片', 'warning');
                        }
                        resolve();
                        return;
                    }

                    // 继续轮询
                    this._pollTimer = setTimeout(poll, 300);
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

    _hideSliceProgress() {
        this._sliceRunning = false;
        this._sliceCancelled = true; // 确保轮询不再继续
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
        this.showToast('正在导出 STL...', 'info');
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

        // 3. 打开 OrcaSlicer GUI 并加载 STL
        try {
            const openResult = await window.pywebview.api.open_with_orca_slicer(stlResult.path, slicerPath);
            if (openResult.success) {
                this.showToast('已打开 OrcaSlicer', 'success');
            } else {
                this.showToast('打开 OrcaSlicer 失败: ' + (openResult.error || ''), 'error');
            }
        } catch (e) {
            this.showToast('打开 OrcaSlicer 异常: ' + e.message, 'error');
        }
    }

    /** 开始打印 */
    async startPrint() {
        if (!window.pywebview || !window.pywebview.api) {
            this.showToast('后端API不可用', 'error');
            return;
        }
        this.showToast('正在准备打印...', 'info');
        try {
            // 调用后端打印接口
            const result = await window.pywebview.api.start_print();
            if (result && result.success) {
                this.showToast('打印已开始', 'success');
            } else {
                this.showToast('打印启动失败: ' + (result ? result.error : '未知错误'), 'error');
            }
        } catch (e) {
            console.error('打印异常:', e);
            this.showToast('打印异常: ' + e.message, 'error');
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
        this.hideArrangeCard();

        const modelCount = this.models.size;
        if (modelCount === 0) {
            this.showToast('场景中没有模型', 'warning');
            return;
        }

        // 获取每个模型相对自身局部原点的真实尺寸（不受 position 影响）
        const items = [];
        this.models.forEach((modelObj, id) => {
            const localBox = new THREE.Box3();
            modelObj.mesh.traverse((child) => {
                if (child.isMesh && child.geometry) {
                    child.geometry.computeBoundingBox();
                    if (child.geometry.boundingBox) {
                        const gb = child.geometry.boundingBox.clone();
                        gb.applyMatrix4(child.matrix);
                        localBox.expandByPoint(gb.min);
                        localBox.expandByPoint(gb.max);
                    }
                }
            });
            const size = localBox.getSize(new THREE.Vector3());
            if (size.x > 0 && size.y > 0) {
                items.push({ mesh: modelObj.mesh, size, area: size.x * size.y });
            }
        });

        if (items.length === 0) return;

        // 从大到小排序
        items.sort((a, b) => b.area - a.area);

        const bedW = this.bedSize.x;
        const bedH = this.bedSize.y;
        const pad = Math.min(spacing, 8);
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

        // 网格起始 XY（尽可能居中，且至少留 pad 边距）
        const originX = Math.max(pad, (bedW - gridW) / 2);
        const originY = Math.max(pad, (bedH - gridH) / 2);

        // 计算每个格子左上角
        const gx = [];
        let cx = originX;
        for (let c = 0; c < colW.length; c++) {
            gx[c] = cx;
            cx += colW[c] + spacing;
        }
        const gy = [];
        let cy = originY;
        for (let r = 0; r < rowH.length; r++) {
            gy[r] = cy;
            cy += rowH[r] + spacing;
        }

        // 摆放
        items.forEach((item, i) => {
            const c = i % cols;
            const r = Math.floor(i / cols);

            // 格子中心
            let px = gx[c] + colW[c] / 2;
            let py = gy[r] + rowH[r] / 2;

            // 确保整模型在热床内
            const hw = item.size.x / 2;
            const hh = item.size.y / 2;
            px = Math.max(hw + pad, Math.min(bedMaxX - hw, px));
            py = Math.max(hh + pad, Math.min(bedMaxY - hh, py));

            console.log(`[auto-arrange] model#${i}: size(${item.size.x.toFixed(1)},${item.size.y.toFixed(1)}) pos(${px.toFixed(1)},${py.toFixed(1)})`);
            item.mesh.position.x = px;
            item.mesh.position.y = py;
            item.mesh.position.z = item.size.z / 2;
        });

        this.saveState('自动摆放');
        this.showToast(`自动摆放完成（${items.length} 个模型，间距 ${spacing}mm）`, 'success');
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

            // 应用热床大小
            if (s.bedSize) {
                let bedChanged = false;
                if (s.bedSize.x && s.bedSize.x !== this.bedSize.x) {
                    this.bedSize.x = s.bedSize.x; bedChanged = true;
                }
                if (s.bedSize.y && s.bedSize.y !== this.bedSize.y) {
                    this.bedSize.y = s.bedSize.y; bedChanged = true;
                }
                if (s.bedSize.z && s.bedSize.z !== this.bedSize.z) {
                    this.bedSize.z = s.bedSize.z; bedChanged = true;
                }
                if (bedChanged) {
                    this.createBed();
                    this.createGrid();
                    needsUpdate = false; // already updated
                }
            }

            if (needsUpdate) {
                this.createBed();
                this.createGrid();
            }

            console.log('已加载偏好设置:', s);
        } catch (e) {
            console.error('加载偏好设置失败:', e);
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
                        bedSize: { ...this.bedSize },
                        showGrid: this.showGrid,
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
     * 导出 STL（模型 + 四角定位平面）到 Documents/MKPSpectrum/Temp/
     * 网格本身不会被导出，只导出模型和四个 1mm×1mm 的定位平面
     */
    async _exportSTLWithPlanes() {
        const geometries = [];

        // 1. 收集所有模型的几何体（应用世界变换，仅导出可打印模型）
        this.models.forEach((model) => {
            if (!model.visible || !model.printable) return;
            // 确保世界矩阵是最新的（处理近期变换操作后未刷新矩阵的情况）
            model.mesh.updateWorldMatrix(true, true);
            model.mesh.traverse((child) => {
                if (child.isMesh) {
                    const geo = child.geometry.clone();
                    geo.applyMatrix4(child.matrixWorld);
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

        // 1. 收集所有模型的几何体 + 材质贴图（仅导出可打印模型）
        this.models.forEach((model) => {
            if (!model.visible || !model.printable) return;
            model.mesh.updateWorldMatrix(true, true);
            model.mesh.traverse((child) => {
                if (!child.isMesh) return;
                const geo = child.geometry.clone();
                geo.applyMatrix4(child.matrixWorld);
                geo.computeVertexNormals();

                let materialName = 'default';
                let textureUrl = null;
                let textureName = null;

                if (child.material) {
                    materialName = child.material.name || 'default';
                    // 提取贴图
                    if (child.material.map && child.material.map.image) {
                        const b64 = this._textureToBase64(child.material.map.image);
                        if (b64) {
                            textureName = `tex_${textureCounter}.png`;
                            textureCounter++;
                            texMap[textureName] = b64;
                            textureUrl = textureName;
                        }
                    }
                }

                meshes.push({ geometry: geo, materialName, textureUrl, textureName });
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

        for (const { geometry, materialName, textureUrl, textureName } of meshes) {
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
                    objStr += `vt ${uv.getX(i).toFixed(6)} ${(1 - uv.getY(i)).toFixed(6)}\n`;
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
                this.displayGcode(result.gcode);
                // 加载完成后更新层数滑块信息
                setTimeout(() => this._updateLayerSlider(), 100);
                // 初始化 3D 视图
                setTimeout(() => {
                    this._setupGcode3DView();
                    this._renderToolpath3D();
                }, 200);
            } else {
                console.warn('[测试] 加载 GCode 失败:', result?.error || '未知错误');
            }
        } catch (e) {
            console.warn('[测试] 加载 GCode 异常:', e);
        }
    }

    // ========== GCode 3D 轨迹可视化 ==========

    _parseGcodeToolpath(gcode) {
        if (!gcode) return [];
        const layers = [];
        const lines = gcode.split('\n');

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

    _setupGcode3DView() {
        const container = document.getElementById('gcode-3d-container');
        if (!container) return;

        // Dispose previous if exists
        if (this._gcode3DRenderer) {
            this._gcode3DRenderer.dispose();
            const oldCanvas = container.querySelector('canvas');
            if (oldCanvas) oldCanvas.remove();
        }

        const rect = container.getBoundingClientRect();
        const width = rect.width || 400;
        const height = rect.height || 300;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x111111);

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.insertBefore(renderer.domElement, container.firstChild);

        // Lighting
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambient);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
        dirLight.position.set(200, 200, 300);
        scene.add(dirLight);

        // Grid and axes helper
        // Scale: GCode coords are in mm, bed is ~150x150
        const gridHelper = new THREE.GridHelper(200, 20, 0x444444, 0x333333);
        gridHelper.rotation.x = Math.PI / 2; // make it horizontal
        scene.add(gridHelper);

        // Axes
        const axesHelper = new THREE.AxesHelper(30);
        scene.add(axesHelper);

        this._gcode3DScene = scene;
        this._gcode3DCamera = camera;
        this._gcode3DRenderer = renderer;
        this._gcode3DGroup = new THREE.Group();
        this._gcode3DLayerGroups = [];
        scene.add(this._gcode3DGroup);

        // Animate the 3D view
        const animate = () => {
            if (!this._gcode3DRenderer) return;
            this._gcode3DAnimId = requestAnimationFrame(animate);
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
            }
        };
        window.addEventListener('resize', onResize);
        this._gcode3DResizeHandler = onResize;
    }

    _renderToolpath3D() {
        const gcode = this._lastGcode;
        if (!gcode) return;
        const scene = this._gcode3DScene;
        const group = this._gcode3DGroup;
        if (!scene || !group) return;

        // Clear previous
        while (group.children.length) {
            const child = group.children[0];
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
            group.remove(child);
        }
        this._gcode3DLayerGroups = [];

        const layers = this._parseGcodeToolpath(gcode);
        if (layers.length === 0) return;

        // Compute bounds for camera auto-fit
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (const layer of layers) {
            const layerGroup = new THREE.Group();
            for (const seg of layer.segments) {
                if (seg.points.length < 2) continue;

                for (const p of seg.points) {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.y > maxY) maxY = p.y;
                    if (p.z < minZ) minZ = p.z;
                    if (p.z > maxZ) maxZ = p.z;
                }

                const positions = [];
                for (const p of seg.points) {
                    positions.push(p.x, p.y, p.z);
                }

                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

                let color = seg.color || 0x666666;

                // Brighten travel moves
                let material;
                if (seg.type === 'travel') {
                    material = new THREE.LineDashedMaterial({
                        color: color,
                        dashSize: 0.5,
                        gapSize: 0.5,
                        transparent: true,
                        opacity: 0.4,
                    });
                } else {
                    material = new THREE.LineBasicMaterial({
                        color: color,
                        linewidth: 1,
                    });
                }

                const line = new THREE.Line(geometry, material);
                if (seg.type === 'travel') {
                    line.computeLineDistances();
                }
                layerGroup.add(line);
            }
            group.add(layerGroup);
            this._gcode3DLayerGroups.push(layerGroup);
        }

        // Auto-fit camera
        if (minX !== Infinity && maxX !== Infinity) {
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const cz = (minZ + maxZ) / 2;
            const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 10);
            const dist = size * 1.5;

            this._gcode3DCamera.position.set(cx, cy - dist * 0.7, cz + dist * 0.7);
            this._gcode3DCamera.lookAt(cx, cy, cz);

            // Add a small bed outline
            if (!this._gcode3DBedOutline) {
                const bedGeo = new THREE.BufferGeometry();
                const halfX = 75, halfY = 75;
                const bedVerts = new Float32Array([
                    -halfX, -halfY, 0,
                    halfX, -halfY, 0,
                    halfX, halfY, 0,
                    -halfX, halfY, 0,
                    -halfX, -halfY, 0,
                ]);
                bedGeo.setAttribute('position', new THREE.Float32BufferAttribute(bedVerts, 3));
                const bedMat = new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.5 });
                const bedLine = new THREE.Line(bedGeo, bedMat);
                scene.add(bedLine);
                this._gcode3DBedOutline = bedLine;
            }
        }

        // Apply current slider
        setTimeout(() => this._updateGcode3DLayers(), 50);
    }

    _updateGcode3DLayers() {
        const layerGroups = this._gcode3DLayerGroups;
        if (!layerGroups || layerGroups.length === 0) return;

        const slider = document.getElementById('layer-slider');
        const pct = slider ? parseFloat(slider.value) : 100;
        const total = layerGroups.length;
        const showCount = Math.max(1, Math.round(total * pct / 100));

        layerGroups.forEach((lg, idx) => {
            lg.visible = idx < showCount;
        });
    }

    displayGcode(gcode) {
        this._lastGcode = gcode;
        // 重新渲染 3D 轨迹视图
        if (this._gcode3DRenderer) {
            this._renderToolpath3D();
        }
    }

    displaySliceImages(images) {
        this._sliceImages = images || [];
        this._showSliceImage(0);
    }

    _showSliceImage(index) {
        const container = document.getElementById('slice-images-container');
        if (!container) return;

        const images = this._sliceImages || [];
        if (images.length === 0) {
            container.innerHTML = '<div class="slice-images-empty">暂无切片图片数据。</div>';
            return;
        }

        const i = Math.max(0, Math.min(index, images.length - 1));
        const imgData = images[i];

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

        // 绑定缩放/平移事件
        this._setupImageZoom(zoomWrapper, img);
    }

    _setupImageZoom(wrapper, img) {
        let scale = 1;
        let panX = 0;
        let panY = 0;
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let lastPanX = 0;
        let lastPanY = 0;

        const MIN_SCALE = 1;
        const MAX_SCALE = 10;
        const ZOOM_STEP = 0.15;

        const applyTransform = () => {
            const tr = isDragging ? 'none' : 'transform 0.12s ease-out';
            img.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
            img.style.transition = tr;
        };

        // 滚轮缩放
        wrapper.addEventListener('wheel', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
            const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale + delta));

            // 以鼠标位置为缩放中心
            if (newScale !== scale && scale >= MIN_SCALE) {
                const rect = wrapper.getBoundingClientRect();
                const mx = e.clientX - rect.left - rect.width / 2;
                const my = e.clientY - rect.top - rect.height / 2;
                const ratio = newScale / scale;
                panX = mx * (1 - ratio) / newScale + panX * ratio;
                panY = my * (1 - ratio) / newScale + panY * ratio;
            }
            scale = newScale;

            // 缩放到 1 时重置平移
            if (scale <= MIN_SCALE) {
                scale = MIN_SCALE;
                panX = 0;
                panY = 0;
                wrapper.style.cursor = 'default';
            } else {
                wrapper.style.cursor = 'grab';
            }

            applyTransform();
        });

        // 鼠标拖拽平移
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
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            wrapper.style.cursor = scale > MIN_SCALE ? 'grab' : 'default';
            img.style.transition = 'transform 0.12s ease-out';
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        // 保存引用以便清理（可选）
        wrapper._zoomCleanup = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }

    async _saveGcodeToProject(gcode) {
        if (!window.pywebview || !window.pywebview.api) return;
        try {
            const project = this.exportProject();
            project.gcode = gcode;
            const result = await window.pywebview.api.save_gcode_to_project(JSON.stringify(project));
            if (result && result.success) {
                this.showToast('Gcode 已保存至项目', 'success');
            }
        } catch (e) {
            console.error('保存 Gcode 到项目异常:', e);
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.orbitControls.update();
        this.renderer.render(this.scene, this.camera);
        this.updateCameraInfo();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new BedPreview();
});
