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
    NSAttributedString,
    NSBackingStoreBuffered,
    NSBezierPath,
    NSColor,
    NSEvent,
    NSFont,
    NSFontAttributeName,
    NSForegroundColorAttributeName,
    NSGradient,
    NSStatusWindowLevel,
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
from Foundation import NSMakeRect, NSObject, NSPoint, NSTimer  # type: ignore[import-not-found]

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
    """灵动岛自定义 NSView：渲染胶囊、捕获鼠标"""

    def init(self):  # noqa: D401 - PyObjC 风格
        self = objc.super(IslandView, self).init()
        if self is None:
            return None
        self.expanded = False
        self.tracking_area = None
        self.dragging = False
        self.drag_moved = False
        self.drag_start_window_origin = None
        self.drag_start_mouse_global = None
        # 动画相关
        self.phase = 0.0
        self.start_flash_until = time.time() + 2.5  # 启动后 2.5 秒疯狂闪烁吸引视线
        self.anim_timer = None
        return self

    def viewDidMoveToWindow(self):
        objc.super(IslandView, self).viewDidMoveToWindow()
        # 启动定时器驱动呼吸动画
        if self.anim_timer is None:
            self.anim_timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                1.0 / ANIM_FPS, self, b"tick:", None, True
            )

    def tick_(self, _timer):
        self.phase = (self.phase + 1.0 / ANIM_FPS) % 100.0
        self.setNeedsDisplay_(True)

    def acceptsFirstMouse_(self, _event):
        return True

    def updateTrackingAreas(self):
        # NSView 文档要求子类先调 super.updateTrackingAreas()，否则 AppKit 在
        # macOS 14+ 会抛 NSInternalInconsistencyException 并 crash 进程
        objc.super(IslandView, self).updateTrackingAreas()
        if self.tracking_area is not None:
            self.removeTrackingArea_(self.tracking_area)
        opts = (
            NSTrackingMouseEnteredAndExited
            | NSTrackingActiveAlways
            | NSTrackingInVisibleRect
        )
        self.tracking_area = NSTrackingArea.alloc().initWithRect_options_owner_userInfo_(
            self.bounds(), opts, self, None
        )
        self.addTrackingArea_(self.tracking_area)

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
        if win is None:
            return
        new_w = EXPANDED_W if expanded else COMPACT_W
        new_h = EXPANDED_H if expanded else COMPACT_H
        cur = win.frame()
        new_x = cur.origin.x + (cur.size.width - new_w) / 2.0
        new_y = cur.origin.y + (cur.size.height - new_h) / 2.0
        win.setFrame_display_animate_(
            NSMakeRect(new_x, new_y, new_w, new_h), True, True
        )
        self.setFrameSize_((new_w, new_h))
        self.setNeedsDisplay_(True)

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
        # 右键 = 退出灵动岛
        NSApplication.sharedApplication().terminate_(None)

    def drawRect_(self, _rect):
        import math

        bounds = self.bounds()
        radius = bounds.size.height / 2.0

        # 启动后 2.5 秒：每秒闪烁 5 次（脉冲），让用户绝对找得到
        now = time.time()
        flashing = now < self.start_flash_until
        flash_intensity = 0.0
        if flashing:
            flash_intensity = abs(math.sin(now * 5.0 * math.pi))

        # 呼吸相位：0..1
        breathe = 0.5 + 0.5 * math.sin(self.phase * math.pi * 1.2)

        # === 外层发光 halo —— 让按钮在远处也能被注意到 ===
        # 用多层径向圆叠加模拟发光（PyObjC 没有直接的 box-shadow）
        cx = bounds.size.width / 2.0
        cy = bounds.size.height / 2.0
        halo_intensity = 0.35 + 0.25 * breathe + 0.4 * flash_intensity
        for i in range(6, 0, -1):
            alpha = halo_intensity * (i / 6.0) * 0.18
            halo_radius = radius + i * 6
            halo_rect = NSMakeRect(
                cx - halo_radius, cy - halo_radius, halo_radius * 2, halo_radius * 2
            )
            halo_path = NSBezierPath.bezierPathWithOvalInRect_(halo_rect)
            NSColor.colorWithRed_green_blue_alpha_(0.93, 0.28, 0.60, alpha).setFill()
            halo_path.fill()

        # === 主胶囊背景 ===
        path = NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(
            bounds, radius, radius
        )
        if self.expanded:
            grad = NSGradient.alloc().initWithStartingColor_endingColor_(
                NSColor.colorWithRed_green_blue_alpha_(0.05, 0.04, 0.08, 0.98),
                NSColor.colorWithRed_green_blue_alpha_(0.10, 0.06, 0.16, 0.98),
            )
            grad.drawInBezierPath_angle_(path, 135.0)
        else:
            NSColor.colorWithRed_green_blue_alpha_(0.03, 0.02, 0.04, 0.97).setFill()
            path.fill()
        # 高光描边（启动闪烁时变亮）
        path.setLineWidth_(1.5 + flash_intensity * 1.5)
        edge_alpha = 0.12 + 0.4 * flash_intensity + 0.15 * breathe
        NSColor.colorWithRed_green_blue_alpha_(1.0, 0.5, 0.8, edge_alpha).setStroke()
        path.stroke()

        if not self.expanded:
            # 紧凑态：放大的中央紫粉光球（呼吸 + 闪烁）
            dot_size = 22.0 + 4.0 * breathe + 6.0 * flash_intensity
            dot_rect = NSMakeRect(
                cx - dot_size / 2.0, cy - dot_size / 2.0, dot_size, dot_size
            )
            dot_path = NSBezierPath.bezierPathWithOvalInRect_(dot_rect)
            grad = NSGradient.alloc().initWithStartingColor_endingColor_(
                NSColor.colorWithRed_green_blue_alpha_(0.55, 0.55, 1.0, 1.0),  # 浅紫
                NSColor.colorWithRed_green_blue_alpha_(0.99, 0.35, 0.70, 1.0),  # 亮粉
            )
            grad.drawInBezierPath_angle_(dot_path, 135.0)
            # 内部高光小点（让球看起来"湿润"）
            hl_size = dot_size * 0.35
            hl_rect = NSMakeRect(
                cx - hl_size / 2.0 - dot_size * 0.15,
                cy + dot_size * 0.10,
                hl_size,
                hl_size,
            )
            hl_path = NSBezierPath.bezierPathWithOvalInRect_(hl_rect)
            NSColor.colorWithWhite_alpha_(1.0, 0.55).setFill()
            hl_path.fill()
        else:
            # 展开态：左侧光点 + 文字
            cx_dot = 22.0
            cy_d = bounds.size.height / 2.0
            dot_size = 14.0 + 2.0 * breathe
            dot_rect = NSMakeRect(
                cx_dot - dot_size / 2.0, cy_d - dot_size / 2.0, dot_size, dot_size
            )
            dot_path = NSBezierPath.bezierPathWithOvalInRect_(dot_rect)
            grad = NSGradient.alloc().initWithStartingColor_endingColor_(
                NSColor.colorWithRed_green_blue_alpha_(0.55, 0.55, 1.0, 1.0),
                NSColor.colorWithRed_green_blue_alpha_(0.99, 0.35, 0.70, 1.0),
            )
            grad.drawInBezierPath_angle_(dot_path, 135.0)

            # 文字
            font = NSFont.boldSystemFontOfSize_(15.0)
            text = "Temine 控制面板"
            attrs = {
                NSForegroundColorAttributeName: NSColor.colorWithWhite_alpha_(0.98, 1.0),
                NSFontAttributeName: font,
            }
            astr = NSAttributedString.alloc().initWithString_attributes_(text, attrs)
            sz = astr.size()
            tx = cx_dot + dot_size / 2.0 + 10.0
            ty = (bounds.size.height - sz.height) / 2.0
            astr.drawAtPoint_(NSPoint(tx, ty))


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
