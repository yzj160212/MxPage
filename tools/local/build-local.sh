#!/usr/bin/env bash
# 构建 MxPage 的 arm64 桌面包（本机与 CI 共用）。
#
# 前置：Node 24（项目的 engines 是 >=24 <25）、npm ci 已装依赖。
# 产出：dist-desktop/MxPage-<version>-macos-arm64.zip
set -euo pipefail

cd "$(dirname "$0")/../.."

# 本机装了 keg-only 的 node@24 时优先用它；CI 里由 setup-node 提供，这里不会命中。
if [ -x /opt/homebrew/opt/node@24/bin/node ]; then
  case ":$PATH:" in
    *":/opt/homebrew/opt/node@24/bin:"*) ;;
    *) export PATH="/opt/homebrew/opt/node@24/bin:$PATH" ;;
  esac
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "24" ]; then
  echo "警告: 项目要求 Node 24，当前为 $(node -v)。Next 14 在更新的 Node 上可能构建失败。" >&2
fi

export NEXT_TELEMETRY_DISABLED=1
export CSC_IDENTITY_AUTO_DISCOVERY=false
# 构建用的数据库放到仓库外，避免把 *.db 留在工作区。
BUILD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/mxpage-build-XXXXXX")"
trap 'rm -rf "$BUILD_TMP"' EXIT
export DATABASE_URL="file:${BUILD_TMP}/build.db"
export APP_SECRET="${APP_SECRET:-isolated-release-build-secret}"
export STORAGE_ROOT="${BUILD_TMP}/storage"

if [ ! -d node_modules ]; then
  echo "==> npm ci"
  npm ci --no-audit --no-fund
fi

# 必须先清掉上一次的产物：electron-builder 会把已存在的 dist-desktop（它自己的输出目录）
# 当成打包源，把上一版 app 嵌套进 .next-desktop/standalone，随后 codesign 会失败。
if [ -d dist-desktop ] || [ -d .next-desktop ]; then
  echo "==> 清理上次的构建产物"
  rm -rf dist-desktop .next-desktop
fi

echo "==> 数据库迁移"
npm run prisma:migrate

echo "==> 桌面控制驱动检查"
npm run check:agent-driver

echo "==> 类型检查与单元测试"
npm run typecheck
npm test

echo "==> 组装桌面包"
npm run build:desktop

echo "==> 打包 arm64 zip"
# osx-sign 会并发扫描未解包的 Node 依赖，需要放宽文件句柄上限。
ulimit -n 65536 2>/dev/null || true
npx --no-install electron-builder --mac zip --arm64 --publish never

ls -lh dist-desktop/*.zip