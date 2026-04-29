#!/usr/bin/env bash
# 推送前安全检查 —— 基于全局规则的 7 维度检查（敏感信息 / 文件大小 / .gitignore 完整性）
# 用法：bash scripts/pre-push-check.sh
# 退出码：0 = 通过，非 0 = 拒绝推送
set -u
cd "$(dirname "$0")/.." || exit 1

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; CYN='\033[0;36m'; RST='\033[0m'
fail=0
warn=0

# ---------- 1. 待推送范围 ----------
echo -e "${CYN}[1/5] 收集待推送变更…${RST}"
remote_branch="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo '')"
if [ -z "$remote_branch" ]; then
  diff_range="HEAD"
  echo "  无 upstream，扫描整个 HEAD"
else
  diff_range="$remote_branch..HEAD"
  echo "  范围：$diff_range"
fi
files_changed="$(git diff --name-only "$diff_range" 2>/dev/null; git status --porcelain | awk '{print $2}')"
files_changed="$(echo "$files_changed" | sort -u | grep -v '^$')"
echo "$files_changed" | head -20 | sed 's/^/    /'

# ---------- 2. 敏感信息扫描 ----------
echo -e "${CYN}[2/5] 敏感信息扫描…${RST}"
SENSITIVE_PATTERNS='(password|passwd|secret|api[_-]?key|access[_-]?key|priv[_-]?key|bearer\s+[a-zA-Z0-9]|sk-[a-zA-Z0-9]{20}|ghp_[a-zA-Z0-9]{20}|ghs_[a-zA-Z0-9]{20}|gho_[a-zA-Z0-9]{20}|aws_(secret|access)_[a-z]+|jdbc:[a-z]+://|mongodb(\\+srv)?://[^[:space:]]*:[^@]+@|postgres(ql)?://[^[:space:]]*:[^@]+@|mysql://[^[:space:]]*:[^@]+@|redis://[^[:space:]]*:[^@]+@|/Users/[a-z][a-z]+/|/home/[a-z][a-z]+/|C:\\\\Users\\\\)'

# 把已 ignore 的不扫；把代码里"模式串"里出现的关键词不算（用 git diff 而非全文扫，仅扫"新增行"）
hits="$(git diff "$diff_range" -- $(echo $files_changed) 2>/dev/null | grep '^+' | grep -v '^+++' | grep -EinI "$SENSITIVE_PATTERNS" || true)"
# 排除：处理中文邮箱表达，单纯的 "password" 单词（注释/i18n string）很常见，需要更严格
strong_hits="$(echo "$hits" | grep -EinI '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|aws_(secret|access)_[a-z]+|password\s*[:=]\s*['\''"][^'\''"]+['\''"]|api[_-]?key\s*[:=]\s*['\''"][^'\''"]{8,}['\''"]|/Users/[a-z][a-z]+/[^[:space:]]|/home/[a-z][a-z]+/[^[:space:]])' || true)"
weak_hits="$(echo "$hits" | grep -v -EinI '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|aws_|password\s*[:=]|api[_-]?key\s*[:=]|/Users/|/home/)' || true)"

if [ -n "$strong_hits" ]; then
  echo -e "${RED}  ✗ 强匹配（必须人工确认）：${RST}"
  echo "$strong_hits" | head -10 | sed 's/^/    /'
  fail=1
elif [ -n "$weak_hits" ]; then
  echo -e "${YLW}  ⚠ 弱匹配（关键词出现，但无证据是真凭证）：${RST}"
  echo "$weak_hits" | head -5 | sed 's/^/    /'
  warn=1
else
  echo -e "${GRN}  ✓ 干净${RST}"
fi

# ---------- 3. 异常大/异常文件 ----------
echo -e "${CYN}[3/5] 异常文件扫描…${RST}"
big_or_bad=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ ! -f "$f" ] && continue
  size=$(wc -c < "$f" 2>/dev/null || echo 0)
  # 单文件超过 2MB 警告
  if [ "$size" -gt 2097152 ]; then
    echo -e "${YLW}  ⚠ 大文件 $(($size / 1024)) KB: $f${RST}"
    big_or_bad=1
  fi
  # 二进制扩展名（除了图标/图片资源）—— 缓存/build 类文件
  case "$f" in
    *.log|*.tmp|*.bak|*.swp|*.DS_Store|*.cache|*.pyc|*.class|*.o|*.so|*.dylib|*.dll)
      echo -e "${RED}  ✗ 不该入库的中间文件：$f${RST}"
      fail=1
      ;;
    *.zip|*.tar|*.tar.gz|*.tgz)
      echo -e "${YLW}  ⚠ 压缩包入库（确认是有意的）：$f${RST}"
      big_or_bad=1
      ;;
    node_modules/*|.vite/*|out/*|dist/*|build/*|.cache/*|coverage/*)
      echo -e "${RED}  ✗ 构建产物入库：$f${RST}"
      fail=1
      ;;
  esac
done <<< "$files_changed"
[ "$big_or_bad" -eq 0 ] && [ "$fail" -eq 0 ] && echo -e "${GRN}  ✓ 干净${RST}"
[ "$big_or_bad" -eq 1 ] && warn=1

# ---------- 4. .gitignore 完整性 ----------
echo -e "${CYN}[4/5] .gitignore 完整性…${RST}"
required_ignore=( "node_modules" ".env" ".vite" "out" "dist" )
missing=()
for ent in "${required_ignore[@]}"; do
  if [ -f .gitignore ] && grep -qE "(^|/)${ent}/?$" .gitignore; then
    :
  else
    missing+=("$ent")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo -e "${YLW}  ⚠ .gitignore 缺少：${missing[*]}${RST}"
  warn=1
else
  echo -e "${GRN}  ✓ 完整${RST}"
fi

# ---------- 5. 工作区状态 ----------
echo -e "${CYN}[5/5] 工作区杂项检查…${RST}"
# 检查是否有 .env 类文件被错误跟踪
tracked_secrets="$(git ls-files | grep -E '(\.env$|\.env\.[a-z]+$|credentials\.json$|secrets\.yml$)' || true)"
if [ -n "$tracked_secrets" ]; then
  echo -e "${RED}  ✗ 跟踪了敏感配置文件：${RST}"
  echo "$tracked_secrets" | sed 's/^/    /'
  fail=1
else
  echo -e "${GRN}  ✓ 干净${RST}"
fi

# ---------- 总结 ----------
echo ""
if [ "$fail" -ne 0 ]; then
  echo -e "${RED}❌ 拒绝推送：发现需要人工处理的问题${RST}"
  exit 1
elif [ "$warn" -ne 0 ]; then
  echo -e "${YLW}⚠️  通过但有警告，请人工确认${RST}"
  exit 0
else
  echo -e "${GRN}✅ 全部通过，可以推送${RST}"
  exit 0
fi
