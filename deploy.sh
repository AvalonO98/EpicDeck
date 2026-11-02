#!/usr/bin/env bash
# =============================================================================
# EpicDeck 部署脚本 (在 Steam Deck 上运行)
#
# 用法:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# 功能:
#   1. 检测/安装 Legendary
#   2. 安装插件文件到 Decky 插件目录
#   3. 重载 Decky Loader
#
# 前置:已开启 SSH,本脚本放在项目根目录 (epicdeck/) 下,通过 scp 传到 Steam Deck
# =============================================================================
set -euo pipefail

# ---- 配置 ---------------------------------------------------------------
PLUGIN_NAME="epicdeck"
PLUGIN_DIR="${HOME}/homebrew/plugins/${PLUGIN_NAME}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

  # 常见位置: Heroic 自带 / flatpak / pip
  for p in \
    "${HOME}/.local/bin/legendary" \
    "${HOME}/Applications/Heroic/legendary" \
    "/app/bin/legendary" \
    "/var/lib/flatpak/app/com.heroicgameslauncher.hgl/current/active/files/bin/legendary"; do
    if [ -x "$p" ]; then
      info "找到 Heroic 自带的 Legendary: $p"
      # 建立软链到 PATH
      mkdir -p "${HOME}/.local/bin"
      ln -sf "$p" "${HOME}/.local/bin/legendary"
      info "已链接到 ~/.local/bin/legendary"
      return 0
    fi
  done

  warn "未找到 Legendary,尝试通过 pip 安装..."
  if command -v pip >/dev/null 2>&1; then
    pip install --user legendary-gl
    info "Legendary 已通过 pip 安装到 ~/.local/bin/"
    return 0
  fi

  error "无法自动安装 Legendary。请手动安装:"
  echo "  方式一: pip install --user legendary-gl"
  echo "  方式二: flatpak install flathub com.heroicgameslauncher.hgl"
  exit 1
}

# ---- 2. 安装插件文件 --------------------------------------------------------
install_plugin() {
  info "创建插件目录: ${PLUGIN_DIR}"
  mkdir -p "${PLUGIN_DIR}"

  info "同步项目文件..."
  # 用 rsync 若可用,否则用 cp
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude node_modules \
      --exclude .git \
      --exclude HANDOFF.md \
      --exclude deploy.sh \
      --exclude deploy_from_windows.* \
      "${PROJECT_DIR}/" "${PLUGIN_DIR}/"
  else
    warn "rsync 不可用,改用 cp (不清除旧文件)"
    cp -r "${PROJECT_DIR}/main.py" "${PLUGIN_DIR}/"
    cp -r "${PROJECT_DIR}/py_modules" "${PLUGIN_DIR}/"
    cp -r "${PROJECT_DIR}/dist" "${PLUGIN_DIR}/"
    cp "${PROJECT_DIR}/plugin.json" "${PLUGIN_DIR}/"
    cp "${PROJECT_DIR}/package.json" "${PLUGIN_DIR}/"
  fi

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
