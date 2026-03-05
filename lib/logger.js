/**
 * 终端输入输出记录 + 搜索
 *
 * 数据存储在 ~/.temine/logs/ 目录下
 * 每个窗口一个日志文件：<窗口ID>.log
 * 同时维护一个索引文件：index.json
 *
 * 性能优化：index 和 marker 在内存中缓存，批量写入磁盘
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
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

// 内存缓存 marker，避免每次读磁盘
const _markerCache = new Map();

/**
 * 批量记录多个窗口的快照（由 watcher 调用）
 * 比逐个调用 recordSnapshot 减少大量 IO
 */
export function recordSnapshots(windowsData) {
  ensureDir();
  const index = loadIndex();
  const now = Date.now();
  let changed = false;

  for (const { windowId, windowName, content, label } of windowsData) {
    const safeId = String(windowId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const logFile = join(LOGS_DIR, `${safeId}.log`);

    // 更新索引（内存操作）
    if (!index[safeId]) {
      index[safeId] = { id: safeId, windowName, label: label || windowName, createdAt: now, updatedAt: now, logFile: `${safeId}.log` };
      changed = true;
    }
    index[safeId].updatedAt = now;
    if (index[safeId].windowName !== windowName) { index[safeId].windowName = windowName; changed = true; }
    if (label && index[safeId].label !== label) { index[safeId].label = label; changed = true; }

    // 从内存缓存取 marker
    const previousContent = _markerCache.get(safeId) || '';

    // 找出新增内容
    let newContent = content;
    if (previousContent && content.startsWith(previousContent)) {
      newContent = content.slice(previousContent.length);
    } else if (previousContent) {
      const tail = previousContent.slice(-200);
      if (tail && content.includes(tail)) {
        const idx = content.indexOf(tail);
        newContent = content.slice(idx + tail.length);
      }
    }

    if (newContent.trim()) {
      const timestamp = new Date().toISOString();
      try { appendFileSync(logFile, `\n--- [${timestamp}] ---\n${newContent}`); } catch {}
    }

    // 更新内存缓存（不写磁盘）
    _markerCache.set(safeId, content.length > 5000 ? content.slice(-5000) : content);
  }

  if (changed) { markIndexDirty(); scheduleIndexFlush(); }
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
    const logFile = join(LOGS_DIR, entry.logFile);
    if (!existsSync(logFile)) continue;

    const content = readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    const matches = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(keyword.toLowerCase())) {
        // 取匹配行前后各 1 行作上下文
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length - 1, i + 1);
        const context = lines.slice(start, end + 1).join('\n');
        matches.push({ line: i + 1, context });
      }
    }

    if (matches.length > 0) {
      const label = entry.label || entry.windowName || entry.id;
      console.log(`📁 ${label} (ID: ${entry.id}) - ${matches.length} 处匹配`);
      console.log('─'.repeat(60));

      for (const m of matches.slice(0, 10)) {
        // 高亮关键词
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

  // 没有指定 windowId：列出所有会话
  if (!windowId) {
    const entries = Object.values(index);
    if (entries.length === 0) {
      console.log('暂无记录。先运行 temine watch 开始记录。');
      return;
    }

    console.log('记录的会话:\n');
    console.log('  ID              标签            最后更新');
    console.log('  ──────────────  ──────────────  ────────────────────');

    for (const entry of entries.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const label = (entry.label || '').padEnd(14);
      const time = new Date(entry.updatedAt).toLocaleString('zh-CN');
      console.log(`  ${entry.id.padEnd(14)}  ${label}  ${time}`);
    }

    console.log(`\n用 temine log show <ID> 查看详细输出`);
    return;
  }

  // 显示指定窗口的日志
  const entry = index[windowId];
  if (!entry) {
    console.log(`未找到 ID 为 "${windowId}" 的会话`);
    console.log('运行 temine log list 查看可用会话');
    return;
  }

  const logFile = join(LOGS_DIR, entry.logFile);
  if (!existsSync(logFile)) {
    console.log('日志文件不存在');
    return;
  }

  const content = readFileSync(logFile, 'utf-8');
  const allLines = content.split('\n');

  const label = entry.label || entry.windowName || entry.id;
  console.log(`📁 ${label} (ID: ${entry.id})`);
  console.log(`   创建: ${new Date(entry.createdAt).toLocaleString('zh-CN')}`);
  console.log(`   更新: ${new Date(entry.updatedAt).toLocaleString('zh-CN')}`);
  console.log('─'.repeat(60));

  // 显示最后 N 行
  const displayLines = lines > 0 ? allLines.slice(-lines) : allLines;
  console.log(displayLines.join('\n'));
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

  const logFile = join(LOGS_DIR, entry.logFile);
  if (!existsSync(logFile)) {
    console.log('日志文件不存在');
    return;
  }

  const content = readFileSync(logFile, 'utf-8');
  const outputPath = outFile || `temine-${windowId}-${Date.now()}.log`;

  writeFileSync(outputPath, content);
  console.log(`✅ 已导出到 ${outputPath} (${(content.length / 1024).toFixed(1)} KB)`);
}
