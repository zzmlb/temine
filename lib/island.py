#!/usr/bin/env python3
"""
TemineIsland —— 桌面悬浮灵动岛按钮（独立常驻进程，不依赖 Chrome）

行为：
  * 紧凑态：48x48 黑色圆胶囊，中央紫粉光点，置顶、跨工作区可见
  * 鼠标悬停：展开为 130x52 横向胶囊（白字 "Temine"）
  * 点击：调用 Chrome --app=http://localhost:7890 唤出控制面板
  * 拖拽：移动位置，记忆下次启动
  * 右键：退出

依赖：pyobjc-core, pyobjc-framework-Cocoa
   pip3 install --user pyobjc-core pyobjc-framework-Cocoa
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# === 必须先做 framework Python 检查 ===
# PyObjC 的 AppKit GUI 只能在 macOS 自带的 framework Python 下跑
# 如果是 conda / pyenv / venv 的 Python，会立即 SIGTRAP 崩溃
# 检测到非 framework Python 时，自动 re-exec 到 /usr/bin/python3
_SYSTEM_PY = "/usr/bin/python3"
_CLT_PY = "/Library/Developer/CommandLineTools/usr/bin/python3"


def _is_framework_python() -> bool:
    exe = sys.executable or ""
    framework_prefixes = (
        "/usr/bin/",
        "/Library/Developer/CommandLineTools/",
        "/Applications/Xcode.app/",
        "/System/",
    )
    return any(exe.startswith(p) for p in framework_prefixes) or "Python.framework" in exe


if not _is_framework_python():
    target = _SYSTEM_PY if os.path.exists(_SYSTEM_PY) else (_CLT_PY if os.path.exists(_CLT_PY) else None)
    if target:
        os.execv(target, [target, *sys.argv])
    # 找不到系统 Python 就放任原 Python 跑，下面 import objc 会给清晰的错

import objc  # type: ignore[import-not-found]
from AppKit import (  # type: ignore[import-not-found]
    NSApplication,
    NSApp,
    NSBackingStoreBuffered,
    NSColor,
    NSEvent,
    NSFont,
    NSStatusWindowLevel,
    NSTextField,
    NSTextAlignmentLeft,
    NSTrackingActiveAlways,
    NSTrackingArea,
    NSTrackingInVisibleRect,
    NSTrackingMouseEnteredAndExited,
    NSView,
    NSWindow,
    NSWindowCollectionBehaviorCanJoinAllSpaces,
    NSWindowCollectionBehaviorFullScreenAuxiliary,
    NSWindowCollectionBehaviorStationary,
    NSWindowStyleMaskBorderless,
)
from Foundation import NSMakeRect, NSObject, NSPoint  # type: ignore[import-not-found]

PORT = 7890
PANEL_URL = f"http://localhost:{PORT}"
STATE_DIR = Path.home() / ".temine" / "island"
STATE_FILE = STATE_DIR / "state.json"

# 大幅放大 + 加发光 halo，确保任何屏幕上都极其醒目
COMPACT_W, COMPACT_H = 88, 88
EXPANDED_W, EXPANDED_H = 220, 72
DRAG_THRESHOLD_PX = 4
ANIM_FPS = 30


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state))
    except Exception:
        pass


def is_panel_running() -> bool:
    try:
        with urllib.request.urlopen(PANEL_URL, timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def find_temine_bin() -> str | None:
    """查找 temine 命令的绝对路径"""
    for candidate in ("/usr/local/bin/temine", "/opt/homebrew/bin/temine"):
        if os.path.exists(candidate):
            return candidate
    try:
        out = subprocess.check_output(
            ["which", "temine"], encoding="utf-8", stderr=subprocess.DEVNULL
        ).strip()
        if out:
            return out
    except Exception:
        pass
    return None


def ensure_panel_running() -> bool:
    """启动 panel server（如果未运行），等待就绪"""
    if is_panel_running():
        return True
    bin_path = find_temine_bin()
    if not bin_path:
        return False
    env = os.environ.copy()
    env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:" + env.get("PATH", "")
    try:
        subprocess.Popen(
            [bin_path, "panel", str(PORT)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            env=env,
        )
    except Exception:
        return False
    for _ in range(50):
        if is_panel_running():
            return True
        time.sleep(0.1)
    return is_panel_running()


def open_panel_window() -> None:
    """启动 panel server 并用 Chrome app-mode 打开"""
    ensure_panel_running()
    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    try:
        if os.path.exists(chrome):
            subprocess.Popen(
                [chrome, f"--app={PANEL_URL}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        elif os.path.exists(edge):
            subprocess.Popen(
                [edge, f"--app={PANEL_URL}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        else:
            subprocess.Popen(["open", PANEL_URL])
    except Exception:
        pass


# pylint: disable=invalid-name
class IslandView(NSView):
    """
    灵动岛容器视图。

    设计原则：**不重写 drawRect_**。所有视觉用 CALayer 子层 + NSTextField 子视图渲染，
    走 Core Animation 渲染管线（C 路径）；Python 只处理鼠标事件。
    PyObjC 12 + macOS 15 在 layer-backed view 中调 Python drawRect_
    会触发 NSException，所以彻底避开。
    """

    def init(self):  # noqa: D401 - PyObjC 风格
        self = objc.super(IslandView, self).init()
        if self is None:
            return None
        self.expanded = False
        self.tracking_area_added = False
        self.dragging = False
        self.drag_moved = False
        self.drag_start_window_origin = None
        self.drag_start_mouse_global = None
        self.dot_view = None
        self.label_view = None
        return self

    def _setup_layers(self) -> None:
        """初始化主视图 layer + 子视图。仅在 viewDidMoveToWindow 调一次。"""
        self.setWantsLayer_(True)
        layer = self.layer()
        if layer is None:
            return
        # 黑色胶囊背景
        layer.setBackgroundColor_(
            NSColor.colorWithRed_green_blue_alpha_(0.04, 0.03, 0.06, 0.97).CGColor()
        )
        layer.setCornerRadius_(COMPACT_H / 2.0)
        layer.setMasksToBounds_(True)
        # 紫粉描边
        layer.setBorderColor_(
            NSColor.colorWithRed_green_blue_alpha_(0.93, 0.28, 0.60, 0.7).CGColor()
        )
        layer.setBorderWidth_(2.0)

        # 紫粉圆点子视图
        cx = COMPACT_W / 2.0
        cy = COMPACT_H / 2.0
        dot_size = 26.0
        self.dot_view = NSView.alloc().initWithFrame_(
            NSMakeRect(cx - dot_size / 2.0, cy - dot_size / 2.0, dot_size, dot_size)
        )
        self.dot_view.setWantsLayer_(True)
        dot_layer = self.dot_view.layer()
        dot_layer.setBackgroundColor_(
            NSColor.colorWithRed_green_blue_alpha_(0.99, 0.35, 0.70, 1.0).CGColor()
        )
        dot_layer.setCornerRadius_(dot_size / 2.0)
        self.addSubview_(self.dot_view)

        # 文字标签（默认隐藏，展开时显示）
        self.label_view = NSTextField.alloc().initWithFrame_(
            NSMakeRect(48, (EXPANDED_H - 24) / 2.0, EXPANDED_W - 56, 24)
        )
        self.label_view.setStringValue_("Temine 控制面板")
        self.label_view.setBezeled_(False)
        self.label_view.setDrawsBackground_(False)
        self.label_view.setEditable_(False)
        self.label_view.setSelectable_(False)
        self.label_view.setBordered_(False)
        self.label_view.setFont_(NSFont.boldSystemFontOfSize_(14.0))
        self.label_view.setTextColor_(NSColor.colorWithWhite_alpha_(0.98, 1.0))
        self.label_view.setAlignment_(NSTextAlignmentLeft)
        self.label_view.setHidden_(True)
        self.addSubview_(self.label_view)

    def viewDidMoveToWindow(self):
        objc.super(IslandView, self).viewDidMoveToWindow()
        if self.window() is None:
            return
        if not self.tracking_area_added:
            opts = (
                NSTrackingMouseEnteredAndExited
                | NSTrackingActiveAlways
                | NSTrackingInVisibleRect
            )
            ta = NSTrackingArea.alloc().initWithRect_options_owner_userInfo_(
                ((0.0, 0.0), (0.0, 0.0)),
                opts,
                self,
                None,
            )
            self.addTrackingArea_(ta)
            self.tracking_area_added = True
        if self.dot_view is None:
            self._setup_layers()

    def acceptsFirstMouse_(self, _event):
        return True

    def mouseEntered_(self, _event):
        self._set_expanded(True)

    def mouseExited_(self, _event):
        if not self.dragging:
            self._set_expanded(False)

    def _set_expanded(self, expanded: bool) -> None:
        if expanded == self.expanded:
            return
        self.expanded = expanded
        win = self.window()
        if win is None or self.dot_view is None:
            return
        new_w = EXPANDED_W if expanded else COMPACT_W
        new_h = EXPANDED_H if expanded else COMPACT_H
        cur = win.frame()
        new_x = cur.origin.x + (cur.size.width - new_w) / 2.0
        new_y = cur.origin.y + (cur.size.height - new_h) / 2.0
        win.setFrame_display_animate_(
            NSMakeRect(new_x, new_y, new_w, new_h), True, True
        )
        # 更新 layer cornerRadius 与子视图位置
        layer = self.layer()
        if layer is not None:
            layer.setCornerRadius_(new_h / 2.0)
        if expanded:
            # 展开：圆点缩到左侧，文字显示
            dot_size = 14.0
            cx_dot = 22.0
            cy = new_h / 2.0
            self.dot_view.setFrame_(
                NSMakeRect(
                    cx_dot - dot_size / 2.0,
                    cy - dot_size / 2.0,
                    dot_size,
                    dot_size,
                )
            )
            self.dot_view.layer().setCornerRadius_(dot_size / 2.0)
            self.label_view.setFrame_(
                NSMakeRect(40, (new_h - 24) / 2.0, new_w - 48, 24)
            )
            self.label_view.setHidden_(False)
        else:
            # 紧凑：圆点回到中央放大，文字隐藏
            self.label_view.setHidden_(True)
            dot_size = 26.0
            cx = new_w / 2.0
            cy = new_h / 2.0
            self.dot_view.setFrame_(
                NSMakeRect(
                    cx - dot_size / 2.0,
                    cy - dot_size / 2.0,
                    dot_size,
                    dot_size,
                )
            )
            self.dot_view.layer().setCornerRadius_(dot_size / 2.0)

    def mouseDown_(self, _event):
        win = self.window()
        if win is None:
            return
        self.dragging = True
        self.drag_moved = False
        self.drag_start_window_origin = win.frame().origin
        self.drag_start_mouse_global = NSEvent.mouseLocation()

    def mouseDragged_(self, _event):
        if not self.dragging or self.drag_start_mouse_global is None:
            return
        cur = NSEvent.mouseLocation()
        dx = cur.x - self.drag_start_mouse_global.x
        dy = cur.y - self.drag_start_mouse_global.y
        if not self.drag_moved and (
            abs(dx) > DRAG_THRESHOLD_PX or abs(dy) > DRAG_THRESHOLD_PX
        ):
            self.drag_moved = True
        win = self.window()
        if win is None:
            return
        new_origin = NSPoint(
            self.drag_start_window_origin.x + dx,
            self.drag_start_window_origin.y + dy,
        )
        win.setFrameOrigin_(new_origin)

    def mouseUp_(self, _event):
        if self.drag_moved:
            win = self.window()
            if win is not None:
                origin = win.frame().origin
                save_state({"x": float(origin.x), "y": float(origin.y)})
        else:
            open_panel_window()
        self.dragging = False
        self.drag_start_mouse_global = None
        self.drag_moved = False

    def rightMouseDown_(self, _event):
        NSApplication.sharedApplication().terminate_(None)


# pylint: disable=invalid-name
class AppDelegate(NSObject):
    def applicationDidFinishLaunching_(self, _notification):
        state = load_state()
        # 默认放在屏幕**正上方居中**（macOS 灵动岛位置），最显眼最直觉
        from AppKit import NSScreen  # type: ignore[import-not-found]

        screen = NSScreen.mainScreen()
        visible = screen.visibleFrame() if screen else None
        if visible:
            default_x = visible.origin.x + (visible.size.width - COMPACT_W) / 2.0
            # macOS 坐标 Y 轴向上：visible.size.height 顶部留 24 像素
            default_y = visible.origin.y + visible.size.height - COMPACT_H - 24
        else:
            default_x, default_y = 800, 1000
        x = float(state.get("x", default_x))
        y = float(state.get("y", default_y))
        rect = NSMakeRect(x, y, COMPACT_W, COMPACT_H)

        self.window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect,
            NSWindowStyleMaskBorderless,
            NSBackingStoreBuffered,
            False,
        )
        self.window.setBackgroundColor_(NSColor.clearColor())
        self.window.setOpaque_(False)
        self.window.setHasShadow_(True)
        self.window.setLevel_(NSStatusWindowLevel)
        self.window.setCollectionBehavior_(
            NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorFullScreenAuxiliary
        )
        self.window.setIgnoresMouseEvents_(False)
        self.window.setMovable_(False)  # 自己处理拖拽

        view = IslandView.alloc().initWithFrame_(
            NSMakeRect(0, 0, COMPACT_W, COMPACT_H)
        )
        self.window.setContentView_(view)
        self.window.makeKeyAndOrderFront_(None)

    def applicationShouldTerminateAfterLastWindowClosed_(self, _sender):
        return True


def main() -> None:
    # 关闭"NSException 直接 crash 进程"行为，让 Python 异常能正常 traceback
    try:
        from AppKit import NSUserDefaults  # type: ignore[import-not-found]

        NSUserDefaults.standardUserDefaults().setBool_forKey_(
            False, "NSApplicationCrashOnExceptions"
        )
    except Exception:
        pass

    # 防止重复启动：用 PID 文件
    pid_file = STATE_DIR / "island.pid"
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        if pid_file.exists():
            try:
                old_pid = int(pid_file.read_text().strip())
                os.kill(old_pid, 0)
                # 旧进程仍在跑，退出
                print("TemineIsland 已经在运行 (pid=%d)" % old_pid, file=sys.stderr)
                return
            except Exception:
                pass
        pid_file.write_text(str(os.getpid()))
    except Exception:
        pass

    app = NSApplication.sharedApplication()
    delegate = AppDelegate.alloc().init()
    app.setDelegate_(delegate)
    app.activateIgnoringOtherApps_(True)
    try:
        app.run()
    finally:
        try:
            pid_file.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    main()
