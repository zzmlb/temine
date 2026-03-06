/**
 * 终端窗口标签管理
 * 支持带编号 + emoji 的醒目标签
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = join(homedir(), '.temine');
const LABELS_FILE = join(STATE_DIR, 'labels.json');

// 预设 emoji 标记（按窗口编号自动分配）
const NUMBER_EMOJI = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

// 用户可用的图标关键字映射
const ICON_MAP = {
  'fe':       '🎨',  // 前端
  'frontend': '🎨',
  'be':       '⚙️',   // 后端
  'backend':  '⚙️',
  'api':      '🔌',
  'test':     '🧪',
  'debug':    '🐛',
  'db':       '🗄️',
  'database': '🗄️',
  'deploy':   '🚀',
  'docs':     '📝',
  'monitor':  '📡',
  'build':    '🔨',
  'dev':      '💻',
  'claude':   '🤖',
  'ai':       '🤖',
};

function ensureDir() {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

function loadLabels() {
  try {
    return JSON.parse(readFileSync(LABELS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveLabels(labels) {
  ensureDir();
  writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 2));
}

/**
 * 根据标签文字自动匹配 emoji
 */
function autoIcon(labelText) {
  const lower = labelText.toLowerCase();
  for (const [keyword, icon] of Object.entries(ICON_MAP)) {
    if (lower.includes(keyword)) return icon;
  }
  return '📌';
}

/**
 * 构建醒目的窗口标题
 * 格式: ① 🤖 Claude前端重构
 */
function buildTitle(index, label) {
  const numEmoji = NUMBER_EMOJI[index - 1] || `[${index}]`;
  const icon = autoIcon(label);
  return `${numEmoji} ${icon} ${label}`;
}

/**
 * 获取所有终端窗口信息
 */
function getWindows() {
  if (process.platform !== 'darwin') {
    console.log('此功能仅支持 macOS');
    return [];
  }

  // 先尝试 Terminal.app
  try {
    const script = `
      set results to ""
      tell application "Terminal"
        set i to 1
        repeat with w in windows
          set results to results & i & "||" & (id of w) & "||" & (name of w) & linefeed
          set i to i + 1
        end repeat
      end tell
      return results
    `;
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) {
      return result.split('\n').filter(l => l.trim()).map(line => {
        const [index, id, name] = line.split('||');
        return { index: parseInt(index), id, name: name?.trim() || '', app: 'Terminal' };
      });
    }
  } catch {}

  // 尝试 iTerm
  try {
    const script = `
      set results to ""
      tell application "iTerm"
        set i to 1
        repeat with w in windows
          set results to results & i & "||" & (id of w) & "||" & (name of w) & linefeed
          set i to i + 1
        end repeat
      end tell
      return results
    `;
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) {
      return result.split('\n').filter(l => l.trim()).map(line => {
        const [index, id, name] = line.split('||');
        return { index: parseInt(index), id, name: name?.trim() || '', app: 'iTerm' };
      });
    }
  } catch {}

  return [];
}

/**
 * 给终端窗口设置标签
 * 支持格式:
 *   temine label 3 前端重构
 *   temine label 3 --icon 🎯 前端重构
 */
export async function labelWindow(windowIndex, label, options = {}) {
  if (process.platform !== 'darwin') {
    console.log('此功能仅支持 macOS');
    return;
  }

  // options.displayIndex: 用于标题显示的编号（与 AppleScript 窗口索引可能不同）
  const displayIndex = options.displayIndex || windowIndex;
  const title = buildTitle(displayIndex, label);

  // 尝试 Terminal.app
  try {
    const script = `
      tell application "Terminal"
        if ${windowIndex} ≤ (count of windows) then
          set w to window ${windowIndex}
          tell tab 1 of w
            set custom title to "${title.replace(/"/g, '\\"')}"
            set title displays custom title to true
            set title displays shell path to false
            set title displays window size to false
          end tell
          return id of w
        else
          return "NOT_FOUND"
        end if
      end tell
    `;
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 5000 }).trim();

    if (result === 'NOT_FOUND') {
      console.log(`❌ 窗口 ${windowIndex} 不存在，运行 temine list 查看可用窗口`);
      return;
    }

    const labels = loadLabels();
    labels[result] = { text: label, title, index: windowIndex };
    saveLabels(labels);

    console.log(`✅ 窗口 ${windowIndex} → ${title}`);
    return;
  } catch {}

  // 尝试 iTerm
  try {
    const script = `
      tell application "iTerm"
        if ${windowIndex} ≤ (count of windows) then
          set w to window ${windowIndex}
          tell current session of current tab of w
            set name to "${title.replace(/"/g, '\\"')}"
          end tell
          return id of w
        else
          return "NOT_FOUND"
        end if
      end tell
    `;
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 5000 }).trim();

    if (result === 'NOT_FOUND') {
      console.log(`❌ 窗口 ${windowIndex} 不存在`);
      return;
    }

    const labels = loadLabels();
    labels[result] = { text: label, title, index: windowIndex };
    saveLabels(labels);

    console.log(`✅ 窗口 ${windowIndex} → ${title}`);
  } catch {
    console.error('❌ 设置标签失败');
  }
}

/**
 * 批量命名所有窗口
 * temine label-all 前端重构 API开发 测试 监控
 */
export async function labelAll(names) {
  if (process.platform !== 'darwin') {
    console.log('此功能仅支持 macOS');
    return;
  }

  const windows = getWindows();
  if (windows.length === 0) {
    console.log('未找到终端窗口');
    return;
  }

  const count = Math.min(names.length, windows.length);
  console.log(`正在命名 ${count} 个窗口...\n`);

  for (let i = 0; i < count; i++) {
    await labelWindow(i + 1, names[i]);
  }

  if (windows.length > names.length) {
    console.log(`\n还有 ${windows.length - names.length} 个窗口未命名`);
  }
}

/**
 * 列出所有终端窗口
 */
export async function listWindows() {
  const windows = getWindows();
  const labels = loadLabels();

  if (windows.length === 0) {
    console.log('未找到终端窗口');
    return;
  }

  console.log('终端窗口列表:\n');
  console.log('  编号  标签                     窗口标题');
  console.log('  ────  ───────────────────────  ──────────────────────────');

  for (const win of windows) {
    const labelData = labels[win.id];
    let labelStr;
    if (labelData) {
      const displayLabel = typeof labelData === 'string' ? labelData : labelData.title || labelData.text;
      labelStr = displayLabel.padEnd(23);
    } else {
      labelStr = '\x1b[2m(未标记)\x1b[0m'.padEnd(33); // DIM + reset 补偿
    }
    console.log(`  ${String(win.index).padEnd(4)}  ${labelStr}  ${win.name}`);
  }

  console.log(`\n标签命令:`);
  console.log(`  temine label 1 前端重构                  给单个窗口命名`);
  console.log(`  temine label-all 前端 API 测试 监控      批量命名所有窗口`);
  console.log(`\n自动图标: fe/frontend=🎨 be/backend=⚙️  api=🔌 test=🧪 claude/ai=🤖 debug=🐛`);
}

/**
 * 通过窗口 ID 设置标签（稳定，不受焦点影响）
 * Web 控制面板使用此函数
 */
export async function labelWindowById(windowId, label, displayIndex = 1) {
  if (process.platform !== 'darwin') return false;
  const title = buildTitle(displayIndex, label);
  const t = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // 尝试 Terminal.app
  try {
    const script = `tell application "Terminal"
  try
    tell tab 1 of (window id ${windowId})
      set custom title to "${t}"
      set title displays custom title to true
      set title displays shell path to false
      set title displays window size to false
    end tell
  end try
end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 5000 });
    const labels = loadLabels();
    labels[windowId] = { text: label, title, index: displayIndex };
    saveLabels(labels);
    return true;
  } catch {}

  // 尝试 iTerm
  try {
    const script = `tell application "iTerm"
  try
    set w to window id ${windowId}
    tell current session of current tab of w
      set name to "${t}"
    end tell
  end try
end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 5000 });
    const labels = loadLabels();
    labels[windowId] = { text: label, title, index: displayIndex };
    saveLabels(labels);
    return true;
  } catch {}

  return false;
}

/**
 * 根据窗口 ID 获取标签文本
 */
export function getLabel(windowId) {
  const labels = loadLabels();
  const data = labels[windowId];
  if (!data) return null;
  if (typeof data === 'string') return data;
  return data.text || data.title || null;
}

/**
 * 批量强制恢复标签（防止 shell 覆盖自定义标题）
 * 单个 AppleScript 调用处理所有窗口，开销很小
 */
export function enforceLabels(windowIds) {
  if (process.platform !== 'darwin') return;
  const labels = loadLabels();
  const toEnforce = [];
  for (const wid of windowIds) {
    const data = labels[wid];
    if (!data) continue;
    const title = typeof data === 'string' ? data : (data.title || '');
    if (title) toEnforce.push({ id: wid, title });
  }
  if (toEnforce.length === 0) return;

  let script = 'tell application "Terminal"\n';
  for (const { id, title } of toEnforce) {
    const t = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    script += `  try\n    tell tab 1 of (window id ${id})\n      set custom title to "${t}"\n      set title displays custom title to true\n      set title displays shell path to false\n      set title displays window size to false\n    end tell\n  end try\n`;
  }
  script += 'end tell';

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', timeout: 10000 });
  } catch {}
}
