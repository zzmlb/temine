/**
 * Temine Web 控制面板 v0.6
 *
 * 1. 标签持久化（Terminal.app title displays custom title）
 * 2. 双击卡片跳转到对应终端窗口
 * 3. 保存输出 + 输出记录管理 tab
 * 4. 屏幕区域选择（全屏/左半/右半/上半 等）
 * 5. 编辑标签时跳过卡片重绘
 * 6. 稳定窗口编号 + 内容变化检测
 */

import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { labelWindow, labelWindowById, getLabel } from './terminal-label.js';

const STATE_DIR = join(homedir(), '.temine');
const STATE_FILE = join(STATE_DIR, 'state.json');
const PID_FILE = join(STATE_DIR, 'watcher.pid');
const WINDOW_MAP_FILE = join(STATE_DIR, 'window-map.json');
const LOGS_DIR = join(STATE_DIR, 'logs');
const RECORDS_DIR = join(STATE_DIR, 'records');
const IGNORED_FILE = join(STATE_DIR, 'ignored.json');
const RECORDING_FILE = join(STATE_DIR, 'recording.json');
const DEFAULT_PORT = 7890;

function ensureDir() { try { mkdirSync(STATE_DIR, { recursive: true }); } catch {} }
function ensureRecordsDir() { try { mkdirSync(RECORDS_DIR, { recursive: true }); } catch {} }
function loadIgnored() { try { return new Set(JSON.parse(readFileSync(IGNORED_FILE, 'utf-8'))); } catch { return new Set(); } }
function saveIgnored(s) { ensureDir(); writeFileSync(IGNORED_FILE, JSON.stringify([...s])); }
function loadRecording() { try { return JSON.parse(readFileSync(RECORDING_FILE, 'utf-8')); } catch { return {}; } }
function saveRecording(r) { ensureDir(); writeFileSync(RECORDING_FILE, JSON.stringify(r, null, 2)); }
function readState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; } }

function isWatcherRunning() {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    process.kill(pid, 0);
    return pid;
  } catch { return false; }
}

// ── 窗口列表 ─────────────────────────────────────────
function getWindows() {
  if (process.platform !== 'darwin') return [];
  try {
    const script = `set results to ""
tell application "Terminal"
  set i to 1
  repeat with w in windows
    set results to results & i & "||" & (id of w) & "||" & (name of w) & linefeed
    set i to i + 1
  end repeat
end tell
return results`;
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!result) return [];
    return result.split('\n').filter(l => l.trim()).map(line => {
      const [index, id, name] = line.split('||');
      return { index: parseInt(index), id, name: name?.trim() || '' };
    });
  } catch { return []; }
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
  const map = loadWindowMap();
  const ids = new Set(windows.map(w => w.id));
  const used = new Set();
  let changed = false;
  for (const w of windows) { if (map[w.id] !== undefined) { w.stableIndex = map[w.id]; used.add(map[w.id]); } }
  let n = 1;
  for (const w of windows) {
    if (w.stableIndex === undefined) {
      while (used.has(n)) n++;
      w.stableIndex = n; map[w.id] = n; used.add(n); changed = true;
    }
  }
  for (const id of Object.keys(map)) { if (!ids.has(id)) { delete map[id]; changed = true; } }
  if (changed) saveWindowMap(map);
  return windows.sort((a, b) => a.stableIndex - b.stableIndex);
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
    return { ok: true, screen: eff, cols, rows, cw, ch, arranged: cnt, ignored: ignored.size };
  } catch { return { ok: false }; }
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

// ── HTML ─────────────────────────────────────────────
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Temine 控制面板</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro','Helvetica Neue',sans-serif;background:#0d1117;color:#c9d1d9}
.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:10px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100}
.topbar h1{font-size:17px;font-weight:600;color:#58a6ff;white-space:nowrap}
.tabs{display:flex;gap:4px}
.tab-btn{background:transparent;border:1px solid transparent;border-radius:6px;padding:5px 14px;color:#8b949e;font-size:13px;cursor:pointer;transition:all .15s}
.tab-btn:hover{color:#c9d1d9}
.tab-btn.active{background:#21262d;color:#c9d1d9;border-color:#30363d}
.topbar-right{margin-left:auto;display:flex;gap:8px;align-items:center}
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
.layout-grid{display:grid;gap:2px;margin-bottom:4px;height:48px}
.layout-cell{background:#21262d;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;color:#484f58}
.layout-card:hover .layout-cell{background:#30363d}
.layout-card.active .layout-cell{background:#1a4b8c;color:#58a6ff}
.layout-name{font-size:10px;color:#8b949e}
.layout-card.active .layout-name{color:#58a6ff}
.layout-actions{display:flex;flex-direction:column;gap:5px;justify-content:center;margin-left:12px}
.btn{padding:5px 14px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;font-size:12px;cursor:pointer;transition:all .15s}
.btn:hover{background:#30363d;border-color:#58a6ff}
.btn.primary{background:#238636;border-color:#238636;color:#fff}
.btn.primary:hover{background:#2ea043}

.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:14px;padding:16px 24px 60px}
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
.card-label{flex:1;background:transparent;border:1px solid transparent;border-radius:4px;padding:3px 6px;color:#c9d1d9;font-size:13px;font-weight:500;outline:none;min-width:0}
.card-label:hover{border-color:#30363d}
.card-label:focus{border-color:#58a6ff;background:#0d1117}
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
.sub-tabs{display:flex;gap:4px;margin-bottom:14px}
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
.log-session:hover{border-color:#484f58}
.log-session .ls-head{display:flex;align-items:center;gap:10px}
.log-session .ls-label{color:#c9d1d9;font-weight:600;font-size:14px}
.log-session .ls-time{color:#8b949e;font-size:12px}
.log-session .ls-badge{font-size:10px;padding:2px 8px;border-radius:10px;background:#21262d;color:#8b949e}
.log-viewer{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;margin-top:8px;max-height:400px;overflow-y:auto}
.log-viewer pre{font-family:'SF Mono',Menlo,Monaco,'Courier New',monospace;font-size:11px;color:#8b949e;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:0}
.log-viewer .lv-cmd{color:#7ee787}.log-viewer .lv-ts{color:#484f58;font-size:10px}
.rec-toggle{display:inline-flex;align-items:center;gap:4px;font-size:10px;cursor:pointer;user-select:none;padding:2px 8px;border-radius:4px;border:1px solid #30363d;transition:all .15s}
.rec-toggle:hover{border-color:#58a6ff}
.rec-toggle.on{border-color:#3fb950;color:#3fb950}
.rec-toggle.off{border-color:#484f58;color:#484f58}

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
</style></head>
<body>

<div class="alert-banner" id="alertBanner">🔴 有终端等待你的确认操作！</div>

<div class="topbar">
  <h1>Temine</h1>
  <div class="tabs">
    <button class="tab-btn active" data-tab="panel" onclick="switchTab('panel')">控制面板</button>
    <button class="tab-btn" data-tab="records" onclick="switchTab('records')">过程记录</button>
  </div>
  <div class="topbar-right">
    <span class="badge" id="watcherBadge" onclick="toggleHint()">检查中...</span>
  </div>
</div>

<!-- ====== TAB: 控制面板 ====== -->
<div id="tabPanel">

<div class="layout-section">
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

<div class="cards" id="cards"><div class="empty"><h2>加载中...</h2></div></div>
</div>

<!-- ====== TAB: 过程记录 ====== -->
<div id="tabRecords" style="display:none">
  <div class="records-page">
    <div class="sub-tabs">
      <button class="sub-tab active" data-stab="output" onclick="switchSubTab('output')">终端输出</button>
      <button class="sub-tab" data-stab="commands" onclick="switchSubTab('commands')">终端命令</button>
      <button class="sub-tab" data-stab="snapshots" onclick="switchSubTab('snapshots')">手动快照</button>
    </div>
    <div id="subTabOutput"><div id="logOutputList"><div class="empty"><h2>加载中...</h2></div></div></div>
    <div id="subTabCommands" style="display:none"><div id="logCmdList"><div class="empty"><h2>加载中...</h2></div></div></div>
    <div id="subTabSnapshots" style="display:none"><div id="recordsList"><div class="empty"><h2>加载中...</h2></div></div></div>
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
var data=null,selectedLayout=null,selectedRegion='full',labelTimers={};

var LAYOUTS=[
  {id:'auto',name:'自动',cols:0},{id:'1c',name:'1列',cols:1},{id:'2c',name:'2列',cols:2},
  {id:'3c',name:'3列',cols:3},{id:'4c',name:'4列',cols:4},{id:'5c',name:'5列',cols:5}
];

function switchTab(t){
  document.getElementById('tabPanel').style.display=t==='panel'?'':'none';
  document.getElementById('tabRecords').style.display=t==='records'?'':'none';
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.toggle('active',b.dataset.tab===t)});
  if(t==='records'){if(currentSubTab==='output')loadLogSessions('out');else if(currentSubTab==='commands')loadLogSessions('cmd');else loadSnapshots();}
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
    var cells='';for(var i=0;i<wc;i++)cells+='<div class="layout-cell">'+(NUM[i]||i+1)+'</div>';
    return '<div class="layout-card'+act+'" onclick="selectLayout(\\''+l.id+'\\','+l.cols+')"><div class="layout-grid" style="grid-template-columns:repeat('+cols+',1fr)">'+cells+'</div><div class="layout-name">'+l.name+(l.cols?' ('+rows+'x'+cols+')':'')+'</div></div>';
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
  var hw=d.windows.some(function(w){return w.state==='waiting_confirm'});
  document.getElementById('alertBanner').className='alert-banner'+(hw?' show':'');
  renderLayouts(d.windows.length||4);
  document.getElementById('windowCount').textContent=d.windows.length+' 个窗口';
  document.getElementById('lastUpdate').textContent=new Date().toLocaleTimeString('zh-CN');

  // 编辑中 → 只更新状态灯
  var foc=document.activeElement;
  if(foc&&foc.classList.contains('card-label')){
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
  if(!d.windows.length){cc.innerHTML='<div class="empty"><h2>未找到终端窗口</h2><p>打开 Terminal.app 后自动显示</p></div>';return}

  cc.innerHTML=d.windows.map(function(w){
    var sc=w.state||'idle',st=SL[sc]||sc,tip=TIPS[sc]||'',pv=esc(w.preview||''),lv=escA(w.labelText||''),ph=escA(w.name||''),si=w.stableIndex||w.index;
    var cmdCnt=(w.commands&&w.commands.length)||0;
    var igcls=w.ignored?' ignored':'';
    return '<div class="card state-'+sc+igcls+'" data-si="'+si+'" data-winid="'+escA(w.id)+'" ondblclick="focusWin(this.dataset.winid)" title="双击跳转到此终端">' +
      '<div class="card-header"><div class="card-header-left"><span class="card-idx">'+(NUM[si-1]||si)+'</span>' +
        '<input class="card-label" value="'+lv+'" placeholder="'+ph+'" data-winid="'+escA(w.id)+'" data-stableidx="'+si+'" oninput="onLabelInput(this)" onblur="onLabelBlur(this)">' +
      '</div><span class="dot '+sc+'"></span><span class="stag '+sc+'" title="'+escA(tip)+'">'+st+'</span></div>' +
      '<div class="card-preview"><pre>'+(pv||'<span style="color:#30363d">暂无输出</span>')+'</pre></div>' +
      '<div class="card-footer">' +
        '<span class="rec-toggle '+(w.recCmd?'on':'off')+'" onclick="toggleRec(\\''+escA(w.id)+'\\',\\'cmd\\')" title="'+(w.recCmd?'点击关闭命令记录':'点击开启命令记录')+'">'+(w.recCmd?'● 命令':'○ 命令')+'</span>' +
        '<span class="rec-toggle '+(w.recOut?'on':'off')+'" onclick="toggleRec(\\''+escA(w.id)+'\\',\\'out\\')" title="'+(w.recOut?'点击关闭输出记录':'点击开启输出记录')+'">'+(w.recOut?'● 输出':'○ 输出')+'</span>' +
        '<button class="fbtn" data-winid="'+escA(w.id)+'" data-apiindex="'+w.index+'" data-name="'+escA(w.labelText||w.name||'窗口'+si)+'" data-stableidx="'+si+'" onclick="saveRecord(this)">📋 快照</button>' +
        '<button class="fbtn'+(w.ignored?' ignore-on':'')+'" onclick="toggleIgnore(\\''+escA(w.id)+'\\','+!!w.ignored+')">'+(w.ignored?'👁 显示':'🙈 忽略')+'</button>' +
        '<span class="spacer"></span><span class="dblclick-hint">双击跳转</span>' +
      '</div></div>';
  }).join('');
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function escA(s){return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}

function onLabelInput(inp){var k=inp.dataset.stableidx;clearTimeout(labelTimers[k]);labelTimers[k]=setTimeout(function(){submitLabel(inp)},1000)}
function onLabelBlur(inp){clearTimeout(labelTimers[inp.dataset.stableidx]);submitLabel(inp)}
function submitLabel(inp){
  var label=inp.value.trim();if(!label)return;
  fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({windowId:inp.dataset.winid,label:label,stableIndex:parseInt(inp.dataset.stableidx)})
  }).catch(function(){});
}

function focusWin(winId){
  var card=document.querySelector('.card[data-winid="'+winId+'"]');
  if(card){card.classList.add('focusing');setTimeout(function(){card.classList.remove('focusing')},700)}
  fetch('/api/focus',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({windowId:winId})}).catch(function(){});
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
      return '<div class="log-session" onclick="toggleLogView(this,\\''+escA(s.id)+'\\',\\''+type+'\\')"><div class="ls-head"><span class="ls-label">'+esc(s.label)+'</span><span class="ls-time">'+new Date(s.updatedAt).toLocaleString('zh-CN')+'</span><span class="ls-badge">'+(type==='cmd'?'命令':'输出')+'</span></div></div>';
    }).join('');
  }).catch(function(){});
}

function toggleLogView(el,id,type){
  var viewer=el.querySelector('.log-viewer');
  if(viewer){viewer.remove();return}
  var d=document.createElement('div');d.className='log-viewer';d.innerHTML='<pre style="color:#484f58">加载中...</pre>';el.appendChild(d);
  var url=type==='cmd'?'/api/log/cmd?id='+id+'&lines=200':'/api/log/out?id='+id+'&lines=200';
  fetch(url).then(function(r){return r.json()}).then(function(data){
    if(!data.content||!data.content.trim()){d.innerHTML='<pre style="color:#484f58">暂无内容</pre>';return}
    if(type==='cmd'){
      d.innerHTML=data.content.split('\\n').filter(function(l){return l.trim()}).map(function(l){
        var m=l.match(/^\\[(.+?)\\]\\s*(.*)$/);
        return m?'<div><span class="lv-ts">['+esc(m[1])+']</span> <span class="lv-cmd">'+esc(m[2])+'</span></div>':'<div class="lv-cmd">'+esc(l)+'</div>';
      }).join('');
    }else{
      d.innerHTML='<pre>'+esc(data.content.slice(-10000))+'</pre>';
    }
    d.scrollTop=d.scrollHeight;
  }).catch(function(){d.innerHTML='<pre style="color:#f85149">加载失败</pre>'});
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

function toggleIgnore(winId,isIgnored){
  fetch(isIgnored?'/api/unignore':'/api/ignore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({windowId:winId})})
    .then(function(r){return r.json()}).then(function(){fetchData()}).catch(function(){});
}

function closeModal(id){document.getElementById(id).style.display='none'}
function toggleHint(){var h=document.getElementById('watcherHint');h.style.display=h.style.display==='none'?'':'none'}
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeModal('historyModal');closeModal('recordModal')}});

function connectSSE(){
  var es=new EventSource('/api/events');
  es.onmessage=function(e){try{data=JSON.parse(e.data);if(document.getElementById('tabPanel').style.display!=='none')render(data)}catch(err){}};
  es.onerror=function(){es.close();setTimeout(connectSSE,3000)};
}
fetchData();connectSSE();
</script></body></html>`;
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
  stabilizeWindows(windows);

  // 只在有窗口时才调用 AppleScript 读内容
  let contentMap = {};
  if (windows.length > 0) {
    contentMap = getAllWindowContent(2000); // 减少到 2000 字符
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

  _statusCache = { windows: enriched, watcherPid };
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

    if (url.pathname === '/api/label' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { windowId, label, stableIndex, index } = JSON.parse(body);
          if (windowId) {
            // 优先使用窗口 ID（稳定，不受焦点影响）
            await labelWindowById(windowId, label, stableIndex || 1);
          } else {
            await labelWindow(index, label, { displayIndex: stableIndex || index });
          }
          _statusCache = null; // 清缓存让前端立即看到新标签
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('bad request'); }
      }); return;
    }

    if (url.pathname === '/api/arrange' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
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
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
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
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
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

    if (url.pathname === '/api/focus' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { windowId } = JSON.parse(body);
          const ok = focusWindowApi(windowId);
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
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
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
          'Content-Disposition': `attachment; filename="temine-${d.label}-${id}.txt"`,
        });
        res.end(d.content);
      } catch { res.writeHead(404); res.end('not found'); }
      return;
    }

    if (url.pathname === '/api/record' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) { res.writeHead(400); res.end('invalid id'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true })); return;
    }

    if (url.pathname === '/api/record/note' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
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

    // 录制设置
    if (url.pathname === '/api/recording' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadRecording())); return;
    }

    if (url.pathname === '/api/recording/toggle' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
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

    if (url.pathname === '/api/events') {
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

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n🖥️  Temine 控制面板 v0.6`);
    console.log(`   ${url}`);
    console.log(`   Ctrl+C 停止\n`);
    if (process.platform === 'darwin') { try { execSync(`open "${url}"`); } catch {} }
    else { console.log(`   请在浏览器打开上面的地址`); }
  });

  process.on('SIGINT', () => { console.log('\n👋 已关闭'); server.close(); process.exit(0); });
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
}
