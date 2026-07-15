<p align="center">
  <img src="media/circletex-activity.svg" alt="CircleTeX" width="96" />
</p>

<h1 align="center">CircleTeX</h1>

<p align="center">
  <strong>在 VS Code 里像用 Word 一样改 LaTeX 论文 —— 直接在 PDF 上增删改，AI 助手帮你写。</strong>
  <br />
  <em>Edit your LaTeX thesis as intuitively as Word — directly on the PDF, with AI-assisted revision.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-^1.95.0-blue?logo=visualstudiocode" alt="VS Code" />
  <img src="https://img.shields.io/badge/version-0.7.3-brightgreen" alt="Version" />
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

---

## ✨ 核心功能 / Core Features

### 📝 PDF 直接编辑 / Direct PDF Editing
- **铅笔工具**：拖选 PDF 文字后直接键入替换、`Backspace`/`Delete` 删除、单击插入
- **中文输入法**完整支持，`Ctrl+Enter` 提交、`Esc` 取消
- **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Y`，支持批量操作
- 公式、表格、注释环境**自动保护**，拒绝不安全编辑

### 🤖 AI 助手 / AI Assistant
- 选中段落，输入修改要求（如"把这段改写得更正式"），AI 生成候选修订
- 支持 **Codex CLI** 和 **Snow CLI** 两种后端
- **结构化差异预览**：候选修改在 VS Code 原生 Diff 视图中对比，确认后写入
- AI 运行在**只读沙箱**中，不接触文件系统

### 🔄 SyncTeX 智能定位 / Smart SyncTeX Mapping
- PDF 选区自动映射到 `main.tex` 源行范围
- 重复短语通过**左右上下文消歧** + SyncTeX 空间位置复核
- 区域框选工具支持**矩形选定 + 多点锚定**，始终强制人工确认

### ⚡ 安全编译 / Safe Compilation
- 隔离临时目录预检 → XeLaTeX 编译 → 产物发布 → PDF 刷新
- 备份自动写入 `backup/circletex/`
- 编译失败保留上一版 PDF，源码不受影响
- 后台运行，不弹出成功通知干扰写作

### 🎨 连续 PDF 阅读 / Continuous PDF Viewer
- 使用内置 PDF.js 连续滚动渲染
- `Ctrl+滚轮` 缩放、页码跳转、适合宽度
- 虚拟页面管理，长文档低内存占用

---

## 🚀 快速开始 / Quick Start

### 安装 / Installation

```powershell
code --install-extension .\circletex-0.7.3.vsix --force
```

### 使用 / Usage

1. 点击左侧活动栏 **CircleTeX** 图标
2. 在左侧"设置"中选择编辑模式（推荐 **直接编辑**）
3. 运行 `CircleTeX：编译论文` 生成带 SyncTeX 信息的 `main.pdf`
4. 运行 `CircleTeX：打开 PDF 审阅`
5. 点击**铅笔图标**，在 PDF 上直接增删改文字
6. 点击 **应用 N 项并编译**，修改写回源码并重新编译

> 需要 AI 帮助？退出铅笔模式，在底部输入框写要求，点击 **当前助手分析**。

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

---

## 🔒 安全边界 / Security

- 未受信任工作区中**不运行外部进程、不写文件**
- AI 助手运行在**只读沙箱**（Codex）或**隔离临时目录**（Snow），禁用文件系统与终端
- 所有修改**必须人工确认**后才能写入
- 源码自动备份，编译失败自动回滚
- 提示词和论文正文**不写入扩展日志**

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

MIT License — 详见 [LICENSE.txt](LICENSE.txt)

---

<p align="center">
  <sub>Made for thesis writers who want to spend more time writing and less time wrestling with LaTeX.</sub>
  <br />
  <sub>为写论文的人做的。少花时间折腾 LaTeX，多花时间写内容。</sub>
</p>
