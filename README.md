<h1 align="center">CircleTeX</h1>

<p align="center">
  <strong>在 VS Code 里像用 Word 一样改 LaTeX 论文 —— 直接在 PDF 上增删改，AI 助手帮你写。</strong>
  <br />
  <em>Edit your LaTeX thesis as intuitively as Word — directly on the PDF, with AI-assisted revision.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-^1.95.0-blue?logo=visualstudiocode" alt="VS Code" />
  <img src="https://img.shields.io/badge/version-0.10.5-brightgreen" alt="版本" />
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey?logo=windows" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
</p>

---

## 💡 这是什么？ / What is CircleTeX?

**CircleTeX** 是一个 VS Code 扩展，专为需要频繁修改 LaTeX 论文的作者设计。

你在 PDF 上选中一段文字，直接打字替换 —— CircleTeX 自动把修改写回 `main.tex` 源码，然后重新编译。不用在源码和 PDF 之间来回切换，不用手动对齐行号。AI 助手还能帮你生成整段修订建议，你只需确认或拒绝。

> **CircleTeX** is a VS Code extension that lets you edit your LaTeX thesis directly on the rendered PDF. Select text, type your changes — CircleTeX maps them back to the source, applies them safely, and recompiles. An AI assistant can also draft revisions for you to review.

---

## 🎯 为什么用 CircleTeX？ / Why CircleTeX?

| 传统 LaTeX 写作痛点 | CircleTeX 怎么做 |
|---|---|
| 改源码 → 编译 → 看 PDF → 找位置 → 循环 | **在 PDF 上直接增删改**，自动写回源码 |
| 行号对不上，不知改哪一行 | **SyncTeX 自动定位**，PDF 选区 ↔ 源码行精确映射 |
| 导师批注 "这段重写" 不知从何下手 | **AI 助手（Codex / Snow）** 按你的要求生成候选修订 |
| 怕改错、怕丢内容 | **自动备份 + 差异预览 + 编译校验**，失败自动回滚 |
| 多人修订痕迹混乱 | **直接模式**：干净 PDF 无残留标记；**修订模式**：保留 redline 痕迹 |
| 没有 Word 底稿，但必须提交 DOCX | 从 `main.tex` **无底稿导出 Word**，公式全部为 MathType 可编辑对象 |

---

## ✨ 核心功能 / Core Features

### 📝 PDF 直接编辑 / Direct PDF Editing
- 工具栏将**处理方式**与**选择方式**分开：上下切换“直编 / Agent”，右侧独立选择文字光标或区域框选
- 文字与区域工具均可再次单击关闭；关闭后保留 PDF 原生文字选择用于复制，但不触发 CircleTeX 定位
- **文字工具**：拖选 PDF 文字后直接键入替换、`Backspace`/`Delete` 删除、单击插入
- **跨页文字选择**：连续选择最多 12 页，可交给 Agent，或作为一项原子直接编辑整体替换、删除
- **区域工具**：框选连续普通正文后替换或删除整个区域；离散片段和不安全结构自动拒绝
- **中文输入法**完整支持，`Ctrl+Enter` 提交、`Esc` 取消
- **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Y`，支持批量操作
- 支持在行内公式、引用两侧及 `\\textbf`、`\\emph` 等格式正文中直接编辑
- 公式内部、未知命令、表格和注释环境**自动保护**，拒绝不安全编辑

### 🤖 AI 助手 / AI Assistant
- 选中段落，输入修改要求（如"把这段改写得更正式"），AI 生成候选修订
- 支持 **Codex CLI** 和 **Snow CLI** 两种后端
- **结构化差异预览**：候选修改在 VS Code 原生 Diff 视图中对比，确认后写入
- AI 运行在**只读沙箱**中，不接触文件系统

### 🧩 外部 Skill 任务
- 在左侧 **外部 Skill** 视图导入包含 `SKILL.md` 的本地目录，由 CircleTeX 保存内容哈希快照并管理启用状态
- 导入或更新时确认任务类型、作用范围、输入快照、输出扩展名、声明命令与超时；内容或权限变化后重新授权
- 在审阅窗口的现有任务选择框中切换“局部修订”或已导入 Skill，整篇任务不要求 PDF 选区
- Skill 仅对论文副本运行，首版支持**分析任务**和**独立产物**，不允许直接修改或编译真实 `main.tex` / `main.pdf`
- 首版仅支持 Codex；选择 Snow 时在执行前明确拦截。产物发布到 `exports/circletex/<skill>/<时间戳>/`，完成后只显示列表
- 独立运行面板显示 Skill 名称、已用时间、总进度、阶段状态和真实计数；详细信息默认收起，失败阶段会保留，不会覆盖论文编译进度

### 保留版式的无底稿 MathType Word 导出
- 扩展内置“保留版式的无底稿 MathType Word 导出”Skill，无需另行导入，也不要求存在 `main.docx`
- 正文唯一来源是隔离复制的 `main.tex`；CircleTeX 根据内置规则动态生成自己的 `reference.docx`，不使用 Pandoc 默认 Word 作为正式排版骨架
- 自动重建封面、Word 目录、A4 页面、页边距、四级标题、题注、页眉横线和三节页码体系，并保留 LaTeX 强制分页与复杂并排图片
- 全部行内与独立公式均输出为单个 `Equation.DSMT4` MathType OLE 对象，禁止 OMML、图片公式和普通文本降级
- 每个不同公式都要通过保存重开、反向回译和语义一致性校验；最终 DOCX 还要通过公式、页面、分节、页码、目录、标题和分页门禁
- `main.pdf` 保持只读并用于页数参照；Word 与 TeX 排版引擎不同，目标是学校格式和结构一致，不承诺逐像素或逐页完全相同
- 导出由 CircleTeX 的确定性执行器完成，不依赖 Agent 改写正文；完成后在现有任务面板展示公式与版式质量门禁，且不会自动跳转

### 🔄 SyncTeX 智能定位 / Smart SyncTeX Mapping
- PDF 选区自动映射到 `main.tex` 源行范围
- 重复短语通过**左右上下文消歧** + SyncTeX 空间位置复核
- 区域框选工具支持**矩形选定 + 多点锚定 + 有序文字片段**；Agent 模式要求人工确认，直接编辑在提交时执行严格连续性校验

### ⚡ 安全编译 / Safe Compilation
- 隔离临时目录预检 → XeLaTeX 编译 → 产物发布 → PDF 刷新
- 备份自动写入 `backup/circletex/`
- 编译失败保留上一版 PDF，源码不受影响
- 后台运行，不弹出成功通知干扰写作

### 🎨 连续 PDF 阅读 / Continuous PDF Viewer
- 使用内置 PDF.js 连续滚动渲染
- `Ctrl+滚轮` 缩放、页码跳转、适合宽度
- 虚拟页面管理，长文档低内存占用
- 优先显示上次稳定页缓存或低清首屏，高清页面与文字选择层在后台分阶段接管

---

## 🚀 快速开始 / Quick Start

### 安装 / Installation

```powershell
code --install-extension .\circletex-0.10.5.vsix --force
```

### 使用 / Usage

1. 点击左侧活动栏 **CircleTeX** 图标
2. 在左侧"设置"中选择编辑模式（推荐 **直接编辑**）
3. 运行 `CircleTeX：编译论文` 生成带 SyncTeX 信息的 `main.pdf`
4. 运行 `CircleTeX：打开 PDF 审阅`
5. 在工具栏上方选择“直编”，再使用文字或区域工具增删改 PDF 正文；区域框选图片后可用上下箭头调整尺寸
6. 点击 **应用 N 项并编译**，修改写回源码并重新编译

### 调整图片尺寸

1. 切换到“直编”和“区域框选”；
2. 粗略框住单张图片主体，CircleTeX 会自动吸附到 PDF 中的真实图片盒子，并排除图注；
3. 灰色虚线表示原始图片边界，蓝色实线表示候选边界；使用 `↑` 或 `↓` 按 5% 调整；
4. 点击“确认”只会加入待编译队列，PDF 和 `main.tex` 尚未变化；
5. 点击现有的 **应用 N 项并编译**，统一写入图片参数并刷新 PDF。

首版支持普通 `includegraphics` 的单一 `width`、`height` 或 `scale`，以及 `width=\linewidth` 的简单 `subfigure`。复杂动态表达式、多重尺寸、TikZ/PGFPlots、自定义图片宏和无法唯一定位的相邻图片会安全拒绝。

> 需要 AI 帮助？切换到“Agent”，选择文字或区域后在底部输入要求，点击 **当前助手分析**。

### 运行外部 Skill

1. 在左侧 CircleTeX 的 **外部 Skill** 视图点击导入按钮，选择包含 `SKILL.md` 的目录
2. 核对静态检查结果并确认权限清单
3. 在 PDF 审阅底部的“任务”选择框中选择该 Skill
4. 输入任务要求并交给 Codex 执行；可复用同一按钮取消任务
5. 在完成后的产物列表中主动打开文件，或从左侧查看任务历史

### 导出 MathType Word

1. 打开 PDF 审阅，在底部“任务”选择框中选择“无底稿 MathType Word 导出”
2. 输入导出要求，例如“从 main.tex 导出正式 Word”，点击现有任务按钮
3. 在独立 Skill 面板查看阶段、真实公式计数和已用时间；需要时展开“详细信息”，导出期间不要关闭当前 VS Code 窗口
4. 从完成后的产物列表打开 `main_mathtype.docx` 或转换报告

正式产物要求本机已安装 Microsoft Word 与 MathType 7。任一公式无法生成稳定的 `Equation.DSMT4` 对象时，任务会整体失败，不会输出降级公式。

---

## ⚙️ 配置 / Configuration

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `circletex.projectRoot` | 空 | 包含 `main.tex` 与 `main.pdf` 的项目目录 |
| `circletex.manualEditMode` | `direct` | `direct` = 干净 PDF；`tracked` = 保留修订痕迹 |
| `circletex.aiAssistant` | `codex` | AI 助手：`codex` 或 `snow` |
| `circletex.autoCompile` | `true` | 应用修改后自动编译 |
| `circletex.compilePasses` | `2` | 最大编译遍数 (1–4) |
| `circletex.contextLines` | `20` | 提交给 AI 的上下文行数 |

---

## 🏗️ 架构 / Architecture

```
┌─────────────────────────────────────────────────────┐
│                    VS Code 扩展                       │
│  ┌───────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │  Webview  │  │  SyncTeX │  │  AI 适配器       │  │
│  │  PDF.js   │←→│  定位     │  │  (Codex / Snow)  │  │
│  │  编辑器    │  └──────────┘  └──────────────────┘  │
│  └─────┬─────┘         ↓                ↓            │
│        ↓         源码行范围        候选修订文本        │
│  ┌──────────┐         ↓                ↓             │
│  │ 编译引擎  │    ┌──────────────────────────┐       │
│  │ XeLaTeX  │    │   修订事务 + 备份管理      │       │
│  └──────────┘    └──────────────────────────┘       │
└─────────────────────────────────────────────────────┘
```

---

## 📋 运行条件 / Requirements

- **Windows**
- **VS Code** 1.95.0+
- **XeLaTeX** + **SyncTeX**（PATH 可用）
- **Codex CLI** 或 **Snow CLI**（AI 功能需要，至少一个）
- **PowerShell 7、Python 3、Pandoc、Microsoft Word、MathType 7、pywin32**（无底稿 MathType Word 导出需要）

---

## 🔒 安全边界 / Security

- 未受信任工作区中**不运行外部进程、不写文件**
- AI 助手运行在**只读沙箱**（Codex）或**隔离临时目录**（Snow），禁用文件系统与终端
- 外部 Skill 使用独立临时任务目录和 `workspace-write` Codex Runner；只向 Runner 提供论文与 Skill 的复制快照
- CircleTeX 在运行后复核输入、Skill 和任务清单哈希，只发布经过扩展名、路径、数量、大小和结构校验的产物
- 网络在 CircleTeX 权限模型中固定为禁止，首版不提供联网授权；Skill 内容或权限变化时必须重新确认
- 所有修改**必须人工确认**后才能写入
- 源码自动备份，编译失败自动回滚
- 提示词和论文正文**不写入扩展日志**

> 隔离边界：`workspace-write` 主要限制 Codex 的写入范围。CircleTeX 不向 Runner 提供真实项目路径，也不会使用额外目录授权，并在执行后进行哈希复核；但当前没有官方证据可将其表述为操作系统级的绝对读取隔离。请仅导入来源可信、已核对内容的 Skill。

---

## 🧪 开发 / Development

```powershell
npm install
npm test        # 完整验证：编译 → 单元测试 → 烟测
npm run package # 打包 VSIX（自动运行完整验证）
```

按 `F5` 启动扩展开发宿主。

---

## 📄 许可证 / License

MIT License — 详见 `LICENSE.txt`

---

<p align="center">
  <sub>Made for thesis writers who want to spend more time writing and less time wrestling with LaTeX.</sub>
  <br />
  <sub>为写论文的人做的。少花时间折腾 LaTeX，多花时间写内容。</sub>
</p>
