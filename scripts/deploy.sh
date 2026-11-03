#!/usr/bin/env bash
# =============================================================================
# EpicDeck 部署脚本 (在 Steam Deck 上运行)
#
# 用法(在仓库根目录执行):
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
#
# 功能:
#   1. 检测/安装 Legendary
#   2. 安装插件文件到 Decky 插件目录(只拷运行必需的文件)
#   3. 重载 Decky Loader
#
# 前置:已开启 SSH。脚本在 scripts/ 下,项目根目录取它的上一级,通过 scp 传到 Steam Deck
# =============================================================================
set -euo pipefail

# ---- 配置 ---------------------------------------------------------------
PLUGIN_NAME="EpicDeck"   # 必须与 plugin.json 的 name 一致,且与 Decky 下已有目录大小写相同
PLUGIN_DIR="${HOME}/homebrew/plugins/${PLUGIN_NAME}"
# 脚本在 scripts/ 下,项目根目录是它的上一级
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- 颜色 -----------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---- 1. 检测/安装 Legendary ------------------------------------------------
install_legendary() {
  if command -v legendary >/dev/null 2>&1; then
    info "Legendary 已安装: $(command -v legendary)"
    return 0
  fi

  # 常见位置: 用户目录 / Heroic 自带 / flatpak
  for p in \
    "${HOME}/.local/bin/legendary" \
    "${HOME}/homebrew/data/EpicDeck/bin/legendary" \
    "${HOME}/Applications/Heroic/legendary" \
    "/app/bin/legendary" \
    "/var/lib/flatpak/app/com.heroicgameslauncher.hgl/current/active/files/bin/legendary"; do
    if [ -x "$p" ]; then
      info "找到 Legendary: $p"
      mkdir -p "${HOME}/.local/bin"
      ln -sf "$p" "${HOME}/.local/bin/legendary"
      info "已链接到 ~/.local/bin/legendary"
      return 0
    fi
  done

  # SteamOS 无 pip,直接下载官方独立二进制
  warn "未找到 Legendary,从 GitHub Releases 下载独立二进制..."
  local ARCH
  ARCH="$(uname -m)"
  local ASSET
  case "$ARCH" in
    x86_64|amd64) ASSET="legendary_linux_x64" ;;
    aarch64|arm64) ASSET="legendary_linux_arm64" ;;
    *) error "不支持的架构: $ARCH"; exit 1 ;;
  esac

  mkdir -p "${HOME}/.local/bin"
  local URL
  URL="https://github.com/derrod/legendary/releases/latest/download/${ASSET}"
  info "下载 $URL"
  if ! curl -fL --retry 3 -o "${HOME}/.local/bin/legendary" "$URL"; then
    error "下载失败。请手动从 https://github.com/derrod/legendary/releases 下载 ${ASSET} 放到 ~/.local/bin/ 并 chmod +x"
    exit 1
  fi
  chmod +x "${HOME}/.local/bin/legendary"
  info "Legendary 已安装到 ~/.local/bin/legendary"
}

# ---- 2. 安装插件文件 --------------------------------------------------------
install_plugin() {
  info "创建插件目录: ${PLUGIN_DIR}"
  mkdir -p "${PLUGIN_DIR}"

  info "同步插件文件..."
  # 只拷插件运行必需的东西。以前是整个仓库 rsync 过去(连 src/、CI 配置、脚本都进了
  # 插件目录);SteamOS 默认没有 rsync,那条路径其实从没生效过,一直走的是下面的 cp 兜底。
  # 现在统一用显式列表,不依赖 rsync。
  mkdir -p "${PLUGIN_DIR}/dist"

  cp -f "${PROJECT_DIR}/main.py" \
        "${PROJECT_DIR}/plugin.json" \
        "${PROJECT_DIR}/package.json" "${PLUGIN_DIR}/"
  cp -f "${PROJECT_DIR}/dist/index.js" "${PLUGIN_DIR}/dist/index.js"

  # 文档:Decky 面板不读,但带上便于在设备上排查
  for f in README.md LICENSE NOTICE SECURITY.md CHANGELOG.md; do
    [ -f "${PROJECT_DIR}/$f" ] && cp -f "${PROJECT_DIR}/$f" "${PLUGIN_DIR}/"
  done

  # 目录型:先删后拷,避免旧模块残留(legendary.py 之类改名后会留下孤儿文件)
  rm -rf "${PLUGIN_DIR}/py_modules" "${PLUGIN_DIR}/assets"
  cp -r "${PROJECT_DIR}/py_modules" "${PLUGIN_DIR}/py_modules"
  [ -d "${PROJECT_DIR}/assets" ] && cp -r "${PROJECT_DIR}/assets" "${PLUGIN_DIR}/assets"

  rm -rf "${PLUGIN_DIR}/__pycache__" "${PLUGIN_DIR}/py_modules/__pycache__"

  # 清掉旧脚本误同步进插件目录的开发文件(老版本 rsync 会带进来)
  for stale in \
    src scripts .github node_modules \
    rollup.config.js tsconfig.json pnpm-lock.yaml decky.pyi HANDOFF.md
  do
    rm -rf "${PLUGIN_DIR:?}/$stale"
  done

  info "插件文件已安装到 ${PLUGIN_DIR}"
  echo "  目录内容:"
  ls -la "${PLUGIN_DIR}"
}

# ---- 3. 重载 Decky ----------------------------------------------------------
reload_decky() {
  info "重载 Decky Loader..."
  # Decky 的重载方式: 通过 systemd 重启 decky-loader 服务
  if systemctl --user list-units 2>/dev/null | grep -q decky; then
    systemctl --user restart plugin_loader.service 2>/dev/null || \
    sudo systemctl restart plugin_loader.service 2>/dev/null || \
    warn "自动重载失败,请在 Decky 菜单手动点击『重载』"
    info "已触发重载"
  else
    warn "未检测到 decky 服务,请手动在 Decky 设置里重载插件"
  fi
}

# ---- 主流程 -----------------------------------------------------------------
info "=== EpicDeck 部署开始 ==="
install_legendary
install_plugin
reload_decky
info "=== 部署完成 ==="
echo ""
info "下一步:"
echo "  1. 回到 Steam 游戏模式,打开 Decky 菜单找到 EpicDeck"
echo "  2. 若登录页提示无法弹浏览器,切到桌面模式先跑一次登录:"
echo "       legendary auth"
echo "     完成授权后,回到游戏模式即可看到已登录状态"
