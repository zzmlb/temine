# Temine

> **macOS 上的 AI 终端编排器 + Dynamic Island 浮岛**
>
> 一键打开 / 排布多个 Claude Code 窗口；桌面右上的小胶囊浮岛 toggle Web 面板、整理 Chrome、批量排布终端。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://www.apple.com/macos)
[![Version](https://img.shields.io/badge/version-0.15.2-blue.svg)]()

[中文](#中文) | [English](#english)

---

## 中文

### 是什么

当你同时跑多个 Claude Code / AI CLI 时，Temine 解决：

- **多终端排布** — 一键开 N 个终端窗口并自动排列
- **AI 状态检测** — 实时识别运行中 / 空闲 / 等待确认
- **Dynamic Island 浮岛** — 桌面右上小胶囊，3 个常用动作一键直达
- **Chrome 窗口管理** — 列窗口、聚焦、桌面堆叠
- **Web 控制面板** — 浏览器统一管控
- **SSH 快捷启动** — 项目预设一键批量打开远程终端

### 安装

```bash
npm install -g github:zzmlb/temine
```

### 快速开始

```bash
# 生成 Temine.app 放到 Dock（推荐，最常用入口）
sudo temine app

# 启动 Dynamic Island 浮岛
temine island

# 直接启动 Web 面板（默认 7890）
temine panel
```

### Dynamic Island 浮岛（macOS）

桌面右上的胶囊浮岛，平时灵动呼吸；hover 展开后 3 个按钮：

| 按钮 | 行为 |
|------|------|
| 📋 **Panel** | toggle Web 控制面板（开了再点就关） |
| 🪟 **Chrome** | 把所有 Chrome 窗口整齐桌面堆叠 |
| 📐 **Arrange** | 按预设序列循环排布终端窗口 |

随手能玩的山洞探险像素动画（CALayer GPU 加速，零 CPU），可在面板"灵动岛配置"里关闭。

### Web 面板

`temine panel` 启动 → 浏览器打开 http://localhost:7890

| Tab | 用途 |
|-----|------|
| **控制面板** | 总览所有终端 + 状态指示 + 在线排布 / 重命名 / 互换 |
| **Chrome 窗口** | 列出 Chrome 所有窗口、聚焦、桌面堆叠 |
| **快捷启动** | SSH 连接管理 + 项目预设 + 批量打开远程终端 |
| **灵动岛配置** | 编辑 Arrange 序列、动画开关 |

> 另有 records tab 用于回看终端输出/命令历史，按需启用。

### 常用命令

```bash
temine open <N>         # 开 N 个终端并自动排布
temine arrange          # 重新排布已有窗口
temine list             # 列出所有终端窗口
temine label <N> <名>    # 给窗口命名（自动匹配图标）
temine watch            # 启动 AI 状态监控
temine panel [端口]      # 启动 Web 面板（默认 7890）
temine island           # 启动 Dynamic Island 浮岛
temine app              # 生成 Temine.app 到 Dock
```

完整命令：`temine --help`

### 系统要求

- macOS (AppleScript + PyObjC)
- Node.js >= 18.0.0
- Terminal.app 或 iTerm2
- Google Chrome（面板 / Chrome 管理功能）

---

## English

### What is Temine?

A macOS terminal orchestrator with a Dynamic Island floating button. Open/tile multiple Claude Code windows, manage Chrome, and trigger common actions from the desktop.

- **Multi-terminal arrangement** — Open N windows, auto-tiled
- **AI state detection** — Running / idle / waiting-confirm
- **Dynamic Island** — Pill-shaped floater on the desktop, 3 quick actions
- **Chrome management** — List, focus, desktop-stack windows
- **Web dashboard** — Manage everything from a browser
- **SSH quick launch** — Batch-open remote terminals from presets

### Install

```bash
npm install -g github:zzmlb/temine
```

### Quick start

```bash
sudo temine app          # Drop Temine.app into Dock
temine island            # Start the Dynamic Island
temine panel             # Web dashboard at :7890
```

### Dynamic Island (macOS)

A small breathing pill at the top-right of your desktop. Hover to expand 3 buttons:

| Button | Action |
|--------|--------|
| 📋 Panel | toggle the web dashboard |
| 🪟 Chrome | desktop-stack all Chrome windows |
| 📐 Arrange | cycle through preset terminal layouts |

Includes an optional pixel-art cave-adventure animation (GPU-accelerated, zero CPU). Toggle in the dashboard.

### Web dashboard

`temine panel` → open http://localhost:7890

| Tab | Purpose |
|-----|---------|
| **Control** | Overview + state + arrange / rename / swap |
| **Chrome** | List Chrome windows, focus, stack |
| **Quick Launch** | SSH presets, batch-open remote terminals |
| **Island Config** | Edit Arrange sequence, animation toggle |

> A `records` tab is also available for terminal output/command playback. Off by default.

### Requirements

- macOS (uses AppleScript + PyObjC)
- Node.js >= 18.0.0
- Terminal.app or iTerm2
- Google Chrome (for panel & Chrome management)

---

## License

MIT — see [LICENSE](LICENSE).

## Author

**zzm** — [GitHub](https://github.com/zzmlb)
