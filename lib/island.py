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
    NSButton,
    NSColor,
    NSEvent,
    NSFont,
    NSFontAttributeName,
    NSForegroundColorAttributeName,
    NSImage,
    NSImageOnly,
    NSScrollView,
    NSScreen,
    NSStatusWindowLevel,
    NSTextField,
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
# 灵动岛展开尺寸：3 按钮均匀对称布局
# 公式：EXPANDED_W = 2*PAD + 3*BTN_SIZE + 2*GAP，让边距=间距，最美观对称
BTN_SIZE = 36
BTN_GAP = 20
BTN_PAD = 20
EXPANDED_W = 2 * BTN_PAD + 3 * BTN_SIZE + 2 * BTN_GAP  # 20+36+20+36+20+36+20 = 188
EXPANDED_H = 48
BTN_Y = (EXPANDED_H - BTN_SIZE) / 2.0  # 6
BTN1_X = float(BTN_PAD)                            # 20  按钮1：开/关控制面板
BTN2_X = BTN1_X + BTN_SIZE + BTN_GAP               # 76  按钮2：Chrome 堆叠
BTN3_X = BTN2_X + BTN_SIZE + BTN_GAP               # 132 按钮3：触发自动排布
DRAG_THRESHOLD_PX = 4
COLLAPSE_DELAY_SEC = 0.15


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
# 排版区域全集 + 中文名（用户在面板里激活几个就循环几个）
ALL_REGIONS = {
    "full": "全屏",
    "top-half": "上 1/2",
    "top-2-3": "上 2/3",
    "bottom-half": "下 1/2",
    "left-half": "左 1/2",
    "right-half": "右 1/2",
    "left-2-3": "左 2/3",
    "left-1-3": "左 1/3",
}
DEFAULT_ARRANGE_SEQUENCE = ["full", "top-half", "bottom-half"]
ISLAND_CFG_FILE = Path.home() / ".temine" / "island-config.json"


def load_arrange_sequence() -> list[dict]:
    """从 ~/.temine/island-config.json 读激活的排版列表，每次按按钮都重新读（支持热更新）"""
    try:
        cfg = json.loads(ISLAND_CFG_FILE.read_text())
        seq = cfg.get("arrangeSequence", [])
        if isinstance(seq, list) and seq:
            valid = [r for r in seq if r in ALL_REGIONS]
            if valid:
                return [{"name": ALL_REGIONS[r], "region": r, "cols": 0} for r in valid]
    except Exception:
        pass
    return [{"name": ALL_REGIONS[r], "region": r, "cols": 0} for r in DEFAULT_ARRANGE_SEQUENCE]


def trigger_chrome_stack() -> None:
    """调 panel 的 /api/chrome/stack 让 Chrome 窗口在桌面上堆叠"""
    if not ensure_panel_running():
        return
    try:
        from AppKit import NSScreen  # type: ignore[import-not-found]
        screen = NSScreen.mainScreen()
        if screen:
            sz = screen.visibleFrame().size
            sw, sh = int(sz.width), int(sz.height)
        else:
            sw, sh = 1512, 944
        body = json.dumps({"screenWidth": sw, "screenHeight": sh, "reveal": 80}).encode("utf-8")
        req = urllib.request.Request(
            f"{PANEL_URL}/api/chrome/stack",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
    except Exception as e:
        print(f"[island] chrome stack failed: {e}", file=sys.stderr)


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


# === 像素 sprite 库（公共领域 Space Invader 风格）===
# 每个角色 11×8 字符矩阵，2 帧动画

OCTOPUS_F1 = [
    "..X.....X..",
    "...X...X...",
    "..XXXXXXX..",
    ".XX.XXX.XX.",
    "XXXXXXXXXXX",
    "X.XXXXXXX.X",
    "X.X.....X.X",
    "...XX.XX...",
]
OCTOPUS_F2 = [
    "..X.....X..",
    "X..X...X..X",
    "X.XXXXXXX.X",
    "XXX.XXX.XXX",
    "XXXXXXXXXXX",
    ".XXXXXXXXX.",
    "..X.....X..",
    ".X.......X.",
]

CRAB_F1 = [
    "..X.....X..",
    "X..X...X..X",
    "X.XXXXXXX.X",
    "XXX.XXX.XXX",
    "XXXXXXXXXXX",
    ".XXXXXXXXX.",
    ".X.X...X.X.",
    "X.X.....X.X",
]
CRAB_F2 = [
    "..X.....X..",
    "...X...X...",
    "..XXXXXXX..",
    ".XX.XXX.XX.",
    "XXXXXXXXXXX",
    "XXXXXXXXXXX",
    "X.X.....X.X",
    ".X.X...X.X.",
]

# === 探险剧情 sprite（小人 + 恐龙 + 特效字）===

# 小人 8x11（站立 / 走路1 / 走路2 / 跑步）
HUMAN_STAND = [
    "...XX...",
    "...XX...",
    "..XXXX..",
    ".XXXXXX.",
    "...XX...",
    "...XX...",
    "..XXXX..",
    ".XX..XX.",
    ".XX..XX.",
    ".X....X.",
    "XX....XX",
]
HUMAN_WALK1 = [
    "...XX...",
    "...XX...",
    "..XXXX..",
    ".XXXXXX.",
    "...XX...",
    "...XX...",
    "..XXXX..",
    ".XX..XX.",
    ".X....X.",
    "XX....X.",
    "X.....XX",
]
HUMAN_WALK2 = [
    "...XX...",
    "...XX...",
    "..XXXX..",
    ".XXXXXX.",
    "...XX...",
    "...XX...",
    "..XXXX..",
    ".XX..XX.",
    ".X....X.",
    ".X....XX",
    "XX.....X",
]
# 跑步 = 同 walk 但更快切换；这里复用 WALK1/WALK2

# 恐龙 11x9（睡觉 / 站立 / 追击）
DINO_SLEEP = [
    "...........",
    "...........",
    "..........",
    "....XXXX...",
    "...XXXXXX..",
    "..XXXXXXXX.",
    ".XXXXXXXXXX",
    "XX.XX.XX.XX",
    "..X..X..X..",
]
DINO_AWAKE = [
    "....XXXX...",
    "....XXXXX..",
    "....XXX....",
    "....XXXX...",
    "....XXXX...",
    "...XXXXX...",
    "..XXXXXXX..",
    ".XX.XXX.XX.",
    "..X..X..X..",
]
DINO_CHASE = [
    "....XXXX...",
    "....XXXXX..",
    "....XXX....",
    "....XXXX...",
    "...XXXXX...",
    "..XXXXXXX..",
    ".XXXXXXXXX.",
    "X.X.X.X.X..",
    "..X..X.....",
]

# zZz 文字（5x3）
ZZZ_F1 = [
    "Z....",
    ".Z...",
    "..ZZZ",
]
ZZZ_F2 = [
    ".Z...",
    "..Z..",
    "...ZZ",
]

# ! 感叹号（3x5）
EXCLAIM = [
    ".X.",
    ".X.",
    ".X.",
    "...",
    ".X.",
]

# 角色 sprite 尺寸（每像素 scale=2 → 屏幕像素）
HUMAN_W = 8 * PIXEL_SCALE   # 16
HUMAN_H = 11 * PIXEL_SCALE  # 22
DINO_W = 11 * PIXEL_SCALE   # 22
DINO_H = 9 * PIXEL_SCALE    # 18
ZZZ_W = 5 * PIXEL_SCALE     # 10
ZZZ_H = 3 * PIXEL_SCALE     # 6
EXCLAIM_W = 3 * PIXEL_SCALE # 6
EXCLAIM_H = 5 * PIXEL_SCALE # 10

# 舞台尺寸：紧贴胶囊一圈（外圈薄环带 = 陆地，内部 = 山洞）
# 胶囊 110×48 居中在舞台 → 胶囊位于 (20, 16)~(130, 64)
# 外圈环带宽 16px（上下左右各 16），舞台 150×80
STAGE_W = 150
STAGE_H = 80
PIXEL_SCALE = 2
# 胶囊在舞台坐标系内的边界
CAVE_LEFT = 20.0
CAVE_RIGHT = 130.0
CAVE_TOP = 16.0      # 山洞顶（上沿）
CAVE_BOTTOM = 64.0   # 山洞底（下沿）
CAVE_CY = (CAVE_TOP + CAVE_BOTTOM) / 2.0   # 40  胶囊垂直中心
# 山洞内分层：上半（通道）和下半（深处恐龙窝）
CAVE_UPPER_Y = CAVE_TOP + 12.0      # 28  小人走廊高度
CAVE_LOWER_Y = CAVE_BOTTOM - 12.0   # 52  恐龙窝高度
SPRITE_W = 11 * PIXEL_SCALE  # 22
SPRITE_H = 8 * PIXEL_SCALE   # 16
STORY_DURATION = 16.0  # 一个完整探险剧情循环 16 秒


def _render_pixel_frame(grid: list, color_rgba: tuple, scale: int = PIXEL_SCALE):
    """字符矩阵 → NSImage（用 NSBezierPath + lockFocus，PyObjC 最稳路径）"""
    try:
        from AppKit import NSImage, NSBezierPath as _NSBP, NSColor as _NSC  # type: ignore[import-not-found]
    except Exception as e:
        print(f"[island] sprite render import failed: {e}", file=sys.stderr)
        return None
    h = len(grid)
    w = max(len(row) for row in grid) if grid else 0
    if w == 0 or h == 0:
        return None
    width = w * scale
    height = h * scale
    image = NSImage.alloc().initWithSize_((float(width), float(height)))
    try:
        image.lockFocus()
        r, g, b, a = color_rgba
        _NSC.colorWithRed_green_blue_alpha_(r, g, b, a).set()
        for y, row in enumerate(grid):
            # NSImage 坐标 y 向上，所以 y=0 是底部；让矩阵顶行对齐图像顶部 → 翻转
            for x, c in enumerate(row):
                if c == "X":
                    _NSBP.fillRect_(
                        ((float(x * scale), float((h - 1 - y) * scale)), (float(scale), float(scale)))
                    )
        image.unlockFocus()
    except Exception as e:
        print(f"[island] sprite render fillRect failed: {e}", file=sys.stderr)
        try:
            image.unlockFocus()
        except Exception:
            pass
        return None
    return image


# === 舞台窗口（透明 + 鼠标穿透 + 跟随灵动岛）=========
# 让角色 sprite 能在灵动岛胶囊周围 +/-125px 范围内游走

class StageWindow(NSObject):
    """舞台：透明 NSWindow，鼠标完全穿透，承载多角色 sprite 动画"""

    def init(self):
        self = objc.super(StageWindow, self).init()
        if self is None:
            return None
        self.window = None
        self.view = None
        self.human_layer = None
        self.dino_layer = None
        self.zzz_layer = None
        self.exclaim_layer = None
        return self

    @objc.python_method
    def _build(self):
        rect = ((0.0, 0.0), (float(STAGE_W), float(STAGE_H)))
        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect, NSWindowStyleMaskBorderless, NSBackingStoreBuffered, False
        )
        win.setBackgroundColor_(NSColor.clearColor())
        win.setOpaque_(False)
        win.setHasShadow_(False)
        win.setIgnoresMouseEvents_(True)  # 鼠标完全穿透
        win.setLevel_(NSStatusWindowLevel)  # 与灵动岛同级
        win.setCollectionBehavior_(
            NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorFullScreenAuxiliary
        )
        view = NSView.alloc().initWithFrame_(((0, 0), (STAGE_W, STAGE_H)))
        view.setWantsLayer_(True)
        win.setContentView_(view)
        self.window = win
        self.view = view
        self._add_characters()

    @objc.python_method
    def _make_character_layer(self, frames_raw, color_rgba):
        """创建一个角色 CALayer + 帧动画"""
        try:
            from Quartz import CALayer, CAKeyframeAnimation  # type: ignore[import-not-found]
        except Exception as e:
            print(f"[stage] CALayer import FAILED: {e}", file=sys.stderr)
            return None
        # 渲染所有帧
        frames = []
        for grid in frames_raw:
            img = _render_pixel_frame(grid, color_rgba, scale=PIXEL_SCALE)
            if img is not None:
                frames.append(img)
        if not frames:
            print(f"[stage] frame render FAILED for color={color_rgba}", file=sys.stderr)
            return None
        layer = CALayer.layer()
        layer.setBounds_(((0, 0), (SPRITE_W, SPRITE_H)))
        layer.setMagnificationFilter_("nearest")
        layer.setMinificationFilter_("nearest")
        layer.setContents_(frames[0])
        # 帧动画（永远循环，2 帧 0.6s）
        contents_ani = CAKeyframeAnimation.animationWithKeyPath_("contents")
        contents_ani.setValues_(frames)
        contents_ani.setDuration_(0.6)
        contents_ani.setRepeatCount_(1e10)
        contents_ani.setCalculationMode_("discrete")
        layer.addAnimation_forKey_(contents_ani, "frames")
        print(f"[stage] character layer OK, {len(frames)} frames", file=sys.stderr)
        return layer

    @objc.python_method
    def _add_characters(self):
        """山洞探险剧情（紧贴灵动岛 16s 循环）

        舞台 150×80：
          胶囊（山洞）= (20, 16)~(130, 64)
          上沿陆地 (16) / 下沿陆地 (64) / 左右陆地外圈
          山洞内分层：上半（小人走廊 y=28）/ 下半（恐龙窝 y=52）

        小人不能离开舞台 150×80 范围
        """
        HUMAN_COLOR = (0.95, 0.95, 0.95, 1.0)
        DINO_COLOR = (0.45, 1.0, 0.55, 1.0)
        ZZZ_COLOR = (0.65, 0.75, 1.0, 0.85)
        EXCLAIM_COLOR = (1.0, 0.85, 0.0, 1.0)

        # 关键位置（舞台坐标系）
        START_X = STAGE_W - 8        # 142  右下角陆地起点
        ENTRANCE_X = CAVE_RIGHT - 6  # 124  山洞右口
        UPPER_LANE_Y = CAVE_UPPER_Y  # 28   山洞内小人走廊
        LOWER_LANE_Y = CAVE_LOWER_Y  # 52   恐龙窝
        DEEP_X = CAVE_LEFT + 16      # 36   山洞左侧深处
        TOP_LANE_Y = 8.0             # 顶部陆地（外圈）
        BOTTOM_LANE_Y = STAGE_H - 8  # 72   底部陆地

        # === 小人（探险者）===
        self.human_layer = self._make_character_layer_v2(
            [HUMAN_STAND, HUMAN_WALK1, HUMAN_STAND, HUMAN_WALK2],
            HUMAN_COLOR, HUMAN_W, HUMAN_H, frame_duration=0.4,
        )
        if self.human_layer is not None:
            self.human_layer.setPosition_((START_X, BOTTOM_LANE_Y))
            self.view.layer().addSublayer_(self.human_layer)
            self._animate_position(
                self.human_layer,
                values=[
                    (START_X, BOTTOM_LANE_Y),     # 0s   外圈起点（右下陆地）
                    (ENTRANCE_X, BOTTOM_LANE_Y),  # 1s   走到山洞右口下方
                    (ENTRANCE_X, UPPER_LANE_Y),   # 2s   钻进山洞（位置上移）
                    (DEEP_X + 30, UPPER_LANE_Y),  # 4s   山洞内向左探险
                    (DEEP_X, UPPER_LANE_Y),       # 5s   到深处
                    (DEEP_X, UPPER_LANE_Y),       # 6s   站住看下方恐龙
                    (DEEP_X + 30, UPPER_LANE_Y),  # 7s   转身往出口跑
                    (ENTRANCE_X, UPPER_LANE_Y),   # 8s   到山洞右口
                    (ENTRANCE_X, BOTTOM_LANE_Y),  # 8.5s 跳出山洞到下沿
                    (CAVE_LEFT - 4, BOTTOM_LANE_Y),  # 10s  沿底部陆地向左跑
                    (CAVE_LEFT - 4, TOP_LANE_Y),     # 11.5s 沿左外圈向上跑
                    (ENTRANCE_X, TOP_LANE_Y),        # 13s  沿顶部陆地向右跑
                    (START_X, TOP_LANE_Y),           # 14s  跑到右上角
                    (START_X, BOTTOM_LANE_Y),        # 15s  下到起点（一圈完成）
                    (START_X, BOTTOM_LANE_Y),        # 16s  循环
                ],
                key_times=[0.0, 0.0625, 0.125, 0.25, 0.3125, 0.375, 0.4375, 0.5, 0.53125, 0.625, 0.71875, 0.8125, 0.875, 0.9375, 1.0],
            )

        # === 恐龙（守洞者）===
        self.dino_layer = self._make_character_layer_v2(
            [DINO_SLEEP, DINO_SLEEP, DINO_AWAKE, DINO_CHASE],
            DINO_COLOR, DINO_W, DINO_H, frame_duration=4.0,
        )
        if self.dino_layer is not None:
            self.dino_layer.setPosition_((DEEP_X, LOWER_LANE_Y))
            self.view.layer().addSublayer_(self.dino_layer)
            self._animate_position(
                self.dino_layer,
                values=[
                    (DEEP_X, LOWER_LANE_Y),         # 0s   山洞深处下方睡
                    (DEEP_X, LOWER_LANE_Y),         # 6s   仍在睡
                    (DEEP_X, LOWER_LANE_Y),         # 7s   醒（位置不动）
                    (DEEP_X + 30, LOWER_LANE_Y),    # 8s   起身向出口移动
                    (ENTRANCE_X - 8, LOWER_LANE_Y), # 9s   到出口（出不去）
                    (ENTRANCE_X - 8, LOWER_LANE_Y), # 14s  停在出口看小人跑
                    (DEEP_X, LOWER_LANE_Y),         # 15s  返回深处
                    (DEEP_X, LOWER_LANE_Y),         # 16s  重新睡
                ],
                key_times=[0.0, 0.375, 0.4375, 0.5, 0.5625, 0.875, 0.9375, 1.0],
            )

        # === zZz 文字（恐龙睡觉时在它头上飘）===
        self.zzz_layer = self._make_character_layer_v2(
            [ZZZ_F1, ZZZ_F2], ZZZ_COLOR, ZZZ_W, ZZZ_H, frame_duration=0.4,
        )
        if self.zzz_layer is not None:
            self.zzz_layer.setPosition_((DEEP_X + 8, LOWER_LANE_Y - 12))
            self.view.layer().addSublayer_(self.zzz_layer)
            # 仅 0~6s 显示（恐龙睡觉时）
            self._animate_opacity(
                self.zzz_layer,
                values=[1.0, 1.0, 0.0, 0.0, 1.0],
                key_times=[0.0, 0.375, 0.4375, 0.9375, 1.0],
            )

        # === ! 感叹号（小人 6~7s 看到恐龙时弹出）===
        self.exclaim_layer = self._make_character_layer_v2(
            [EXCLAIM, EXCLAIM], EXCLAIM_COLOR, EXCLAIM_W, EXCLAIM_H, frame_duration=0.3,
        )
        if self.exclaim_layer is not None:
            self.exclaim_layer.setPosition_((DEEP_X, UPPER_LANE_Y - 14))
            self.view.layer().addSublayer_(self.exclaim_layer)
            self._animate_opacity(
                self.exclaim_layer,
                values=[0.0, 0.0, 1.0, 1.0, 0.0, 0.0],
                key_times=[0.0, 0.375, 0.376, 0.4375, 0.438, 1.0],
            )

        print("[stage] cave adventure loaded (human + dino + zZz + ! ; 16s loop)", file=sys.stderr)

    @objc.python_method
    def _make_character_layer_v2(self, frames_raw, color_rgba, w, h, frame_duration=0.5):
        """V2 通用版：自定义尺寸 + 帧切换时长"""
        try:
            from Quartz import CALayer, CAKeyframeAnimation  # type: ignore[import-not-found]
        except Exception as e:
            print(f"[stage] CALayer import FAILED: {e}", file=sys.stderr)
            return None
        frames = []
        for grid in frames_raw:
            img = _render_pixel_frame(grid, color_rgba, scale=PIXEL_SCALE)
            if img is not None:
                frames.append(img)
        if not frames:
            print(f"[stage] frame render FAILED for color={color_rgba}", file=sys.stderr)
            return None
        layer = CALayer.layer()
        layer.setBounds_(((0, 0), (w, h)))
        layer.setMagnificationFilter_("nearest")
        layer.setMinificationFilter_("nearest")
        layer.setContents_(frames[0])
        # 帧动画
        contents_ani = CAKeyframeAnimation.animationWithKeyPath_("contents")
        contents_ani.setValues_(frames)
        contents_ani.setDuration_(frame_duration * len(frames))
        contents_ani.setRepeatCount_(1e10)
        contents_ani.setCalculationMode_("discrete")
        layer.addAnimation_forKey_(contents_ani, "frames")
        return layer

    @objc.python_method
    def _animate_opacity(self, layer, values, key_times):
        """给 layer 加 opacity keyframe 动画（剧情周期循环）"""
        try:
            from Quartz import CAKeyframeAnimation  # type: ignore[import-not-found]
        except Exception as e:
            print(f"[stage] opacity anim import failed: {e}", file=sys.stderr)
            return
        ani = CAKeyframeAnimation.animationWithKeyPath_("opacity")
        ani.setValues_([float(v) for v in values])
        ani.setKeyTimes_([float(t) for t in key_times])
        ani.setDuration_(STORY_DURATION)
        ani.setRepeatCount_(1e10)
        ani.setCalculationMode_("linear")
        layer.addAnimation_forKey_(ani, "opacity")

    @objc.python_method
    def _animate_position(self, layer, values, key_times):
        """给 layer 加 position keyframe 动画（8s 循环）"""
        try:
            from Quartz import CAKeyframeAnimation  # type: ignore[import-not-found]
            from Foundation import NSValue  # type: ignore[import-not-found]
        except Exception as e:
            print(f"[stage] position anim import failed: {e}", file=sys.stderr)
            return
        ns_values = []
        for x, y in values:
            ns_values.append(NSValue.valueWithPoint_((float(x), float(y))))
        ani = CAKeyframeAnimation.animationWithKeyPath_("position")
        ani.setValues_(ns_values)
        ani.setKeyTimes_([float(t) for t in key_times])
        ani.setDuration_(STORY_DURATION)
        ani.setRepeatCount_(1e10)
        ani.setCalculationMode_("linear")  # 平滑插值移动
        layer.addAnimation_forKey_(ani, "story")

    @objc.python_method
    def show(self):
        if self.window is None:
            self._build()
        self.window.orderFront_(None)

    @objc.python_method
    def hide(self):
        if self.window:
            self.window.orderOut_(None)

    @objc.python_method
    def follow(self, island_origin_x, island_origin_y, island_w, island_h):
        """灵动岛位置变化时同步舞台位置（中心对齐）"""
        if self.window is None:
            self._build()
        # 灵动岛中心 = (island_x + island_w/2, island_y + island_h/2)
        # 舞台中心对齐：stage_x + STAGE_W/2 = island_x + island_w/2
        sx = island_origin_x + (island_w - STAGE_W) / 2.0
        sy = island_origin_y + (island_h - STAGE_H) / 2.0
        self.window.setFrameOrigin_((float(sx), float(sy)))


# === Chrome 浮层窗口（独立 NSWindow，不用 NSPopover 避免 PyObjC 踩坑）===
POPOVER_W = 360
POPOVER_H = 460
POPOVER_HEADER_H = 56
POPOVER_PAD = 10
POPOVER_TAB_ROW_H = 38


class ChromePopover(NSObject):
    """Chrome 窗口/tab 浮层。click 灵动岛 Chrome 按钮时 toggle 显示。"""

    def init(self):
        self = objc.super(ChromePopover, self).init()
        if self is None:
            return None
        self.window = None
        self.list_view = None
        self.scroll_view = None
        self.title_label = None
        return self

    @objc.python_method
    def _build_window(self):
        rect = ((0.0, 0.0), (float(POPOVER_W), float(POPOVER_H)))
        win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect, NSWindowStyleMaskBorderless, NSBackingStoreBuffered, False
        )
        win.setBackgroundColor_(NSColor.clearColor())
        win.setOpaque_(False)
        win.setHasShadow_(True)
        win.setLevel_(NSStatusWindowLevel)
        win.setCollectionBehavior_(
            NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorFullScreenAuxiliary
        )
        win.setMovable_(False)

        # 主容器 view（半透明深色背景 + 大圆角）
        content = NSView.alloc().initWithFrame_(((0, 0), (POPOVER_W, POPOVER_H)))
        content.setWantsLayer_(True)
        content.layer().setBackgroundColor_(
            NSColor.colorWithRed_green_blue_alpha_(0.06, 0.05, 0.08, 0.94).CGColor()
        )
        content.layer().setCornerRadius_(14.0)
        content.layer().setBorderColor_(
            NSColor.colorWithWhite_alpha_(1.0, 0.10).CGColor()
        )
        content.layer().setBorderWidth_(0.5)

        # 顶部头部区
        header_y = POPOVER_H - POPOVER_HEADER_H
        # 标题
        self.title_label = NSTextField.alloc().initWithFrame_(
            ((POPOVER_PAD + 4, header_y + 28), (POPOVER_W - 2 * POPOVER_PAD - 8, 20))
        )
        self.title_label.setStringValue_("Chrome 窗口（加载中…）")
        self.title_label.setBezeled_(False)
        self.title_label.setDrawsBackground_(False)
        self.title_label.setEditable_(False)
        self.title_label.setSelectable_(False)
        self.title_label.setBordered_(False)
        self.title_label.setFont_(NSFont.boldSystemFontOfSize_(12.0))
        self.title_label.setTextColor_(NSColor.colorWithWhite_alpha_(0.9, 1.0))
        content.addSubview_(self.title_label)

        # 「桌面堆叠」按钮
        stack_btn = NSButton.alloc().initWithFrame_(
            ((POPOVER_PAD, header_y + 4), (160, 22))
        )
        stack_btn.setTitle_("📚 桌面堆叠")
        stack_btn.setBezelStyle_(1)  # NSBezelStyleRounded
        stack_btn.setTarget_(self)
        stack_btn.setAction_(b"_onStackClicked:")
        content.addSubview_(stack_btn)

        # 「↻ 刷新」按钮
        refresh_btn = NSButton.alloc().initWithFrame_(
            ((POPOVER_W - POPOVER_PAD - 80, header_y + 4), (80, 22))
        )
        refresh_btn.setTitle_("↻ 刷新")
        refresh_btn.setBezelStyle_(1)
        refresh_btn.setTarget_(self)
        refresh_btn.setAction_(b"_onRefreshClicked:")
        content.addSubview_(refresh_btn)

        # 列表 ScrollView
        scroll = NSScrollView.alloc().initWithFrame_(
            ((POPOVER_PAD, POPOVER_PAD), (POPOVER_W - 2 * POPOVER_PAD, POPOVER_H - POPOVER_HEADER_H - POPOVER_PAD))
        )
        scroll.setHasVerticalScroller_(True)
        scroll.setBorderType_(0)  # NSNoBorder
        scroll.setDrawsBackground_(False)
        list_view = NSView.alloc().initWithFrame_(
            ((0, 0), (POPOVER_W - 2 * POPOVER_PAD, 1))
        )
        list_view.setWantsLayer_(True)
        scroll.setDocumentView_(list_view)
        content.addSubview_(scroll)

        win.setContentView_(content)
        self.window = win
        self.list_view = list_view
        self.scroll_view = scroll

    @objc.python_method
    def is_visible(self) -> bool:
        return bool(self.window and not self.window.isReleasedWhenClosed() and self.window.isVisible())

    @objc.python_method
    def show_below(self, anchor_view) -> None:
        """anchor_view 是 chrome_btn，把 popover 显示在它正下方"""
        if self.window is None:
            self._build_window()
        # 计算 popover 应该显示的屏幕坐标（anchor_view 下方）
        if anchor_view and anchor_view.window():
            try:
                anchor_rect_in_win = anchor_view.convertRect_toView_(
                    anchor_view.bounds(), None
                )
                anchor_rect_in_screen = anchor_view.window().convertRectToScreen_(
                    anchor_rect_in_win
                )
                ax = anchor_rect_in_screen.origin.x + anchor_rect_in_screen.size.width / 2.0
                ay = anchor_rect_in_screen.origin.y
                # popover 居中对齐 anchor，紧贴下方
                px = ax - POPOVER_W / 2.0
                py = ay - POPOVER_H - 10
                self.window.setFrameOrigin_(((px, py)))
            except Exception:
                pass
        self.window.orderFront_(None)
        self.refresh_data()

    @objc.python_method
    def hide(self) -> None:
        if self.window:
            self.window.orderOut_(None)

    @objc.python_method
    def toggle(self, anchor_view) -> None:
        if self.is_visible():
            self.hide()
        else:
            self.show_below(anchor_view)

    @objc.python_method
    def refresh_data(self) -> None:
        """从 panel server 拉 Chrome 窗口列表，渲染列表"""
        import threading

        def do_fetch():
            try:
                with urllib.request.urlopen(
                    f"{PANEL_URL}/api/chrome/windows", timeout=3
                ) as r:
                    data = json.loads(r.read())
                    windows = data.get("windows", []) if isinstance(data, dict) else []
            except Exception as e:
                print(f"[island popover] fetch failed: {e}", file=sys.stderr)
                windows = []
            try:
                from Foundation import NSOperationQueue  # type: ignore[import-not-found]
                NSOperationQueue.mainQueue().addOperationWithBlock_(
                    lambda: self._render_list(windows)
                )
            except Exception:
                pass

        threading.Thread(target=do_fetch, daemon=True).start()

    @objc.python_method
    def _render_list(self, windows: list) -> None:
        """主线程：清空 list_view + 添加每个 tab 一个 NSButton"""
        if self.list_view is None:
            return
        for v in list(self.list_view.subviews()):
            v.removeFromSuperview()
        if self.title_label is not None:
            total_tabs = sum((w.get("tabCount", 0) for w in windows))
            self.title_label.setStringValue_(
                f"Chrome 窗口 · {len(windows)} 个窗口 · {total_tabs} 个 tab"
            )
        if not windows:
            self._add_empty_label()
            return

        # 计算总高度并设 list_view 大小
        row_per_win_header = 24
        total_h = 0
        for w in windows:
            total_h += row_per_win_header
            total_h += POPOVER_TAB_ROW_H * len(w.get("tabs", []))
            total_h += 6  # 窗口间隔
        list_w = POPOVER_W - 2 * POPOVER_PAD
        self.list_view.setFrame_(((0, 0), (list_w, max(total_h, 1))))

        # 从底部往上排（NSView 坐标系 y 向上）
        # 反转顺序，让"窗口 1"在视觉上方（即 y 大）
        y_cursor = total_h
        for w in windows:
            # 窗口标题
            y_cursor -= row_per_win_header
            title = w.get("title", "(无标题窗口)")
            count = w.get("tabCount", 0)
            label = NSTextField.alloc().initWithFrame_(
                ((4, y_cursor + 4), (list_w - 8, 18))
            )
            label.setStringValue_(f"  {title}  ·  {count} tab")
            label.setBezeled_(False)
            label.setDrawsBackground_(False)
            label.setEditable_(False)
            label.setSelectable_(False)
            label.setBordered_(False)
            label.setFont_(NSFont.boldSystemFontOfSize_(11.0))
            label.setTextColor_(NSColor.colorWithRed_green_blue_alpha_(0.55, 0.65, 0.95, 1.0))
            self.list_view.addSubview_(label)

            # 每个 tab 一个 button
            for t in w.get("tabs", []):
                y_cursor -= POPOVER_TAB_ROW_H
                btn = NSButton.alloc().initWithFrame_(
                    ((6, y_cursor + 2), (list_w - 12, POPOVER_TAB_ROW_H - 4))
                )
                tab_title = (t.get("title") or "(无标题)").strip() or "(无标题)"
                if len(tab_title) > 50:
                    tab_title = tab_title[:48] + "…"
                btn.setTitle_(tab_title)
                btn.setBordered_(False)
                btn.setBezelStyle_(0)
                btn.setAlignment_(0)  # NSTextAlignmentLeft
                btn.setFont_(NSFont.systemFontOfSize_(12.0))
                btn.setTarget_(self)
                btn.setAction_(b"_onTabClicked:")
                # 把 windowId 和 tabIndex 编码到 tag 里：高 32 位 wid，低 16 位 tidx
                wid = int(w.get("id", 0)) & 0xFFFFFFFF
                tidx = int(t.get("idx", 0)) & 0xFFFF
                btn.setTag_((wid << 16) | tidx)
                # 浅色 hover 反馈
                btn.setWantsLayer_(True)
                btn.layer().setBackgroundColor_(NSColor.clearColor().CGColor())
                btn.layer().setCornerRadius_(6.0)
                self.list_view.addSubview_(btn)

            y_cursor -= 6

    @objc.python_method
    def _add_empty_label(self):
        list_w = POPOVER_W - 2 * POPOVER_PAD
        self.list_view.setFrame_(((0, 0), (list_w, 100)))
        label = NSTextField.alloc().initWithFrame_(((10, 30), (list_w - 20, 40)))
        label.setStringValue_("没有检测到 Chrome 窗口\n请先打开 Chrome 并授权自动化权限")
        label.setBezeled_(False)
        label.setDrawsBackground_(False)
        label.setEditable_(False)
        label.setSelectable_(False)
        label.setBordered_(False)
        label.setFont_(NSFont.systemFontOfSize_(11.0))
        label.setTextColor_(NSColor.colorWithWhite_alpha_(0.5, 1.0))
        label.setAlignment_(2)  # NSTextAlignmentCenter
        self.list_view.addSubview_(label)

    def _onStackClicked_(self, _sender):
        trigger_chrome_stack()
        # 堆叠后稍等再刷新（让 osascript 完成）
        import threading
        def delayed_refresh():
            import time
            time.sleep(0.4)
            try:
                from Foundation import NSOperationQueue
                NSOperationQueue.mainQueue().addOperationWithBlock_(self.refresh_data)
            except Exception:
                pass
        threading.Thread(target=delayed_refresh, daemon=True).start()

    def _onRefreshClicked_(self, _sender):
        self.refresh_data()

    def _onTabClicked_(self, sender):
        tag = int(sender.tag())
        wid = (tag >> 16) & 0xFFFFFFFF
        tidx = tag & 0xFFFF
        if wid <= 0 or tidx <= 0:
            return
        # 调 panel 的 focus API
        try:
            body = json.dumps({"windowId": wid, "tabIndex": tidx}).encode("utf-8")
            req = urllib.request.Request(
                f"{PANEL_URL}/api/chrome/focus",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=3) as r:
                r.read()
        except Exception as e:
            print(f"[island popover] focus failed: {e}", file=sys.stderr)
        # 关闭浮层
        self.hide()


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
        self.chrome_btn = None
        self.arrange_btn = None
        self.arrange_idx = 0  # 排布序列当前索引
        self.chrome_popover = None  # Chrome 浮层（懒加载）
        self.stage = None           # 角色舞台窗口（懒加载）
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
            # 紧凑态胶囊里只放紫粉光点 + 呼吸动画（角色都在舞台上）
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
                dot_layer.setShadowColor_(NSColor.systemPinkColor().CGColor())
                dot_layer.setShadowOpacity_(0.85)
                dot_layer.setShadowRadius_(8.0)
                dot_layer.setShadowOffset_((0.0, 0.0))
                self._add_breathe_animation(dot_layer)
            self.addSubview_(self.dot_view)

            # 按钮 1：开/关控制面板（SF Symbol "macwindow"）
            self.panel_btn = self._make_button(
                ["macwindow", "macwindow.on.rectangle"],
                "▢",
                BTN1_X,
                b"onClickPanel:",
            )
            self.addSubview_(self.panel_btn)

            # 按钮 2：Chrome 桌面堆叠（SF Symbol "safari" / globe）
            self.chrome_btn = self._make_button(
                ["safari", "safari.fill", "globe"],
                "◎",
                BTN2_X,
                b"onClickChrome:",
            )
            self.addSubview_(self.chrome_btn)

            # 按钮 3：循环切换排布（SF Symbol "rectangle.3.group.fill"）
            self.arrange_btn = self._make_button(
                ["rectangle.3.group.fill", "square.grid.3x1.below.line.grid.1x2"],
                "⊞",
                BTN3_X,
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

    @objc.python_method
    def _add_sprite_animation(self, layer, frames: list, fps: float = 8.0):
        """像素 sprite 帧动画：CAKeyframeAnimation 切换 layer.contents
        - 离散切换（不插值），保持像素动画的"跳帧"感
        - GPU 渲染，零 CPU
        """
        try:
            from Quartz import CAKeyframeAnimation  # type: ignore[import-not-found]
            n = len(frames)
            if n == 0:
                return
            duration = n / fps  # 全周期时长（秒）
            ani = CAKeyframeAnimation.animationWithKeyPath_("contents")
            ani.setValues_(frames)
            ani.setDuration_(duration)
            ani.setRepeatCount_(1e10)
            # 离散模式：直接切下一帧不做颜色插值
            ani.setCalculationMode_("discrete")
            layer.addAnimation_forKey_(ani, "sprite-walk")
        except Exception as e:
            print(f"[island] sprite anim failed: {e}", file=sys.stderr)

    @objc.python_method
    def _add_breathe_animation(self, layer):
        """给光点 layer 加呼吸动画 + 阴影脉冲（Core Animation GPU 渲染，零 CPU）"""
        try:
            from Quartz import CABasicAnimation, CAMediaTimingFunction  # type: ignore[import-not-found]
            # 1) 透明度呼吸：0.55 ↔ 1.0
            opacity_ani = CABasicAnimation.animationWithKeyPath_("opacity")
            opacity_ani.setFromValue_(0.55)
            opacity_ani.setToValue_(1.0)
            opacity_ani.setDuration_(1.6)
            opacity_ani.setAutoreverses_(True)
            opacity_ani.setRepeatCount_(1e10)  # 无限循环
            opacity_ani.setTimingFunction_(
                CAMediaTimingFunction.functionWithName_("easeInEaseOut")
            )
            layer.addAnimation_forKey_(opacity_ani, "breathe-opacity")

            # 2) 缩放呼吸：90% ↔ 110%
            scale_ani = CABasicAnimation.animationWithKeyPath_("transform.scale")
            scale_ani.setFromValue_(0.9)
            scale_ani.setToValue_(1.15)
            scale_ani.setDuration_(1.6)
            scale_ani.setAutoreverses_(True)
            scale_ani.setRepeatCount_(1e10)
            scale_ani.setTimingFunction_(
                CAMediaTimingFunction.functionWithName_("easeInEaseOut")
            )
            layer.addAnimation_forKey_(scale_ani, "breathe-scale")

            # 3) 阴影发光脉冲：6 ↔ 14
            shadow_ani = CABasicAnimation.animationWithKeyPath_("shadowRadius")
            shadow_ani.setFromValue_(6.0)
            shadow_ani.setToValue_(14.0)
            shadow_ani.setDuration_(1.6)
            shadow_ani.setAutoreverses_(True)
            shadow_ani.setRepeatCount_(1e10)
            shadow_ani.setTimingFunction_(
                CAMediaTimingFunction.functionWithName_("easeInEaseOut")
            )
            layer.addAnimation_forKey_(shadow_ani, "breathe-shadow")
        except Exception as e:
            print(f"[island] breathe anim failed: {e}", file=sys.stderr)

    def onClickPanel_(self, _sender):
        toggle_panel_window()

    def onClickArrange_(self, _sender):
        # 每次重新读 config，支持面板里改了配置后立即生效
        seq = load_arrange_sequence()
        if not seq:
            return
        idx = self.arrange_idx % len(seq)
        item = seq[idx]
        print(f"[island] arrange → {item['name']} ({item['region']})", file=sys.stderr)
        trigger_arrange(region=item["region"], cols=item["cols"])
        self.arrange_idx = (idx + 1) % len(seq)

    def onClickChrome_(self, _sender):
        # 单击 Chrome 按钮 → 直接桌面堆叠所有 Chrome 窗口
        trigger_chrome_stack()

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
            # 创建并显示舞台
            if self.stage is None:
                self.stage = StageWindow.alloc().init()
            self._sync_stage()
            self.stage.show()
        except Exception as e:
            import traceback
            print(f"[island] viewDidMoveToWindow EXCEPTION: {type(e).__name__}: {e}", file=sys.stderr)
            traceback.print_exc()

    @objc.python_method
    def _sync_stage(self):
        """根据当前主窗口位置/大小，同步舞台位置"""
        if self.stage is None:
            return
        win = self.window()
        if win is None:
            return
        f = win.frame()
        self.stage.follow(f.origin.x, f.origin.y, f.size.width, f.size.height)

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
        # 展开/收缩后舞台位置也要同步
        self._sync_stage()
        # 更新 layer cornerRadius 与子视图位置
        layer = self.layer()
        if layer is not None:
            layer.setCornerRadius_(new_h / 2.0)
        if expanded:
            # 展开：圆点隐藏，两个按钮显示
            self.dot_view.setHidden_(True)
            self.panel_btn.setHidden_(False)
            if self.chrome_btn is not None:
                self.chrome_btn.setHidden_(False)
            self.arrange_btn.setHidden_(False)
        else:
            # 紧凑：圆点居中，按钮隐藏
            self.panel_btn.setHidden_(True)
            if self.chrome_btn is not None:
                self.chrome_btn.setHidden_(True)
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
        # 拖动时同步舞台位置
        self._sync_stage()

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
