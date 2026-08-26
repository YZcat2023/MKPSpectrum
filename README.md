# MKPSpectrum


https://github.com/user-attachments/assets/4098b29d-1f43-411e-a300-9b0f80b3839a


MKPSpectrum is an integrated software and hardware project for inkjet-based full-color 3D printing. It uses the Snapmaker U1 or other open-source Klipper-compatible 3D printers as the motion platform, combines them with a detachable portable CMYK inkjet printhead, and connects FDM printing, surface color printing, flat 2D printing, slicing preview, device control, and calibration into one workflow.

The goal of the project is to give ordinary desktop FDM printers a practical path toward vivid and saturated full-color output. The FDM printer builds the object layer by layer, while the inkjet printhead prints color patterns on selected layers, object surfaces, or flat materials. MKPSpectrum links the model, texture, inkjet data, printer GCode, and hardware actions into a coordinated printing process.

## Key Features

- Import, place, rotate, move, scale, and automatically arrange 3D models.
- Process textured 3D models and convert surface colors into printable inkjet data.
- Support flat 2D inkjet printing on envelopes, cards, sheets, and other flat materials.
- Preview GCode toolpaths and sliced color images before printing.
- Calibrate inkjet offset, print speed, ink density, repeated printing, and parallelogram distortion.
- Work with Klipper, Moonraker, and Fluidd-based printer workflows for uploading, starting, and monitoring print jobs.
- Save MKP project files containing models, placement, textures, slicing data, and print settings.

## Software Components

MKPSpectrum includes a desktop application shell, frontend interface, slicing pipeline, GCode post-processing tools, and device communication modules.

| Component | Role |
| --- | --- |
| Desktop application | Starts the local app window and provides file, slicing, and device communication interfaces |
| Frontend interface | Provides the home, prepare, preview, flat printing, device, and calibration pages |
| Texture slicing | Reads model textures and converts colored surfaces into layer-by-layer inkjet images |
| Strip processing | Splits images into printable strips and blocks according to the effective inkjet width |
| GCode post-processing | Merges inkjet actions, printhead pickup/release actions, and base printer paths |
| Device communication | Communicates with the printer control interface and inkjet printhead |

## Hardware Components

The hardware system is built around a 3D printer, a portable inkjet printhead, a mounting or pickup mechanism, and printer control connections.

| Hardware | Role |
| --- | --- |
| 3D printer | Provides three-axis motion and FDM structural printing |
| Portable CMYK inkjet printhead | Prints color patterns on object surfaces or flat materials |
| Pickup and release mechanism | Allows the printer toolhead to acquire and return the inkjet printhead when needed |
| Inkjet mounting bracket | Fixes the printhead position and aligns the inkjet area with printer motion |
| Ink-receptive printing material | Carries ink color and affects color saturation, adhesion, and bleeding |
| Printer control system | Executes GCode, controls motion, and provides network access |

In a typical print, the FDM nozzle forms the structure and the inkjet printhead applies color. MKPSpectrum uses GCode macros to control printhead pickup, printing, and release, and uses offset calibration to align printed color with the model geometry.

## Workflow

1. Import a model on the Prepare page and adjust its position, rotation, and size.
2. Read the model texture or flat image and generate image data suitable for inkjet printing.
3. Split the generated image into strips based on the effective printhead width and skip blank areas.
4. Convert image strips into the data format used by the inkjet printhead.
5. Insert inkjet actions into the base GCode so the printer can print color at selected positions.
6. During printing, the machine performs FDM deposition, printhead pickup, inkjet output, and printhead release.

## Main Pages

### Home

The Home page is used to create a new project, open an MKP project file, and access recently opened projects.

### Prepare

The Prepare page is used to import 3D models, adjust placement, rotate and scale objects, arrange models automatically, and choose whether each model participates in printing.

### Preview

The Preview page shows sliced images and 3D GCode paths. Users can check layer images, motion paths, and inkjet positions before starting a print.

### Flat Printing

The Flat page is used for 2D image printing. Users can upload one or more images, adjust position, size, angle, and Z height, then generate and send a flat printing task.

### Device

The Device page is used to view the printer control interface and device status. After the printer address is configured, the printer page can be monitored directly inside MKPSpectrum.

### Calibration

The Calibration page manages inkjet settings such as offset, density, speed, repeated printing, and parallelogram correction. Image-based calibration can also use a photo of a calibration card to help calculate offset values.

## Typical Use Cases

### Full-Color 3D Model Printing

1. Create or open a project.
2. Import a model on the Prepare page.
3. Adjust position, rotation, scale, and printability.
4. Confirm printer address, inkjet printhead address, and inkjet configuration.
5. Run texture slicing and wait for slicing and post-processing to finish.
6. Check sliced images and 3D paths on the Preview page.
7. Send the print job after confirming the preview.

### Flat Image Printing

1. Open the Flat page.
2. Upload an image.
3. Adjust image position, size, and angle.
4. Set Z height according to the material thickness.
5. Generate and start the print task.
6. Wait for strip processing, upload, and print startup to complete.

## Calibration Suggestions

- Complete X/Y inkjet offset calibration before first use.
- Recalibrate after replacing the printhead, bracket, material, or build surface.
- If the pattern is skewed or edges are misaligned, check parallelogram calibration first.
- If color is too light or too dark, adjust ink density, print speed, and repeated printing.
- Before flat printing, confirm material height to avoid blurry output or printhead collision.

## Material Guidance

The project proposes a modified PLA filament designed to absorb and retain ink for vivid and saturated color output. If other filaments are used, an ink-receptive coating may be needed to improve adhesion, reduce bleeding, and keep the printed color stable. For flat printing, use materials with a flat surface, stable ink absorption, and low deformation.

## Project Files

MKPSpectrum uses MKP project files to save task data. A project file can include models, placement, texture information, slicing results, and related configuration, making it easier to continue editing or reprint a previous task.

## Application Areas

- Full-color 3D model printing experiments.
- Inkjet expansion for desktop 3D printers.
- Surface patterns, labels, and texture output for printed models.
- Inkjet printing on envelopes, cards, sheets, and other flat materials.
- Research on coordinated control between multi-tool printers and external inkjet printheads.

## Notes

- Confirm the printer motion range, printhead mounting position, and inkjet offset before use.
- Always inspect the GCode preview before printing to avoid paths outside the build plate or collisions with brackets.
- Fix flat materials securely before printing to prevent movement during the job.
- Keep the inkjet nozzle clean and store the printhead according to its maintenance requirements when not in use.
- MKPSpectrum does not manufacture inkjet printheads, cartridges, or printer hardware. The hardware system is based on commercial devices and custom integration parts.

## Open-Source Notice

Project-developed parts of MKPSpectrum are planned for release under an open license for research, learning, modification, and redistribution. Third-party software, toolchains, and hardware products used with the project remain subject to their own licenses and terms.

---

# 中文说明

MKPSpectrum 是一个面向喷墨全彩 3D 打印的软硬件结合项目。它以 Snapmaker U1 或其他开源 3D 打印机为运动平台，配合可抓取和释放的便携式喷墨打印头，把传统 FDM 打印、表面喷墨上色、平面图案打印、切片预览和设备校准整合到同一套工作流中。

项目目标是让普通桌面级 3D 打印机具备更接近全彩打印的能力：模型由 FDM 打印机逐层成型，喷墨头在指定层面或平面材料上输出彩色图案，软件负责把模型、纹理、喷墨数据和打印机 GCode 串联起来。

## 项目特点

- 支持 3D 模型导入、摆放、旋转、移动、缩放和自动排布。
- 支持带纹理模型的彩色切片，将模型表面颜色转换为喷墨头可执行的数据。
- 支持平面 2D 打印，可在信封、卡片、薄片等平整材料上直接喷墨。
- 支持 GCode 轨迹预览和切片图片预览，便于打印前检查路径和颜色层。
- 支持喷墨偏移、打印速度、打印浓度、重复喷墨和平行四边形形变校准。
- 支持与 Klipper、Moonraker、Fluidd 工作流配合，实现上传、开始打印和设备状态查看。
- 支持 MKP 项目文件保存，便于保留模型、位置、纹理和打印配置。

## 软件组成

MKPSpectrum 软件由桌面壳、前端界面、切片处理、GCode 后处理和设备通信模块组成。

| 模块 | 作用 |
| --- | --- |
| 桌面程序 | 启动本地窗口，承载用户界面，并提供文件、切片和设备通信接口 |
| 前端界面 | 提供首页、准备、预览、平面、设备和校准等页面 |
| 纹理切片 | 读取模型表面纹理，将彩色表面转换成逐层喷墨图像 |
| 条带切割 | 按喷墨头有效宽度把图像切成可打印条带和块 |
| GCode 后处理 | 将喷墨动作、抓取/释放喷墨头动作和基础打印路径合并 |
| 设备通信 | 与打印机控制界面和喷墨头通信，完成上传、打印和参数设置 |

## 硬件组成

项目硬件由 3D 打印机、喷墨打印头、转接支架和控制连接组成。

| 硬件 | 作用 |
| --- | --- |
| 3D 打印机 | 提供三维运动平台和 FDM 打印能力 |
| 便携式 CMYK 喷墨打印头 | 输出彩色图案，用于模型表面或平面材料喷墨 |
| 抓取和释放结构 | 让打印机工具头在需要时取得喷墨头，完成后放回 |
| 喷墨头安装支架 | 固定喷墨头位置，保证喷墨区域与打印轨迹对齐 |
| 吸墨打印材料 | 承载喷墨颜色，影响显色、附着和扩散效果 |
| 打印机控制系统 | 负责执行 GCode、控制运动和提供网络接口 |

实际使用中，FDM 喷嘴负责结构成型，喷墨头负责彩色图案输出。软件通过 GCode 宏控制喷墨头的取得、打印和释放，并通过偏移校准保证喷墨图案与模型位置对齐。

## 工作原理

1. 用户在准备页导入模型，并调整模型的位置、角度和尺寸。
2. 软件读取模型纹理或平面图片，生成适合喷墨打印的图像数据。
3. 图像会按喷墨头有效打印宽度切成多个条带，空白区域会被跳过。
4. 喷墨图像被转换成喷墨头可识别的数据格式。
5. 软件把喷墨动作插入基础 GCode，使打印机在指定位置执行喷墨。
6. 打印过程中，打印机完成结构打印、喷墨头抓取、喷墨输出和喷墨头释放。

## 主要页面

### 首页

首页用于新建项目、打开 MKP 项目文件，以及查看最近打开的项目。

### 准备

准备页用于导入三维模型、调整模型位置、执行旋转和缩放、自动摆放模型，以及设置模型是否参与打印。

### 预览

预览页用于查看切片图片和 3D GCode 轨迹。用户可以在打印前检查每层图像是否正确、路径是否异常、喷墨位置是否符合预期。

### 平面

平面页用于 2D 图案打印。用户可以上传一张或多张图片，调整位置、尺寸、角度和 Z 高度，然后生成并发送平面打印任务。

### 设备

设备页用于查看打印机控制界面和设备状态。打印机地址配置完成后，可在软件内直接观察打印机页面。

### 校准

校准页用于管理喷墨配置，调整喷墨偏移、打印浓度、打印速度、重复喷墨和平行四边形校准。图片校准功能可通过校准卡照片辅助计算偏移。

## 典型使用流程

### 彩色 3D 模型打印

1. 新建或打开项目。
2. 在准备页导入模型。
3. 调整模型位置、旋转、缩放和可打印状态。
4. 确认打印机地址、喷墨头地址和喷墨配置。
5. 点击纹理切片，等待切片和后处理完成。
6. 在预览页检查切片图片和 3D 轨迹。
7. 确认无误后发送打印。

### 平面图片打印

1. 进入平面页。
2. 上传图片。
3. 调整图片位置、尺寸和角度。
4. 根据材料厚度设置 Z 高度。
5. 点击生成并打印。
6. 等待软件完成条带切割、上传和打印启动。

## 校准建议

- 首次使用前先完成喷墨 X/Y 偏移校准。
- 更换喷墨头、支架、耗材或打印平台后，建议重新校准。
- 图案出现斜切或边缘错位时，优先检查平行四边形校准。
- 颜色偏淡或过深时，调整打印浓度、打印速度和重复喷墨。
- 平面打印前确认材料高度，避免喷墨头过高导致模糊，或过低导致碰撞。

## 材料建议

推荐使用 MKP 配方的 PLA 耗材。如果使用其他耗材，应涂覆吸墨涂层，保证喷墨颜色能够稳定附着并减少渗色。用于平面打印时，应优先选择表面平整、吸墨稳定、不易变形的材料。

## 项目文件

MKPSpectrum 使用 MKP 项目文件保存任务数据。项目文件通常包含模型、摆放位置、纹理信息、切片结果和相关配置，便于后续继续编辑或重新打印。

## 适用场景

- 彩色 3D 模型打印实验。
- 桌面级 3D 打印机喷墨扩展。
- 模型表面图案、标识和纹理输出。
- 信封、卡片、薄片等平面材料喷墨。
- 多工具打印机与外部喷墨头协同控制研究。

## 注意事项

- 使用前确认打印机运动范围、喷墨头安装位置和喷墨偏移。
- 打印前必须检查 GCode 预览，避免路径超出平台或与支架干涉。
- 平面打印时要确认材料固定可靠，避免打印过程中移动。
- 喷墨头需要保持喷嘴清洁，长期不用时应按喷墨头维护要求保存。
- 项目不生产喷墨头、墨盒或打印机硬件，硬件部分基于市售设备和自制转接结构进行集成。

## 开源说明

MKPSpectrum 中由项目团队完成的部分计划按开放协议发布，供研究、学习、改造和再分发使用。项目中引用或配套使用的第三方软件、工具链和硬件产品，应遵循其各自许可证和使用条款。
