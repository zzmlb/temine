/**
 * Temine Web 控制面板 v0.8
 *
 * 1. 标签持久化（Terminal.app title displays custom title）
 * 2. 双击卡片跳转到对应终端窗口
 * 3. 保存输出 + 输出记录管理 tab
 * 4. 屏幕区域选择（全屏/左半/右半/上半 等）
 * 5. 编辑标签时跳过卡片重绘
 * 6. 稳定窗口编号 + 内容变化检测
 */

import { createServer } from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { labelWindow, labelWindowById, getLabel } from './terminal-label.js';
import { clearAllLogs, clearLogsByType } from './logger.js';

// 读取版本号显示在 panel 标题上，方便确认 panel server 跑的是哪一版
const PANEL_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return '?';
  }
})();

const STATE_DIR = join(homedir(), '.temine');
const STATE_FILE = join(STATE_DIR, 'state.json');
const PID_FILE = join(STATE_DIR, 'watcher.pid');
const WINDOW_MAP_FILE = join(STATE_DIR, 'window-map.json');
const LOGS_DIR = join(STATE_DIR, 'logs');
const RECORDS_DIR = join(STATE_DIR, 'records');
const IGNORED_FILE = join(STATE_DIR, 'ignored.json');
const RECORDING_FILE = join(STATE_DIR, 'recording.json');
const LAYOUT_FILE = join(STATE_DIR, 'layout.json');
const SSH_CONNECTIONS_FILE = join(STATE_DIR, 'ssh-connections.json');
const SSH_PRESETS_FILE = join(STATE_DIR, 'ssh-presets.json');
const GLOBAL_RECORDING_FILE = join(STATE_DIR, 'global-recording.json');
const BOARD_FILE = join(STATE_DIR, 'board.json');
const DEFAULT_PORT = 7890;

function ensureDir() { try { mkdirSync(STATE_DIR, { recursive: true }); } catch {} }

// 安全：验证窗口 ID 为正整数（防止 AppleScript 注入）
function safeWindowId(id) {
  const n = parseInt(id);
  return (!isNaN(n) && n > 0 && n < 1e9) ? n : null;
}

// 安全：限制请求体大小（1MB）
function readBody(req, cb) {
  let body = '';
  req.on('data', d => {
    body += d;
    if (body.length > 1e6) { req.destroy(); return; }
  });
  req.on('end', () => cb(body));
}
function ensureRecordsDir() { try { mkdirSync(RECORDS_DIR, { recursive: true }); } catch {} }
function loadIgnored() { try { return new Set(JSON.parse(readFileSync(IGNORED_FILE, 'utf-8'))); } catch { return new Set(); } }
function saveIgnored(s) { ensureDir(); writeFileSync(IGNORED_FILE, JSON.stringify([...s])); }
function loadRecording() { try { return JSON.parse(readFileSync(RECORDING_FILE, 'utf-8')); } catch { return {}; } }
function saveRecording(r) { ensureDir(); writeFileSync(RECORDING_FILE, JSON.stringify(r, null, 2)); }
function loadSSHConnections() { try { return JSON.parse(readFileSync(SSH_CONNECTIONS_FILE, 'utf-8')); } catch { return {}; } }
function saveSSHConnections(d) { ensureDir(); writeFileSync(SSH_CONNECTIONS_FILE, JSON.stringify(d, null, 2)); }
function loadSSHPresets() { try { return JSON.parse(readFileSync(SSH_PRESETS_FILE, 'utf-8')); } catch { return {}; } }
function saveSSHPresets(d) { ensureDir(); writeFileSync(SSH_PRESETS_FILE, JSON.stringify(d, null, 2)); }
function loadGlobalRecording() { try { return JSON.parse(readFileSync(GLOBAL_RECORDING_FILE, 'utf-8')); } catch { return { enabled: true }; } }
function saveGlobalRecording(d) { ensureDir(); writeFileSync(GLOBAL_RECORDING_FILE, JSON.stringify(d, null, 2)); }
function loadBoard() { try { return JSON.parse(readFileSync(BOARD_FILE, 'utf-8')); } catch { return { nodes: {}, notes: [] }; } }
function saveBoard(d) { ensureDir(); writeFileSync(BOARD_FILE, JSON.stringify(d, null, 2)); }
function readState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; } }

function isWatcherRunning() {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    process.kill(pid, 0);
    return pid;
  } catch { return false; }
}

// ── 窗口列表（含物理位置）────────────────────────────
function getWindows() {
  if (process.platform !== 'darwin') return [];
  try {
    const script = `set results to ""
tell application "Terminal"
  set i to 1
  repeat with w in windows
    set b to bounds of w
    set results to results & i & "||" & (id of w) & "||" & (name of w) & "||" & (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b) & linefeed
    set i to i + 1
  end repeat
end tell
return results`;
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!result) return [];
    return result.split('\n').filter(l => l.trim()).map(line => {
      const parts = line.split('||');
      const [index, id, name] = parts;
      let x = 0, y = 0;
      if (parts[3]) {
        const coords = parts[3].split(',').map(Number);
        x = coords[0] || 0;
        y = coords[1] || 0;
      }
      return { index: parseInt(index), id, name: name?.trim() || '', x, y };
    });
  } catch { return []; }
}

// ── Chrome 多窗口 + 标签页扫描 ───────────────────────
// 用 JavaScript osascript 直接输出 JSON，避免 AppleScript 字符串拼接 / 转义复杂性
function getChromeWindows() {
  if (process.platform !== 'darwin') return [];
  try {
    // Chrome 没运行就直接返回空（避免 osascript 弹"是否启动 Chrome"对话框）
    const probe = execSync(
      `osascript -e 'tell application "System Events" to (exists process "Google Chrome")'`,
      { encoding: 'utf-8', timeout: 2000 }
    ).trim();
    if (probe !== 'true') return [];

    const jsScript = [
      'function run() {',
      '  try {',
      "    const Chrome = Application('Google Chrome');",
      '    const wins = Chrome.windows();',
      '    const out = [];',
      '    for (let i = 0; i < wins.length; i++) {',
      '      const w = wins[i];',
      "      let id = 0, title = '', tabs = [];",
      '      try { id = w.id(); } catch(e) {}',
      '      try { title = w.title(); } catch(e) {}',
      '      try {',
      '        const ts = w.tabs();',
      '        for (let j = 0; j < ts.length; j++) {',
      "          let tt = '', tu = '';",
      '          try { tt = ts[j].title(); } catch(e) {}',
      '          try { tu = ts[j].url(); } catch(e) {}',
      '          tabs.push({ idx: j + 1, title: tt, url: tu });',
      '        }',
      '      } catch(e) {}',
      '      out.push({ idx: i + 1, id: id, title: title, tabCount: tabs.length, tabs: tabs });',
      '    }',
      '    return JSON.stringify(out);',
      '  } catch (e) {',
      "    return JSON.stringify({ error: String(e) });",
      '  }',
      '}',
    ].join('\n');
    const result = execSync(
      `osascript -l JavaScript -e '${jsScript.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf-8', timeout: 6000 }
    ).trim();
    if (!result) return [];
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

function focusChromeTab(windowId, tabIndex) {
  if (process.platform !== 'darwin') return false;
  const wid = parseInt(windowId);
  const tidx = parseInt(tabIndex);
  if (!wid || wid < 1 || !tidx || tidx < 1) return false;
  try {
    const script = `tell application "Google Chrome"
  try
    set targetWin to first window whose id is ${wid}
    set active tab index of targetWin to ${tidx}
    set index of targetWin to 1
    activate
  end try
end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8', timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Chrome 桌面堆叠排列 ───────────────────────────────
// 把所有 Chrome 窗口在桌面上排成垂直堆叠
// 每个窗口 y 错开 reveal 像素（露出顶部 tab bar）
// z-order：最下面位置(y最大)的窗口放最上层完整可见，
//         其他依次靠后，被盖住只露顶部 reveal 像素
// 可选 focusedWindowId：把指定窗口排到最底(完整可见)
function stackChromeWindows(opts) {
  if (process.platform !== 'darwin') return false;
  const o = opts || {};
  const focusedId = parseInt(o.focusedWindowId) || 0;
  const screenW = parseInt(o.screenWidth) || 1512;
  const screenH = parseInt(o.screenHeight) || 944;
  const reveal = parseInt(o.reveal) || 80;
  if (screenW < 200 || screenH < 200 || reveal < 20 || reveal > 400) return false;
  const wins = getChromeWindows();
  if (wins.length === 0) return false;

  // 排序：focusedId 排到最后(底部位置 = 完整显示)
  let ordered = wins.slice();
  if (focusedId) {
    const fIdx = ordered.findIndex(w => w.id === focusedId);
    if (fIdx >= 0) {
      const focused = ordered.splice(fIdx, 1)[0];
      ordered.push(focused);
    }
  }

  // 算法：所有窗口"底部对齐"到屏幕底，y 错开 reveal，z-order 让位置靠下的在最前
  // 这样：每个窗口露顶部 reveal 像素 + 最底位置的完整可见，其他窗口的下半部被盖住
  // 不同于"高度=屏幕高度"的算法（那种会让 ordered[0] 占满整屏，其他被盖）
  const N = ordered.length;
  const totalReveal = (N - 1) * reveal;
  const winHeight = Math.max(200, screenH - totalReveal);  // Chrome 窗口最小高度约 200
  let cmds = 'activate\n';
  for (let i = 0; i < N; i++) {
    const w = ordered[i];
    const y = i * reveal;
    const bottom = y + winHeight;
    cmds += `try
  set bounds of (window id ${w.id}) to {0, ${y}, ${screenW}, ${bottom}}
end try
`;
  }
  // z-order: ordered[N-1] (最底 y=(N-1)*reveal) → index=1 最前完整可见
  //          ordered[0]   (最顶 y=0)          → index=N 最后只露 reveal 像素
  for (let i = 0; i < N; i++) {
    const w = ordered[i];
    const idx = N - i;  // i=0→N(最后), i=N-1→1(最前)
    cmds += `try
  tell window id ${w.id} to set index to ${idx}
end try
`;
  }
  try {
    const script = `tell application "Google Chrome"\n${cmds}end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8', timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── 一次读取所有窗口内容 ─────────────────────────────
function getAllWindowContent(maxLen = 3000) {
  if (process.platform !== 'darwin') return {};
  try {
    const script = `set results to ""
tell application "Terminal"
  repeat with w in windows
    set wid to id of w
    try
      set c to contents of tab 1 of w
      if length of c > ${maxLen} then
        set c to text ((length of c) - ${maxLen}) thru (length of c) of c
      end if
      set results to results & "===WIN:" & wid & "===" & linefeed & c & linefeed
    end try
  end repeat
end tell
return results`;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8', timeout: 15000,
    });
    const m = {};
    const parts = result.split(/===WIN:(\d+)===/);
    for (let i = 1; i < parts.length; i += 2) m[parts[i]] = (parts[i + 1] || '').trim();
    return m;
  } catch { return {}; }
}

// 单窗口完整内容（用于保存记录）
function getWindowContentFull(windowIndex, maxLen = 50000) {
  if (process.platform !== 'darwin') return '';
  try {
    const script = `tell application "Terminal"
  if ${windowIndex} ≤ (count of windows) then
    set c to contents of tab 1 of window ${windowIndex}
    if length of c > ${maxLen} then
      set c to text ((length of c) - ${maxLen}) thru (length of c) of c
    end if
    return c
  end if
end tell`;
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8', timeout: 15000,
    }).trim();
  } catch { return ''; }
}

// ── 命令提取 ─────────────────────────────────────────
function stripAnsiLight(t) {
  return t.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function extractCommands(content) {
  if (!content) return [];
  const lines = stripAnsiLight(content).split('\n');
  const raw = [];
  const pats = [/[@:][^$%#]*[$%#]\s+(.{2,})$/, /^\s*[$%#]\s+(.{2,})$/, /^➜\s+\S+\s+(.{2,})$/, /^❯\s+(.{2,})$/];
  for (let i = 0; i < lines.length; i++) {
    for (const p of pats) {
      const m = lines[i].match(p);
      if (m) {
        const c = m[1].trim();
        if (c && !/^[-=─]+$/.test(c) && c.length < 300) {
          // 只算"已回车"的命令：后面必须有输出（下一行不是空的或另一个提示符）
          // 最后一个匹配的命令 = 当前正在输入，跳过
          raw.push({ cmd: c, lineIdx: i });
        }
        break;
      }
    }
  }
  // 去掉最后一条（可能是正在输入、还没回车的）
  if (raw.length > 0) raw.pop();
  // 全局去重（保留顺序，同一命令只保留最后一次出现）
  const lastSeen = new Map();
  raw.forEach((r, i) => lastSeen.set(r.cmd, i));
  const deduped = raw.filter((r, i) => lastSeen.get(r.cmd) === i);
  return deduped.map(r => r.cmd).slice(-30);
}

// ── 稳定窗口编号 ─────────────────────────────────────
function loadWindowMap() { try { return JSON.parse(readFileSync(WINDOW_MAP_FILE, 'utf-8')); } catch { return {}; } }
function saveWindowMap(m) { ensureDir(); writeFileSync(WINDOW_MAP_FILE, JSON.stringify(m, null, 2)); }

function stabilizeWindows(windows) {
  // 按物理位置排序：先按 y（上→下，容差 50px 归为同一行），再按 x（左→右）
  const ROW_TOLERANCE = 50;
  windows.sort((a, b) => {
    const rowA = Math.floor((a.y || 0) / ROW_TOLERANCE);
    const rowB = Math.floor((b.y || 0) / ROW_TOLERANCE);
    if (rowA !== rowB) return rowA - rowB;
    return (a.x || 0) - (b.x || 0);
  });

  // 按物理位置分配编号
  const map = {};
  for (let i = 0; i < windows.length; i++) {
    windows[i].stableIndex = i + 1;
    map[windows[i].id] = i + 1;
  }
  saveWindowMap(map);
  return windows;
}

// ── 内容变化检测 ─────────────────────────────────────
const prevSnap = new Map();
function isContentChanging(wid, content) {
  const snap = content.slice(-500);
  const prev = prevSnap.get(wid);
  prevSnap.set(wid, snap);
  return prev !== undefined && prev !== snap;
}

// 清理已关闭窗口的内存缓存
function cleanupSnapCache(activeIds) {
  for (const wid of prevSnap.keys()) {
    if (!activeIds.has(wid)) prevSnap.delete(wid);
  }
}

// ── 屏幕区域 ─────────────────────────────────────────
function getAvailableScreen() {
  if (process.platform !== 'darwin') return { x: 0, y: 25, width: 1920, height: 985 };
  try {
    const s = 'ObjC.import("AppKit");var s=$.NSScreen.mainScreen;var f=s.frame;var v=s.visibleFrame;var t=f.size.height-v.origin.y-v.size.height;Math.round(v.origin.x)+","+Math.round(t)+","+Math.round(v.size.width)+","+Math.round(v.size.height)';
    const r = execSync(`osascript -l JavaScript -e '${s}'`, { encoding: 'utf-8', timeout: 5000 }).trim();
    const [x, y, w, h] = r.split(',').map(Number);
    if (w > 100 && h > 100) return { x, y, width: w, height: h };
  } catch {}
  try {
    const r = execSync(`osascript -e 'tell application "Finder" to set b to bounds of window of desktop\nreturn (item 3 of b) & "," & (item 4 of b)'`, { encoding: 'utf-8', timeout: 5000 }).trim();
    const [w, h] = r.split(',').map(Number);
    if (w > 100) return { x: 0, y: 25, width: w, height: h - 95 };
  } catch {}
  return { x: 0, y: 25, width: 1920, height: 985 };
}

const REGIONS = {
  'full':       { x: 0,     y: 0,   w: 1,     h: 1     },
  'left-half':  { x: 0,     y: 0,   w: 0.5,   h: 1     },
  'right-half': { x: 0.5,   y: 0,   w: 0.5,   h: 1     },
  'left-2-3':   { x: 0,     y: 0,   w: 0.667, h: 1     },
  'left-1-3':   { x: 0,     y: 0,   w: 0.333, h: 1     },
  'top-half':   { x: 0,     y: 0,   w: 1,     h: 0.5   },
  'bottom-half':{ x: 0,     y: 0.5, w: 1,     h: 0.5   },
  'top-2-3':    { x: 0,     y: 0,   w: 1,     h: 0.667 },
};

function arrangeWindowsApi(cols, regionId) {
  if (process.platform !== 'darwin') return { ok: false };
  try {
    const allWindows = getWindows();
    const ignored = loadIgnored();
    const toArrange = allWindows.filter(w => !ignored.has(w.id));
    const cnt = toArrange.length;
    if (!cnt) return { ok: false };

    const screen = getAvailableScreen();
    const rg = REGIONS[regionId] || REGIONS['full'];
    const eff = {
      x: screen.x + Math.round(screen.width * rg.x),
      y: screen.y + Math.round(screen.height * rg.y),
      width: Math.round(screen.width * rg.w),
      height: Math.round(screen.height * rg.h),
    };
    const gap = 8;
    if (!cols || cols <= 0) {
      if (cnt <= 3) cols = cnt;
      else if (cnt <= 4) cols = 2;
      else if (cnt <= 6) cols = 3;
      else cols = 4;
    }
    const rows = Math.ceil(cnt / cols);
    const cw = Math.floor((eff.width - gap * (cols + 1)) / cols);
    const ch = Math.floor((eff.height - gap * (rows + 1)) / rows);

    let cmds = '';
    for (let i = 0; i < cnt; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const x = eff.x + gap + c * (cw + gap);
      const y = eff.y + gap + r * (ch + gap);
      cmds += `  set bounds of (window id ${toArrange[i].id}) to {${x}, ${y}, ${x + cw}, ${y + ch}}\n`;
    }
    execSync(`osascript -e 'tell application "Terminal"\n  activate\n${cmds}end tell'`, { encoding: 'utf-8', timeout: 15000 });
    // 保存当前布局信息，供 Web 面板使用
    try { writeFileSync(LAYOUT_FILE, JSON.stringify({ cols, rows, arranged: cnt })); } catch {}
    return { ok: true, screen: eff, cols, rows, cw, ch, arranged: cnt, ignored: ignored.size };
  } catch { return { ok: false }; }
}

// 交换两个窗口的物理位置（bounds）
function swapWindowsApi(winIdA, winIdB) {
  if (process.platform !== 'darwin') return false;
  try {
    const script = `tell application "Terminal"
  set wA to window id ${winIdA}
  set wB to window id ${winIdB}
  set bA to bounds of wA
  set bB to bounds of wB
  set bounds of wA to bB
  set bounds of wB to bA
end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 5000 });
    // 同时交换 stableIndex
    const map = loadWindowMap();
    if (map[winIdA] !== undefined && map[winIdB] !== undefined) {
      const tmp = map[winIdA];
      map[winIdA] = map[winIdB];
      map[winIdB] = tmp;
      saveWindowMap(map);
    }
    return true;
  } catch { return false; }
}

function focusWindowApi(windowId) {
  if (process.platform !== 'darwin') return false;
  try {
    // 置前 + 弹跳效果：先缩小窗口再弹回原尺寸，让用户一眼看到是哪个
    const script = `tell application "Terminal"
  activate
  set w to window id ${windowId}
  set index of w to 1
  set ob to bounds of w
  set {x1, y1, x2, y2} to ob
  set bounds of w to {x1 + 30, y1 + 25, x2 - 30, y2 - 25}
  delay 0.1
  set bounds of w to {x1 + 15, y1 + 12, x2 - 15, y2 - 12}
  delay 0.08
  set bounds of w to ob
end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch { return false; }
}

function closeWindowApi(windowId) {
  if (process.platform !== 'darwin') return false;
  try {
    const script = `tell application "Terminal"
  close window id ${windowId}
end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch { return false; }
}

function activateTerminal() {
  if (process.platform !== 'darwin') return false;
  try { execSync(`osascript -e 'tell application "Terminal" to activate'`, { encoding: 'utf-8', timeout: 5000 }); return true; } catch { return false; }
}

// ── 输出记录管理 ─────────────────────────────────────
function listRecords() {
  ensureRecordsDir();
  try {
    const files = readdirSync(RECORDS_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const d = JSON.parse(readFileSync(join(RECORDS_DIR, f), 'utf-8'));
        return { id: d.id, label: d.label, createdAt: d.createdAt, lines: d.lines, note: d.note || '' };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

// ── SSH 连接测试 ─────────────────────────────────────
function testSSHConnection(conn) {
  const safeHost = /^[a-zA-Z0-9._-]+$/.test(conn.host) ? conn.host : null;
  const safeUser = /^[a-zA-Z0-9._-]+$/.test(conn.username) ? conn.username : null;
  const port = parseInt(conn.port) || 22;
  if (!safeHost || !safeUser || port < 1 || port > 65535) return { ok: false, error: '参数校验失败' };
  try {
    let cmd = `ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no -p ${port}`;
    if (conn.keyPath) {
      const safePath = conn.keyPath.replace(/^~/, homedir());
      if (!existsSync(safePath)) return { ok: false, error: 'SSH Key 文件不存在: ' + conn.keyPath };
      if (/[;&|`$(){}"'\\<>\n\r]/.test(safePath)) return { ok: false, error: 'Key 路径包含非法字符' };
      cmd += ` -i "${safePath}"`;
    }
    cmd += ` ${safeUser}@${safeHost} echo ok`;
    execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
    return { ok: true };
  } catch (err) {
    const msg = err.stderr || err.message || '连接失败';
    return { ok: false, error: msg.slice(0, 200) };
  }
}

// ── SSH 批量启动 ─────────────────────────────────────
function launchSSHPresets(presetIds) {
  if (process.platform !== 'darwin') return { ok: false, error: '仅支持 macOS' };
  const presets = loadSSHPresets();
  const connections = loadSSHConnections();
  const launched = [];
  const presetWindowMap = {};

  // 启动前记录一次窗口集合（避免每个预设都调用 AppleScript）
  let beforeIds;
  try {
    beforeIds = new Set(getWindows().map(w => w.id));
  } catch { beforeIds = new Set(); }

  for (const pid of presetIds) {
    const preset = presets[pid];
    if (!preset) continue;
    const conn = connections[preset.connectionId];
    if (!conn) continue;

    const dir = (preset.directory || '').replace(/'/g, "'\\''");
    const cmd = (preset.command || '').replace(/'/g, "'\\''");

    if (conn.type === 'local' || conn.type === 'shell') {
      // local / shell：本机直接 cd && cmd（不涉及 ssh）
      let localCmd = '';
      if (dir && cmd) localCmd = `cd '${dir}' && ${cmd}`;
      else if (dir) localCmd = `cd '${dir}'`;
      else if (cmd) localCmd = cmd;

      try {
        const escapedCmd = localCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const script = `tell application "Terminal"\n  activate\n  do script "${escapedCmd}"\nend tell`;
        execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 10000 });
        launched.push(preset.name);
      } catch {}
    } else {
      // SSH 连接：决定连接段（用户自定义 ssh 别名 OR 标准 ssh 拼接）
      let connectPart = '';
      const customConn = (conn.customConnect || '').trim();
      if (customConn) {
        // 用户填了 customConnect（如 "ssh vps-proxy"）→ 直接用
        // 仅过滤换行符（前面 API 已校验，这里再保险一下）
        if (/[\n\r]/.test(customConn)) continue;
        connectPart = customConn;
      } else {
        // 标准模式：ssh -p PORT user@host [-i keyPath]
        const safeHost = /^[a-zA-Z0-9._-]+$/.test(conn.host) ? conn.host : null;
        const safeUser = /^[a-zA-Z0-9._-]+$/.test(conn.username) ? conn.username : null;
        const port = parseInt(conn.port) || 22;
        if (!safeHost || !safeUser || port < 1 || port > 65535) continue;
        connectPart = `ssh -p ${port}`;
        if (conn.keyPath) {
          const safePath = conn.keyPath.replace(/^~/, homedir());
          if (existsSync(safePath) && !/[;&|`$(){}"'\\<>\n\r]/.test(safePath)) {
            connectPart += ` -i '${safePath}'`;
          }
        }
        connectPart += ` ${safeUser}@${safeHost}`;
      }

      let remoteCmd = '';
      if (dir && cmd) remoteCmd = ` -t 'cd ${dir} && ${cmd}; exec $SHELL'`;
      else if (dir) remoteCmd = ` -t 'cd ${dir}; exec $SHELL'`;
      else if (cmd) remoteCmd = ` -t '${cmd}; exec $SHELL'`;

      const fullCmd = `${connectPart}${remoteCmd}`;
      try {
        const escapedCmd = fullCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const script = `tell application "Terminal"\n  activate\n  do script "${escapedCmd}"\nend tell`;
        execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 10000 });
        launched.push(preset.name);
      } catch {}
    }

  }

  // 启动后统一获取一次新窗口列表，找出所有新增窗口
  try {
    const afterWindows = getWindows();
    const newWindowIds = afterWindows.filter(w => !beforeIds.has(w.id)).map(w => w.id);
    // 按顺序将新窗口分配给各预设
    let ni = 0;
    for (const pid of presetIds) {
      if (ni < newWindowIds.length && launched.includes(presets[pid]?.name)) {
        presetWindowMap[pid] = newWindowIds[ni++];
      }
    }
  } catch {}

  return { ok: true, launched, presetWindowMap };
}

// ── HTML ─────────────────────────────────────────────
let _cachedHTML = null;
function getHTML() {
  if (_cachedHTML) return _cachedHTML;
  _cachedHTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Temine 控制面板</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro','Helvetica Neue',sans-serif;background:#0d1117;color:#c9d1d9}
.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:10px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100}
.topbar h1{font-size:17px;font-weight:600;color:#58a6ff;white-space:nowrap;display:flex;align-items:baseline;gap:8px}
.topbar h1 .version-tag{font-size:11px;font-weight:500;color:#8b949e;padding:2px 8px;background:#21262d;border:1px solid #30363d;border-radius:10px;letter-spacing:0.3px}
body.theme-warp .topbar h1 .version-tag{background:rgba(255,138,200,0.12);border:1px solid rgba(255,138,200,0.25);color:#ffd8eb}
.tabs{display:flex;gap:4px}
.tab-btn{background:transparent;border:1px solid transparent;border-radius:6px;padding:5px 14px;color:#8b949e;font-size:13px;cursor:pointer;transition:all .15s}
.tab-btn:hover{color:#c9d1d9}
.tab-btn.active{background:#21262d;color:#c9d1d9;border-color:#30363d}
.topbar-right{margin-left:auto;display:flex;gap:8px;align-items:center}
.update-btn,.theme-toggle{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:5px 12px;border-radius:6px;font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
.update-btn:hover,.theme-toggle:hover{background:#30363d;border-color:#58a6ff}
.update-btn.updating{background:#0d4429;color:#3fb950;border-color:#238636;cursor:wait;pointer-events:none}
.update-btn.success{background:#0d4429;color:#3fb950;border-color:#238636}
.update-btn.failed{background:#3d0a0a;color:#f85149;border-color:#f85149}
.badge{padding:4px 12px;border-radius:12px;font-size:12px;font-weight:500}
.badge.on{background:#0d4429;color:#3fb950}.badge.off{background:#3d1d00;color:#d29922;cursor:pointer}

.alert-banner{display:none;background:#490202;border-bottom:2px solid #f85149;padding:8px 24px;color:#f85149;font-weight:600;font-size:13px;animation:bannerBlink 1s infinite;text-align:center}
.alert-banner.show{display:block}
@keyframes bannerBlink{0%,100%{opacity:1}50%{opacity:.7}}

.layout-section{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px}
.layout-section h3{font-size:12px;color:#8b949e;margin-bottom:8px}
.region-row{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.region-label{font-size:12px;color:#8b949e;margin-right:4px}
.region-btn{background:#21262d;border:1px solid #30363d;border-radius:4px;padding:3px 10px;color:#8b949e;font-size:11px;cursor:pointer;transition:all .15s}
.region-btn:hover{border-color:#58a6ff;color:#c9d1d9}
.region-btn.active{background:#0c2d6b;border-color:#58a6ff;color:#58a6ff}
.layout-options{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}
.layout-card{border:1px solid #30363d;border-radius:8px;padding:8px;cursor:pointer;background:#0d1117;width:100px;text-align:center;transition:all .15s}
.layout-card:hover{border-color:#58a6ff;transform:translateY(-1px)}
.layout-card.active{border-color:#58a6ff;background:#0c2d6b22}
.layout-grid{display:grid;gap:2px;margin-bottom:4px;height:48px;overflow:hidden}
.layout-cell{background:#21262d;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;color:#484f58;min-height:0}
.layout-card:hover .layout-cell{background:#30363d}
.layout-card.active .layout-cell{background:#1a4b8c;color:#58a6ff}
.layout-name{font-size:10px;color:#8b949e}
.layout-card.active .layout-name{color:#58a6ff}
.layout-actions{display:flex;flex-direction:column;gap:5px;justify-content:center;margin-left:12px}
.btn{padding:5px 14px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;font-size:12px;cursor:pointer;transition:all .15s}
.btn:hover{background:#30363d;border-color:#58a6ff}
.btn.primary{background:#238636;border-color:#238636;color:#fff}
.btn.primary:hover{background:#2ea043}

.cards{display:grid;gap:14px;padding:16px 24px 10px}
.ignored-section{padding:0 24px 60px}
.ignored-section h4{font-size:12px;color:#484f58;margin:8px 0;border-top:1px dashed #30363d;padding-top:10px}
.ignored-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden;transition:border-color .2s,box-shadow .2s;cursor:default}
.card:hover{border-color:#484f58}
.card.focusing{animation:focusFlash .7s ease;cursor:pointer}
@keyframes focusFlash{0%{box-shadow:0 0 0 3px #58a6ff;transform:scale(1.03)}40%{box-shadow:0 0 12px 4px rgba(88,166,255,.4);transform:scale(1.01)}100%{box-shadow:none;transform:scale(1)}}
.card.state-waiting_confirm{border:2px solid #f85149}
.card.state-running{border-color:#3fb950}
.card.state-error{border-color:#d29922}
.card.state-completed{border-color:#58a6ff}

.card-header{padding:8px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #21262d}
.card-header-left{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.card-idx{font-size:17px;min-width:26px;text-align:center}
.card-label{flex:1;background:transparent;border:1px solid transparent;border-radius:4px;padding:3px 6px;color:#c9d1d9;font-size:13px;font-weight:500;outline:none;min-width:0;pointer-events:none}
.card-label.editing{pointer-events:auto;border-color:#58a6ff;background:#0d1117}
.label-edit-btn{background:none;border:none;color:#484f58;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:3px;transition:all .15s;flex-shrink:0}
.label-edit-btn:hover{color:#58a6ff;background:#21262d}
.label-confirm-btn{background:#238636;border:none;color:#fff;font-size:11px;cursor:pointer;padding:2px 8px;border-radius:3px;display:none;flex-shrink:0}
.label-confirm-btn.show{display:inline-block}
.label-cancel-btn{background:none;border:1px solid #30363d;color:#8b949e;font-size:11px;cursor:pointer;padding:2px 6px;border-radius:3px;display:none;flex-shrink:0}
.label-cancel-btn.show{display:inline-block}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.dot.idle{background:#484f58}.dot.running{background:#3fb950;animation:pulse 1.5s infinite}
.dot.waiting_confirm{background:#f85149;animation:blink .8s infinite}
.dot.error{background:#d29922}.dot.completed{background:#58a6ff}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(1.3)}}
.stag{font-size:10px;padding:2px 7px;border-radius:10px;white-space:nowrap;cursor:help}
.stag.idle{background:#21262d;color:#8b949e}.stag.running{background:#0d4429;color:#3fb950}
.stag.waiting_confirm{background:#490202;color:#f85149;font-weight:600}
.stag.error{background:#3d1d00;color:#d29922}.stag.completed{background:#0c2d6b;color:#58a6ff}

.card-preview{max-height:110px;overflow-y:auto}
.card-preview pre{font-family:'SF Mono',Menlo,Monaco,'Courier New',monospace;font-size:10px;line-height:1.4;padding:8px 12px;color:#8b949e;white-space:pre-wrap;word-break:break-all;margin:0}
.card-preview::-webkit-scrollbar{width:5px}
.card-preview::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
.card-footer{border-top:1px solid #21262d;padding:5px 12px;display:flex;gap:6px;align-items:center}
.card-footer .fbtn{background:none;border:1px solid #30363d;border-radius:4px;padding:2px 8px;color:#8b949e;font-size:10px;cursor:pointer;transition:all .15s;white-space:nowrap}
.card-footer .fbtn:hover{border-color:#58a6ff;color:#58a6ff}
.card-footer .fbtn.saved{border-color:#3fb950;color:#3fb950}
.card-footer .spacer{flex:1}
.card-footer .dblclick-hint{font-size:10px;color:#484f58;opacity:.6;transition:opacity .15s}
.card:hover .dblclick-hint{opacity:1;color:#58a6ff}

.watcher-hint{margin:16px 24px;padding:14px 18px;background:#161b22;border:1px dashed #30363d;border-radius:8px;color:#8b949e;font-size:12px;line-height:1.7}
.watcher-hint code{background:#21262d;padding:2px 5px;border-radius:4px;color:#58a6ff;font-size:11px}

/* 过程记录 tab */
.records-page{padding:16px 24px 60px}
.records-page h3{font-size:14px;color:#8b949e;margin-bottom:12px}
.sub-tabs{display:flex;gap:4px;margin-bottom:14px;align-items:center}
.sub-tab{background:transparent;border:1px solid transparent;border-radius:6px;padding:5px 14px;color:#8b949e;font-size:13px;cursor:pointer;transition:all .15s}
.sub-tab:hover{color:#c9d1d9}
.sub-tab.active{background:#21262d;color:#c9d1d9;border-color:#30363d}
.rec-item{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin-bottom:10px}
.rec-item:hover{border-color:#484f58}
.rec-meta{display:flex;gap:12px;align-items:center;margin-bottom:6px;flex-wrap:wrap}
.rec-label{color:#c9d1d9;font-weight:600;font-size:14px}
.rec-time{color:#8b949e;font-size:12px}
.rec-lines{color:#484f58;font-size:12px}
.rec-note-input{background:transparent;border:1px solid #21262d;border-radius:4px;padding:3px 8px;color:#c9d1d9;font-size:12px;width:100%;margin-bottom:6px;outline:none}
.rec-note-input:focus{border-color:#58a6ff}
.rec-actions{display:flex;gap:6px}
.rec-actions .btn{font-size:11px;padding:3px 10px}
.log-session{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin-bottom:10px;cursor:pointer;transition:border-color .15s}
.log-session:hover{border-color:#58a6ff}
.log-session.open{border-color:#58a6ff;background:#0d1117}
.log-session .ls-head{display:flex;align-items:center;gap:10px}
.log-session .ls-label{color:#c9d1d9;font-weight:600;font-size:14px}
.log-session .ls-time{color:#8b949e;font-size:12px}
.log-session .ls-badge{font-size:10px;padding:2px 8px;border-radius:10px;background:#21262d;color:#8b949e}
.log-session .ls-toggle{margin-left:auto;color:#484f58;font-size:12px;transition:color .15s}
.log-session:hover .ls-toggle{color:#58a6ff}
.log-viewer{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;margin-top:8px;max-height:500px;overflow-y:auto;user-select:text;cursor:text;position:relative}
.log-viewer pre{font-family:'SF Mono',Menlo,Monaco,'Courier New',monospace;font-size:11px;color:#8b949e;line-height:1.6;white-space:pre-wrap;word-break:break-all;margin:0;user-select:text}
.log-viewer .lv-cmd{color:#7ee787}.log-viewer .lv-ts{color:#484f58;font-size:10px}
.log-viewer-toolbar{display:flex;gap:6px;margin-bottom:8px;justify-content:flex-end;user-select:none}
.log-viewer-toolbar .btn{font-size:10px;padding:2px 8px}
.rec-toggle{display:inline-flex;align-items:center;gap:4px;font-size:10px;cursor:pointer;user-select:none;padding:2px 8px;border-radius:4px;border:1px solid #30363d;transition:all .15s}
.rec-toggle:hover{border-color:#58a6ff}
.rec-toggle.on{border-color:#3fb950;color:#3fb950}
.rec-toggle.off{border-color:#484f58;color:#484f58}
.rec-toggle.disabled{border-color:#21262d;color:#30363d;cursor:not-allowed;opacity:.4}

/* 弹窗 */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:200}
.modal-box{background:#161b22;border:1px solid #30363d;border-radius:12px;width:700px;max-height:85vh;display:flex;flex-direction:column}
.modal-head{padding:12px 18px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center}
.modal-head h3{color:#c9d1d9;font-size:15px}
.modal-close{background:none;border:none;color:#8b949e;font-size:18px;cursor:pointer}
.modal-close:hover{color:#c9d1d9}
.modal-body{padding:12px 18px;overflow-y:auto;flex:1}
.modal-body pre{font-family:'SF Mono',Menlo,Monaco,'Courier New',monospace;font-size:11px;color:#8b949e;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.cmd-line{font-family:'SF Mono',Menlo,Monaco,'Courier New',monospace;font-size:11px;color:#7ee787;padding:2px 0}
.cmd-line::before{content:'$ ';color:#484f58}

.statusbar{position:fixed;bottom:0;left:0;right:0;background:#161b22;border-top:1px solid #30363d;padding:5px 24px;font-size:11px;color:#484f58;display:flex;justify-content:space-between}
.empty{text-align:center;padding:50px 20px;color:#484f58}
.empty h2{font-size:18px;margin-bottom:6px}
.card.ignored{opacity:0.4;border-style:dashed}
.card.ignored .card-preview{max-height:40px}
.fbtn.ignore-on{color:#f0883e;border-color:#f0883e}
.fbtn.close-btn{color:#f85149;border-color:#f85149}
.fbtn.close-btn:hover{background:#490202;color:#ff7b72}

/* 预设工具栏 */
.preset-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
.preset-search{background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:5px 10px;color:#c9d1d9;font-size:12px;width:160px;outline:none}
.preset-search:focus{border-color:#58a6ff}
.preset-sort-btn{background:#21262d;border:1px solid #30363d;border-radius:4px;padding:4px 10px;color:#8b949e;font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
.preset-sort-btn:hover{border-color:#58a6ff;color:#c9d1d9}
.preset-sort-btn.active{border-color:#58a6ff;color:#58a6ff}
.preset-group-tabs{display:flex;gap:4px;flex-wrap:wrap;flex:1}
.preset-group-tab{background:transparent;border:1px solid #30363d;border-radius:12px;padding:3px 10px;color:#8b949e;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap}
.preset-group-tab:hover{border-color:#58a6ff;color:#c9d1d9}
.preset-group-tab.active{background:#0c2d6b;border-color:#58a6ff;color:#58a6ff}
.preset-group-badge{font-size:10px;padding:1px 6px;border-radius:8px;background:#21262d;color:#8b949e;margin-left:6px}

/* SSH 快捷启动 tab */
.ssh-container{display:flex;height:calc(100vh - 100px)}
.ssh-left{width:38%;border-right:1px solid #30363d;overflow-y:auto;padding:16px}
.ssh-right{width:62%;overflow-y:auto;padding:16px}
.ssh-section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.ssh-section-head h3{font-size:14px;color:#8b949e}
.ssh-form{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:12px}
.ssh-form label{display:block;font-size:12px;color:#8b949e;margin-bottom:3px;margin-top:8px}
.ssh-form label:first-child{margin-top:0}
.ssh-form input,.ssh-form select{width:100%;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#c9d1d9;font-size:13px;outline:none}
.ssh-form input:focus,.ssh-form select:focus{border-color:#58a6ff}
.ssh-form .form-row{display:flex;gap:8px}
.ssh-form .form-row>*{flex:1}
.ssh-form .form-actions{display:flex;gap:8px;margin-top:12px;justify-content:flex-end}
.conn-item{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;margin-bottom:8px;cursor:pointer;transition:all .15s}
.conn-item:hover{border-color:#484f58}
.conn-item.active{border-color:#58a6ff;background:#0c2d6b22}
.conn-item .conn-name{font-size:14px;color:#c9d1d9;font-weight:500}
.conn-item .conn-host{font-size:12px;color:#8b949e;margin-top:2px}
.conn-item .conn-actions{display:flex;gap:6px;margin-top:6px}
.conn-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:6px}
.conn-dot.ok{background:#3fb950}
.conn-dot.fail{background:#f85149}
.conn-dot.unknown{background:#484f58}
.preset-item{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:flex-start;gap:10px;transition:all .15s}
.preset-item:hover{border-color:#484f58}
.preset-item .preset-check{margin-top:2px;cursor:pointer;width:16px;height:16px;accent-color:#58a6ff}
.preset-item .preset-info{flex:1}
.preset-item .preset-name{font-size:14px;color:#c9d1d9;font-weight:500}
.preset-item .preset-cmd{font-size:12px;color:#8b949e;margin-top:2px;font-family:'SF Mono',Menlo,monospace}
.preset-item .preset-actions{display:flex;gap:6px;margin-top:6px}
.ssh-launch-bar{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#161b22;border:1px solid #30363d;border-radius:12px;padding:10px 24px;display:flex;align-items:center;gap:16px;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.global-rec{display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:500;transition:all .15s;user-select:none}
.global-rec.on{background:#0d4429;color:#3fb950}
.global-rec.off{background:#3d1d00;color:#d29922}
.log-search-input{background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:4px 10px;color:#c9d1d9;font-size:12px;width:160px;outline:none}
.log-search-input:focus{border-color:#58a6ff}
.search-result-item{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;margin-bottom:8px}
.search-result-item .sr-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.search-result-item .sr-label{color:#c9d1d9;font-weight:600;font-size:13px}
.search-result-item .sr-count{font-size:11px;color:#8b949e}
.search-result-item .sr-preview{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#8b949e;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.search-result-item mark{background:#634c00;color:#f0c000;border-radius:2px;padding:0 1px}
.hint-text{font-size:11px;color:#484f58;line-height:1.5;margin:0}
.section-desc{font-size:11px;color:#484f58;margin-bottom:6px}
.inline-hint{font-size:10px;color:#484f58;margin-left:6px;font-weight:normal}

/* 拖拽换位 */
.card.dragging{opacity:.4;border:2px dashed #58a6ff}
.card.drag-over{box-shadow:0 0 0 2px #58a6ff;border-color:#58a6ff;background:#0c2d6b22}

/* 预设已启动标亮 */
.preset-item{cursor:pointer;transition:all .15s}
.preset-item.launched{border-left:3px solid #3fb950;background:#0d442911}

/* 视图切换 */
.view-toggle{display:flex;gap:0;margin:0 24px 0;padding-top:12px}
.view-toggle .vt-btn{background:#21262d;border:1px solid #30363d;padding:5px 16px;color:#8b949e;font-size:12px;cursor:pointer;transition:all .15s}
.view-toggle .vt-btn:first-child{border-radius:6px 0 0 6px}
.view-toggle .vt-btn:last-child{border-radius:0 6px 6px 0;border-left:none}
.view-toggle .vt-btn.active{background:#0c2d6b;color:#58a6ff;border-color:#58a6ff}

/* 画版视图 */
.board-container{position:relative;overflow:auto;height:calc(100vh - 200px);background:#0d1117;background-image:radial-gradient(circle,#21262d 1px,transparent 1px);background-size:24px 24px;border:1px solid #30363d;border-radius:8px;margin:0 24px}
.board-toolbar{display:flex;gap:8px;padding:8px 24px;align-items:center}
.board-node{position:absolute;width:200px;background:#161b22;border:1px solid #30363d;border-radius:8px;cursor:grab;transition:box-shadow .15s;user-select:none;z-index:1}
.board-node:hover{border-color:#484f58;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.board-node.bn-dragging{cursor:grabbing;box-shadow:0 4px 16px rgba(0,0,0,.5);z-index:10;opacity:.9}
.board-node .bn-header{padding:6px 8px;display:flex;align-items:center;gap:4px}
.board-node .bn-title{font-size:11px;color:#c9d1d9;word-break:break-all;line-height:1.3;max-height:2.6em;overflow:hidden;flex:1;background:transparent;border:1px solid transparent;border-radius:3px;padding:1px 3px;outline:none;width:100%;font-family:inherit}
.board-node .bn-title:not([readonly]){border-color:#58a6ff;background:#0d1117;cursor:text}
.board-node .bn-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.board-node .bn-stag{font-size:8px;color:#8b949e;padding:1px 4px;border-radius:6px;white-space:nowrap}
.board-node .bn-stag.running{color:#3fb950}.board-node .bn-stag.waiting_confirm{color:#f85149;font-weight:600}.board-node .bn-stag.error{color:#d29922}.board-node .bn-stag.completed{color:#58a6ff}
.board-node.state-waiting_confirm{border-color:#f85149}.board-node.state-running{border-color:#3fb950}.board-node.state-error{border-color:#d29922}.board-node.state-completed{border-color:#58a6ff}
.board-node .bn-idx{font-size:10px;color:#484f58;min-width:14px}
.board-node .bn-preview{font-size:9px;color:#484f58;padding:0 8px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-node.bn-closed{opacity:.4;border-style:dashed}
.bn-color-bar{height:4px;border-radius:0 0 7px 7px;overflow:hidden;display:flex;transition:height .2s;cursor:pointer}
.board-node:hover .bn-color-bar{height:16px}
.bn-color-bar .bn-cswatch{flex:1;transition:opacity .15s;opacity:0}
.board-node:hover .bn-color-bar .bn-cswatch{opacity:1}
.bn-color-bar .bn-cswatch:hover{opacity:1;filter:brightness(1.3)}
.board-note{position:absolute;background:#1c2333;border:1px dashed #30363d;border-radius:8px;min-width:120px;min-height:60px;z-index:1;overflow:visible}
.board-note:hover{border-color:#484f58}
.board-note textarea{width:100%;height:calc(100% - 24px);background:transparent;border:none;color:#c9d1d9;font-size:12px;padding:4px 8px;resize:none;outline:none;font-family:inherit}
.board-note .note-header{display:flex;align-items:center;padding:4px 8px;cursor:grab}
.board-note .note-header span{flex:1;font-size:10px;color:#484f58}
.board-note .note-delete{background:none;border:none;color:#484f58;cursor:pointer;font-size:12px;padding:2px 4px;border-radius:3px}
.board-note .note-delete:hover{color:#f85149;background:#21262d}
.board-note .note-resize{position:absolute;bottom:0;right:0;width:12px;height:12px;cursor:nwse-resize;opacity:0}
.board-note:hover .note-resize{opacity:.5}

/* === Chrome 多窗口卡片（堆叠 + 折叠/展开） === */
.chrome-empty{padding:40px 20px;text-align:center;color:#484f58;font-size:13px}
.chrome-window-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:8px;overflow:hidden;transition:border-color .15s}
.chrome-window-card:hover{border-color:#58a6ff}
.chrome-window-head{padding:12px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;user-select:none}
.chrome-window-head:hover{background:#1c2129}
.chrome-window-toggle{color:#8b949e;font-size:13px;flex:0 0 14px;transition:transform .25s ease}
.chrome-window-card.expanded .chrome-window-toggle{transform:rotate(90deg);color:#58a6ff}
.chrome-window-icon{flex:0 0 22px;height:22px;border-radius:5px;background:linear-gradient(135deg,#fbbc05,#ea4335);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff}
.chrome-window-title{flex:1;font-weight:600;color:#c9d1d9;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chrome-window-meta{color:#8b949e;font-size:11px;flex-shrink:0}
.chrome-window-tabs{max-height:0;overflow:hidden;transition:max-height .35s ease,border-top-color .35s ease;border-top:1px solid transparent}
.chrome-window-card.expanded .chrome-window-tabs{max-height:600px;overflow-y:auto;border-top-color:#30363d}
.chrome-tab-item{padding:9px 16px 9px 40px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid #21262d;transition:background .1s}
.chrome-tab-item:last-child{border-bottom:none}
.chrome-tab-item:hover{background:#21262d}
.chrome-tab-favicon{flex:0 0 14px;height:14px;border-radius:2px;background:#30363d}
.chrome-tab-title{flex:1;color:#c9d1d9;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chrome-tab-url{color:#6e7681;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;font-family:'SF Mono',Menlo,monospace}
body.theme-warp .chrome-window-card{background:rgba(28,20,40,0.55);border-color:rgba(255,138,200,0.18)}
body.theme-warp .chrome-window-card:hover{border-color:#ff8db4}
body.theme-warp .chrome-window-card.expanded .chrome-window-toggle{color:#ff8db4}
body.theme-warp .chrome-window-tabs{border-top-color:transparent}
body.theme-warp .chrome-window-card.expanded .chrome-window-tabs{border-top-color:rgba(255,138,200,0.18)}
body.theme-warp .chrome-tab-item{border-bottom-color:rgba(255,138,200,0.1)}

/* ════════════════════════════════════════════════════════════
   Warp 主题（参考 warp.dev 产品风格：暖紫粉橙 + 玻璃拟态 + 大圆角）
   通过 body.theme-warp 启用
   ═══════════════════════════════════════════════════════════ */
body.theme-warp{
  background:radial-gradient(ellipse 80% 60% at 20% 0%,#2a1438 0%,transparent 60%),
             radial-gradient(ellipse 70% 50% at 80% 100%,#4a1d3a 0%,transparent 55%),
             radial-gradient(ellipse 60% 80% at 100% 30%,#3d1530 0%,transparent 50%),
             #0a0613;
  background-attachment:fixed;
  color:#e8d9ff;
}
body.theme-warp .topbar{
  background:rgba(20,12,28,0.72);
  backdrop-filter:blur(20px) saturate(160%);
  -webkit-backdrop-filter:blur(20px) saturate(160%);
  border-bottom:1px solid rgba(255,138,200,0.18);
  padding:12px 28px;
}
body.theme-warp .topbar h1{
  background:linear-gradient(135deg,#ff8db4 0%,#c879ff 50%,#ffb088 100%);
  -webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;
  font-weight:700;letter-spacing:-0.3px;
}
body.theme-warp .tab-btn{color:rgba(232,217,255,0.55);border-radius:10px;padding:6px 16px;font-weight:500}
body.theme-warp .tab-btn:hover{color:#ffd8eb;background:rgba(255,138,200,0.08)}
body.theme-warp .tab-btn.active{
  background:linear-gradient(135deg,rgba(255,138,200,0.18),rgba(200,121,255,0.18));
  color:#ffd8eb;border:1px solid rgba(255,138,200,0.3);
  box-shadow:0 2px 12px rgba(255,138,200,0.18);
}
body.theme-warp .update-btn,body.theme-warp .theme-toggle{
  background:rgba(255,255,255,0.05);
  border:1px solid rgba(255,138,200,0.25);
  color:#ffd8eb;border-radius:10px;
}
body.theme-warp .update-btn:hover,body.theme-warp .theme-toggle:hover{
  background:rgba(255,138,200,0.14);
  border-color:#ff8db4;
  box-shadow:0 0 14px rgba(255,138,200,0.3);
}
body.theme-warp .badge{background:rgba(255,255,255,0.06);color:#e8d9ff;border-radius:10px}
body.theme-warp .badge.on{background:rgba(64,220,166,0.18);color:#7ff5c4}
body.theme-warp .badge.off{background:rgba(255,178,86,0.2);color:#ffc88a}
body.theme-warp .global-rec{border-radius:10px;padding:5px 14px}
body.theme-warp .global-rec.on{background:rgba(64,220,166,0.18);color:#7ff5c4}
body.theme-warp .global-rec.off{background:rgba(255,178,86,0.2);color:#ffc88a}

body.theme-warp .btn{
  background:rgba(255,255,255,0.05);
  border:1px solid rgba(255,138,200,0.22);
  color:#e8d9ff;border-radius:10px;padding:6px 16px;
}
body.theme-warp .btn:hover{
  background:rgba(255,138,200,0.14);
  border-color:#ff8db4;
}
body.theme-warp .btn.primary{
  background:linear-gradient(135deg,#ff6ad5 0%,#c879ff 100%);
  border:none;color:#fff;font-weight:600;
  box-shadow:0 4px 16px rgba(255,106,213,0.35);
}
body.theme-warp .btn.primary:hover{
  background:linear-gradient(135deg,#ff85e0 0%,#d68cff 100%);
  box-shadow:0 6px 22px rgba(255,106,213,0.5);
}

body.theme-warp .card{
  background:rgba(28,20,40,0.6);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  border:1px solid rgba(255,138,200,0.18);
  border-radius:14px;
  box-shadow:0 4px 20px rgba(0,0,0,0.3);
}
body.theme-warp .card:hover{border-color:rgba(255,138,200,0.45)}
body.theme-warp .card.state-completed{border-color:#c879ff}
body.theme-warp .card-header{border-bottom-color:rgba(255,138,200,0.15)}

body.theme-warp .layout-card{
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,138,200,0.18);
  border-radius:12px;
}
body.theme-warp .layout-card:hover{border-color:#ff8db4}
body.theme-warp .layout-card.active{
  border-color:#c879ff;
  background:linear-gradient(135deg,rgba(255,106,213,0.12),rgba(200,121,255,0.12));
}
body.theme-warp .layout-card.active .layout-cell{background:rgba(200,121,255,0.3);color:#ffd8eb}
body.theme-warp .layout-card.active .layout-name{color:#ffd8eb}

body.theme-warp .region-btn{
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,138,200,0.18);
  color:rgba(232,217,255,0.7);border-radius:10px;
}
body.theme-warp .region-btn:hover{border-color:#ff8db4;color:#ffd8eb}
body.theme-warp .region-btn.active{
  background:linear-gradient(135deg,rgba(255,106,213,0.18),rgba(200,121,255,0.18));
  border-color:#c879ff;color:#ffd8eb;
}

body.theme-warp .ssh-form,body.theme-warp .conn-item,body.theme-warp .preset-item,body.theme-warp .log-session{
  background:rgba(28,20,40,0.55);
  border:1px solid rgba(255,138,200,0.18);
  border-radius:12px;
}
body.theme-warp .conn-item:hover,body.theme-warp .preset-item:hover,body.theme-warp .log-session:hover{
  border-color:#ff8db4;
}
body.theme-warp .conn-item.active{
  background:linear-gradient(135deg,rgba(255,106,213,0.14),rgba(200,121,255,0.14));
  border-color:#c879ff;
}
body.theme-warp .ssh-form input,body.theme-warp .ssh-form select{
  background:rgba(0,0,0,0.3);
  border:1px solid rgba(255,138,200,0.2);
  color:#e8d9ff;border-radius:8px;
}
body.theme-warp .ssh-form input:focus,body.theme-warp .ssh-form select:focus{border-color:#ff8db4}

body.theme-warp .modal-box{
  background:rgba(20,12,28,0.92);
  backdrop-filter:blur(24px);
  -webkit-backdrop-filter:blur(24px);
  border:1px solid rgba(255,138,200,0.25);
  border-radius:16px;
  box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 1px rgba(255,138,200,0.12);
}

body.theme-warp .vt-btn{
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,138,200,0.18);
  color:rgba(232,217,255,0.7);border-radius:10px;
}
body.theme-warp .vt-btn.active{
  background:linear-gradient(135deg,rgba(255,106,213,0.2),rgba(200,121,255,0.2));
  border-color:#c879ff;color:#ffd8eb;
}

body.theme-warp .preset-group-tab.active,body.theme-warp .preset-group-badge{
  background:linear-gradient(135deg,#ff6ad5,#c879ff);color:#fff;border:none;
}

body.theme-warp .ssh-launch-bar{
  background:rgba(20,12,28,0.92);
  backdrop-filter:blur(20px);
  border-top:1px solid rgba(255,138,200,0.25);
}

body.theme-warp ::-webkit-scrollbar-thumb{background:rgba(255,138,200,0.25);border-radius:6px}
body.theme-warp ::-webkit-scrollbar-thumb:hover{background:rgba(255,138,200,0.45)}

body.theme-warp code{background:rgba(255,138,200,0.15);color:#ffd8eb;border-radius:4px;padding:2px 6px}
body.theme-warp .alert-banner{
  background:linear-gradient(90deg,rgba(255,90,140,0.25),rgba(255,140,90,0.25));
  border-bottom:2px solid #ff5a8c;color:#ffb6c8;
}
</style></head>
<body>

<div class="alert-banner" id="alertBanner">🔴 有终端等待你的确认操作！</div>

<div class="topbar">
  <h1>Temine <span class="version-tag">v${PANEL_VERSION}</span></h1>
  <div class="tabs">
    <button class="tab-btn active" data-tab="panel" onclick="switchTab('panel')">控制面板</button>
    <button class="tab-btn" data-tab="records" onclick="switchTab('records')">过程记录</button>
    <button class="tab-btn" data-tab="ssh" onclick="switchTab('ssh')">快捷启动</button>
    <button class="tab-btn" data-tab="chrome" onclick="switchTab('chrome')">Chrome 窗口</button>
  </div>
  <div class="topbar-right">
    <span class="global-rec on" id="globalRecBadge" onclick="toggleGlobalRec()">● 录制中</span><span id="globalRecHint" style="font-size:11px;color:#484f58;max-width:180px">自动记录命令和输出，点击暂停</span>
    <button class="theme-toggle" id="themeToggleBtn" onclick="toggleTheme()" title="切换主题（GitHub Dark / Warp）">🎨 主题</button>
    <button class="update-btn" id="updateBtn" onclick="syncUpdate()" title="从 github:zzmlb/temine 拉取最新版本">⬆ 更新</button>
    <span class="badge" id="watcherBadge" onclick="toggleHint()" title="点击查看状态检测说明">检查中...</span>
  </div>
</div>

<!-- ====== TAB: 控制面板 ====== -->
<div id="tabPanel">

<div class="layout-section">
  <p class="section-desc">选择终端窗口的排布区域和列数，点击"应用排布"自动整理所有终端窗口位置</p>
  <div class="region-row">
    <span class="region-label">屏幕区域:</span>
    <button class="region-btn active" data-rg="full" onclick="selectRegion('full')">全屏</button>
    <button class="region-btn" data-rg="left-half" onclick="selectRegion('left-half')">左 ½</button>
    <button class="region-btn" data-rg="right-half" onclick="selectRegion('right-half')">右 ½</button>
    <button class="region-btn" data-rg="left-2-3" onclick="selectRegion('left-2-3')">左 ⅔</button>
    <button class="region-btn" data-rg="left-1-3" onclick="selectRegion('left-1-3')">左 ⅓</button>
    <button class="region-btn" data-rg="top-half" onclick="selectRegion('top-half')">上 ½</button>
    <button class="region-btn" data-rg="top-2-3" onclick="selectRegion('top-2-3')">上 ⅔</button>
    <button class="region-btn" data-rg="bottom-half" onclick="selectRegion('bottom-half')">下 ½</button>
  </div>
  <h3>窗口排列</h3>
  <div class="layout-options" id="layoutOptions"></div>
</div>

<div class="watcher-hint" id="watcherHint" style="display:none">
  <strong>状态检测:</strong> <code>temine watch</code> 每秒读取终端内容。<br>
  🟢 <b>运行中</b> = 内容在变化 或 检测到 spinner/进度条<br>
  🔴 <b>等待确认</b> = 检测到 Do you want to proceed? 等提示<br>
  ⚪ <b>空闲</b> = 内容无变化且无匹配模式<br>
  没有 watch 时默认"空闲"。请在另一终端运行 <code>temine watch</code>。
</div>

<div class="view-toggle">
  <button class="vt-btn active" onclick="switchView('cards')">卡片视图</button>
  <button class="vt-btn" onclick="switchView('board')">画版视图</button>
</div>

<div id="cardsView">
<div class="cards" id="cards"><div class="empty"><h2>加载中...</h2></div></div>
<div class="ignored-section" id="ignoredSection" style="display:none"><h4>已忽略的终端</h4><div class="ignored-cards" id="ignoredCards"></div></div>
</div>

<div id="boardView" style="display:none">
  <div class="board-toolbar">
    <button class="btn" onclick="addBoardNote()">+ 添加便签</button>
    <button class="btn" onclick="resetBoardLayout()">重置布局</button>
    <span style="flex:1"></span>
    <span style="font-size:11px;color:#484f58">拖拽方块自由分组 · 双击空白创建便签 · 双击标题编辑 · hover底部换色</span>
  </div>
  <div id="boardCanvas" class="board-container" ondblclick="onBoardCanvasDblClick(event)"></div>
</div>
</div>

<!-- ====== TAB: 过程记录 ====== -->
<div id="tabRecords" style="display:none">
  <div class="records-page">
    <p class="section-desc" style="margin-bottom:10px">自动录制的终端命令和输出日志，以及手动保存的快照记录。可搜索关键词或按分类清空。</p>
    <div class="sub-tabs">
      <button class="sub-tab active" data-stab="output" onclick="switchSubTab('output')" title="自动录制的终端输出内容">终端输出</button>
      <button class="sub-tab" data-stab="commands" onclick="switchSubTab('commands')" title="自动录制的已执行命令">终端命令</button>
      <button class="sub-tab" data-stab="snapshots" onclick="switchSubTab('snapshots')" title="在控制面板中手动保存的终端快照">手动快照</button>
      <span style="flex:1"></span>
      <input class="log-search-input" id="logSearchInput" placeholder="搜索关键词..." title="在所有日志和快照中搜索关键词" onkeydown="if(event.key===\\'Enter\\')searchLogsUI()">
      <button class="btn" style="font-size:11px;padding:3px 10px" onclick="searchLogsUI()" title="搜索所有日志内容">搜索</button>
      <button class="btn" id="clearTypeBtn" style="font-size:11px;padding:3px 10px;color:#f85149;border-color:#f85149" onclick="clearLogsByTypeUI()" title="仅清空当前分类的日志，不影响其他分类">清空输出</button>
    </div>
    <div id="logSearchResults" style="display:none"></div>
    <div id="subTabOutput"><div id="logOutputList"><div class="empty"><h2>加载中...</h2></div></div></div>
    <div id="subTabCommands" style="display:none"><div id="logCmdList"><div class="empty"><h2>加载中...</h2></div></div></div>
    <div id="subTabSnapshots" style="display:none"><div id="recordsList"><div class="empty"><h2>加载中...</h2></div></div></div>
  </div>
</div>

<!-- ====== TAB: 快捷启动 ====== -->
<div id="tabSSH" style="display:none">
  <div class="ssh-container">
    <div class="ssh-left">
      <div class="ssh-section-head">
        <h3>连接管理</h3>
        <div style="display:flex;gap:6px">
          <button class="btn" onclick="showConnForm(null,'local')" title="添加本地终端连接，直接在本机打开终端窗口">+ 本地</button>
          <button class="btn" onclick="showConnForm(null,'ssh')" title="添加 SSH 远程连接，通过 SSH 连接到远程服务器">+ SSH</button>
          <button class="btn" onclick="showConnForm(null,'shell')" title="强制命令行：预设里填写的命令会被原样执行，不拼接 ssh user@host">+ 强制命令</button>
        </div>
      </div>
      <p class="section-desc">本地：本机打开终端 / SSH：远程连接 / 强制命令：预设的命令直接原样执行，不走 ssh。</p>
      <div id="connForm" style="display:none">
        <div class="ssh-form">
          <label>连接名称</label>
          <input id="cfName" placeholder="如: 开发服务器">
          <div id="shellHint" style="display:none;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:8px 10px;margin-top:8px;color:#8b949e;font-size:12px;line-height:1.5">
            <strong style="color:#58a6ff">强制命令模式</strong><br>预设的「启动命令」会被原样执行，不会拼接 ssh user@host。适合用来调用 <code>claude</code>、<code>tmux attach</code>、自定义脚本等任意命令。
          </div>
          <div id="sshFields">
            <div class="form-row">
              <div><label>主机地址</label><input id="cfHost" placeholder="192.168.1.100"></div>
              <div><label>端口</label><input id="cfPort" type="number" value="22" min="1" max="65535"></div>
            </div>
            <label>用户名</label>
            <input id="cfUser" placeholder="root">
            <label>Key 路径（可选，留空使用默认 SSH 配置）</label>
            <input id="cfKeyPath" placeholder="留空即可，SSH 会自动查找 ~/.ssh/ 下的密钥">
            <label>自定义连接命令（可选，覆盖 ssh user@host 部分）</label>
            <input id="cfCustomConnect" placeholder="如 ssh vps-proxy（使用 ~/.ssh/config 别名）；留空走标准拼接">
            <div style="font-size:11px;color:#8b949e;margin-top:4px;line-height:1.5">
              填了之后，启动预设时会用你填的命令替代 <code>ssh -p &lt;端口&gt; &lt;用户&gt;@&lt;主机&gt;</code>，<br>后面照常加 <code>-t 'cd 目录 && 命令; exec $SHELL'</code>。
            </div>
          </div>
          <input type="hidden" id="cfEditId" value="">
          <input type="hidden" id="cfType" value="ssh">
          <div class="form-actions">
            <button class="btn" onclick="hideConnForm()">取消</button>
            <button class="btn primary" onclick="saveConn()">保存</button>
          </div>
        </div>
      </div>
      <div id="connList"><div class="empty" style="padding:20px"><h2>暂无连接</h2><p>点击"+ 本地"添加本机终端，或"+ SSH"添加远程服务器</p></div></div>
    </div>
    <div class="ssh-right">
      <div id="presetHeader" style="display:none">
        <div class="ssh-section-head">
          <h3>项目预设 — <span id="presetConnName" style="color:#58a6ff"></span></h3>
          <button class="btn" onclick="showPresetForm()">+ 新建预设</button>
        </div>
        <div id="presetForm" style="display:none">
          <div class="ssh-form">
            <label>项目名称</label>
            <input id="pfName" placeholder="如: 前端项目">
            <label>目标目录</label>
            <input id="pfDir" placeholder="/home/dev/frontend">
            <label>启动命令</label>
            <input id="pfCmd" placeholder="claude" value="claude" list="cmdPresets">
            <datalist id="cmdPresets"><option value="claude --teammate-mode tmux">团队模式</option><option value="claude">标准模式</option></datalist>
            <label>分组标签（可选）</label>
            <input id="pfGroup" placeholder="如: 前端、后端、测试" list="groupPresets">
            <datalist id="groupPresets"></datalist>
            <input type="hidden" id="pfEditId" value="">
            <div class="form-actions">
              <button class="btn" onclick="hidePresetForm()">取消</button>
              <button class="btn primary" onclick="savePreset()">保存</button>
            </div>
          </div>
        </div>
        <div class="preset-toolbar" id="presetToolbar" style="display:none">
          <input class="preset-search" id="presetSearchInput" placeholder="搜索预设..." oninput="filterPresets()">
          <button class="preset-sort-btn" id="presetSortBtn" onclick="togglePresetSort()" title="按名称排序">排序 ↕</button>
          <div class="preset-group-tabs" id="presetGroupTabs"></div>
        </div>
        <div id="presetList"></div>
      </div>
      <div id="presetEmpty"><div class="empty" style="padding:40px 20px"><h2>请选择左侧的连接</h2><p>选择连接后可添加项目预设，每个预设包含目录和启动命令，勾选后可一键批量打开</p></div></div>
    </div>
  </div>
  <div class="ssh-launch-bar" id="sshLaunchBar" style="display:none">
    <span id="sshSelectedCount" style="color:#8b949e;font-size:13px">已选: 0 个预设</span>
    <button class="btn primary" onclick="launchSelected()" title="为每个选中的预设打开一个新终端窗口，自动切换目录并执行启动命令">一键打开</button>
  </div>
</div>

<!-- ====== TAB: Chrome 窗口 ====== -->
<div id="tabChrome" style="display:none">
  <div style="padding:16px 24px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap">
      <p class="section-desc" style="margin:0;flex:1;min-width:200px">面板里堆叠展示所有 Chrome 窗口的 tab；同时可以一键把真实 Chrome 窗口在桌面上**物理堆叠**——每个露 80px 顶部，循环切换。</p>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn" onclick="loadChromeWindows()" title="重新扫描 Chrome 窗口">↻ 刷新</button>
        <button class="btn primary" onclick="stackChromeDesktop()" title="把所有真实 Chrome 窗口在桌面上排成堆叠（每个露 80px 头部）">📚 桌面堆叠</button>
      </div>
    </div>
    <label style="display:flex;align-items:center;gap:6px;color:#8b949e;font-size:12px;margin-bottom:12px;cursor:pointer">
      <input type="checkbox" id="chromeAutoStack" style="width:auto;margin:0;cursor:pointer">
      <span>自动循环模式：点 tab 后自动把该窗口沉到堆叠最底（完整显示），其他往上挪一位</span>
    </label>
    <div id="chromeList"></div>
  </div>
</div>

<!-- 弹窗: 命令历史 -->
<div class="modal-overlay" id="historyModal" style="display:none" onclick="if(event.target===this)closeModal('historyModal')">
  <div class="modal-box">
    <div class="modal-head"><h3 id="historyTitle">命令历史</h3><button class="modal-close" onclick="closeModal('historyModal')">✕</button></div>
    <div class="modal-body" id="historyBody"></div>
  </div>
</div>

<!-- 弹窗: 查看记录 -->
<div class="modal-overlay" id="recordModal" style="display:none" onclick="if(event.target===this)closeModal('recordModal')">
  <div class="modal-box" style="width:800px">
    <div class="modal-head"><h3 id="recordTitle">输出记录</h3><button class="modal-close" onclick="closeModal('recordModal')">✕</button></div>
    <div class="modal-body" id="recordBody"></div>
  </div>
</div>

<div class="statusbar">
  <span id="windowCount">-</span>
  <span id="lastUpdate">-</span>
</div>

<script>
var SL={idle:'空闲',running:'运行中',waiting_confirm:'等待确认',error:'错误',completed:'完成'};
var TIPS={idle:'内容无变化',running:'内容变化中或检测到 spinner',waiting_confirm:'检测到确认提示',error:'检测到错误',completed:'检测到完成标志'};
var NUM=['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
var data=null,selectedLayout=null,selectedRegion='full';
var currentView='cards';
var boardData={nodes:{},notes:[]},boardDirty=false,boardSaveTimer=null;
var launchedPresetIds=new Set();
var BOARD_COLORS=['#58a6ff','#3fb950','#d29922','#f0883e','#f85149','#bc8cff','#79c0ff','#56d364'];

var LAYOUTS=[
  {id:'auto',name:'自动',cols:0},{id:'1c',name:'1列',cols:1},{id:'2c',name:'2列',cols:2},
  {id:'3c',name:'3列',cols:3},{id:'4c',name:'4列',cols:4},{id:'5c',name:'5列',cols:5}
];

// ── 更新同步 ──
function syncUpdate(){
  var btn=document.getElementById('updateBtn');
  if(!btn||btn.classList.contains('updating'))return;
  if(!confirm('从 GitHub 拉取最新版 temine 控制面板？\\n\\n这会执行 npm install -g github:zzmlb/temine。\\n更新完成后请重启 Temine 应用以加载新代码。'))return;
  btn.classList.remove('success','failed');btn.classList.add('updating');
  btn.textContent='⏳ 更新中…';
  fetch('/api/update',{method:'POST'}).then(function(r){return r.json()}).then(function(d){
    btn.classList.remove('updating');
    if(d.ok){
      btn.classList.add('success');
      btn.textContent='✓ 完成 v'+(d.version||'?');
      alert('更新成功（v'+(d.version||'?')+'）。\\n\\n请退出 Temine 应用并重新打开，让新代码生效。');
    }else{
      btn.classList.add('failed');
      btn.textContent='✗ 失败';
      alert('更新失败：\\n\\n'+(d.error||'未知错误'));
    }
    setTimeout(function(){btn.classList.remove('success','failed');btn.textContent='⬆ 更新'},5000);
  }).catch(function(e){
    btn.classList.remove('updating');btn.classList.add('failed');btn.textContent='✗ 失败';
    alert('请求失败：'+e.message);
    setTimeout(function(){btn.classList.remove('failed');btn.textContent='⬆ 更新'},5000);
  });
}

// ── 主题切换 ──
function applyTheme(theme){
  document.body.classList.toggle('theme-warp',theme==='warp');
  try{localStorage.setItem('temine.theme',theme||'default')}catch(e){}
}
function toggleTheme(){
  var cur=document.body.classList.contains('theme-warp')?'warp':'default';
  applyTheme(cur==='warp'?'default':'warp');
}
(function(){try{var t=localStorage.getItem('temine.theme');if(t==='warp')applyTheme('warp')}catch(e){}})();

function switchTab(t){
  document.getElementById('tabPanel').style.display=t==='panel'?'':'none';
  document.getElementById('tabRecords').style.display=t==='records'?'':'none';
  document.getElementById('tabSSH').style.display=t==='ssh'?'':'none';
  document.getElementById('tabChrome').style.display=t==='chrome'?'':'none';
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.toggle('active',b.dataset.tab===t)});
  if(t==='records'){if(currentSubTab==='output')loadLogSessions('out');else if(currentSubTab==='commands')loadLogSessions('cmd');else loadSnapshots();}
  if(t==='ssh')loadSSHData();
  if(t==='chrome')loadChromeWindows();
}

// === Chrome 窗口管理 ===
var chromeExpanded={};  // 记忆每个窗口的展开状态：{ winId: true }
function loadChromeWindows(){
  fetch('/api/chrome/windows').then(function(r){return r.json()}).then(function(d){
    renderChromeWindows((d&&d.windows)||[]);
  }).catch(function(){renderChromeWindows([])});
}
function renderChromeWindows(windows){
  var list=document.getElementById('chromeList');
  if(!windows.length){
    list.innerHTML='<div class="chrome-empty"><h2>未检测到 Chrome 窗口</h2><p>请先打开 Chrome（且首次需要授权"自动化控制 Chrome"）</p></div>';
    return;
  }
  list.innerHTML=windows.map(function(w){
    var winId=w.id||0;
    var expanded=chromeExpanded[winId]?' expanded':'';
    var tabsHtml=(w.tabs||[]).map(function(t){
      var faviconChar=(t.title||'?').slice(0,1).toUpperCase();
      return '<div class="chrome-tab-item" onclick="focusChromeTabClick('+winId+','+t.idx+')" title="'+escA(t.url||'')+'">'+
        '<div class="chrome-tab-favicon" style="display:flex;align-items:center;justify-content:center;font-size:9px;color:#8b949e">'+esc(faviconChar)+'</div>'+
        '<div class="chrome-tab-title">'+esc(t.title||'(无标题)')+'</div>'+
        '<div class="chrome-tab-url">'+esc(shortUrl(t.url||''))+'</div>'+
      '</div>';
    }).join('');
    var firstTabHint=w.tabs&&w.tabs[0]?(' · '+esc((w.tabs[0].title||'').slice(0,40))):'';
    return '<div class="chrome-window-card'+expanded+'">'+
      '<div class="chrome-window-head" onclick="toggleChromeWindow('+winId+')">'+
        '<span class="chrome-window-toggle">▶</span>'+
        '<div class="chrome-window-icon">G</div>'+
        '<div class="chrome-window-title">'+esc(w.title||'(无标题窗口)')+firstTabHint+'</div>'+
        '<div class="chrome-window-meta">'+(w.tabCount||0)+' 个 tab</div>'+
      '</div>'+
      '<div class="chrome-window-tabs">'+tabsHtml+'</div>'+
    '</div>';
  }).join('');
}
function shortUrl(u){
  if(!u)return '';
  try{var url=new URL(u);return url.hostname+(url.pathname.length>1?url.pathname.slice(0,30):'')}
  catch(e){return u.slice(0,40)}
}
function toggleChromeWindow(winId){
  chromeExpanded[winId]=!chromeExpanded[winId];
  // 不重新 fetch，仅切 class 触发动画
  loadChromeWindows();
}
function focusChromeTabClick(winId,tabIdx){
  fetch('/api/chrome/focus',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({windowId:winId,tabIndex:tabIdx})}).then(function(){
    // 自动循环模式：切到 tab 后再 stack 一次，把这个窗口沉到最底完整显示
    var auto=document.getElementById('chromeAutoStack');
    if(auto&&auto.checked){
      stackChromeDesktop(winId);
    }
  }).catch(function(){});
}
function stackChromeDesktop(focusedWindowId){
  var sw=window.screen&&window.screen.width||1512;
  var sh=window.screen&&window.screen.height||944;
  var body={screenWidth:sw,screenHeight:sh,reveal:80};
  if(focusedWindowId)body.focusedWindowId=focusedWindowId;
  fetch('/api/chrome/stack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){
    if(!d.ok&&!focusedWindowId)alert('堆叠失败：请确认 Chrome 已运行且授权了自动化权限');
  }).catch(function(){});
}

function selectRegion(rg){
  selectedRegion=rg;
  document.querySelectorAll('.region-btn').forEach(function(b){b.classList.toggle('active',b.dataset.rg===rg)});
}

function renderLayouts(wc){
  var c=document.getElementById('layoutOptions');
  if(!wc)wc=4;
  c.innerHTML=LAYOUTS.map(function(l){
    var cols=l.cols||(wc<=3?wc:wc<=4?2:wc<=6?3:4);
    var rows=Math.ceil(wc/cols);
    var act=selectedLayout===l.id?' active':'';
    var maxCells=Math.min(wc,12);
    var cells='';for(var i=0;i<maxCells;i++)cells+='<div class="layout-cell">'+(NUM[i]||i+1)+'</div>';
    if(wc>12)cells+='<div class="layout-cell">+' +(wc-12)+'</div>';
    var displayCols=cols||1;
    var displayRows=wc>12?Math.ceil((maxCells+1)/displayCols):Math.ceil(wc/displayCols);
    var gridH=Math.max(48,Math.min(80,displayRows*16));
    return '<div class="layout-card'+act+'" onclick="selectLayout(\\''+l.id+'\\','+l.cols+')"><div class="layout-grid" style="grid-template-columns:repeat('+displayCols+',1fr);height:'+gridH+'px">'+cells+'</div><div class="layout-name">'+l.name+(l.cols?' ('+rows+'x'+cols+')':'')+'</div></div>';
  }).join('')+'<div class="layout-actions"><button class="btn primary" onclick="applyLayout()" '+(selectedLayout?'':'disabled')+'>应用排布</button><button class="btn" onclick="bringToFront()">显示终端</button></div>';
}
function selectLayout(id,cols){selectedLayout=id;window._cols=cols;renderLayouts(data?data.windows.length:4)}
function applyLayout(){
  fetch('/api/arrange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cols:window._cols||0,region:selectedRegion})})
    .then(function(r){return r.json()}).then(function(d){if(d.screen)console.log('Arrange:',d)}).catch(function(){});
  setTimeout(fetchData,500);
}
function bringToFront(){fetch('/api/activate',{method:'POST'}).catch(function(){})}

function fetchData(){fetch('/api/status').then(function(r){return r.json()}).then(function(d){data=d;render(d)}).catch(function(){})}

function render(d){
  var b=document.getElementById('watcherBadge');
  if(d.watcherPid){b.textContent='监控 PID:'+d.watcherPid;b.className='badge on';document.getElementById('watcherHint').style.display='none'}
  else{b.textContent='监控未运行';b.className='badge off'}
  if(d.globalRecording!==undefined)updateGlobalRecUI(d.globalRecording);
  var hw=d.windows.some(function(w){return w.state==='waiting_confirm'});
  document.getElementById('alertBanner').className='alert-banner'+(hw?' show':'');
  renderLayouts(d.windows.length||4);
  document.getElementById('windowCount').textContent=d.windows.length+' 个窗口';
  document.getElementById('lastUpdate').textContent=new Date().toLocaleTimeString('zh-CN');

  // 编辑中 → 只更新状态灯，不重绘（防止丢失输入焦点）
  var editingLabel=document.querySelector('.card-label.editing');
  if(editingLabel){
    d.windows.forEach(function(w){
      var si=w.stableIndex||w.index;
      var dot=document.querySelector('.card[data-si="'+si+'"] .dot');
      var stag=document.querySelector('.card[data-si="'+si+'"] .stag');
      if(dot)dot.className='dot '+(w.state||'idle');
      if(stag){var sc=w.state||'idle';stag.className='stag '+sc;stag.textContent=SL[sc]||sc}
    });
    return;
  }

  var cc=document.getElementById('cards');
  var igSection=document.getElementById('ignoredSection');
  var igCards=document.getElementById('ignoredCards');
  if(!d.windows.length){cc.innerHTML='<div class="empty"><h2>未找到终端窗口</h2><p>打开 Terminal.app 后自动显示</p></div>';igSection.style.display='none';return}

  var normal=d.windows.filter(function(w){return !w.ignored});
  var ignored=d.windows.filter(function(w){return w.ignored});

  // 根据实际排布设置网格列数
  var gridCols=d.layout&&d.layout.cols?d.layout.cols:(normal.length<=3?normal.length:normal.length<=4?2:normal.length<=6?3:4);
  if(gridCols<1)gridCols=normal.length<=3?normal.length:normal.length<=4?2:3;
  cc.style.gridTemplateColumns='repeat('+gridCols+',1fr)';

  function renderCard(w,idx){
    var sc=w.state||'idle',st=SL[sc]||sc,tip=TIPS[sc]||'',pv=esc(w.preview||''),lv=escA(w.labelText||''),ph=escA(w.name||''),si=w.stableIndex||w.index;
    return '<div class="card state-'+sc+'" data-si="'+si+'" data-winid="'+escA(w.id)+'" draggable="true" ondragstart="onCardDragStart(event,this.dataset.winid)" ondragend="onCardDragEnd(event)" ondragover="onCardDragOver(event)" ondragleave="onCardDragLeave(event)" ondrop="onCardDrop(event,this.dataset.winid)" ondblclick="focusWin(this.dataset.winid)" title="拖拽换位 / 双击跳转">' +
      '<div class="card-header"><div class="card-header-left"><span class="card-idx">'+(NUM[si-1]||si)+'</span>' +
        '<input class="card-label" value="'+lv+'" placeholder="'+ph+'" data-winid="'+escA(w.id)+'" data-stableidx="'+si+'" data-original="'+lv+'" onkeydown="onLabelKey(event,this)" readonly>' +
        '<button class="label-edit-btn" onclick="event.stopPropagation();startEditLabel(this)" title="修改名称">✏️</button>' +
        '<button class="label-confirm-btn" onclick="event.stopPropagation();confirmLabel(this)">✓ 确认</button>' +
        '<button class="label-cancel-btn" onclick="event.stopPropagation();cancelEditLabel(this)">✕</button>' +
      '</div><span class="dot '+sc+'"></span><span class="stag '+sc+'" title="'+escA(tip)+'">'+st+'</span></div>' +
      '<div class="card-preview"><pre>'+(pv||'<span style="color:#30363d">暂无输出</span>')+'</pre></div>' +
      '<div class="card-footer">' +
        '<span style="font-size:10px;color:#484f58;margin-right:2px" title="●=录制中 ○=已关闭，点击切换">录制</span>' +
        (globalRecEnabled?
        '<span class="rec-toggle '+(w.recCmd?'on':'off')+'" title="命令录制：开启后自动记录此终端执行的命令到日志（●开 ○关）" onclick="event.stopPropagation();toggleRec(\\''+escA(w.id)+'\\',\\'cmd\\')">'+(w.recCmd?'● 命令':'○ 命令')+'</span>' +
        '<span class="rec-toggle '+(w.recOut?'on':'off')+'" title="输出录制：开启后自动记录此终端的输出内容到日志（●开 ○关）" onclick="event.stopPropagation();toggleRec(\\''+escA(w.id)+'\\',\\'out\\')">'+(w.recOut?'● 输出':'○ 输出')+'</span>'
        :
        '<span class="rec-toggle disabled" title="全局录制已暂停，请先开启顶部录制开关">○ 命令</span>' +
        '<span class="rec-toggle disabled" title="全局录制已暂停，请先开启顶部录制开关">○ 输出</span>') +
        '<button class="fbtn" title="手动快照：立即捕获当前终端内容，可在过程记录中查看" data-winid="'+escA(w.id)+'" data-apiindex="'+w.index+'" data-name="'+escA(w.labelText||w.name||'窗口'+si)+'" data-stableidx="'+si+'" onclick="event.stopPropagation();saveRecord(this)">📋 快照</button>' +
        (w.ignored?'<button class="fbtn ignore-on" title="显示：恢复到主面板" onclick="event.stopPropagation();toggleIgnore(\\''+escA(w.id)+'\\',true)">👁 显示</button>':
        '<button class="fbtn" title="忽略：隐藏到底部，不参与排布" onclick="event.stopPropagation();toggleIgnore(\\''+escA(w.id)+'\\',false)">🙈 忽略</button>') +
        '<button class="fbtn close-btn" title="关闭：关闭此终端窗口（不可撤销）" onclick="event.stopPropagation();closeWin(\\''+escA(w.id)+'\\',\\''+escA(w.labelText||w.name||'窗口'+si)+'\\')">✕ 关闭</button>' +
        '<span class="spacer"></span><span class="dblclick-hint">双击跳转</span>' +
      '</div></div>';
  }

  cc.innerHTML=normal.map(renderCard).join('');

  if(ignored.length){
    igSection.style.display='';
    igCards.innerHTML=ignored.map(function(w){return renderCard(w)}).join('');
  }else{igSection.style.display='none'}
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function escA(s){return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/'/g,'&#39;')}

function startEditLabel(btn){
  var card=btn.closest('.card-header-left');
  var inp=card.querySelector('.card-label');
  var confirmBtn=card.querySelector('.label-confirm-btn');
  var cancelBtn=card.querySelector('.label-cancel-btn');
  inp.readOnly=false;
  inp.classList.add('editing');
  inp.focus();
  inp.select();
  confirmBtn.classList.add('show');
  cancelBtn.classList.add('show');
  btn.style.display='none';
}
function confirmLabel(btn){
  var card=btn.closest('.card-header-left');
  var inp=card.querySelector('.card-label');
  var label=inp.value.trim();
  if(!label){cancelEditLabel(btn);return}
  fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({windowId:inp.dataset.winid,label:label,stableIndex:parseInt(inp.dataset.stableidx)})
  }).then(function(){
    inp.dataset.original=label;
    finishEdit(card);
  }).catch(function(){});
}
function cancelEditLabel(btn){
  var card=btn.closest('.card-header-left');
  var inp=card.querySelector('.card-label');
  inp.value=inp.dataset.original||'';
  finishEdit(card);
}
function finishEdit(card){
  var inp=card.querySelector('.card-label');
  var editBtn=card.querySelector('.label-edit-btn');
  var confirmBtn=card.querySelector('.label-confirm-btn');
  var cancelBtn=card.querySelector('.label-cancel-btn');
  inp.readOnly=true;
  inp.classList.remove('editing');
  inp.blur();
  confirmBtn.classList.remove('show');
  cancelBtn.classList.remove('show');
  editBtn.style.display='';
}
function onLabelKey(e,inp){
  if(e.key==='Enter'){e.preventDefault();var card=inp.closest('.card-header-left');confirmLabel(card.querySelector('.label-confirm-btn'))}
  if(e.key==='Escape'){e.preventDefault();var card=inp.closest('.card-header-left');cancelEditLabel(card.querySelector('.label-cancel-btn'))}
}

function focusWin(winId){
  var card=document.querySelector('.card[data-winid="'+winId+'"]');
  if(card){card.classList.add('focusing');setTimeout(function(){card.classList.remove('focusing')},700)}
  fetch('/api/focus',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({windowId:winId})}).catch(function(){});
}
function closeWin(winId,winName){
  if(!confirm('确定要关闭终端窗口「'+(winName||winId)+'」吗？此操作不可撤销。'))return;
  fetch('/api/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({windowId:winId})}).then(function(r){return r.json()}).then(function(d){if(d.ok)fetchData()}).catch(function(){});
}

function saveRecord(btn){
  btn.textContent='⏳ 保存中...';
  fetch('/api/record',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({windowIndex:parseInt(btn.dataset.apiindex),windowId:btn.dataset.winid,label:btn.dataset.name,stableIndex:parseInt(btn.dataset.stableidx)})
  }).then(function(r){return r.json()}).then(function(d){
    if(d.ok){btn.textContent='✅ 已保存';btn.classList.add('saved');setTimeout(function(){btn.textContent='📋 保存输出';btn.classList.remove('saved')},2000)}
  }).catch(function(){btn.textContent='❌ 失败'});
}

// === 过程记录 Tab ===
var currentSubTab='output';
function switchSubTab(t){
  currentSubTab=t;
  document.getElementById('subTabOutput').style.display=t==='output'?'':'none';
  document.getElementById('subTabCommands').style.display=t==='commands'?'':'none';
  document.getElementById('subTabSnapshots').style.display=t==='snapshots'?'':'none';
  document.querySelectorAll('.sub-tab').forEach(function(b){b.classList.toggle('active',b.dataset.stab===t)});
  var clearBtn=document.getElementById('clearTypeBtn');
  if(t==='output')clearBtn.textContent='清空输出';
  else if(t==='commands')clearBtn.textContent='清空命令';
  else clearBtn.textContent='清空快照';
  closeSearchResults();
  if(t==='output')loadLogSessions('out');
  if(t==='commands')loadLogSessions('cmd');
  if(t==='snapshots')loadSnapshots();
}

function loadLogSessions(type){
  var listId=type==='cmd'?'logCmdList':'logOutputList';
  fetch('/api/logs').then(function(r){return r.json()}).then(function(d){
    var list=document.getElementById(listId);
    var sessions=d.sessions.filter(function(s){return type==='cmd'?s.hasCmdLog:s.hasOutLog});
    if(!sessions.length){list.innerHTML='<div class="empty"><h2>暂无'+(type==='cmd'?'命令':'输出')+'记录</h2><p>开启 <code style="background:#21262d;padding:2px 6px;border-radius:4px;color:#58a6ff">temine watch</code> 后自动记录</p></div>';return}
    list.innerHTML=sessions.map(function(s){
      return '<div class="log-session" onclick="toggleLogView(this,\\''+escA(s.id)+'\\',\\''+type+'\\')"><div class="ls-head"><span class="ls-label">'+esc(s.label)+'</span><span class="ls-time">'+new Date(s.updatedAt).toLocaleString('zh-CN')+'</span><span class="ls-badge">'+(type==='cmd'?'命令':'输出')+'</span><span class="ls-toggle">点击展开 ▼</span></div></div>';
    }).join('');
  }).catch(function(){});
}

function toggleLogView(el,id,type){
  // 如果点击来自查看器内部（选择文字、点击按钮），不关闭
  if(event&&event.target.closest&&event.target.closest('.log-viewer'))return;
  var viewer=el.querySelector('.log-viewer');
  var toggle=el.querySelector('.ls-toggle');
  if(viewer){viewer.remove();el.classList.remove('open');if(toggle)toggle.textContent='点击展开 ▼';return}
  el.classList.add('open');if(toggle)toggle.textContent='点击收起 ▲';
  var d=document.createElement('div');d.className='log-viewer';
  d.onclick=function(e){e.stopPropagation()}; // 阻止冒泡
  d.innerHTML='<pre style="color:#484f58">加载中...</pre>';el.appendChild(d);
  var url=type==='cmd'?'/api/log/cmd?id='+id+'&lines=500':'/api/log/out?id='+id+'&lines=500';
  fetch(url).then(function(r){return r.json()}).then(function(data){
    if(!data.content||!data.content.trim()){d.innerHTML='<pre style="color:#484f58">暂无内容</pre>';return}
    var toolbar='<div class="log-viewer-toolbar"><button class="btn" onclick="copyLogContent(this)">复制全部</button><button class="btn" onclick="this.closest(\\'.log-viewer\\').remove()" style="color:#f85149">关闭</button></div>';
    if(type==='cmd'){
      var lines=data.content.split('\\n').filter(function(l){return l.trim()}).map(function(l){
        var m=l.match(/^\\[(.+?)\\]\\s*(.*)$/);
        return m?'<div><span class="lv-ts">['+esc(m[1])+']</span> <span class="lv-cmd">'+esc(m[2])+'</span></div>':'<div class="lv-cmd">'+esc(l)+'</div>';
      }).join('');
      d.innerHTML=toolbar+'<div class="lv-content">'+lines+'</div>';
    }else{
      d.innerHTML=toolbar+'<div class="lv-content"><pre>'+esc(data.content.slice(-20000))+'</pre></div>';
    }
    d.scrollTop=d.scrollHeight;
  }).catch(function(){d.innerHTML='<pre style="color:#f85149">加载失败</pre>'});
}

function copyLogContent(btn){
  var viewer=btn.closest('.log-viewer');
  var content=viewer.querySelector('.lv-content');
  if(content){
    var text=content.innerText||content.textContent;
    navigator.clipboard.writeText(text).then(function(){
      btn.textContent='已复制';btn.style.color='#3fb950';btn.style.borderColor='#3fb950';
      setTimeout(function(){btn.textContent='复制全部';btn.style.color='';btn.style.borderColor=''},1500);
    }).catch(function(){});
  }
}

function loadSnapshots(){
  fetch('/api/records').then(function(r){return r.json()}).then(function(d){
    var list=document.getElementById('recordsList');
    if(!d.records.length){list.innerHTML='<div class="empty"><h2>暂无手动快照</h2><p>在控制面板中点击"📋 快照"来捕获终端内容</p></div>';return}
    list.innerHTML=d.records.map(function(r){
      return '<div class="rec-item"><div class="rec-meta"><span class="rec-label">'+esc(r.label)+'</span><span class="rec-time">'+new Date(r.createdAt).toLocaleString('zh-CN')+'</span><span class="rec-lines">'+r.lines+' 行</span></div>' +
        '<input class="rec-note-input" value="'+escA(r.note||'')+'" placeholder="添加备注..." data-id="'+r.id+'" onblur="updateNote(this)">' +
        '<div class="rec-actions"><button class="btn" onclick="viewRecord(\\''+r.id+'\\')">查看</button><button class="btn" onclick="exportRecord(\\''+r.id+'\\')">导出</button><button class="btn" style="color:#f85149" onclick="deleteRecord(\\''+r.id+'\\')">删除</button></div></div>';
    }).join('');
  }).catch(function(){});
}

function viewRecord(id){
  document.getElementById('recordTitle').textContent='快照记录';
  document.getElementById('recordBody').innerHTML='<div style="color:#8b949e">加载中...</div>';
  document.getElementById('recordModal').style.display='flex';
  fetch('/api/record?id='+id).then(function(r){return r.json()}).then(function(d){
    document.getElementById('recordTitle').textContent=d.label+' — '+new Date(d.createdAt).toLocaleString('zh-CN');
    document.getElementById('recordBody').innerHTML='<pre>'+esc(d.content||'')+'</pre>';
  }).catch(function(){document.getElementById('recordBody').innerHTML='<div style="color:#f85149">加载失败</div>'});
}

function exportRecord(id){window.open('/api/record/export?id='+id,'_blank')}

function deleteRecord(id){
  if(!confirm('确定删除此记录?'))return;
  fetch('/api/record?id='+id,{method:'DELETE'}).then(function(){loadSnapshots()}).catch(function(){});
}

function updateNote(inp){
  fetch('/api/record/note',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:inp.dataset.id,note:inp.value})
  }).catch(function(){});
}

function toggleRec(winId,field){
  fetch('/api/recording/toggle',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({windowId:winId,field:field})
  }).then(function(r){return r.json()}).then(function(){fetchData()}).catch(function(){});
}

// === 卡片拖拽换位 ===
var dragSrcWinId=null;
function onCardDragStart(e,winId){
  dragSrcWinId=winId;
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',winId);
  setTimeout(function(){e.target.closest('.card').classList.add('dragging')},0);
}
function onCardDragEnd(e){
  e.target.closest('.card').classList.remove('dragging');
  document.querySelectorAll('.card.drag-over').forEach(function(c){c.classList.remove('drag-over')});
  dragSrcWinId=null;
}
function onCardDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect='move';
  var card=e.target.closest('.card');
  if(card&&card.dataset.winid!==dragSrcWinId)card.classList.add('drag-over');
}
function onCardDragLeave(e){
  var card=e.target.closest('.card');
  if(card)card.classList.remove('drag-over');
}
function onCardDrop(e,targetWinId){
  e.preventDefault();
  var card=e.target.closest('.card');
  if(card)card.classList.remove('drag-over');
  var srcWinId=e.dataTransfer.getData('text/plain');
  if(srcWinId&&targetWinId&&srcWinId!==targetWinId){
    doSwap(srcWinId,targetWinId);
  }
}
function doSwap(a,b){
  fetch('/api/swap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({winIdA:a,winIdB:b})})
    .then(function(r){return r.json()}).then(function(){fetchData()}).catch(function(){});
}

function clearAllLogs(){
  if(!confirm('确定清空所有过程记录（终端输出、命令日志）？此操作不可撤销。'))return;
  fetch('/api/logs/clear',{method:'POST'}).then(function(r){return r.json()}).then(function(d){
    if(d.ok){alert('已清空 '+d.deleted+' 个文件');if(currentSubTab==='output')loadLogSessions('out');else if(currentSubTab==='commands')loadLogSessions('cmd');else loadSnapshots()}
  }).catch(function(){alert('清空失败')});
}
function clearLogsByTypeUI(){
  var typeMap={output:'out',commands:'cmd',snapshots:'snapshots'};
  var labelMap={output:'输出日志',commands:'命令日志',snapshots:'快照记录'};
  var type=typeMap[currentSubTab]||'out';
  var label=labelMap[currentSubTab]||'日志';
  if(!confirm('确定清空所有'+label+'？此操作不可撤销。'))return;
  fetch('/api/logs/clear-type',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:type})}).then(function(r){return r.json()}).then(function(d){
    if(d.ok){alert('已清空 '+d.deleted+' 个文件');if(currentSubTab==='output')loadLogSessions('out');else if(currentSubTab==='commands')loadLogSessions('cmd');else loadSnapshots()}
  }).catch(function(){alert('清空失败')});
}
function searchLogsUI(){
  var q=document.getElementById('logSearchInput').value.trim();
  if(!q)return;
  if(q.length>500){alert('搜索词过长（最多500字符）');return}
  var resultsDiv=document.getElementById('logSearchResults');
  resultsDiv.style.display='';
  resultsDiv.innerHTML='<div style="color:#8b949e;padding:12px">搜索中...</div>';
  document.getElementById('subTabOutput').style.display='none';
  document.getElementById('subTabCommands').style.display='none';
  document.getElementById('subTabSnapshots').style.display='none';
  fetch('/api/logs/search?q='+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(d){
    if(!d.results||!d.results.length){resultsDiv.innerHTML='<div class="empty" style="padding:20px"><h2>未找到匹配结果</h2><button class="btn" style="margin-top:8px" onclick="closeSearchResults()">关闭搜索</button></div>';return}
    var safeQ=q.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');
    var re=new RegExp('('+safeQ+')','gi');
    resultsDiv.innerHTML='<div style="padding:8px 0;display:flex;align-items:center;gap:8px"><span style="color:#8b949e;font-size:13px">找到 '+d.totalMatches+' 处匹配（'+d.results.length+' 个终端）</span><button class="btn" style="font-size:11px;padding:2px 8px" onclick="closeSearchResults()">关闭搜索</button></div>'+
      d.results.map(function(r){
        var preview=r.preview.map(function(line){return '<div>'+esc(line).replace(re,'<mark>$1</mark>')+'</div>'}).join('');
        return '<div class="search-result-item"><div class="sr-head"><span class="sr-label">'+esc(r.label)+'</span><span class="sr-count">'+r.matchCount+' 处匹配 ('+r.fileType+')</span></div><div class="sr-preview">'+preview+'</div></div>';
      }).join('');
  }).catch(function(){resultsDiv.innerHTML='<div style="color:#f85149;padding:12px">搜索失败</div>'});
}
function closeSearchResults(){
  document.getElementById('logSearchResults').style.display='none';
  document.getElementById('subTab'+(currentSubTab==='output'?'Output':currentSubTab==='commands'?'Commands':'Snapshots')).style.display='';
}

function toggleIgnore(winId,isIgnored){
  fetch(isIgnored?'/api/unignore':'/api/ignore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({windowId:winId})})
    .then(function(r){return r.json()}).then(function(){fetchData()}).catch(function(){});
}

function closeModal(id){document.getElementById(id).style.display='none'}
function toggleHint(){var h=document.getElementById('watcherHint');h.style.display=h.style.display==='none'?'':'none'}
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeModal('historyModal');closeModal('recordModal')}});

function connectSSE(){
  var es=new EventSource('/api/events');
  es.onmessage=function(e){try{data=JSON.parse(e.data);if(document.getElementById('tabPanel').style.display!=='none'){if(currentView==='cards')render(data);else updateBoardFromSSE(data)}checkPresetWindows(data)}catch(err){}};
  es.onerror=function(){es.close();setTimeout(connectSSE,3000)};
}
// === 全局录制开关 ===
var globalRecEnabled=true;
function updateGlobalRecUI(enabled){
  globalRecEnabled=enabled;
  var b=document.getElementById('globalRecBadge');
  var h=document.getElementById('globalRecHint');
  if(enabled){b.className='global-rec on';b.innerHTML='● 录制中';if(h)h.textContent='自动记录命令和输出，点击暂停'}
  else{b.className='global-rec off';b.innerHTML='⏸ 已暂停';if(h)h.textContent='录制已关闭，点击恢复录制'}
}
function toggleGlobalRec(){
  fetch('/api/global-recording/toggle',{method:'POST'}).then(function(r){return r.json()}).then(function(d){updateGlobalRecUI(d.enabled)}).catch(function(){});
}
function fetchGlobalRec(){
  fetch('/api/global-recording').then(function(r){return r.json()}).then(function(d){updateGlobalRecUI(d.enabled)}).catch(function(){});
}

// === SSH 快捷启动 ===
var sshConns={},sshPresets={},selectedConnId=null,selectedPresetIds=new Set();
var presetSortOrder='none',presetFilterGroup='',presetSearchKeyword='';

function loadSSHData(){
  fetch('/api/ssh/connections').then(function(r){return r.json()}).then(function(d){sshConns=d;renderConns()}).catch(function(){});
}
function renderConns(){
  var list=document.getElementById('connList');
  var ids=Object.keys(sshConns);
  if(!ids.length){list.innerHTML='<div class="empty" style="padding:20px"><h2>暂无连接</h2><p>点击上方"+ 新建连接"添加</p></div>';return}
  list.innerHTML=ids.map(function(id){
    var c=sshConns[id];
    var active=selectedConnId===id?' active':'';
    var isLocal=(c.type==='local');
    var isShell=(c.type==='shell');
    var hasCustomConnect=(c.type==='ssh' && c.customConnect && c.customConnect.length>0);
    var noNetwork=isLocal||isShell;
    var dotCls=noNetwork?'ok':(c.lastTestResult===true?'ok':(c.lastTestResult===false?'fail':'unknown'));
    var hostLine=isShell?'强制命令行'
      :(isLocal?'本地终端'
      :(hasCustomConnect
        ? '⚡ '+esc(c.customConnect)
        : esc(c.username||'')+'@'+esc(c.host||'')+':'+esc(String(c.port||22))));
    var testBtn=noNetwork?'':'<button class="btn" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();testConn(\\''+escA(id)+'\\',this)">测试</button>';
    return '<div class="conn-item'+active+'" onclick="selectConn(\\''+escA(id)+'\\')"><div class="conn-name">'+esc(c.name)+'<span class="conn-dot '+dotCls+'"></span></div><div class="conn-host">'+hostLine+'</div><div class="conn-actions"><button class="btn" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();editConn(\\''+escA(id)+'\\')">编辑</button><button class="btn" style="font-size:11px;padding:2px 8px;color:#f85149" onclick="event.stopPropagation();deleteConn(\\''+escA(id)+'\\')">删除</button>'+testBtn+'</div></div>';
  }).join('');
}
function selectConn(id){
  selectedConnId=id;
  selectedPresetIds.clear();
  launchedPresetIds.clear();
  presetSortOrder='none';presetFilterGroup='';presetSearchKeyword='';
  var si=document.getElementById('presetSearchInput');if(si)si.value='';
  renderConns();
  document.getElementById('presetHeader').style.display='';
  document.getElementById('presetEmpty').style.display='none';
  var c=sshConns[id];
  document.getElementById('presetConnName').textContent=c?(c.type==='shell'?c.name+' (强制命令)':(c.type==='local'?c.name+' (本地)':(c.username+'@'+c.host))):'';
  loadPresets(id);
}
function loadPresets(connId){
  fetch('/api/ssh/presets?connectionId='+(connId||'')).then(function(r){return r.json()}).then(function(d){sshPresets=d;renderPresets()}).catch(function(){});
}
function renderPresets(){
  var list=document.getElementById('presetList');
  var toolbar=document.getElementById('presetToolbar');
  var ids=Object.keys(sshPresets);
  if(!ids.length){list.innerHTML='<div style="color:#484f58;text-align:center;padding:20px;font-size:13px">暂无预设，点击"+ 新建预设"添加</div>';if(toolbar)toolbar.style.display='none';updateLaunchBar();return}
  if(toolbar)toolbar.style.display='flex';
  renderGroupTabs();
  updateGroupDatalist();
  // 筛选：分组
  var filtered=ids;
  if(presetFilterGroup){filtered=filtered.filter(function(id){return (sshPresets[id].group||'')===presetFilterGroup})}
  // 筛选：关键词搜索
  if(presetSearchKeyword){var kw=presetSearchKeyword.toLowerCase();filtered=filtered.filter(function(id){var p=sshPresets[id];return (p.name||'').toLowerCase().indexOf(kw)>=0||(p.directory||'').toLowerCase().indexOf(kw)>=0||(p.command||'').toLowerCase().indexOf(kw)>=0||(p.group||'').toLowerCase().indexOf(kw)>=0})}
  // 排序
  if(presetSortOrder==='asc'){filtered.sort(function(a,b){return (sshPresets[a].name||'').localeCompare(sshPresets[b].name||'')})}
  else if(presetSortOrder==='desc'){filtered.sort(function(a,b){return (sshPresets[b].name||'').localeCompare(sshPresets[a].name||'')})}
  if(!filtered.length){list.innerHTML='<div style="color:#484f58;text-align:center;padding:20px;font-size:13px">无匹配的预设</div>';updateLaunchBar();return}
  list.innerHTML=filtered.map(function(id){
    var p=sshPresets[id];
    var checked=selectedPresetIds.has(id)?' checked':'';
    var launchedCls=launchedPresetIds.has(id)?' launched':'';
    var cmdStr='';
    if(p.directory)cmdStr+='cd '+esc(p.directory);
    if(p.directory&&p.command)cmdStr+=' && ';
    if(p.command)cmdStr+=esc(p.command);
    var groupBadge=(p.group)?'<span class="preset-group-badge">'+esc(p.group)+'</span>':'';
    return '<div class="preset-item'+launchedCls+'" onclick="onPresetRowClick(\\''+escA(id)+'\\',event)"><input type="checkbox" class="preset-check"'+checked+' onclick="event.stopPropagation()" onchange="togglePresetSelect(\\''+escA(id)+'\\',this.checked)"><div class="preset-info"><div class="preset-name">'+esc(p.name)+groupBadge+(launchedPresetIds.has(id)?'<span style="font-size:10px;color:#3fb950;margin-left:6px">已启动</span>':'')+'</div><div class="preset-cmd">'+cmdStr+'</div><div class="preset-actions"><button class="btn" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();editPreset(\\''+escA(id)+'\\')">编辑</button><button class="btn" style="font-size:11px;padding:2px 8px;color:#f85149" onclick="event.stopPropagation();deletePreset(\\''+escA(id)+'\\')">删除</button></div></div></div>';
  }).join('');
  updateLaunchBar();
}
function renderGroupTabs(){
  var container=document.getElementById('presetGroupTabs');
  if(!container)return;
  var groups=new Set();
  Object.values(sshPresets).forEach(function(p){if(p.group)groups.add(p.group)});
  if(!groups.size){container.innerHTML='';return}
  var html='<span class="preset-group-tab'+(presetFilterGroup?'':' active')+'" onclick="setPresetGroup(\\'\\')">全部</span>';
  groups.forEach(function(g){html+='<span class="preset-group-tab'+(presetFilterGroup===g?' active':'')+'" onclick="setPresetGroup(\\''+escA(g)+'\\')">'+esc(g)+'</span>'});
  container.innerHTML=html;
}
function setPresetGroup(g){presetFilterGroup=g;renderPresets()}
function updateGroupDatalist(){
  var dl=document.getElementById('groupPresets');
  if(!dl)return;
  var groups=new Set();
  Object.values(sshPresets).forEach(function(p){if(p.group)groups.add(p.group)});
  dl.innerHTML='';
  groups.forEach(function(g){var o=document.createElement('option');o.value=g;dl.appendChild(o)});
}
function filterPresets(){
  presetSearchKeyword=(document.getElementById('presetSearchInput').value||'').trim();
  renderPresets();
}
function togglePresetSort(){
  var btn=document.getElementById('presetSortBtn');
  if(presetSortOrder==='none'){presetSortOrder='asc';btn.textContent='排序 ↑';btn.classList.add('active')}
  else if(presetSortOrder==='asc'){presetSortOrder='desc';btn.textContent='排序 ↓';btn.classList.add('active')}
  else{presetSortOrder='none';btn.textContent='排序 ↕';btn.classList.remove('active')}
  renderPresets();
}
function togglePresetSelect(id,checked){
  if(checked)selectedPresetIds.add(id);else selectedPresetIds.delete(id);
  updateLaunchBar();
}
function updateLaunchBar(){
  var bar=document.getElementById('sshLaunchBar');
  var cnt=selectedPresetIds.size;
  if(cnt>0){bar.style.display='flex';document.getElementById('sshSelectedCount').textContent='已选: '+cnt+' 个预设'}
  else{bar.style.display='none'}
}
function showConnForm(editId,type){
  document.getElementById('connForm').style.display='';
  var t=type||'ssh';
  document.getElementById('cfType').value=t;
  document.getElementById('sshFields').style.display=t==='ssh'?'':'none';
  document.getElementById('shellHint').style.display=t==='shell'?'':'none';
  if(!editId){
    document.getElementById('cfName').value='';
    document.getElementById('cfHost').value='';
    document.getElementById('cfPort').value='22';
    document.getElementById('cfUser').value='';
    document.getElementById('cfKeyPath').value='';
    document.getElementById('cfCustomConnect').value='';
    document.getElementById('cfEditId').value='';
  }
}
function hideConnForm(){document.getElementById('connForm').style.display='none'}
function editConn(id){
  var c=sshConns[id];if(!c)return;
  showConnForm(id,c.type||'ssh');
  document.getElementById('cfName').value=c.name||'';
  document.getElementById('cfHost').value=c.host||'';
  document.getElementById('cfPort').value=c.port||22;
  document.getElementById('cfUser').value=c.username||'';
  document.getElementById('cfKeyPath').value=c.keyPath||'';
  document.getElementById('cfCustomConnect').value=c.customConnect||'';
  document.getElementById('cfEditId').value=id;
}
function saveConn(){
  var connType=document.getElementById('cfType').value||'ssh';
  var d={name:document.getElementById('cfName').value.trim(),type:connType};
  if(connType==='ssh'){
    d.host=document.getElementById('cfHost').value.trim();
    d.port=parseInt(document.getElementById('cfPort').value)||22;
    d.username=document.getElementById('cfUser').value.trim();
    d.keyPath=document.getElementById('cfKeyPath').value.trim();
    d.customConnect=document.getElementById('cfCustomConnect').value.trim();
    if(!d.name||!d.host||!d.username){alert('请填写必要字段');return}
  }else{
    if(!d.name){alert('请填写连接名称');return}
  }
  var editId=document.getElementById('cfEditId').value;
  if(editId){d.id=editId;fetch('/api/ssh/connections',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json()}).then(function(){hideConnForm();loadSSHData()}).catch(function(){})}
  else{fetch('/api/ssh/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json()}).then(function(){hideConnForm();loadSSHData()}).catch(function(){})}
}
function deleteConn(id){
  if(!confirm('确定删除此连接及其所有预设？'))return;
  fetch('/api/ssh/connections?id='+id,{method:'DELETE'}).then(function(r){return r.json()}).then(function(){if(selectedConnId===id){selectedConnId=null;document.getElementById('presetHeader').style.display='none';document.getElementById('presetEmpty').style.display=''}loadSSHData()}).catch(function(){});
}
function testConn(id,btn){
  var orig=btn.textContent;btn.textContent='测试中...';btn.disabled=true;
  fetch('/api/ssh/connections/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})}).then(function(r){return r.json()}).then(function(d){
    if(d.ok){btn.textContent='✓ 连通';btn.style.color='#3fb950'}else{btn.textContent='✗ 失败';btn.style.color='#f85149';if(d.error)alert(d.error)}
    btn.disabled=false;setTimeout(function(){btn.textContent=orig;btn.style.color='';loadSSHData()},2000);
  }).catch(function(){btn.textContent=orig;btn.disabled=false});
}
function showPresetForm(editId){
  document.getElementById('presetForm').style.display='';
  if(!editId){document.getElementById('pfName').value='';document.getElementById('pfDir').value='';document.getElementById('pfCmd').value='claude';document.getElementById('pfGroup').value='';document.getElementById('pfEditId').value=''}
  updateGroupDatalist();
}
function hidePresetForm(){document.getElementById('presetForm').style.display='none'}
function editPreset(id){
  var p=sshPresets[id];if(!p)return;
  showPresetForm(id);
  document.getElementById('pfName').value=p.name||'';
  document.getElementById('pfDir').value=p.directory||'';
  document.getElementById('pfCmd').value=p.command||'';
  document.getElementById('pfGroup').value=p.group||'';
  document.getElementById('pfEditId').value=id;
}
function savePreset(){
  var d={name:document.getElementById('pfName').value.trim(),directory:document.getElementById('pfDir').value.trim(),command:document.getElementById('pfCmd').value.trim(),group:document.getElementById('pfGroup').value.trim(),connectionId:selectedConnId};
  if(!d.name||!d.connectionId){alert('请填写项目名称');return}
  var editId=document.getElementById('pfEditId').value;
  if(editId){d.id=editId;fetch('/api/ssh/presets',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json()}).then(function(){hidePresetForm();loadPresets(selectedConnId)}).catch(function(){})}
  else{fetch('/api/ssh/presets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json()}).then(function(){hidePresetForm();loadPresets(selectedConnId)}).catch(function(){})}
}
function deletePreset(id){
  if(!confirm('确定删除此预设？'))return;
  fetch('/api/ssh/presets?id='+id,{method:'DELETE'}).then(function(r){return r.json()}).then(function(){selectedPresetIds.delete(id);loadPresets(selectedConnId)}).catch(function(){});
}
function onPresetRowClick(id,e){
  if(e.target.closest('.preset-actions')||e.target.classList.contains('preset-check'))return;
  var checked=!selectedPresetIds.has(id);
  if(checked)selectedPresetIds.add(id);else selectedPresetIds.delete(id);
  renderPresets();
  updateLaunchBar();
}
function launchSelected(){
  if(!selectedPresetIds.size)return;
  var launchIds=Array.from(selectedPresetIds);
  var btn=document.querySelector('.ssh-launch-bar .btn.primary');
  btn.textContent='启动中...';btn.disabled=true;
  fetch('/api/ssh/launch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({presetIds:launchIds})}).then(function(r){return r.json()}).then(function(d){
    if(d.ok){
      // 记录已启动的预设
      launchIds.forEach(function(id){launchedPresetIds.add(id)});
      // 存储预设-窗口映射（如果后端返回了映射）
      if(d.presetWindowMap){
        for(var pid in d.presetWindowMap){presetWindowMap[pid]=d.presetWindowMap[pid]}
      }
      // 自动取消勾选
      selectedPresetIds.clear();
      renderPresets();
      updateLaunchBar();
      btn.textContent='✓ 已启动 '+d.launched.length+' 个';setTimeout(function(){btn.textContent='一键打开';btn.disabled=false},2000);
    }
    else{btn.textContent='一键打开';btn.disabled=false;alert(d.error||'启动失败')}
  }).catch(function(){btn.textContent='一键打开';btn.disabled=false});
}

// === 视图切换 ===
function switchView(mode){
  currentView=mode;
  document.getElementById('cardsView').style.display=mode==='cards'?'':'none';
  document.getElementById('boardView').style.display=mode==='board'?'':'none';
  document.querySelectorAll('.view-toggle .vt-btn').forEach(function(b){b.classList.toggle('active',b.textContent.indexOf(mode==='cards'?'卡片':'画版')>=0)});
  if(mode==='board'){loadBoardData()}
  else if(data){render(data)}
}

// === 画版视图 ===
function loadBoardData(){
  fetch('/api/board').then(function(r){return r.json()}).then(function(d){
    boardData=d||{nodes:{},notes:[]};
    if(!boardData.nodes)boardData.nodes={};
    if(!boardData.notes)boardData.notes=[];
    renderBoard();
  }).catch(function(){renderBoard()});
}
function getBoardColor(w,idx){
  if(boardData.nodes[w.id]&&boardData.nodes[w.id].color)return boardData.nodes[w.id].color;
  // 按 labelText 前缀分组自动分色
  var label=w.labelText||w.name||'';
  var prefix=label.split(/[-_./\\s]/)[0]||'';
  if(!prefix)return BOARD_COLORS[idx%BOARD_COLORS.length];
  // 简单 hash
  var h=0;for(var i=0;i<prefix.length;i++)h=((h<<5)-h)+prefix.charCodeAt(i);
  return BOARD_COLORS[Math.abs(h)%BOARD_COLORS.length];
}
function renderBoard(){
  if(!data||!data.windows)return;
  var canvas=document.getElementById('boardCanvas');
  if(!canvas)return;
  var html='';
  var NUM=['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  var usedPositions={};

  // 渲染终端方块
  var visIdx=0;
  data.windows.forEach(function(w,idx){
    if(w.ignored)return;
    var si=w.stableIndex||w.index;
    var nd=boardData.nodes[w.id];
    var x,y;
    if(nd){x=nd.x;y=nd.y}
    else{
      // 自动排列：网格填充（加宽后5列，间距230px）
      var col=visIdx%5,row=Math.floor(visIdx/5);
      x=20+col*230;y=20+row*110;
    }
    visIdx++;
    var color=getBoardColor(w,idx);
    var sc=w.state||'idle';
    var dotCls=sc;
    var stLabel=SL[sc]||sc;
    var title=escA(w.labelText||w.name||'窗口'+si);
    var titleText=w.labelText||w.name||'窗口'+si;
    var preview=esc((w.preview||'').split('\\n').pop()||'');
    if(preview.length>30)preview=preview.slice(0,30)+'...';
    // 底部色条
    var colorBar='<div class="bn-color-bar" style="background:'+color+'">';
    BOARD_COLORS.forEach(function(c){colorBar+='<div class="bn-cswatch" style="background:'+c+'" onclick="event.stopPropagation();setBoardColor(\\''+escA(w.id)+'\\',\\''+c+'\\')"></div>'});
    colorBar+='</div>';
    html+='<div class="board-node state-'+sc+'" data-winid="'+escA(w.id)+'" style="left:'+x+'px;top:'+y+'px;border-left:4px solid '+color+'" onmousedown="startNodeDrag(event,\\''+escA(w.id)+'\\')" ondblclick="onBoardNodeDblClick(event,\\''+escA(w.id)+'\\')"><div class="bn-header"><span class="bn-idx">'+(NUM[si-1]||si)+'</span><input class="bn-title" value="'+escA(titleText)+'" data-winid="'+escA(w.id)+'" data-original="'+escA(titleText)+'" readonly ondblclick="event.stopPropagation();startBoardEditTitle(this)" onkeydown="onBoardTitleKey(event,this)" onblur="cancelBoardEditTitle(this)"><span class="bn-dot dot '+dotCls+'"></span><span class="bn-stag '+sc+'">'+stLabel+'</span></div><div class="bn-preview">'+preview+'</div>'+colorBar+'</div>';
    usedPositions[w.id]={x:x,y:y};
  });

  // 渲染便签
  boardData.notes.forEach(function(note){
    var nw=note.w||160,nh=note.h||80;
    html+='<div class="board-note" data-noteid="'+escA(note.id)+'" style="left:'+(note.x||200)+'px;top:'+(note.y||200)+'px;width:'+nw+'px;height:'+nh+'px"><div class="note-header" onmousedown="startNoteDrag(event,\\''+escA(note.id)+'\\')"><span>便签</span><button class="note-delete" onclick="deleteBoardNote(\\''+escA(note.id)+'\\')">✕</button></div><textarea oninput="onNoteInput(\\''+escA(note.id)+'\\',this.value)" placeholder="输入笔记...">'+esc(note.text||'')+'</textarea><div class="note-resize" onmousedown="startNoteResize(event,\\''+escA(note.id)+'\\')"></div></div>';
  });

  canvas.innerHTML=html;
}
function updateBoardFromSSE(d){
  if(!d||!d.windows)return;
  // 只更新状态灯、标题和状态标签，不重置位置
  d.windows.forEach(function(w){
    var node=document.querySelector('.board-node[data-winid="'+w.id+'"]');
    if(node){
      var sc=w.state||'idle';
      var dot=node.querySelector('.bn-dot');
      if(dot)dot.className='bn-dot dot '+sc;
      var stag=node.querySelector('.bn-stag');
      if(stag){stag.className='bn-stag '+sc;stag.textContent=SL[sc]||sc}
      // 更新状态边框
      node.className=node.className.replace(/\\bstate-\\S+/g,'').trim()+' state-'+sc;
      var title=node.querySelector('.bn-title');
      if(title&&title.readOnly){var t=w.labelText||w.name||'';if(t)title.value=t}
    }
  });
  checkPresetWindows(d);
  // 检查新窗口或已关闭的窗口
  var currentIds=new Set();
  d.windows.forEach(function(w){if(!w.ignored)currentIds.add(w.id)});
  var boardIds=new Set();
  document.querySelectorAll('.board-node').forEach(function(n){boardIds.add(n.dataset.winid)});
  var hasNew=false;
  currentIds.forEach(function(id){if(!boardIds.has(id))hasNew=true});
  // 标记已关闭的窗口
  boardIds.forEach(function(id){
    if(!currentIds.has(id)){
      var node=document.querySelector('.board-node[data-winid="'+id+'"]');
      if(node)node.classList.add('bn-closed');
    }
  });
  if(hasNew)renderBoard();
}

// --- 方块拖拽 ---
var nodeDrag={active:false,winId:null,offsetX:0,offsetY:0,startX:0,startY:0,moved:false};
function startNodeDrag(e,winId){
  if(e.button!==0)return;
  e.preventDefault();
  var node=e.target.closest('.board-node');
  if(!node)return;
  var rect=node.getBoundingClientRect();
  nodeDrag={active:true,winId:winId,offsetX:e.clientX-rect.left,offsetY:e.clientY-rect.top,startX:e.clientX,startY:e.clientY,moved:false};
  node.classList.add('bn-dragging');
  document.addEventListener('mousemove',onNodeDrag);
  document.addEventListener('mouseup',endNodeDrag);
}
function onNodeDrag(e){
  if(!nodeDrag.active)return;
  if(Math.abs(e.clientX-nodeDrag.startX)>3||Math.abs(e.clientY-nodeDrag.startY)>3)nodeDrag.moved=true;
  if(!nodeDrag.moved)return;
  var canvas=document.getElementById('boardCanvas');
  var rect=canvas.getBoundingClientRect();
  var x=e.clientX-rect.left-nodeDrag.offsetX+canvas.scrollLeft;
  var y=e.clientY-rect.top-nodeDrag.offsetY+canvas.scrollTop;
  if(x<0)x=0;if(y<0)y=0;
  var node=document.querySelector('.board-node[data-winid="'+nodeDrag.winId+'"]');
  if(node){node.style.left=x+'px';node.style.top=y+'px'}
}
function endNodeDrag(e){
  document.removeEventListener('mousemove',onNodeDrag);
  document.removeEventListener('mouseup',endNodeDrag);
  var node=document.querySelector('.board-node[data-winid="'+nodeDrag.winId+'"]');
  if(node){
    node.classList.remove('bn-dragging');
    if(nodeDrag.moved){
      var x=parseInt(node.style.left)||0,y=parseInt(node.style.top)||0;
      if(!boardData.nodes[nodeDrag.winId])boardData.nodes[nodeDrag.winId]={};
      boardData.nodes[nodeDrag.winId].x=x;
      boardData.nodes[nodeDrag.winId].y=y;
      if(boardData.nodes[nodeDrag.winId].color===undefined){
        // 保留自动分配的颜色
        var colorEl=node.style.borderLeft;
        var m=colorEl.match(/#[0-9a-fA-F]+/);
        if(m)boardData.nodes[nodeDrag.winId].color=m[0];
      }
      boardDirty=true;
      saveBoardDebounced();
    }
  }
  nodeDrag.active=false;
}

// --- 便签拖拽 ---
var noteDragState={active:false,noteId:null,offsetX:0,offsetY:0};
function startNoteDrag(e,noteId){
  if(e.button!==0)return;
  e.preventDefault();
  var note=e.target.closest('.board-note');
  if(!note)return;
  var rect=note.getBoundingClientRect();
  noteDragState={active:true,noteId:noteId,offsetX:e.clientX-rect.left,offsetY:e.clientY-rect.top};
  document.addEventListener('mousemove',onNoteDrag);
  document.addEventListener('mouseup',endNoteDrag);
}
function onNoteDrag(e){
  if(!noteDragState.active)return;
  var canvas=document.getElementById('boardCanvas');
  var rect=canvas.getBoundingClientRect();
  var x=e.clientX-rect.left-noteDragState.offsetX+canvas.scrollLeft;
  var y=e.clientY-rect.top-noteDragState.offsetY+canvas.scrollTop;
  if(x<0)x=0;if(y<0)y=0;
  var note=document.querySelector('.board-note[data-noteid="'+noteDragState.noteId+'"]');
  if(note){note.style.left=x+'px';note.style.top=y+'px'}
}
function endNoteDrag(e){
  document.removeEventListener('mousemove',onNoteDrag);
  document.removeEventListener('mouseup',endNoteDrag);
  if(noteDragState.active){
    var note=document.querySelector('.board-note[data-noteid="'+noteDragState.noteId+'"]');
    if(note){
      var x=parseInt(note.style.left)||0,y=parseInt(note.style.top)||0;
      for(var i=0;i<boardData.notes.length;i++){
        if(boardData.notes[i].id===noteDragState.noteId){boardData.notes[i].x=x;boardData.notes[i].y=y;break}
      }
      boardDirty=true;saveBoardDebounced();
    }
  }
  noteDragState.active=false;
}

// --- 便签 resize ---
var noteResizeState={active:false,noteId:null,startW:0,startH:0,startX:0,startY:0};
function startNoteResize(e,noteId){
  e.preventDefault();e.stopPropagation();
  var note=e.target.closest('.board-note');
  if(!note)return;
  noteResizeState={active:true,noteId:noteId,startW:note.offsetWidth,startH:note.offsetHeight,startX:e.clientX,startY:e.clientY};
  document.addEventListener('mousemove',onNoteResize);
  document.addEventListener('mouseup',endNoteResize);
}
function onNoteResize(e){
  if(!noteResizeState.active)return;
  var note=document.querySelector('.board-note[data-noteid="'+noteResizeState.noteId+'"]');
  if(!note)return;
  var w=Math.max(120,noteResizeState.startW+(e.clientX-noteResizeState.startX));
  var h=Math.max(60,noteResizeState.startH+(e.clientY-noteResizeState.startY));
  note.style.width=w+'px';note.style.height=h+'px';
}
function endNoteResize(e){
  document.removeEventListener('mousemove',onNoteResize);
  document.removeEventListener('mouseup',endNoteResize);
  if(noteResizeState.active){
    var note=document.querySelector('.board-note[data-noteid="'+noteResizeState.noteId+'"]');
    if(note){
      var w=note.offsetWidth,h=note.offsetHeight;
      for(var i=0;i<boardData.notes.length;i++){
        if(boardData.notes[i].id===noteResizeState.noteId){boardData.notes[i].w=w;boardData.notes[i].h=h;break}
      }
      boardDirty=true;saveBoardDebounced();
    }
  }
  noteResizeState.active=false;
}

// --- 便签管理 ---
function addBoardNote(){
  var canvas=document.getElementById('boardCanvas');
  var cx=Math.round(canvas.scrollLeft+canvas.clientWidth/2-80);
  var cy=Math.round(canvas.scrollTop+canvas.clientHeight/2-40);
  var note={id:'n_'+Date.now(),x:cx,y:cy,w:160,h:80,text:''};
  boardData.notes.push(note);
  boardDirty=true;
  renderBoard();
  saveBoardDebounced();
}
function onNoteInput(noteId,text){
  for(var i=0;i<boardData.notes.length;i++){
    if(boardData.notes[i].id===noteId){boardData.notes[i].text=text;break}
  }
  boardDirty=true;saveBoardDebounced();
}
function deleteBoardNote(noteId){
  boardData.notes=boardData.notes.filter(function(n){return n.id!==noteId});
  boardDirty=true;
  renderBoard();
  saveBoardDebounced();
}
function resetBoardLayout(){
  if(!confirm('确定重置所有方块位置？'))return;
  boardData.nodes={};
  boardDirty=true;
  renderBoard();
  saveBoardDebounced();
}

// --- 底部色条颜色选择 ---
function setBoardColor(winId,color){
  if(BOARD_COLORS.indexOf(color)<0)return;
  var node=document.querySelector('.board-node[data-winid="'+winId+'"]');
  if(!node)return;
  if(!boardData.nodes[winId])boardData.nodes[winId]={x:parseInt(node.style.left)||0,y:parseInt(node.style.top)||0};
  boardData.nodes[winId].color=color;
  node.style.borderLeft='4px solid '+color;
  var bar=node.querySelector('.bn-color-bar');
  if(bar)bar.style.background=color;
  boardDirty=true;saveBoardDebounced();
}

// --- 双击标题 inline 编辑 ---
function startBoardEditTitle(inp){
  inp.readOnly=false;
  inp.focus();
  inp.select();
}
function confirmBoardTitle(inp){
  var label=inp.value.trim().slice(0,100);
  if(!label){cancelBoardEditTitle(inp);return}
  inp.readOnly=true;
  inp.dataset.original=label;
  var winId=inp.dataset.winid;
  fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({windowId:winId,label:label})
  }).catch(function(){});
}
function cancelBoardEditTitle(inp){
  if(inp.readOnly)return;
  inp.value=inp.dataset.original||'';
  inp.readOnly=true;
}
function onBoardTitleKey(e,inp){
  if(e.key==='Enter'){e.preventDefault();confirmBoardTitle(inp)}
  if(e.key==='Escape'){e.preventDefault();cancelBoardEditTitle(inp)}
}
function onBoardNodeDblClick(e,winId){
  // 如果双击的是标题输入框，不触发 focusWin
  if(e.target.classList.contains('bn-title'))return;
  focusWin(winId);
}

// --- 双击画版空白创建便签 ---
function onBoardCanvasDblClick(e){
  // 排除点击在方块或便签上
  if(e.target.closest('.board-node')||e.target.closest('.board-note'))return;
  var canvas=document.getElementById('boardCanvas');
  if(!canvas)return;
  var rect=canvas.getBoundingClientRect();
  var x=Math.round(e.clientX-rect.left+canvas.scrollLeft);
  var y=Math.round(e.clientY-rect.top+canvas.scrollTop);
  var note={id:'n_'+Date.now(),x:Math.max(0,x-80),y:Math.max(0,y-40),w:160,h:80,text:''};
  boardData.notes.push(note);
  boardDirty=true;
  renderBoard();
  saveBoardDebounced();
  // 自动 focus textarea
  setTimeout(function(){
    var el=document.querySelector('.board-note[data-noteid="'+note.id+'"] textarea');
    if(el)el.focus();
  },50);
}

// --- 预设启动感知 ---
var presetWindowMap={};
function checkPresetWindows(d){
  if(!d||!d.windows)return;
  var currentIds=new Set();
  d.windows.forEach(function(w){currentIds.add(String(w.id))});
  var changed=false;
  for(var pid in presetWindowMap){
    var wid=presetWindowMap[pid];
    if(!currentIds.has(String(wid))){
      launchedPresetIds.delete(pid);
      delete presetWindowMap[pid];
      changed=true;
    }
  }
  if(changed&&document.getElementById('tabSSH').style.display!=='none'){
    renderPresets();
  }
}

// --- 画版保存 ---
function saveBoardDebounced(){
  if(boardSaveTimer)clearTimeout(boardSaveTimer);
  boardSaveTimer=setTimeout(function(){
    fetch('/api/board',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(boardData)})
      .then(function(){boardDirty=false}).catch(function(){});
  },1000);
}
window.addEventListener('beforeunload',function(){
  if(boardDirty){
    navigator.sendBeacon('/api/board',new Blob([JSON.stringify(boardData)],{type:'application/json'}));
  }
});

fetchData();connectSSE();fetchGlobalRec();
</script></body></html>`;
  return _cachedHTML;
}

// ── 收集状态（带缓存，避免 SSE 频繁调用重复计算）───
let _statusCache = null;
let _statusCacheTime = 0;
const STATUS_CACHE_TTL = 1500; // 1.5 秒缓存

function collectStatus() {
  const now = Date.now();
  if (_statusCache && now - _statusCacheTime < STATUS_CACHE_TTL) return _statusCache;

  const windows = getWindows();
  const aiState = readState();
  const watcherPid = isWatcherRunning();
  const globalRec = loadGlobalRecording();
  stabilizeWindows(windows);

  // 全局录制关闭时跳过 AppleScript 内容读取，避免性能问题
  let contentMap = {};
  if (windows.length > 0 && globalRec.enabled !== false) {
    contentMap = getAllWindowContent(2000);
  }

  const activeIds = new Set(windows.map(w => w.id));
  cleanupSnapCache(activeIds);

  const ignored = loadIgnored();
  const recSettings = loadRecording();
  const enriched = windows.map(win => {
    const labelText = getLabel(win.id) || '';
    const stateInfo = aiState[win.id] || {};
    const content = contentMap[win.id] || '';
    const preview = content.split('\n').filter(l => l.trim()).slice(-8).join('\n');
    const commands = extractCommands(content);
    let state = stateInfo.state || 'idle';
    if (state === 'idle' && isContentChanging(win.id, content)) state = 'running';
    const rs = recSettings[win.id] || { cmd: true, out: true };
    return { index: win.index, stableIndex: win.stableIndex, id: win.id, name: win.name,
      labelText, state, confidence: stateInfo.confidence || 0, preview, commands,
      ignored: ignored.has(win.id), recCmd: rs.cmd !== false, recOut: rs.out !== false };
  });

  // 忽略的终端排到最后
  enriched.sort((a, b) => {
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1;
    return a.stableIndex - b.stableIndex;
  });

  // 读取布局信息
  let layout = { cols: 0, rows: 0 };
  try { layout = JSON.parse(readFileSync(LAYOUT_FILE, 'utf-8')); } catch {}

  _statusCache = { windows: enriched, watcherPid, layout, globalRecording: globalRec.enabled !== false };
  _statusCacheTime = now;
  return _statusCache;
}

// ── 服务器 ───────────────────────────────────────────
export async function startPanel(port) {
  port = Number(port) || DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error(`❌ 无效端口: ${port}（范围 1024-65535）`);
    process.exit(1);
  }

  // 自动启动 AI 状态监控（如果尚未运行）
  const pidFile = join(homedir(), '.temine', 'watcher.pid');
  let watcherRunning = false;
  if (existsSync(pidFile)) {
    try { process.kill(parseInt(readFileSync(pidFile, 'utf8').trim()), 0); watcherRunning = true; } catch {}
  }
  if (!watcherRunning) {
    const temineBin = new URL('../bin/temine.js', import.meta.url).pathname;
    const watcher = spawn(process.execPath, [temineBin, 'watch'], {
      stdio: 'ignore', detached: true,
    });
    watcher.unref();
    console.log(`   🔍 已自动启动 AI 监控 (PID: ${watcher.pid})`);
  }

  ensureDir(); ensureRecordsDir();
  const sseClients = new Set();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHTML()); return;
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(collectStatus())); return;
    }

    // Chrome 窗口列表（含每个窗口的 tab）
    if (url.pathname === '/api/chrome/windows' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, windows: getChromeWindows() }));
      return;
    }

    // 切换到指定 Chrome 窗口的指定 tab
    if (url.pathname === '/api/chrome/focus' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { windowId, tabIndex } = JSON.parse(body);
          const ok = focusChromeTab(windowId, tabIndex);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        } catch {
          res.writeHead(400); res.end('bad request');
        }
      });
      return;
    }

    // 桌面堆叠所有 Chrome 窗口（可选 focusedWindowId 把它放最底完整显示）
    if (url.pathname === '/api/chrome/stack' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const params = body ? JSON.parse(body) : {};
          const ok = stackChromeWindows(params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        } catch {
          res.writeHead(400); res.end('bad request');
        }
      });
      return;
    }

    // 更新同步：从 github:zzmlb/temine 拉最新版本
    if (url.pathname === '/api/update' && req.method === 'POST') {
      const child = spawn('npm', ['install', '-g', 'github:zzmlb/temine'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.stdout.on('data', () => {});
      // 5 分钟超时
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 5 * 60 * 1000);
      child.on('close', (code) => {
        clearTimeout(timer);
        let version = '';
        try {
          const out = execSync('npm ls -g temine --depth=0 --json', { encoding: 'utf-8', timeout: 10000 });
          const parsed = JSON.parse(out);
          version = parsed?.dependencies?.temine?.version || '';
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (code === 0) {
          res.end(JSON.stringify({ ok: true, version }));
        } else {
          // 截断 stderr 防止过大
          res.end(JSON.stringify({ ok: false, error: (stderr || '').slice(-2000) || `npm 退出码 ${code}` }));
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
      return;
    }

    if (url.pathname === '/api/label' && req.method === 'POST') {
      readBody(req, async (body) => {
        try {
          const { windowId, label, stableIndex, index } = JSON.parse(body);
          // 安全：校验 windowId + 限制 label 长度
          const safeLabel = String(label || '').slice(0, 100);
          if (!safeLabel) { res.writeHead(400); res.end('empty label'); return; }
          if (windowId) {
            const wid = safeWindowId(windowId);
            if (!wid) { res.writeHead(400); res.end('invalid windowId'); return; }
            await labelWindowById(wid, safeLabel, stableIndex || 1);
          } else {
            await labelWindow(index, safeLabel, { displayIndex: stableIndex || index });
          }
          _statusCache = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/arrange' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { cols, region } = JSON.parse(body);
          const result = arrangeWindowsApi(cols, region);
          res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/activate' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: activateTerminal() })); return;
    }

    if (url.pathname === '/api/ignore' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { windowId } = JSON.parse(body);
          const ignored = loadIgnored();
          ignored.add(windowId);
          saveIgnored(ignored);
          _statusCache = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/unignore' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { windowId } = JSON.parse(body);
          const ignored = loadIgnored();
          ignored.delete(windowId);
          saveIgnored(ignored);
          _statusCache = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/swap' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { winIdA, winIdB } = JSON.parse(body);
          const a = safeWindowId(winIdA), b = safeWindowId(winIdB);
          if (!a || !b) { res.writeHead(400); res.end('invalid windowId'); return; }
          const ok = swapWindowsApi(a, b);
          _statusCache = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/focus' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { windowId } = JSON.parse(body);
          const wid = safeWindowId(windowId);
          if (!wid) { res.writeHead(400); res.end('invalid windowId'); return; }
          const ok = focusWindowApi(wid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/close' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { windowId } = JSON.parse(body);
          const wid = safeWindowId(windowId);
          if (!wid) { res.writeHead(400); res.end('invalid windowId'); return; }
          const ok = closeWindowApi(wid);
          _statusCache = null;
          // 从忽略列表移除残留
          const ignored = loadIgnored();
          if (ignored.has(String(wid))) {
            ignored.delete(String(wid));
            saveIgnored(ignored);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    // 命令历史（从日志提取）
    if (url.pathname === '/api/history' && req.method === 'GET') {
      const wid = url.searchParams.get('id');
      if (!wid) { res.writeHead(400); res.end('missing id'); return; }
      const safeId = String(wid).replace(/[^a-zA-Z0-9_-]/g, '_');
      // 优先读 .cmd.log（新格式），回退 .log（旧格式）
      const cmdLogFile = join(LOGS_DIR, `${safeId}.cmd.log`);
      const oldLogFile = join(LOGS_DIR, `${safeId}.out.log`);
      let commands = [];
      try {
        if (existsSync(cmdLogFile)) {
          // 新格式: 每行 [timestamp] command
          const lines = readFileSync(cmdLogFile, 'utf-8').trim().split('\n').filter(l => l.trim());
          commands = lines.map(l => l.replace(/^\[.*?\]\s*/, '')).slice(-100);
        } else if (existsSync(oldLogFile)) {
          commands = extractCommands(readFileSync(oldLogFile, 'utf-8')).slice(-100);
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ commands })); return;
    }

    // ── 输出记录 API ──
    if (url.pathname === '/api/record' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { windowIndex, windowId, label, stableIndex } = JSON.parse(body);
          const content = getWindowContentFull(windowIndex);
          const id = String(Date.now());
          const record = { id, windowId, stableIndex, label: label || 'Window', content, createdAt: Date.now(), note: '', lines: content.split('\n').length };
          ensureRecordsDir();
          writeFileSync(join(RECORDS_DIR, id + '.json'), JSON.stringify(record));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch { res.writeHead(500); res.end('error'); }
      }); return;
    }

    if (url.pathname === '/api/records' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records: listRecords() })); return;
    }

    if (url.pathname === '/api/record' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) { res.writeHead(400); res.end('invalid id'); return; }
      try {
        const d = JSON.parse(readFileSync(join(RECORDS_DIR, id + '.json'), 'utf-8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(d));
      } catch { res.writeHead(404); res.end('not found'); }
      return;
    }

    if (url.pathname === '/api/record/export' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) { res.writeHead(400); res.end('invalid id'); return; }
      try {
        const d = JSON.parse(readFileSync(join(RECORDS_DIR, id + '.json'), 'utf-8'));
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="temine-${String(d.label).replace(/["\r\n\\]/g, '_')}-${id}.txt"`,
        });
        res.end(d.content);
      } catch { res.writeHead(404); res.end('not found'); }
      return;
    }

    if (url.pathname === '/api/record' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) { res.writeHead(400); res.end('invalid id'); return; }
      try { unlinkSync(join(RECORDS_DIR, id + '.json')); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true })); return;
    }

    if (url.pathname === '/api/record/note' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { id, note } = JSON.parse(body);
          if (!id || !/^\d+$/.test(String(id))) { res.writeHead(400); res.end('invalid id'); return; }
          const file = join(RECORDS_DIR, id + '.json');
          const d = JSON.parse(readFileSync(file, 'utf-8'));
          d.note = note;
          writeFileSync(file, JSON.stringify(d));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    // ── 过程记录 API ──
    // 列出所有日志会话
    if (url.pathname === '/api/logs' && req.method === 'GET') {
      try {
        const indexFile = join(LOGS_DIR, 'index.json');
        let index = {};
        try { index = JSON.parse(readFileSync(indexFile, 'utf-8')); } catch {}
        const sessions = Object.values(index).map(e => ({
          id: e.id, label: e.label || e.windowName || e.id,
          updatedAt: e.updatedAt, createdAt: e.createdAt,
          hasCmdLog: existsSync(join(LOGS_DIR, e.cmdFile || '')),
          hasOutLog: existsSync(join(LOGS_DIR, e.outFile || e.logFile || '')),
        })).sort((a, b) => b.updatedAt - a.updatedAt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions }));
      } catch { res.writeHead(500); res.end('error'); }
      return;
    }

    // 读取命令日志
    if (url.pathname === '/api/log/cmd' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id || !/^[\w-]+$/.test(id)) { res.writeHead(400); res.end('invalid id'); return; }
      const file = join(LOGS_DIR, `${id}.cmd.log`);
      let content = '';
      try { content = readFileSync(file, 'utf-8'); } catch {}
      const lines = url.searchParams.get('lines');
      if (lines) {
        const arr = content.split('\n');
        content = arr.slice(-parseInt(lines)).join('\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content })); return;
    }

    // 读取输出日志
    if (url.pathname === '/api/log/out' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id || !/^[\w-]+$/.test(id)) { res.writeHead(400); res.end('invalid id'); return; }
      const file = join(LOGS_DIR, `${id}.out.log`);
      let content = '';
      try { content = readFileSync(file, 'utf-8'); } catch {}
      const lines = url.searchParams.get('lines');
      if (lines) {
        const arr = content.split('\n');
        content = arr.slice(-parseInt(lines)).join('\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content })); return;
    }

    // 清空所有日志
    if (url.pathname === '/api/logs/clear' && req.method === 'POST') {
      try {
        const deleted = clearAllLogs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted }));
      } catch { res.writeHead(500); res.end('error'); }
      return;
    }

    // 按类型清空日志
    if (url.pathname === '/api/logs/clear-type' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { type } = JSON.parse(body);
          let deleted = 0;
          if (type === 'cmd' || type === 'out') {
            deleted = clearLogsByType(type);
          } else if (type === 'snapshots') {
            // 删除所有快照 records/*.json
            ensureRecordsDir();
            try {
              const files = readdirSync(RECORDS_DIR).filter(f => f.endsWith('.json'));
              for (const f of files) { try { unlinkSync(join(RECORDS_DIR, f)); deleted++; } catch {} }
            } catch {}
          } else {
            res.writeHead(400); res.end('invalid type'); return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deleted }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    // 关键词搜索日志
    if (url.pathname === '/api/logs/search' && req.method === 'GET') {
      const q = url.searchParams.get('q');
      if (!q || q.length > 500) { res.writeHead(400); res.end(!q ? 'missing q' : 'query too long'); return; }
      try {
        const indexFile = join(LOGS_DIR, 'index.json');
        let index = {};
        try { index = JSON.parse(readFileSync(indexFile, 'utf-8')); } catch {}
        const results = [];
        let totalMatches = 0;
        const kw = q.toLowerCase();

        for (const entry of Object.values(index)) {
          const filesToSearch = [
            { file: entry.cmdFile, type: '命令' },
            { file: entry.outFile || entry.logFile, type: '输出' },
          ].filter(f => f.file);

          for (const { file, type } of filesToSearch) {
            // 路径安全检查：文件名不得含 .. 或绝对路径，防止路径穿越
            if (!file || /\.\./.test(file) || file.startsWith('/')) continue;
            const fpath = join(LOGS_DIR, file);
            if (!existsSync(fpath)) continue;
            let content;
            try { content = readFileSync(fpath, 'utf-8'); } catch { continue; }
            const lines = content.split('\n');
            const matchLines = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(kw)) {
                matchLines.push(i);
              }
            }
            if (matchLines.length > 0) {
              const preview = matchLines.slice(0, 5).map(i => lines[i]);
              results.push({
                id: entry.id,
                label: entry.label || entry.windowName || entry.id,
                fileType: type,
                matchCount: matchLines.length,
                preview,
              });
              totalMatches += matchLines.length;
            }
          }
        }

        // 搜索快照
        ensureRecordsDir();
        try {
          const snapFiles = readdirSync(RECORDS_DIR).filter(f => f.endsWith('.json'));
          for (const f of snapFiles) {
            try {
              const snap = JSON.parse(readFileSync(join(RECORDS_DIR, f), 'utf-8'));
              if (!snap.content) continue;
              const lines = snap.content.split('\n');
              const matchLines = [];
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(kw)) matchLines.push(i);
              }
              if (matchLines.length > 0) {
                results.push({
                  id: snap.id,
                  label: (snap.label || '快照') + ' (快照)',
                  fileType: '快照',
                  matchCount: matchLines.length,
                  preview: matchLines.slice(0, 5).map(i => lines[i]),
                });
                totalMatches += matchLines.length;
              }
            } catch {}
          }
        } catch {}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results, totalMatches }));
      } catch { res.writeHead(500); res.end('error'); }
      return;
    }

    // 录制设置
    if (url.pathname === '/api/recording' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadRecording())); return;
    }

    if (url.pathname === '/api/recording/toggle' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { windowId, field } = JSON.parse(body); // field: 'cmd' or 'out'
          if (!windowId || !['cmd', 'out'].includes(field)) { res.writeHead(400); res.end('bad request'); return; }
          const rec = loadRecording();
          if (!rec[windowId]) rec[windowId] = { cmd: true, out: true };
          rec[windowId][field] = !rec[windowId][field];
          saveRecording(rec);
          _statusCache = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, settings: rec[windowId] }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    // ── SSH 连接 CRUD ──
    if (url.pathname === '/api/ssh/connections' && req.method === 'GET') {
      // 过滤 keyPath 防止密钥路径泄露到前端
      const conns = loadSSHConnections();
      const safe = {};
      for (const [id, c] of Object.entries(conns)) {
        safe[id] = { ...c, keyPath: c.keyPath ? '(已配置)' : '' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(safe)); return;
    }

    if (url.pathname === '/api/ssh/connections' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const d = JSON.parse(body);
          if (!d.name) { res.writeHead(400); res.end('missing name'); return; }
          const connType = d.type || 'ssh';
          const conns = loadSSHConnections();
          const id = 'conn_' + Date.now();
          if (connType === 'local') {
            conns[id] = { id, type: 'local', name: d.name, lastTestResult: null };
          } else if (connType === 'shell') {
            conns[id] = { id, type: 'shell', name: d.name, lastTestResult: null };
          } else {
            if (!d.host || !d.username) { res.writeHead(400); res.end('missing fields'); return; }
            if (!/^[a-zA-Z0-9._-]+$/.test(d.host)) { res.writeHead(400); res.end('invalid host'); return; }
            if (!/^[a-zA-Z0-9._-]+$/.test(d.username)) { res.writeHead(400); res.end('invalid username'); return; }
            const port = parseInt(d.port) || 22;
            if (port < 1 || port > 65535) { res.writeHead(400); res.end('invalid port'); return; }
            if (d.keyPath && /[;&|`$(){}"'\\<>\n\r]/.test(d.keyPath)) { res.writeHead(400); res.end('invalid keyPath'); return; }
            // customConnect 是用户自定义的连接命令（如 "ssh vps-proxy"），仅过滤换行符
            const customConn = (typeof d.customConnect === 'string' ? d.customConnect : '').trim();
            if (customConn && /[\n\r]/.test(customConn)) { res.writeHead(400); res.end('invalid customConnect'); return; }
            if (customConn.length > 200) { res.writeHead(400); res.end('customConnect too long'); return; }
            conns[id] = {
              id, type: 'ssh', name: d.name,
              host: d.host, port, username: d.username, keyPath: d.keyPath || '',
              customConnect: customConn,
              lastTestResult: null,
            };
          }
          saveSSHConnections(conns);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/ssh/connections' && req.method === 'PUT') {
      readBody(req, (body) => {
        try {
          const d = JSON.parse(body);
          if (!d.id) { res.writeHead(400); res.end('missing id'); return; }
          const conns = loadSSHConnections();
          if (!conns[d.id]) { res.writeHead(404); res.end('not found'); return; }
          const connType = d.type || conns[d.id].type || 'ssh';
          if (connType === 'local') {
            Object.assign(conns[d.id], { name: d.name || conns[d.id].name, type: 'local' });
          } else if (connType === 'shell') {
            Object.assign(conns[d.id], { name: d.name || conns[d.id].name, type: 'shell' });
          } else {
            if (d.host && !/^[a-zA-Z0-9._-]+$/.test(d.host)) { res.writeHead(400); res.end('invalid host'); return; }
            if (d.username && !/^[a-zA-Z0-9._-]+$/.test(d.username)) { res.writeHead(400); res.end('invalid username'); return; }
            if (d.port) { const p = parseInt(d.port); if (p < 1 || p > 65535) { res.writeHead(400); res.end('invalid port'); return; } }
            if (d.keyPath && /[;&|`$(){}"'\\<>\n\r]/.test(d.keyPath)) { res.writeHead(400); res.end('invalid keyPath'); return; }
            const newKeyPath = (d.keyPath !== undefined && d.keyPath !== '(已配置)') ? d.keyPath : conns[d.id].keyPath;
            // customConnect：传入字符串就更新（含空字符串=清除），未传则保持原值
            let newCustomConnect = conns[d.id].customConnect || '';
            if (typeof d.customConnect === 'string') {
              const cc = d.customConnect.trim();
              if (cc && /[\n\r]/.test(cc)) { res.writeHead(400); res.end('invalid customConnect'); return; }
              if (cc.length > 200) { res.writeHead(400); res.end('customConnect too long'); return; }
              newCustomConnect = cc;
            }
            Object.assign(conns[d.id], {
              name: d.name || conns[d.id].name,
              type: 'ssh',
              host: d.host || conns[d.id].host,
              port: parseInt(d.port) || conns[d.id].port,
              username: d.username || conns[d.id].username,
              keyPath: newKeyPath,
              customConnect: newCustomConnect,
            });
          }
          saveSSHConnections(conns);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/ssh/connections' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) { res.writeHead(400); res.end('missing id'); return; }
      const conns = loadSSHConnections();
      delete conns[id];
      saveSSHConnections(conns);
      // 级联删除关联预设
      const presets = loadSSHPresets();
      let deleted = 0;
      for (const pid of Object.keys(presets)) {
        if (presets[pid].connectionId === id) { delete presets[pid]; deleted++; }
      }
      if (deleted > 0) saveSSHPresets(presets);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true })); return;
    }

    if (url.pathname === '/api/ssh/connections/test' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { id } = JSON.parse(body);
          const conns = loadSSHConnections();
          const conn = conns[id];
          if (!conn) { res.writeHead(404); res.end('not found'); return; }
          if (conn.type === 'local' || conn.type === 'shell') {
            conn.lastTestResult = true;
            saveSSHConnections(conns);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true })); return;
          }
          const result = testSSHConnection(conn);
          conn.lastTestResult = result.ok;
          saveSSHConnections(conns);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    // ── 项目预设 CRUD ──
    if (url.pathname === '/api/ssh/presets' && req.method === 'GET') {
      const connId = url.searchParams.get('connectionId');
      const all = loadSSHPresets();
      const filtered = connId ? Object.fromEntries(Object.entries(all).filter(([, v]) => v.connectionId === connId)) : all;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(filtered)); return;
    }

    if (url.pathname === '/api/ssh/presets' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const d = JSON.parse(body);
          if (!d.name || !d.connectionId) { res.writeHead(400); res.end('missing fields'); return; }
          const presets = loadSSHPresets();
          const id = 'preset_' + Date.now();
          presets[id] = { id, connectionId: d.connectionId, name: d.name, directory: d.directory || '', command: d.command || '', group: d.group || '' };
          saveSSHPresets(presets);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/ssh/presets' && req.method === 'PUT') {
      readBody(req, (body) => {
        try {
          const d = JSON.parse(body);
          if (!d.id) { res.writeHead(400); res.end('missing id'); return; }
          const presets = loadSSHPresets();
          if (!presets[d.id]) { res.writeHead(404); res.end('not found'); return; }
          Object.assign(presets[d.id], { name: d.name || presets[d.id].name, directory: d.directory !== undefined ? d.directory : presets[d.id].directory, command: d.command !== undefined ? d.command : presets[d.id].command, group: d.group !== undefined ? d.group : (presets[d.id].group || '') });
          saveSSHPresets(presets);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/ssh/presets' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) { res.writeHead(400); res.end('missing id'); return; }
      const presets = loadSSHPresets();
      delete presets[id];
      saveSSHPresets(presets);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true })); return;
    }

    // ── 批量启动 ──
    if (url.pathname === '/api/ssh/launch' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { presetIds } = JSON.parse(body);
          if (!Array.isArray(presetIds) || !presetIds.length) { res.writeHead(400); res.end('missing presetIds'); return; }
          const result = launchSSHPresets(presetIds);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    // ── 全局录制开关 ──
    if (url.pathname === '/api/global-recording' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadGlobalRecording())); return;
    }

    if (url.pathname === '/api/global-recording/toggle' && req.method === 'POST') {
      const gr = loadGlobalRecording();
      gr.enabled = !gr.enabled;
      saveGlobalRecording(gr);
      _statusCache = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gr)); return;
    }

    // ── 画版 API ──
    if (url.pathname === '/api/board' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadBoard())); return;
    }

    if (url.pathname === '/api/board' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const d = JSON.parse(body);
          if (!d || typeof d !== 'object') { res.writeHead(400); res.end('bad request'); return; }
          // 校验数据结构
          const board = { nodes: {}, notes: [] };
          if (d.nodes && typeof d.nodes === 'object') {
            for (const [k, v] of Object.entries(d.nodes)) {
              if (v && typeof v === 'object') {
                board.nodes[k] = { x: Math.min(Math.max(Number(v.x) || 0, 0), 100000), y: Math.min(Math.max(Number(v.y) || 0, 0), 100000) };
                if (v.color && typeof v.color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.color)) {
                  board.nodes[k].color = v.color;
                }
              }
            }
          }
          if (Array.isArray(d.notes)) {
            board.notes = d.notes.slice(0, 100).filter(n => n && typeof n === 'object' && n.id).map(n => ({
              id: String(n.id).slice(0, 50),
              x: Number(n.x) || 0, y: Number(n.y) || 0,
              w: Math.min(Number(n.w) || 160, 2000), h: Math.min(Number(n.h) || 80, 2000),
              text: String(n.text || '').slice(0, 5000)
            }));
          }
          saveBoard(board);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/board/note' && req.method === 'POST') {
      readBody(req, (body) => {
        try {
          const { action, note } = JSON.parse(body);
          const board = loadBoard();
          if (action === 'add' && note) {
            board.notes.push({
              id: String(note.id || 'n_' + Date.now()).slice(0, 50),
              x: Number(note.x) || 0, y: Number(note.y) || 0,
              w: Number(note.w) || 160, h: Number(note.h) || 80,
              text: String(note.text || '').slice(0, 5000)
            });
          } else if (action === 'update' && note && note.id) {
            const idx = board.notes.findIndex(n => n.id === note.id);
            if (idx >= 0) Object.assign(board.notes[idx], { text: String(note.text || '').slice(0, 5000) });
          } else if (action === 'delete' && note && note.id) {
            board.notes = board.notes.filter(n => n.id !== note.id);
          }
          saveBoard(board);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/events') {
      if (sseClients.size >= 10) { res.writeHead(429); res.end('too many connections'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    res.writeHead(404); res.end('not found');
  });

  setInterval(() => {
    if (sseClients.size === 0) return;
    try {
      const d = JSON.stringify(collectStatus());
      for (const c of sseClients) {
        try {
          if (c.destroyed || c.writableEnded) { sseClients.delete(c); continue; }
          c.write(`data: ${d}\n\n`);
        } catch { sseClients.delete(c); }
      }
    } catch {} // AppleScript 超时等错误不影响服务
  }, 4000);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口 ${port} 已被占用`);
      console.log(`  换端口: temine panel ${port + 1}`);
      console.log(`  杀占用: lsof -i :${port} | grep LISTEN 然后 kill <PID>\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n🖥️  Temine 控制面板 v0.8`);
    console.log(`   ${url}`);
    console.log(`   Ctrl+C 停止\n`);
    if (process.platform === 'darwin') {
      // 直接调用 Chrome/Edge 可执行文件的 --app 模式（Chrome 已运行时也生效）
      let opened = false;
      for (const [name, bin] of [
        ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ]) {
        try {
          if (existsSync(bin)) {
            spawn(bin, [`--app=${url}`], { stdio: 'ignore', detached: true }).unref();
            console.log(`   已在 ${name} App Mode 中打开`);
            opened = true; break;
          }
        } catch {}
      }
      if (!opened) { try { execSync(`open "${url}"`); } catch {} }
    } else { console.log(`   请在浏览器打开上面的地址`); }
  });

  function cleanup() {
    server.close();
    // 如果 watcher 是我们启动的，一并关闭
    if (!watcherRunning && existsSync(pidFile)) {
      try { process.kill(parseInt(readFileSync(pidFile, 'utf8').trim()), 'SIGTERM'); } catch {}
    }
  }
  process.on('SIGINT', () => { console.log('\n👋 已关闭'); cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}
