/**
 * 配置文件管理
 * 配置文件位于 ~/.temine/config.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = join(homedir(), '.temine');
const CONFIG_FILE = join(STATE_DIR, 'config.json');

// 默认配置
const DEFAULTS = {
  watch: {
    interval: 2000,           // 轮询间隔（毫秒），降低 CPU 和 AppleScript 压力
    contentLength: 2000,      // 抓取终端内容长度
  },
  notification: {
    enabled: true,
    cooldown: 15000,          // 通知冷却时间（毫秒）
    sound: 'Glass',           // macOS 通知声音
    persistentAlert: true,    // 等待确认时持续提醒
  },
  terminal: {
    app: 'Terminal',          // 默认终端应用
    gap: 10,                  // 窗口间距
    menuBarHeight: 25,
    dockHeight: 70,
  },
  log: {
    maxAgeDays: 30,           // 日志保留天数
  },
};

function ensureDir() {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

/**
 * 深度合并（用户配置覆盖默认值）
 */
function deepMerge(target, source) {
  const result = { ...source };
  for (const key of Object.keys(target)) {
    if (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
        && source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = target[key];
    }
  }
  return result;
}

/**
 * 加载配置（合并默认值）
 */
export function loadConfig() {
  try {
    const userConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return deepMerge(userConfig, DEFAULTS);
  } catch {
    return { ...JSON.parse(JSON.stringify(DEFAULTS)) };
  }
}

/**
 * 保存配置
 */
export function saveConfig(config) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * 获取单个配置值（支持点号路径）
 */
export function getConfigValue(path) {
  const config = loadConfig();
  return path.split('.').reduce((obj, key) => obj?.[key], config);
}

/**
 * 设置单个配置值
 */
export function setConfigValue(path, value) {
  const config = loadConfig();
  const keys = path.split('.');
  let obj = config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') {
      obj[keys[i]] = {};
    }
    obj = obj[keys[i]];
  }
  if (value === 'true') value = true;
  else if (value === 'false') value = false;
  else if (!isNaN(value) && value !== '') value = Number(value);

  obj[keys[keys.length - 1]] = value;
  saveConfig(config);
  return config;
}

/**
 * 显示配置
 */
export function showConfig() {
  const config = loadConfig();
  console.log('当前配置 (~/.temine/config.json):\n');
  console.log(JSON.stringify(config, null, 2));
  console.log('\n修改配置:');
  console.log('  temine config set <key> <value>');
  console.log('  示例: temine config set watch.interval 500');
  console.log('  示例: temine config set notification.cooldown 10000');
}

/**
 * 重置为默认配置
 */
export function resetConfig() {
  saveConfig(DEFAULTS);
  console.log('✅ 配置已重置为默认值');
}

export { DEFAULTS };
