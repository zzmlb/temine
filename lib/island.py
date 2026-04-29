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
    NSButton,
    NSColor,
    NSEvent,
    NSFont,
    NSImage,
    NSImageOnly,
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
from Foundation import NSMakeRect, NSObject, NSPoint  # type: ignore[import-not-found]

PORT = 7890
PANEL_URL = f"http://localhost:{PORT}"
STATE_DIR = Path.home() / ".temine" / "island"
STATE_FILE = STATE_DIR / "state.json"

# 紧凑/展开**高度必须相同**，否则鼠标会在垂直方向出展开窗口边界，引发抖动
COMPACT_W, COMPACT_H = 110, 48
EXPANDED_W, EXPANDED_H = 200, 48
DRAG_THRESHOLD_PX = 4
COLLAPSE_DELAY_SEC = 0.15  # 鼠标退出后延迟收缩，防抖

# 展开态两个按钮的位置（相对窗口左下角）
BTN_SIZE = 36
BTN_Y = (EXPANDED_H - BTN_SIZE) / 2.0  # 6
BTN1_X = 20.0   # 按钮1：开/关控制面板
BTN2_X = 144.0  # 按钮2：触发自动排布


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


# 排布序列：每次按按钮 2 循环切换到下一个
ARRANGE_SEQUENCE = [
    {"name": "全屏", "region": "full", "cols": 0},
    {"name": "上 1/2", "region": "top-half", "cols": 0},
    {"name": "上 2/3", "region": "top-2-3", "cols": 0},
    {"name": "下 1/2", "region": "bottom-half", "cols": 0},
    {"name": "左 1/2", "region": "left-half", "cols": 0},
    {"name": "右 1/2", "region": "right-half", "cols": 0},
    {"name": "左 2/3", "region": "left-2-3", "cols": 0},
]


def trigger_arrange(region: str = "full", cols: int = 0) -> None:
    """调用控制面板的 /api/arrange 接口，按指定 region 排布"""
    if not ensure_panel_running():
        return
    try:
        body = json.dumps({"cols": cols, "region": region}).encode("utf-8")
        req = urllib.request.Request(
            f"{PANEL_URL}/api/arrange",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            r.read()
    except Exception as e:
        print(f"[island] arrange failed: {e}", file=sys.stderr)


# === Chrome 窗口 toggle 支持 ===
def _osa(script: str, timeout: float = 3.0) -> str:
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=timeout,
        )
        return r.stdout.strip()
    except Exception:
        return ""


def is_chrome_panel_open() -> bool:
    """检查 Chrome 是否有 http://localhost:7890 的窗口"""
    script = '''
try
    tell application "System Events"
        if not (exists process "Google Chrome") then return "false"
    end tell
    tell application "Google Chrome"
        repeat with w in windows
            try
                if (count of tabs of w) > 0 then
                    if URL of active tab of w starts with "http://localhost:7890" then
                        return "true"
                    end if
                end if
            end try
        end repeat
    end tell
    return "false"
on error
    return "false"
end try
'''
    return _osa(script) == "true"


def close_chrome_panel() -> None:
    """关闭所有 URL 含 localhost:7890 的 Chrome 窗口"""
    script = '''
try
    tell application "Google Chrome"
        set windowsToClose to {}
        repeat with w in windows
            try
                if (count of tabs of w) > 0 then
                    if URL of active tab of w starts with "http://localhost:7890" then
                        set end of windowsToClose to w
                    end if
                end if
            end try
        end repeat
        repeat with w in windowsToClose
            try
                close w
            end try
        end repeat
    end tell
end try
'''
    _osa(script)


def toggle_panel_window() -> None:
    """开了就关，关了就开"""
    if is_chrome_panel_open():
        close_chrome_panel()
    else:
        open_panel_window()


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

    def initWithFrame_(self, frame):  # noqa: D401 - PyObjC 风格
        self = objc.super(IslandView, self).initWithFrame_(frame)
        if self is None:
            return None
        self.expanded = False
        self.tracking_area_added = False
        self.dragging = False
        self.drag_moved = False
        self.drag_start_window_origin = None
        self.drag_start_mouse_global = None
        self.dot_view = None
        self.panel_btn = None
        self.arrange_btn = None
        self.arrange_idx = 0  # 排布序列当前索引
        self.setWantsLayer_(True)
        print(f"[island] IslandView initWithFrame_ OK, frame={frame}", file=sys.stderr)
        return self

    def _setup_layers(self) -> None:
        """初始化主视图 layer + 子视图。仅在 viewDidMoveToWindow 调一次。"""
        try:
            self.setWantsLayer_(True)
            layer = self.layer()
            print(f"[island] _setup_layers: layer={layer}", file=sys.stderr)
            if layer is None:
                print("[island] WARNING: self.layer() is None after setWantsLayer", file=sys.stderr)
                return
            # 用系统预定义色，避免 NSColor.colorWithRed_...CGColor 在某些组合下出问题
            layer.setBackgroundColor_(NSColor.blackColor().CGColor())
            print("[island] backgroundColor set", file=sys.stderr)
            layer.setCornerRadius_(COMPACT_H / 2.0)
            layer.setMasksToBounds_(True)
            layer.setBorderColor_(NSColor.systemPinkColor().CGColor())
            layer.setBorderWidth_(3.0)
            print(f"[island] _setup_layers OK, layer.bounds={layer.bounds()}", file=sys.stderr)
        except Exception as e:
            import traceback
            print(f"[island] _setup_layers EXCEPTION: {type(e).__name__}: {e}", file=sys.stderr)
            traceback.print_exc()

        try:
            # 紫粉圆点子视图（紧凑态居中）
            cx = COMPACT_W / 2.0
            cy = COMPACT_H / 2.0
            dot_size = 16.0
            self.dot_view = NSView.alloc().initWithFrame_(
                NSMakeRect(cx - dot_size / 2.0, cy - dot_size / 2.0, dot_size, dot_size)
            )
            self.dot_view.setWantsLayer_(True)
            dot_layer = self.dot_view.layer()
            if dot_layer is not None:
                dot_layer.setBackgroundColor_(NSColor.systemPinkColor().CGColor())
                dot_layer.setCornerRadius_(dot_size / 2.0)
            self.addSubview_(self.dot_view)
            print("[island] dot_view added", file=sys.stderr)

            # 按钮 1：开/关控制面板（SF Symbol "macwindow"）
            self.panel_btn = self._make_button(
                ["macwindow", "macwindow.on.rectangle"],
                "▢",
                BTN1_X,
                b"onClickPanel:",
            )
            self.addSubview_(self.panel_btn)

            # 按钮 2：循环切换排布（SF Symbol "rectangle.split.3x1"）
            self.arrange_btn = self._make_button(
                ["rectangle.3.group.fill", "square.grid.3x1.below.line.grid.1x2"],
                "⊞",
                BTN2_X,
                b"onClickArrange:",
            )
            self.addSubview_(self.arrange_btn)
            print("[island] buttons added", file=sys.stderr)
        except Exception as e:
            import traceback
            print(f"[island] subviews EXCEPTION: {type(e).__name__}: {e}", file=sys.stderr)
            traceback.print_exc()

    def _make_button(self, sf_symbol_candidates, fallback_char: str, x: float, action: bytes):
        """
        创建灵动岛风格按钮：
        - 透明背景，hover 时背景变浅（在 mouseDown 处理）
        - SF Symbol 图标（系统色 = 白），优雅简洁
        - 失败时回退到单字符
        """
        btn = NSButton.alloc().initWithFrame_(
            NSMakeRect(x, BTN_Y, BTN_SIZE, BTN_SIZE)
        )
        btn.setBordered_(False)
        btn.setWantsLayer_(True)
        layer = btn.layer()
        if layer is not None:
            # 默认透明，hover/click 时通过子层或动画反馈
            layer.setBackgroundColor_(
                NSColor.colorWithWhite_alpha_(1.0, 0.06).CGColor()
            )
            layer.setCornerRadius_(BTN_SIZE / 2.0)
            # 极薄高光描边
            layer.setBorderColor_(
                NSColor.colorWithWhite_alpha_(1.0, 0.16).CGColor()
            )
            layer.setBorderWidth_(0.5)
        # 尝试 SF Symbol（macOS 11+）
        img = None
        for name in sf_symbol_candidates:
            try:
                candidate = NSImage.imageWithSystemSymbolName_accessibilityDescription_(name, None)
                if candidate is not None:
                    img = candidate
                    break
            except Exception:
                continue
        if img is not None:
            btn.setImage_(img)
            btn.setImagePosition_(NSImageOnly)
            try:
                btn.setContentTintColor_(NSColor.whiteColor())
            except Exception:
                pass
        else:
            btn.setTitle_(fallback_char)
            btn.setFont_(NSFont.boldSystemFontOfSize_(16.0))
        btn.setTarget_(self)
        btn.setAction_(action)
        btn.setHidden_(True)
        return btn

    def onClickPanel_(self, _sender):
        toggle_panel_window()

    def onClickArrange_(self, _sender):
        # 循环到下一个排布
        idx = self.arrange_idx % len(ARRANGE_SEQUENCE)
        item = ARRANGE_SEQUENCE[idx]
        print(f"[island] arrange → {item['name']} ({item['region']})", file=sys.stderr)
        trigger_arrange(region=item["region"], cols=item["cols"])
        self.arrange_idx = (idx + 1) % len(ARRANGE_SEQUENCE)

    def viewDidMoveToWindow(self):
        try:
            objc.super(IslandView, self).viewDidMoveToWindow()
            print(f"[island] viewDidMoveToWindow called, window={self.window()}", file=sys.stderr)
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
                print("[island] tracking area added", file=sys.stderr)
            if self.dot_view is None:
                self._setup_layers()
        except Exception as e:
            import traceback
            print(f"[island] viewDidMoveToWindow EXCEPTION: {type(e).__name__}: {e}", file=sys.stderr)
            traceback.print_exc()

    def acceptsFirstMouse_(self, _event):
        return True

    def mouseEntered_(self, _event):
        # 取消任何待执行的收缩
        NSObject.cancelPreviousPerformRequestsWithTarget_selector_object_(
            self, b"_doCollapse:", None
        )
        self._set_expanded(True)

    def mouseExited_(self, _event):
        if self.dragging:
            return
        # 延迟收缩，避免展开/收缩动画期间鼠标短暂跨越边界引发抖动
        self.performSelector_withObject_afterDelay_(
            b"_doCollapse:", None, COLLAPSE_DELAY_SEC
        )

    def _doCollapse_(self, _arg):
        # 收缩前再次确认鼠标确实在窗口外
        win = self.window()
        if win is None or self.dragging:
            return
        cur = NSEvent.mouseLocation()
        f = win.frame()
        if (f.origin.x <= cur.x <= f.origin.x + f.size.width and
                f.origin.y <= cur.y <= f.origin.y + f.size.height):
            return  # 鼠标还在窗口内，不收缩
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
            # 展开：圆点隐藏，两个按钮显示
            self.dot_view.setHidden_(True)
            self.panel_btn.setHidden_(False)
            self.arrange_btn.setHidden_(False)
        else:
            # 紧凑：圆点居中，按钮隐藏
            self.panel_btn.setHidden_(True)
            self.arrange_btn.setHidden_(True)
            self.dot_view.setHidden_(False)
            dot_size = 16.0
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
        elif not self.expanded:
            # 紧凑态点击 = 默认动作（开/关 Chrome 面板）
            # 展开态点击由按钮处理，IslandView 不处理 click
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
        print(f"[island] screen visible={visible}", file=sys.stderr)
        print(f"[island] window will be at x={x} y={y} w={COMPACT_W} h={COMPACT_H}", file=sys.stderr)

        try:
            self.window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
                rect,
                NSWindowStyleMaskBorderless,
                NSBackingStoreBuffered,
                False,
            )
            print(f"[island] NSWindow created: {self.window}", file=sys.stderr)
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
            self.window.setMovable_(False)
            print("[island] window props set, creating view…", file=sys.stderr)

            view = IslandView.alloc().initWithFrame_(
                NSMakeRect(0, 0, COMPACT_W, COMPACT_H)
            )
            print(f"[island] view created: {view}", file=sys.stderr)
            self.window.setContentView_(view)
            print("[island] setContentView OK", file=sys.stderr)
            self.window.makeKeyAndOrderFront_(None)
            print("[island] makeKeyAndOrderFront OK", file=sys.stderr)
            NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
            actual_frame = self.window.frame()
            print(f"[island] window actual frame={actual_frame} visible={self.window.isVisible()}", file=sys.stderr)
        except Exception as e:
            import traceback
            print(f"[island] applicationDidFinishLaunching EXCEPTION: {type(e).__name__}: {e}", file=sys.stderr)
            traceback.print_exc()

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
