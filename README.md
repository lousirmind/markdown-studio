# Markdown Studio (macOS 独立阅读与编辑器)

> 基于 Python 3 + PyWebView + Vditor 开源底座构建的高性能、现代化独立 Markdown 桌面应用。

---

## 🌟 特性亮点

- ⚡ **原生 macOS 体验**：使用 PyWebView 渲染原生 WebKit 窗口，轻量、丝滑、内存占用极低。
- 📦 **100% 离线运行**：内置 Vditor 3.10.8 完整依赖（包含 KaTeX、Mermaid、ECharts、代码高亮等），无公网连接亦可完美使用。
- 🛡️ **安全原子写入**：所有文件写入操作均经由临时文件与原子替换，避免崩溃导致文档损坏。
- 🖼️ **图片无缝粘贴**：直接 `Cmd + V` 粘贴剪贴板截图，自动在当前文档同级创建 `./assets/` 存放并自动插入 Markdown 相对路径。
- 🧾 **原生 PDF 导出**：一键导出 A4 分页 PDF（矢量排版、KaTeX 公式、Mermaid 图表与本地图片完整保留，全程离线）。
- 📑 **智能目录大纲 (TOC)**：随正文滚动自动高亮追踪当前章节，支持一键点击平滑定位。
- 🧩 **高解耦架构**：后端服务各司其职，严禁交叉引用，全部通过统一门面 `DesktopBridge` 与前端交互。

---

## 🚀 快速启动

### 1. 安装环境依赖
```bash
pip install -r requirements.txt
```

### 2. 运行应用
```bash
# 启动桌面应用
python3 main.py

# 或者打开指定 Markdown 文件
python3 main.py ./sample/welcome.md

# 或者直接在 Finder 中双击运行
./run.command
```

### 3. 打包为 macOS App

```bash
# 生成自定义图标 + 打包 .app（需要 PyInstaller 与 Pillow）
./packaging/build_app.command
```

产物：`dist/Markdown Studio.app`（可拖入 /Applications），以及 `dist/Markdown Studio-1.0.0.zip`。
打包后可做无界面自检：

```bash
"dist/Markdown Studio.app/Contents/MacOS/Markdown Studio" --headless-check
"dist/Markdown Studio.app/Contents/MacOS/Markdown Studio" --smoke-test
```

### 4. 运行自动化接口自检
```bash
python3 main.py --headless-check
```

---

## 🛠️ 项目架构说明
详情参见 [PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md)。