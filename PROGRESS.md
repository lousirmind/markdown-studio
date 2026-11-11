# 开发进度与路线图

> 记录当前交付状态、质量基线、已知限制与后续计划。更新于 2026-11-11。

## 当前状态（2026-11-11）

| 项目 | 状态 |
| :--- | :--- |
| 版本 | **v1.1.1**（含查找高亮、Finder 双击/打开方式修复） |
| 本地应用 | `/Applications/Markdown Studio.app`（1.1.1，已替换旧版） |
| GitHub 仓库 | https://github.com/lousirmind/markdown-studio |
| 最新提交 | `4c6fef8 fix(finder): 支持 Finder 双击与打开方式打开 Markdown 文档（v1.1.1）` |
| 发布 | [v1.1.1](https://github.com/lousirmind/markdown-studio/releases/tag/v1.1.1) / [v1.1.0](https://github.com/lousirmind/markdown-studio/releases/tag/v1.1.0) |
| 工作区 | 干净（dist/build 均被忽略，不入库） |
| 下一步 | 等待 T9 七个决策点确认后，从 T9-0 开工 |

### 本轮会话完成清单

1. Finder 拖拽打开（文档/文件夹，图片仅粘贴）
2. 图片灯箱显示修复 + 实时缩放百分比
3. 启动恢复上次标签与未保存内容
4. PDF 导出选项（纸张/方向/边距/页眉页脚/缩放）
5. 标签拖拽排序 + 最近文件
6. 全文查找替换 + 查找命中高亮
7. 快速打开 / 命令面板（Cmd+P / Cmd+Shift+P）
8. Finder 双击/右键“打开方式”打开 .md/.txt（v1.1.1 修复）
9. v1.1.0 / v1.1.1 打包、签名、GitHub 发布

### 继续开发

- 启动开发版：`python3 main.py`
- 自检：`python3 main.py --headless-check`；端到端：`python3 test_e2e.py`
- 重新打包：`./packaging/build_app.command`，产物在 `dist/`


## 当前版本：v1.1.1

| 能力 | 状态 | 提交 |
| :--- | :--- | :--- |
| Finder 拖拽打开（.md/.txt/文件夹；图片仅粘贴） | ✅ | `e03b757` |
| 图片灯箱显示修复 + 实时缩放百分比 | ✅ | `2cfc3f7` |
| 启动恢复上次标签与未保存内容 | ✅ | `e5aa391` |
| PDF 导出选项（纸张/方向/边距/页眉页脚/缩放） | ✅ | `c4a55cc` |
| 标签拖拽排序 + 最近文件 | ✅ | `a659bf3` |
| 全文查找替换（源码级，四模式） | ✅ | `9379974` |
| 查找命中高亮（CSS Custom Highlight API） | ✅ | `dd62749` |
| 快速打开 / 命令面板（Cmd+P / Cmd+Shift+P） | ✅ | `eebae0c` |
| 文档与 v1.1.0 发布配置 | ✅ | `6233f12` |
| Finder 双击/“打开方式”打开文档（Info.plist UTI + NSApplication openURLs） | ✅ | `4c6fef8` |

### 质量基线（最终代码）

- `python3 main.py --headless-check`：**12/12**
- `python3 test_e2e.py`：**15/15**（含真实 WebKit 窗口、PDF、内建屏）
- 显示/性能验收（`/tmp/verify_mdstudio.py`）：16 项全通过（按键 10 次 ≤1ms、平滑滚动 0、TOC/状态栏重建 0/1、previewCalls=0、toolbar 保留、图片 2/2、0 JS 错误）
- HANDOVER/Mermaid + LaTeX 四模式渲染：公式 6/6、KaTeX 错误 0、表格/Mermaid 正常
- PDF 实测：welcome 6 页、HANDOVER 21 页、LaTeX 2 页；A4/Letter 横向/A5 的 MediaBox 均符合预期
- 冻结包：`--headless-check` 12/12、`--smoke-test` 通过；zip 内 `.app` 代码签名校验 OK

### 已知限制

- 仅 arm64 macOS；ad-hoc 签名，跨机器分发需 Developer ID + 公证。
- 项目位于 iCloud 同步目录时，`codesign --verify` 可能报 detritus；`xattr -cr "Markdown Studio.app"` 可消除，不影响运行。
- 快速打开索引受后端目录树深度 4 限制。
- 正则替换暂不支持 `$1` 捕获组引用。
- 大文档（>1MB）查找会触发 20000 匹配上限保护。

## T9：多文档分屏（待确认，尚未开工）

### 目标（MVP）

左右/上下双窗格，两个窗格都可编辑，各自拥有独立活动标签与编辑模式；工作区/主题全局共享；TOC、状态栏、查找、PDF 等按“当前聚焦窗格”工作；分屏布局随会话恢复。

### 主要改造点

1. `AppStore` 增加 `panes`（primary/secondary）与 `activePaneId`，`activeTabId` 兼容保留。
2. 抽取 `EditorPane` 管理单个 Vditor 实例；`EditorEngine` 降为活动窗格 Facade，保持现有公开 API，避免大范围改动 TOC/搜索/PDF/会话模块。
3. 工作区 DOM 改为双 pane 容器 + 分割条；单窗格时第二窗格隐藏，旧路径行为不变。
4. TabManager 标签激活按聚焦窗格路由；已打开标签在对应窗格激活。
5. session v2 保存布局/方向/比例/双窗格标签与模式，v1 自动迁移。
6. TOC/查找/PDF/最近文件/命令面板/拖拽等按活动窗格适配。

### 交互设计

- 顶栏“分屏”按钮；`Cmd/Ctrl+\` 开/关，`Cmd+Shift+\` 切换水平/垂直，`Cmd+1/2` 聚焦窗格。
- 分割条可拖拽比例；窗口宽度 <1100px 自动折叠为单窗格并提示。
- 同一文档不允许双开（自动聚焦已打开窗格）；主题全局，模式/滚动位置按窗格独立。

### 任务拆解（估算 1 人）

| # | 任务 | 估算 |
| :-- | :--- | :-- |
| T9-0 | 需求冻结 + 架构评审 | 0.5d |
| T9-1 | Store pane 模型 + session v2 + 双 pane DOM/CSS + 分割条 | 1.5d |
| T9-2 | 抽取 EditorPane + EditorEngine Facade 重构（单窗格零回归） | 2d |
| T9-3 | 标签按窗格路由 + 全局模块适配 | 2d |
| T9-4 | 方向/比例/快捷键/焦点/窄窗折叠 | 1d |
| T9-5 | 会话 v2 持久化与恢复 | 0.5–1d |
| T9-6 | 边界策略（同文档/保存/外部刷新/跨窗格） | 1d |
| T9-7 | E2E 扩展 + 性能/内存测量 | 1.5d |
| T9-8 | 文档 + 打包 v1.2.0 | 0.5d |
| | **合计** | **约 10–11.5 人日** |

建议分两个里程碑：M1（T9-1～T9-3，约 4.5–5 人日）双栏可编辑 MVP；M2（T9-4～T9-8，约 5 人日）交互、持久化、边界与发布。

### 待确认决策

1. 两个窗格都可编辑？（推荐：是）
2. 同一文档是否允许双开？（推荐：禁止，聚焦已打开窗格）
3. 编辑模式 per-pane 独立、主题全局？（推荐：是）
4. 支持水平 + 垂直方向？（推荐：都支持，默认水平）
5. 跨窗格拖拽标签是否首版就要？（推荐：放入 M2）
6. 分屏状态随会话恢复、<1100px 自动折叠？（推荐：是）
7. 同文档同步滚动/对照阅读属于 T9 之外？（推荐：单独立项）

## 发布记录

- **v1.1.0**（2026-11-11）：7 项交互增强 + 查找高亮；构建 `dist/Markdown Studio.app`（74 MB），分发 zip 28 MB，arm64 / ad-hoc 签名。
- **v1.1.1**（2026-11-11）：修复 Finder 双击/“打开方式”提示 “cannot open files in the Markdown Text format”；补全 `CFBundleDocumentTypes`（md/markdown/mdown Owner、txt Alternate）与 `application:openURLs:` 处理，支持启动时与运行中打开文档。
  - 提交：`4c6fef8`；安装包：`dist/Markdown Studio-1.1.1.zip`（29 MB，arm64 / ad-hoc 签名）；
  - 发布：https://github.com/lousirmind/markdown-studio/releases/tag/v1.1.1