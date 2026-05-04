#!/usr/bin/env bash
# 中文註解：Cursor stop 事件後呼叫；無開關檔時 ship-git.js --hook 會立刻結束
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
cat >/dev/null
node ship-git.js --hook
echo '{}'
