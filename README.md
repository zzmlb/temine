# Temine

> AI 编程终端管理工具 / Terminal management tool for AI coding workflows

[![npm version](https://img.shields.io/npm/v/temine.svg)](https://www.npmjs.com/package/temine)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://www.apple.com/macos)

[中文](#中文) | [English](#english)

---

## 中文

### Temine 是什么？

Temine 是一个专为 AI 编程场景设计的终端管理工具。当你同时运行多个 Claude Code / AI CLI 窗口时，Temine 帮你解决窗口管理的混乱：

- **智能窗口排布** — 一键打开多个终端并自动排列
- **AI 状态检测** — 实时监控 Claude 运行状态（运行中 / 空闲 / 等待确认）
- **系统通知** — AI 需要确认时弹出通知提醒
- **Web 控制面板** — 在浏览器中管理所有终端
- **稳定编号** — 窗口编号固定不变，不因切换焦点而改变
- **输出记录** — 保存和搜索终端输出历史
- **局部屏幕排布** — 终端只占屏幕一半、三分之二等区域
- **窗口标签** — 给终端命名，自动匹配图标

### 安装

```bash
npm install -g temine
```

或克隆到本地：

```bash
git clone https://github.com/zzmlb/temine.git
cd temine
npm link
```

### 快速开始

```bash
# 打开 4 个终端窗口并自动排列
temine open 4

# 启动 AI 状态监控
temine watch

# 启动 Web 控制面板（默认端口 7890）
temine panel

# 浏览器打开 http://localhost:7890
```

### 命令列表

| 命令 | 说明 |
|------|------|
| `temine open <数量>` | 打开多个终端并自动排列 |
| `temine arrange` | 重新排布已有终端窗口 |
| `temine arrange --layout 3x2` | 使用预设布局排列 |
| `temine arrange layouts` | 查看所有布局预设 |
| `temine list` | 列出所有终端窗口 |
| `temine label <编号> <名称>` | 给窗口命名（自动匹配图标） |
| `temine label-all <名1> <名2> ...` | 批量命名所有窗口 |
| `temine watch` | 启动 AI 状态监控 |
| `temine status` | 查看监控状态 |
| `temine stop` | 停止监控 |
| `temine float` | 终端内状态浮窗 |
| `temine panel [端口]` | 启动 Web 控制面板（默认 7890） |
| `temine log list` | 列出记录的会话 |
| `temine log show <ID> [行数]` | 查看输出历史 |
| `temine log search <关键词>` | 搜索历史记录 |
| `temine log export <ID> [文件]` | 导出记录 |
| `temine config` | 查看配置 |
| `temine config set <key> <val>` | 修改配置 |
| `temine config reset` | 重置默认配置 |

### 参数选项

```bash
temine open 6 --cols 3          # 3 列布局
temine open 4 --app iTerm       # 使用 iTerm 而非 Terminal
temine open 4 --gap 10          # 窗口间距 10 像素
temine arrange --cols 2         # 重新排成 2 列
```

### Web 控制面板功能

通过 `temine panel` 启动的 Web 面板提供：

- **控制面板** — 查看所有终端状态（运行中 / 空闲 / 等待确认）
- **输出记录** — 保存、查看、导出、管理终端输出快照
- **屏幕区域** — 选择全屏、左半、右半、左⅔ 等区域排布
- **双击跳转** — 双击卡片跳转到对应终端窗口（带弹跳动画）
- **在线重命名** — 直接在浏览器中修改终端标签
- **布局选择** — 选择网格布局（2x1、3x2、1+2 等）

### AI 状态检测说明

Temine 通过分析终端输出内容检测 AI 工具的工作状态：

| 状态 | 指示 | 含义 |
|------|------|------|
| 🟢 运行中 | 绿色 | AI 正在输出内容 |
| 🟡 空闲 | 黄色 | 终端空闲，等待用户输入 |
| 🔴 等待确认 | 红色 | AI 需要用户确认（Y/N） |
| ✅ 已完成 | 蓝色 | 任务完成 |
| ❌ 错误 | 红色 | 检测到错误 |

### 系统要求

- **macOS**（使用 AppleScript 控制终端）
- **Node.js** >= 18.0.0
- **Terminal.app** 或 **iTerm2**

### 工作原理

Temine 利用 macOS AppleScript 与 Terminal.app / iTerm2 交互：
- 读取终端内容检测 AI 状态
- 控制窗口位置和大小实现排布
- 设置自定义窗口标题实现标签功能
- 通过 JXA 调用 `NSScreen.visibleFrame` 精确获取可用屏幕区域

---

## English

### What is Temine?

Temine is a terminal management tool built for developers who run multiple AI CLI sessions (like Claude Code) in parallel. It solves the chaos of managing many terminal windows by providing:

- **Smart window arrangement** — Open and tile terminal windows with one command
- **AI state detection** — Know when Claude is running, idle, or waiting for confirmation
- **System notifications** — Get notified when AI needs your input
- **Web dashboard** — Control all terminals from a browser panel
- **Stable numbering** — Windows keep their numbers even when focus changes
- **Output recording** — Save and search terminal output history
- **Partial screen layouts** — Arrange terminals in half-screen, two-thirds, etc.
- **Window labels** — Name your terminals with auto-matched icons

### Installation

```bash
npm install -g temine
```

Or clone and link locally:

```bash
git clone https://github.com/zzmlb/temine.git
cd temine
npm link
```

### Quick Start

```bash
# Open 4 terminal windows, auto-arranged
temine open 4

# Start AI state monitoring
temine watch

# Launch web control panel (default port 7890)
temine panel

# Open browser to http://localhost:7890
```

### Commands

| Command | Description |
|---------|-------------|
| `temine open <N>` | Open N terminal windows and auto-arrange |
| `temine arrange` | Re-arrange existing terminal windows |
| `temine arrange --layout 3x2` | Arrange using preset layout |
| `temine arrange layouts` | Show all available layout presets |
| `temine list` | List all terminal windows |
| `temine label <N> <name>` | Name a window (auto icon matching) |
| `temine label-all <n1> <n2> ...` | Name all windows at once |
| `temine watch` | Start AI state monitoring |
| `temine status` | Show monitoring status |
| `temine stop` | Stop monitoring |
| `temine float` | Show terminal status panel (TUI) |
| `temine panel [port]` | Launch web dashboard (default: 7890) |
| `temine log list` | List recorded sessions |
| `temine log show <ID>` | View output history |
| `temine log search <keyword>` | Search history |
| `temine log export <ID> [file]` | Export log to file |
| `temine config` | View configuration |
| `temine config set <key> <val>` | Set configuration value |
| `temine config reset` | Reset to defaults |

### Options

```bash
temine open 6 --cols 3          # 3 columns layout
temine open 4 --app iTerm       # Use iTerm instead of Terminal
temine open 4 --gap 10          # 10px gap between windows
temine arrange --cols 2         # Re-arrange in 2 columns
```

### Web Dashboard Features

The web dashboard (`temine panel`) provides:

- **Control Panel** — View all terminals with status indicators (running/idle/waiting)
- **Output Records** — Save, view, export, and manage terminal output snapshots
- **Screen Regions** — Arrange windows in full screen, left/right half, two-thirds, etc.
- **Double-click** — Jump to any terminal window with visual feedback
- **Label editing** — Rename terminals directly from the browser
- **Layout selection** — Choose grid layouts (2x1, 3x2, 1+2, etc.)

### AI State Detection

Temine detects the state of AI CLI tools by analyzing terminal output:

| State | Indicator | Meaning |
|-------|-----------|---------|
| 🟢 Running | Green | AI is actively generating output |
| 🟡 Idle | Yellow | Terminal is idle, waiting for input |
| 🔴 Waiting | Red | AI needs confirmation (Y/N prompt) |
| ✅ Completed | Blue | Task completed |
| ❌ Error | Red | Error detected |

### Requirements

- **macOS** (uses AppleScript for terminal control)
- **Node.js** >= 18.0.0
- **Terminal.app** or **iTerm2**

### How It Works

Temine uses macOS AppleScript to interact with Terminal.app/iTerm2:
- Reads terminal content to detect AI states
- Controls window position and size for arrangement
- Sets custom window titles for labeling
- Uses `NSScreen.visibleFrame` (via JXA) for accurate screen detection

---

## License

MIT License - see [LICENSE](LICENSE) for details.

## Author

**zzm** — [GitHub](https://github.com/zzmlb)
