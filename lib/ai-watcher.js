/**
 * AI 状态监控器
 *
 * 监控所有终端窗口，定期抓取终端内容，
 * 检测 Claude Code 等 AI 工具的状态，触发 macOS 系统通知。
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { recordSnapshots } from './logger.js';
import { getLabel } from './terminal-label.js';
import { loadConfig } from './config.js';

const STATE_DIR = join(homedir(), '.temine');
const PID_FILE = join(STATE_DIR, 'watcher.pid');
const STATE_FILE = join(STATE_DIR, 'state.json');

// ============================================================
// ANSI 转义码剥离（更完善的正则）
// ============================================================
function stripAnsi(text) {
  // 覆盖 CSI, OSC, DCS, PM, APC 等所有转义序列
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')       // CSI 序列 (如 \x1b[31m)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '') // OSC 序列
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')      // DCS/PM/APC 序列
    .replace(/\x1b[()][0-9A-B]/g, '')               // 字符集切换
    .replace(/\x1b[#%][0-9A-Z]/g, '')               // 其他短序列
    .replace(/\x1b[NOcn=><78]/g, '')                // 单字符转义
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // 控制字符
}

// ============================================================
// Claude Code 专用检测模式（带优先级和置信度）
// ============================================================
const DETECTION_RULES = [
  // === 等待确认（最高优先级）===
  // Claude Code 工具审批提示
  {
    state: 'waiting_confirm',
    // Claude Code 权限提示的典型格式
    test: (text, lastLines) => {
      for (const line of lastLines) {
        // Claude Code 的权限确认关键词
        if (/Do you want to proceed\??/i.test(line)) return { confidence: 0.95, trigger: line };
        if (/\(y\)es\s*\/\s*\(n\)o/i.test(line)) return { confidence: 0.95, trigger: line };
        if (/\(Y\/n\)|\(y\/N\)/i.test(line)) return { confidence: 0.9, trigger: line };
        if (/Allow\s+(once|always)\b/i.test(line)) return { confidence: 0.95, trigger: line };
        if (/Do you want to allow/i.test(line)) return { confidence: 0.9, trigger: line };
        if (/Press\s+Enter\s+to\s+continue/i.test(line)) return { confidence: 0.85, trigger: line };
        // Claude Code Bash 工具审批
        if (/Run\s+(this|the)\s+(command|script)\??/i.test(line)) return { confidence: 0.85, trigger: line };
        // Claude Code 文件编辑审批
        if (/Apply\s+(this|these)\s+(edit|change)/i.test(line)) return { confidence: 0.85, trigger: line };
        // 通用 yes/no 提示（较低置信度，避免匹配代码输出中的 y/n）
        if (/^\s*\[?(yes|no|y|n)\]?\s*[:/>\?]\s*$/i.test(line)) return { confidence: 0.7, trigger: line };
      }
      return null;
    },
  },

  // === 运行中 ===
  {
    state: 'running',
    test: (text, lastLines) => {
      for (const line of lastLines) {
        // Claude Code spinner 字符
        if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/.test(line)) return { confidence: 0.9, trigger: 'spinner' };
        // Claude Code 活动指示
        if (/Thinking\s*\.{2,}/i.test(line)) return { confidence: 0.85, trigger: line };
        if (/(?:Reading|Writing|Editing|Searching|Analyzing|Creating|Updating)\s/i.test(line) &&
            !/Error|Failed/i.test(line)) return { confidence: 0.7, trigger: line };
        // 进度条
        if (/\[#+\s*\]|\[=+>?\s*\]|[0-9]+%/.test(line)) return { confidence: 0.6, trigger: line };
      }
      return null;
    },
  },

  // === 错误 ===
  {
    state: 'error',
    test: (text, lastLines) => {
      // 只检测最后 5 行，减少误报
      const recent = lastLines.slice(-5);
      for (const line of recent) {
        // 明确的错误前缀（不匹配代码中的 Error 类名）
        if (/^(Error|ERROR|FATAL|PANIC):/m.test(line)) return { confidence: 0.85, trigger: line };
        if (/^ERR!/.test(line)) return { confidence: 0.85, trigger: line };
        // npm/命令执行错误
        if (/Command failed|Process exited with code [^0]/i.test(line)) return { confidence: 0.8, trigger: line };
        // 编译错误
        if (/Build failed|Compilation failed/i.test(line)) return { confidence: 0.8, trigger: line };
      }
      return null;
    },
  },

  // === 完成 ===
  {
    state: 'completed',
    test: (text, lastLines) => {
      const recent = lastLines.slice(-3);
      for (const line of recent) {
        if (/✓\s+Done|✔\s+Done/i.test(line)) return { confidence: 0.8, trigger: line };
        if (/Successfully\s+(completed|finished|built|deployed)/i.test(line)) return { confidence: 0.8, trigger: line };
        if (/Build\s+succeeded/i.test(line)) return { confidence: 0.8, trigger: line };
      }
      return null;
    },
  },
];

/**
 * 检测文本中的 AI 状态
 */
function detectState(text) {
  const clean = stripAnsi(text);
  const lines = clean.split('\n').filter(l => l.trim());
  const lastLines = lines.slice(-30); // 取最后 30 行

  for (const rule of DETECTION_RULES) {
    const result = rule.test(clean, lastLines);
    if (result && result.confidence >= 0.6) {
      return { state: rule.state, confidence: result.confidence, trigger: result.trigger };
    }
  }

  return { state: 'idle', confidence: 1.0, trigger: '' };
}

/**
 * macOS 通知
 */
function notify(title, body, config) {
  if (process.platform !== 'darwin') {
    console.log(`[通知] ${title}: ${body}`);
    return;
  }
  try {
    const sound = config?.notification?.sound || 'Glass';
    const escapedBody = body.replace(/"/g, '\\"').replace(/'/g, "'\\''");
    const escapedTitle = title.replace(/"/g, '\\"').replace(/'/g, "'\\''");
    const script = `display notification "${escapedBody}" with title "${escapedTitle}" sound name "${sound}"`;
    execSync(`osascript -e '${script}'`, { timeout: 5000 });
  } catch {
    // 通知失败不影响主流程
  }
}

/**
 * 获取 Terminal.app 的窗口内容
 */
function getTerminalContents(contentLength) {
  if (process.platform !== 'darwin') return [];

  try {
    const script = `
      set results to ""
      tell application "Terminal"
        repeat with w in windows
          set windowName to name of w
          set windowId to id of w
          try
            set tabContent to contents of tab 1 of w
            if length of tabContent > ${contentLength} then
              set tabContent to text ((length of tabContent) - ${contentLength}) thru (length of tabContent) of tabContent
            end if
            set results to results & "===WINDOW:" & windowId & ":" & windowName & "===" & linefeed & tabContent & linefeed
          end try
        end repeat
      end tell
      return results
    `;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });

    const windows = [];
    const parts = result.split(/===WINDOW:(\d+):(.+?)===/);
    for (let i = 1; i < parts.length; i += 3) {
      windows.push({
        id: parts[i],
        name: parts[i + 1],
        content: (parts[i + 2] || '').trim(),
      });
    }
    return windows;
  } catch {
    return [];
  }
}

/**
 * 检查 iTerm2 是否正在运行（只检查一次，减少不必要的 AppleScript 调用）
 */
let _itermRunning = null;
let _itermCheckTime = 0;
function isITermRunning() {
  const now = Date.now();
  if (_itermRunning !== null && now - _itermCheckTime < 30000) return _itermRunning;
  try {
    const r = execSync(`pgrep -x iTerm2`, { encoding: 'utf-8', timeout: 2000 }).trim();
    _itermRunning = r.length > 0;
  } catch { _itermRunning = false; }
  _itermCheckTime = now;
  return _itermRunning;
}

/**
 * 获取 iTerm2 的窗口内容
 */
function getITermContents(contentLength) {
  if (process.platform !== 'darwin') return [];
  if (!isITermRunning()) return [];

  try {
    const script = `
      set results to ""
      tell application "iTerm"
        repeat with w in windows
          set windowName to name of w
          set windowId to id of w
          tell current session of current tab of w
            set tabContent to contents
            if length of tabContent > ${contentLength} then
              set tabContent to text ((length of tabContent) - ${contentLength}) thru (length of tabContent) of tabContent
            end if
          end tell
          set results to results & "===WINDOW:" & windowId & ":" & windowName & "===" & linefeed & tabContent & linefeed
        end repeat
      end tell
      return results
    `;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });

    const windows = [];
    const parts = result.split(/===WINDOW:(\d+):(.+?)===/);
    for (let i = 1; i < parts.length; i += 3) {
      windows.push({
        id: parts[i],
        name: parts[i + 1],
        content: (parts[i + 2] || '').trim(),
      });
    }
    return windows;
  } catch {
    return [];
  }
}

function ensureStateDir() {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

/**
 * 监控主循环
 */
async function watchLoop() {
  ensureStateDir();

  const config = loadConfig();
  const pollInterval = config.watch.interval;
  const contentLength = config.watch.contentLength;
  const notifyCooldown = config.notification.cooldown;
  const persistentAlert = config.notification.persistentAlert;

  // 保存 PID
  writeFileSync(PID_FILE, String(process.pid));

  const previousStates = new Map();
  const lastNotifyTime = new Map();
  // 追踪持续等待确认的窗口
  const waitingConfirmSince = new Map();

  console.log('🔍 Temine AI 状态监控已启动');
  console.log(`   PID: ${process.pid}`);
  console.log(`   轮询间隔: ${pollInterval}ms`);
  console.log(`   通知冷却: ${notifyCooldown}ms`);
  console.log(`   持续提醒: ${persistentAlert ? '开启' : '关闭'}`);
  console.log('   按 Ctrl+C 停止\n');

  const stateLabels = {
    idle: '⚪ 空闲',
    running: '🟢 运行中',
    waiting_confirm: '🔴 等待确认',
    error: '❌ 错误',
    completed: '✅ 完成',
  };

  const tick = () => {
    try {
      const terminals = getTerminalContents(contentLength);
      const iterms = getITermContents(contentLength);
      const allWindows = [...terminals, ...iterms];

      const stateMap = {};

      // 批量收集快照数据，一次性写入（减少 IO）
      const snapshotBatch = [];

      for (const win of allWindows) {
        const detection = detectState(win.content);
        const prevState = previousStates.get(win.id);
        const customLabel = getLabel(win.id);
        const displayName = customLabel || win.name;

        stateMap[win.id] = {
          name: displayName,
          state: detection.state,
          confidence: detection.confidence,
          trigger: detection.trigger,
          updatedAt: Date.now(),
        };

        // 收集快照（稍后批量写入）
        snapshotBatch.push({ windowId: win.id, windowName: win.name, content: win.content, label: customLabel });

        // 状态变化处理
        if (detection.state !== prevState) {
          previousStates.set(win.id, detection.state);

          const label = stateLabels[detection.state] || detection.state;
          const timestamp = new Date().toLocaleTimeString('zh-CN');
          const confidenceStr = `[${Math.round(detection.confidence * 100)}%]`;
          console.log(`[${timestamp}] ${displayName}: ${label} ${confidenceStr}`);

          // 追踪等待确认时间
          if (detection.state === 'waiting_confirm') {
            waitingConfirmSince.set(win.id, Date.now());
          } else {
            waitingConfirmSince.delete(win.id);
          }
        }

        // 通知逻辑
        const now = Date.now();
        const shouldNotify = detection.state === 'waiting_confirm' || detection.state === 'error';

        if (shouldNotify && config.notification.enabled) {
          const lastTime = lastNotifyTime.get(win.id) || 0;
          const timeSinceLastNotify = now - lastTime;

          // 首次状态变化 或 持续提醒
          const isFirstNotify = detection.state !== prevState;
          const isPersistentReminder = persistentAlert &&
            detection.state === 'waiting_confirm' &&
            timeSinceLastNotify > notifyCooldown;

          if (isFirstNotify || isPersistentReminder) {
            lastNotifyTime.set(win.id, now);

            if (detection.state === 'waiting_confirm') {
              const waitTime = waitingConfirmSince.get(win.id);
              const waitSecs = waitTime ? Math.round((now - waitTime) / 1000) : 0;
              const waitStr = waitSecs > 0 ? ` (已等待 ${waitSecs}s)` : '';
              notify('Temine - 需要确认', `"${displayName}" 等待你的操作${waitStr}`, config);
            } else {
              notify('Temine - 错误', `"${displayName}" 遇到错误`, config);
            }
          }
        }

        // 状态不再是等待确认时，清除追踪
        if (detection.state !== 'waiting_confirm') {
          lastNotifyTime.delete(win.id);
        }
      }

      // 批量写入快照
      if (snapshotBatch.length > 0) recordSnapshots(snapshotBatch);

      // 更新状态文件
      writeFileSync(STATE_FILE, JSON.stringify(stateMap, null, 2));
    } catch (err) {
      // 静默处理，继续监控
    }
  };

  tick();
  setInterval(tick, pollInterval);

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n🛑 监控已停止');
    try { unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    try { unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  });
}

/**
 * 启动监控
 */
export async function startWatcher() {
  ensureStateDir();

  // 检查是否已在运行
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(parseInt(pid), 0);
      console.log(`监控已在运行 (PID: ${pid})`);
      console.log('运行 temine stop 先停止');
      return;
    } catch {
      unlinkSync(PID_FILE);
    }
  }

  await watchLoop();
}

/**
 * 停止监控
 */
export async function stopWatcher() {
  if (!existsSync(PID_FILE)) {
    console.log('监控未在运行');
    return;
  }
  const pid = readFileSync(PID_FILE, 'utf-8').trim();
  try {
    process.kill(parseInt(pid), 'SIGTERM');
    console.log(`✅ 已停止监控 (PID: ${pid})`);
  } catch {
    console.log('监控进程已不存在');
  }
  try { unlinkSync(PID_FILE); } catch {}
}

/**
 * 显示状态
 */
export async function showStatus() {
  let running = false;
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(parseInt(pid), 0);
      running = true;
      console.log(`监控状态: 🟢 运行中 (PID: ${pid})`);
    } catch {
      console.log('监控状态: ⚪ 未运行');
    }
  } else {
    console.log('监控状态: ⚪ 未运行');
  }

  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      const entries = Object.entries(state);
      if (entries.length > 0) {
        console.log('\n终端状态:');
        const stateIcons = {
          idle: '⚪',
          running: '🟢',
          waiting_confirm: '🔴',
          error: '❌',
          completed: '✅',
        };
        for (const [id, info] of entries) {
          const icon = stateIcons[info.state] || '⚪';
          const conf = info.confidence ? ` [${Math.round(info.confidence * 100)}%]` : '';
          console.log(`  ${icon} ${info.name} [${info.state}]${conf}`);
        }
      } else {
        console.log('\n暂无终端在运行');
      }
    } catch {
      console.log('\n暂无状态数据');
    }
  }
}
