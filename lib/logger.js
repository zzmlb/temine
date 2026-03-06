/**
 * 终端输入输出记录 + 搜索
 *
 * 数据存储在 ~/.temine/logs/ 目录下
 * 每个窗口两个日志文件：
 *   <窗口ID>.cmd.log  — 输入（已提交的命令）
 *   <窗口ID>.out.log  — 输出（终端新增内容）
 * 索引文件：index.json
 *
 * 性能优化：index 和 marker 在内存中缓存，批量写入磁盘
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = join(homedir(), '.temine');
const LOGS_DIR = join(STATE_DIR, 'logs');
const INDEX_FILE = join(LOGS_DIR, 'index.json');

let _dirReady = false;
function ensureDir() {
  if (_dirReady) return;
  try { mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
  _dirReady = true;
}

// 内存缓存 index，避免每次磁盘读写
let _indexCache = null;
let _indexDirty = false;

function loadIndex() {
  if (_indexCache) return _indexCache;
  try {
    _indexCache = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'));
  } catch {
    _indexCache = {};
  }
  return _indexCache;
}

function markIndexDirty() { _indexDirty = true; }

// 定期刷新 index 到磁盘（而非每次调用都写）
let _flushTimer = null;
function scheduleIndexFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (_indexDirty && _indexCache) {
      try { writeFileSync(INDEX_FILE, JSON.stringify(_indexCache, null, 2)); } catch {}
      _indexDirty = false;
    }
  }, 5000);
}

// 内存缓存：存储每个窗口的上次内容行（用于行级去重）
const _markerCache = new Map();
// 内存缓存：每个窗口已记录的命令集合（用于命令去重）
const _seenCmds = new Map();

// 简单字符串哈希（用于行去重）
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

// 字符 3-gram 相似度（用于命令模糊去重）
function trigramSimilarity(a, b) {
  const triA = new Set(), triB = new Set();
  for (let i = 0; i <= a.length - 3; i++) triA.add(a.slice(i, i + 3));
  for (let i = 0; i <= b.length - 3; i++) triB.add(b.slice(i, i + 3));
  let inter = 0;
  for (const t of triA) { if (triB.has(t)) inter++; }
  return inter / (triA.size + triB.size - inter);
}

// Shell 提示符匹配模式（用于识别已提交的命令）
const CMD_PATTERNS = [
  /[@:][^$%#]*[$%#]\s+(.{2,})$/,   // user@host:path$ command
  /^\s*[$%#]\s+(.{2,})$/,           // $ command
  /^➜\s+\S+\s+(.{2,})$/,           // oh-my-zsh: ➜ dir command
  /^❯\s+(.{2,})$/,                  // starship: ❯ command
];

/**
 * 判断文本是否像终端输出（而非用户输入的命令/文本）
 * 排除明显的程序输出内容，保留用户输入（包括给 Claude 的中文长文本）
 */
function looksLikeCommand(text) {
  // 含有明显输出特征的排除（程序生成的格式化内容）
  if (/^(Error|Warning|Info|DEBUG|WARN|ERR)\b/i.test(text)) return false;
  // 纯符号/box-drawing 行
  if (/^[─═━—\-=~_│┃|┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬\s]{3,}$/.test(text)) return false;
  // 含有省略号+括号等输出格式（如 "Boss名…)"）
  if (/…[)）]$/.test(text)) return false;
  // 文件路径列表输出（如 drwxr-xr-x ...）
  if (/^[d\-rwx]{10}\s/.test(text)) return false;
  return true;
}

/**
 * 从新增行中分离命令和输出
 */
function separateCmdAndOutput(newLines) {
  const cmds = [];
  const output = [];

  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i];
    let isCmd = false;
    for (const p of CMD_PATTERNS) {
      const m = line.match(p);
      if (m) {
        const cmd = m[1].trim();
        if (cmd && !/^[-=─]+$/.test(cmd) && looksLikeCommand(cmd)) {
          cmds.push(cmd);
          isCmd = true;
        }
        break;
      }
    }
    if (!isCmd) {
      output.push(line);
    }
  }
  return { cmds, output };
}

/**
 * 过滤噪声行：分隔线、空行、状态栏、spinner 等不值得记录的内容
 */
function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  // 纯分隔线（─ ═ ━ — - =）
  if (/^[─═━—\-=~_]{3,}$/.test(t)) return true;
  // 纯空白或仅含 box-drawing 字符
  if (/^[│┃|┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬─═━\s]+$/.test(t)) return true;
  // spinner 字符行
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷\s]+$/.test(t)) return true;
  // Claude Code 状态栏 / 提示符
  if (/^\? for shortcuts/.test(t)) return true;
  if (/^[❯›>]\s*$/.test(t)) return true;
  // Auto-update 提示
  if (/Auto-update failed/i.test(t)) return true;
  // Claude Code 底部状态行（token 计数、cost、模型名等）
  if (/^\d+[kK]?\s*(tokens?|input|output|cost)/i.test(t)) return true;
  if (/^(claude|opus|sonnet|haiku)\s/i.test(t)) return true;
  if (/^\$\d+\.\d+\s*(cost|remaining|total)/i.test(t)) return true;
  // 进度百分比行
  if (/^\s*\d{1,3}%\s*$/.test(t)) return true;
  // 仅含 ANSI 控制序列残留
  if (/^[\s\x1b\[\]0-9;mHJKGABCDn]*$/.test(t) && t.length < 20) return true;
  return false;
}

// 已写入输出的行哈希缓冲（每个窗口保留最近写入的 200 行哈希，防止重复写入）
const _writtenHashes = new Map();

/**
 * 行级去重：找出真正新增的行
 * 排除底部 5 行（Claude Code 状态栏 + 当前输入行区域，会频繁变化）
 */
function findNewLines(prevLines, currLines) {
  // 排除底部 5 行（状态栏区域 + 未提交的输入行）
  const TAIL_SKIP = 5;
  const curr = currLines.length > TAIL_SKIP ? currLines.slice(0, -TAIL_SKIP) : [];
  const prev = prevLines.length > TAIL_SKIP ? prevLines.slice(0, -TAIL_SKIP) : [];

  if (curr.length === 0) return [];
  if (prev.length === 0) return filterNoise(curr);

  // 方法1：前缀匹配（最常见情况：新输出追加在后面）
  let commonPrefix = 0;
  const maxCheck = Math.min(prev.length, curr.length);
  for (let i = 0; i < maxCheck; i++) {
    if (curr[i] === prev[i]) commonPrefix++;
    else break;
  }
  if (commonPrefix > 0) return filterNoise(curr.slice(commonPrefix));

  // 方法2：尾部匹配（终端滚动，旧内容滚出缓冲区）
  const tailLen = Math.min(prev.length, 20);
  const tail = prev.slice(-tailLen);
  for (let i = curr.length - tailLen; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < tailLen; j++) {
      if (curr[i + j] !== tail[j]) { match = false; break; }
    }
    if (match) return filterNoise(curr.slice(i + tailLen));
  }

  // 方法3：内容完全不同 — 检查相似度，避免重复记录
  const currJoined = curr.join('\n');
  const prevJoined = prev.join('\n');
  if (currJoined === prevJoined) return [];
  // 计算简单相似度（共同行数/总行数），高相似则跳过
  let same = 0;
  const prevSet = new Set(prev);
  for (const l of curr) { if (prevSet.has(l)) same++; }
  if (same > curr.length * 0.7) return []; // 超过 70% 相同，视为重复
  return filterNoise(curr);
}

function filterNoise(lines) {
  return lines.filter(l => !isNoiseLine(l));
}

/**
 * 批量记录多个窗口的快照（由 watcher 调用）
 * 输入（命令）和输出分别存储到不同文件
 */
export function recordSnapshots(windowsData) {
  ensureDir();
  const index = loadIndex();
  const now = Date.now();
  let changed = false;

  for (const { windowId, windowName, content, label, skipCmd, skipOut } of windowsData) {
    const safeId = String(windowId).replace(/[^a-zA-Z0-9_-]/g, '_');

    // 更新索引（内存操作）
    if (!index[safeId]) {
      index[safeId] = {
        id: safeId, windowName, label: label || windowName,
        createdAt: now, updatedAt: now,
        cmdFile: `${safeId}.cmd.log`,
        outFile: `${safeId}.out.log`,
        logFile: `${safeId}.out.log`, // 兼容旧接口
      };
      changed = true;
    }
    index[safeId].updatedAt = now;
    if (index[safeId].windowName !== windowName) { index[safeId].windowName = windowName; changed = true; }
    if (label && index[safeId].label !== label) { index[safeId].label = label; changed = true; }
    // 补充旧索引缺少的字段
    if (!index[safeId].cmdFile) { index[safeId].cmdFile = `${safeId}.cmd.log`; changed = true; }
    if (!index[safeId].outFile) { index[safeId].outFile = `${safeId}.out.log`; changed = true; }

    // 行级去重
    const currLines = content.split('\n');
    const prevLines = _markerCache.get(safeId) || [];
    const newLines = findNewLines(prevLines, currLines);

    if (newLines.length > 0 && newLines.some(l => l.trim())) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const { cmds, output } = separateCmdAndOutput(newLines);

      // 写入命令文件（模糊去重：精确匹配 + 前缀/子串匹配）
      if (cmds.length > 0 && !skipCmd) {
        let seenList = _seenCmds.get(safeId);
        if (!seenList) { seenList = []; _seenCmds.set(safeId, seenList); }
        const newCmds = cmds.filter(c => {
          // 精确匹配
          if (seenList.includes(c)) return false;
          // 模糊匹配：新命令是已有命令的前缀/子串，或已有命令是新命令的前缀/子串
          for (const seen of seenList) {
            if (seen.startsWith(c) || c.startsWith(seen)) return false;
            // 短命令相似度检查（Jaccard，按字符 3-gram）
            if (c.length > 10 && seen.length > 10 && trigramSimilarity(c, seen) > 0.6) return false;
          }
          return true;
        });
        if (newCmds.length > 0) {
          const cmdFile = join(LOGS_DIR, `${safeId}.cmd.log`);
          const entries = newCmds.map(c => `[${ts}] ${c}`).join('\n');
          try { appendFileSync(cmdFile, entries + '\n'); } catch {}
          seenList.push(...newCmds);
          // 限制大小
          if (seenList.length > 500) {
            _seenCmds.set(safeId, seenList.slice(-300));
          }
        }
      }

      // 写入输出文件（用行哈希缓冲去重，避免相同内容反复写入）
      if (output.length > 0 && !skipOut) {
        let hashSet = _writtenHashes.get(safeId);
        if (!hashSet) { hashSet = new Set(); _writtenHashes.set(safeId, hashSet); }
        const newOutput = output.filter(l => {
          if (!l.trim()) return false;
          const h = simpleHash(l);
          if (hashSet.has(h)) return false;
          hashSet.add(h);
          return true;
        });
        if (newOutput.length > 0) {
          const outFile = join(LOGS_DIR, `${safeId}.out.log`);
          try { appendFileSync(outFile, `\n[${ts}]\n${newOutput.join('\n')}\n`); } catch {}
        }
        // 限制哈希缓冲大小
        if (hashSet.size > 2000) {
          const arr = [...hashSet];
          _writtenHashes.set(safeId, new Set(arr.slice(-1000)));
        }
      }
    }

    // 缓存当前完整行（保留最后 80 行用于下次比对）
    _markerCache.set(safeId, currLines.slice(-80));
  }

  if (changed) { markIndexDirty(); scheduleIndexFlush(); }

  // 清理不再活跃的窗口缓存（只保留本次传入的窗口）
  if (_markerCache.size > windowsData.length + 5) {
    const activeIds = new Set(windowsData.map(w => String(w.windowId).replace(/[^a-zA-Z0-9_-]/g, '_')));
    for (const id of _markerCache.keys()) {
      if (!activeIds.has(id)) { _markerCache.delete(id); _seenCmds.delete(id); _writtenHashes.delete(id); }
    }
  }
}

/**
 * 记录一次终端快照（单窗口，兼容旧接口）
 */
export function recordSnapshot(windowId, windowName, content, label) {
  recordSnapshots([{ windowId, windowName, content, label }]);
}

/**
 * 搜索所有日志
 */
export async function searchLogs(keyword) {
  ensureDir();
  const index = loadIndex();
  const entries = Object.values(index);

  if (entries.length === 0) {
    console.log('暂无记录。先运行 temine watch 开始记录。');
    return;
  }

  console.log(`搜索 "${keyword}"...\n`);

  let totalMatches = 0;

  for (const entry of entries) {
    // 搜索输出文件和命令文件
    const filesToSearch = [
      entry.outFile || entry.logFile,
      entry.cmdFile,
    ].filter(Boolean);

    for (const fname of filesToSearch) {
      const fpath = join(LOGS_DIR, fname);
      if (!existsSync(fpath)) continue;

      const content = readFileSync(fpath, 'utf-8');
      const lines = content.split('\n');
      const matches = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(keyword.toLowerCase())) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length - 1, i + 1);
          const context = lines.slice(start, end + 1).join('\n');
          matches.push({ line: i + 1, context });
        }
      }

      if (matches.length > 0) {
        const label = entry.label || entry.windowName || entry.id;
        const fileType = fname.endsWith('.cmd.log') ? '命令' : '输出';
        console.log(`📁 ${label} [${fileType}] (ID: ${entry.id}) - ${matches.length} 处匹配`);
        console.log('-'.repeat(60));

        for (const m of matches.slice(0, 10)) {
          const highlighted = m.context.replace(
            new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
            (match) => `\x1b[43m\x1b[30m${match}\x1b[0m`
          );
          console.log(`  行 ${m.line}:`);
          console.log(`  ${highlighted}`);
          console.log();
        }

        if (matches.length > 10) {
          console.log(`  ... 还有 ${matches.length - 10} 处匹配\n`);
        }

        totalMatches += matches.length;
      }
    }
  }

  if (totalMatches === 0) {
    console.log('未找到匹配结果');
  } else {
    console.log(`共找到 ${totalMatches} 处匹配`);
  }
}

/**
 * 显示时间线 / 列出会话
 */
export async function showTimeline(windowId, lines) {
  ensureDir();
  const index = loadIndex();

  if (!windowId) {
    const entries = Object.values(index);
    if (entries.length === 0) {
      console.log('暂无记录。先运行 temine watch 开始记录。');
      return;
    }

    console.log('记录的会话:\n');
    console.log('  ID              标签            最后更新');
    console.log('  --------------  --------------  --------------------');

    for (const entry of entries.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const label = (entry.label || '').padEnd(14);
      const time = new Date(entry.updatedAt).toLocaleString('zh-CN');
      console.log(`  ${entry.id.padEnd(14)}  ${label}  ${time}`);
    }

    console.log(`\n用 temine log show <ID> 查看详细输出`);
    return;
  }

  const entry = index[windowId];
  if (!entry) {
    console.log(`未找到 ID 为 "${windowId}" 的会话`);
    console.log('运行 temine log list 查看可用会话');
    return;
  }

  // 显示输出日志
  const outFile = join(LOGS_DIR, entry.outFile || entry.logFile);
  const cmdFile = join(LOGS_DIR, entry.cmdFile || '');

  const label = entry.label || entry.windowName || entry.id;
  console.log(`📁 ${label} (ID: ${entry.id})`);
  console.log(`   创建: ${new Date(entry.createdAt).toLocaleString('zh-CN')}`);
  console.log(`   更新: ${new Date(entry.updatedAt).toLocaleString('zh-CN')}`);

  // 先显示命令记录
  if (cmdFile && existsSync(cmdFile)) {
    const cmdContent = readFileSync(cmdFile, 'utf-8').trim();
    if (cmdContent) {
      console.log('\n  == 命令记录 ==');
      const cmdLines = cmdContent.split('\n');
      const showCmds = lines > 0 ? cmdLines.slice(-lines) : cmdLines;
      console.log(showCmds.join('\n'));
    }
  }

  // 再显示输出记录
  if (existsSync(outFile)) {
    console.log('\n  == 输出记录 ==');
    const content = readFileSync(outFile, 'utf-8');
    const allLines = content.split('\n');
    const displayLines = lines > 0 ? allLines.slice(-lines) : allLines;
    console.log(displayLines.join('\n'));
  } else {
    console.log('\n暂无输出记录');
  }
}

/**
 * 清空所有日志记录
 */
export function clearAllLogs() {
  ensureDir();
  try {
    const files = readdirSync(LOGS_DIR);
    let count = 0;
    for (const f of files) {
      try { unlinkSync(join(LOGS_DIR, f)); count++; } catch {}
    }
    // 清空内存缓存
    _indexCache = null;
    _indexDirty = false;
    _markerCache.clear();
    _seenCmds.clear();
    _writtenHashes.clear();
    return count;
  } catch { return 0; }
}

/**
 * 导出日志到文件
 */
export async function exportLog(windowId, outFile) {
  ensureDir();
  const index = loadIndex();

  if (!windowId) {
    console.log('用法: temine log export <窗口ID> [输出文件]');
    return;
  }

  const entry = index[windowId];
  if (!entry) {
    console.log(`未找到 ID 为 "${windowId}" 的会话`);
    return;
  }

  // 合并命令和输出导出
  let combined = '';
  const cmdPath = join(LOGS_DIR, entry.cmdFile || '');
  const outPath = join(LOGS_DIR, entry.outFile || entry.logFile);

  if (cmdPath && existsSync(cmdPath)) {
    combined += '=== 命令记录 ===\n' + readFileSync(cmdPath, 'utf-8') + '\n\n';
  }
  if (existsSync(outPath)) {
    combined += '=== 输出记录 ===\n' + readFileSync(outPath, 'utf-8');
  }

  if (!combined.trim()) {
    console.log('无内容可导出');
    return;
  }

  const outputPath = outFile || `temine-${windowId}-${Date.now()}.log`;
  writeFileSync(outputPath, combined);
  console.log(`✅ 已导出到 ${outputPath} (${(combined.length / 1024).toFixed(1)} KB)`);
}
