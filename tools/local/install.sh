#!/usr/bin/env bash
# 从 fork 的最新 release 下载 MxPage 加固版并安装到 /Applications。
#
#   bash install.sh            # 自动找最新 release 的 arm64 zip
#   bash install.sh <url|path> # 用指定的 zip / 本地文件
set -euo pipefail

REPO="yzj160212/MxPage"
PRODUCT="MxPage"
BUNDLE="$PRODUCT.app"
APP_DIR="/Applications"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mxpage-install-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

SOURCE="${1:-}"
if [ -z "$SOURCE" ]; then
  echo "==> 查询 $REPO 最新 release"
  URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | python3 -c 'import json,sys
d = json.load(sys.stdin)
assets = [a["browser_download_url"] for a in d.get("assets", []) if a["name"].endswith("-macos-arm64.zip")]
print(assets[0] if assets else "")')"
  if [ -z "$URL" ]; then
    echo "错误：最新 release 里没有 arm64 zip 资产。" >&2
    echo "      可以先在 fork 里手动跑一次 local-build workflow。" >&2
    exit 1
  fi
  SOURCE="$URL"
fi

if [ -f "$SOURCE" ]; then
  echo "==> 使用本地文件 $SOURCE"
  cp "$SOURCE" "$TMP/app.zip"
else
  echo "==> 下载 $SOURCE"
  curl -fL --progress-bar "$SOURCE" -o "$TMP/app.zip"
fi

echo "==> 解压"
ditto -x -k "$TMP/app.zip" "$TMP/out"
APP="$(find "$TMP/out" -maxdepth 3 -name "$BUNDLE" -type d | head -1)"
if [ -z "$APP" ]; then
  echo "错误：压缩包里找不到 $BUNDLE" >&2
  exit 1
fi

echo "==> 退出正在运行的 $PRODUCT"
osascript -e "quit app \"$PRODUCT\"" >/dev/null 2>&1 || true
pkill -x "$PRODUCT" >/dev/null 2>&1 || true
sleep 1

if [ -e "$APP_DIR/$BUNDLE" ]; then
  echo "==> 旧版本移到废纸篓"
  if command -v trash >/dev/null 2>&1; then
    trash "$APP_DIR/$BUNDLE"
  else
    rm -rf "$APP_DIR/$BUNDLE"
  fi
fi

echo "==> 安装到 $APP_DIR/$BUNDLE"
if ! ditto "$APP" "$APP_DIR/$BUNDLE" 2>/dev/null; then
  echo "   普通权限不够，改用 sudo：" >&2
  sudo ditto "$APP" "$APP_DIR/$BUNDLE"
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP_DIR/$BUNDLE/Contents/Info.plist" 2>/dev/null || echo unknown)"
echo "==> 已安装 $PRODUCT $VERSION ($(lipo -archs "$APP_DIR/$BUNDLE/Contents/MacOS/$PRODUCT" 2>/dev/null || echo unknown))"

if xattr -p com.apple.quarantine "$APP_DIR/$BUNDLE" >/dev/null 2>&1; then
  read -r -p "检测到下载隔离标记，是否清除以便直接打开？[y/N] " answer
  case "$answer" in
    y|Y) xattr -dr com.apple.quarantine "$APP_DIR/$BUNDLE"; echo "   已清除" ;;
    *) echo "   保留标记（首次打开需要右键 → 打开，或在系统设置里放行）" ;;
  esac
fi

echo "==> 启动"
open -a "$APP_DIR/$BUNDLE"