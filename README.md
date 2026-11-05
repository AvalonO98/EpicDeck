# EpicDeck

**在 Steam Deck 游戏模式里玩 Epic 库里的游戏。**

[Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) 插件：登录 Epic、浏览库、下载安装、点开就玩，并自动把游戏写进 Steam 库——带封面图标，Windows 游戏由 Proton 运行。不需要 Epic 客户端，不用回桌面模式，不用手配 wine。

`0.9.0` · BSD-3-Clause · SteamOS / Steam Deck · Python + Legendary

## English

A Decky Loader plugin that brings your Epic library into Steam Deck's Game Mode: Epic sign-in inside
Steam's browser, library browsing, downloads with pause/resume, Proton for Windows titles, and
non-Steam entries with box art.

- **Sign-in** — web login in Steam's built-in browser; the authorization code is captured for you.
- **Library** — filters, search, L1/R1 paging, sizes, playtime, localised titles, instant snapshot cache.
- **Downloads** — live progress, pause/resume, install-dir picker with free space, concurrency and CDN options.
- **Launching** — Proton wrapper per Windows title (GE preferred), per-game arguments, optional LSFG-VK frame-gen.
- **Steam integration** — writes `shortcuts.vdf`, fills cover/hero/icon art, restarts Steam on demand.
- **Diagnostics** — per-launch logs with credentials redacted, one-click log export.

Requires SteamOS 3.x + Decky Loader 3.x. Legendary is downloaded on first run (pinned release, SHA-256
verified) into the plugin's own runtime directory; nothing is installed system-wide.
Install from [Releases](https://github.com/AvalonO98/EpicDeck/releases) → Decky → Developer →
*Install plugin from zip*. Settings live in `~/homebrew/settings/EpicDeck`, data in
`~/homebrew/data/EpicDeck`, and only `~/homebrew/plugins/EpicDeck` is removed on uninstall.

## 功能

- **账号**：网页授权登录（二维码 / 自动取码）、昵称、登出、登录失效单独提示；换号时库与游玩时长自动切到新账号。
- **游戏库**：已安装/未安装筛选、L1/R1 翻页、搜索、排序、体积、游玩时长；Epic 缺中文名时用 Steam 商店的官方名补（不机翻），补不到就保持英文。
- **下载**：实时进度（字节/速度/ETA）、暂停续传、取消、安装目录选择（带剩余空间）、并发与 CDN 可调。
- **启动**：Windows 游戏自动套 Proton（GE 优先）、每游戏启动参数、可选 Proton 版本、小黄鸭插帧（LSFG-VK）开关。
- **Steam 集成**：写 `shortcuts.vdf`、补竖版/横版封面与图标、一键重启 Steam 刷新。
- **详情与诊断**：ProtonDB 评级、Epic 云存档手动同步、新旧版本提醒、每游戏日志（凭据脱敏）、一键导出诊断包。
- **界面**：跟随 Steam 语言（中文/English）可强制切换；库快照缓存秒开（冷抓 3.95 s → 命中 0 ms）。

## 安装与首次使用

**从 Release 装（推荐）**：下载 [最新 zip](https://github.com/AvalonO98/EpicDeck/releases) → 传进 Deck → 桌面模式 Decky → 开发者 → *Install plugin from zip*。

**从源码构建**：

```bash
git clone https://github.com/AvalonO98/EpicDeck.git && cd EpicDeck
pnpm install && pnpm build && pnpm package   # 产出 EpicDeck-v<version>.zip
```

Legendary 不用手动装：首次没检测到会显示「一键安装」，自动下载官方二进制（约 3 MB）。

首次流程：Quick Access → EpicDeck → 登录 → 选下载目录 → 安装游戏（装完自动进 Steam 库；封面没出现就用「重启 Steam 刷新游戏库」）。

Windows 游戏首次启动要初始化 Proton 前缀，**黑屏 1~2 分钟属正常**。

## 数据与卸载

| 内容 | 路径 |
|---|---|
| 插件配置 / 库快照 | `~/homebrew/settings/EpicDeck/` |
| 日志 / 导出的诊断包 | `~/homebrew/logs/EpicDeck/`、`~/epicdeck_logs/` |
| Epic token / Legendary 配置 | `~/.config/legendary/` |
| 启动脚本、Proton 包装、legendary | `~/homebrew/data/EpicDeck/{launchers,proton,bin}/` |
| 封面与图标 | `~/.local/share/Steam/userdata/<uid>/config/grid/` |
| 游戏本体 | 用户自选（默认见设置页） |

设置页「数据位置」区块列出全部路径，每行可聚焦、按 A 复制。

Decky 卸载**只删插件代码目录**，游戏、存档、登录态、安装记录、Steam 快捷方式全部保留，重装后无需重新登录；启动脚本在 `data/` 下，卸载后现有条目仍能启动。彻底清理：删 Steam 条目 → 删 `data/EpicDeck` 与 `settings/EpicDeck`。**不要删 `~/.config/legendary/`**，那等于丢登录态和安装记录。

## 架构

```
QAM / 大屏页 ──callable──▶ main.py ──子进程──▶ legendary（下载/启动）
      ▲                      │
      └──── 事件 ────────────┘  install_progress / library_patch / library_full / library_error

Steam ──▶ launchers/<app>.sh ──legendary launch --wine──▶ proton/<app>.sh ──▶ Proton ──▶ 游戏
```

- **前端** `src/`：`fullscreen.tsx` 大屏页、`qam.tsx` 面板、`store.ts` 状态与缓存、`api.ts` callable 封装、`geomnav.ts` 方向键导航、`i18n.ts` 多语言词条。
- **后端** `main.py` + `py_modules/`：`legendary.py` CLI 封装、`steam.py` 快捷方式、`proton.py` Proton 包装、`artwork.py` 封面、`title_sources.py` 中文名、`protondb.py` 兼容性评级、`update_check.py` 版本检查、`epic_api.py` 时长与元数据、`legendary_installer.py` 二进制安装、`launchshim.py` 两阶段启动（让 Steam 正确计时）。

callable 与事件以 `main.py` 顶部和 `src/api.ts` 为准，不在文档里重复罗列。

## 几个绕不开的问题

1. **用 Legendary 而非自调 Epic API**：分片下载、CDN、清单签名、断点续传都交给成熟的独立二进制。
2. **不走 device code**：授权码绑定签发它的 client，必须用 Legendary 的 client 打开授权页再兑换。
3. **Windows 游戏包一层 Proton**：SteamOS 无 wine，而 Steam 只给「目标本身是 exe」的快捷方式套兼容层——所以生成带 `STEAM_COMPAT_*` 的包装脚本再 `exec proton`。
4. **封面自己补**：Steam 不给非 Steam 条目找图，插件把 Epic 元数据的图下进 `grid/`，按图片魔数判断扩展名（设备无 Pillow）。

## 发版

`0.x` 按改动性质升位：修 bug → 补丁位，新功能 → 次版本，正式版 → `1.0.0`。push `main` 只跑构建校验，**push `v*` tag 才发 Release**（正文取自 `CHANGELOG.md`）。步骤：改 `package.json` 版本 + 补 CHANGELOG + 打 tag。详见 [CHANGELOG.md](./CHANGELOG.md)。

## 已知限制

只支持 Epic 商城游戏；下载进度解析 Legendary 的文本输出，百分比可能有偏差；新增条目后建议重启 Steam；EOS 反作弊、Epic overlay（好友/成就）、自动云存档同步暂不支持。

## 常见问题

- **一直黑屏**：首次启动在初始化 Proton 前缀，1~2 分钟正常；更久看 `~/steam-<appid>.log`。
- **封面没出现**：`grid/` 要重启 Steam 才读，用设置里的「重启 Steam 刷新游戏库」。
- **连不上 Epic**：区分网络问题与登录失效；有缓存时会继续显示旧库。
- **装完不在库里**：确认「自动添加到 Steam」开着，或详情页手动添加。
- **重装会不会丢东西**：同机重装不丢；换机器要重新登录并重装游戏。

## 安全与许可

无后端服务器，数据全在本机；只硬编码 Epic 公开客户端 ID，不含密钥；授权码不保存，只留 Legendary token；无遥测。详见 [SECURITY.md](./SECURITY.md)。

基于 [BSD 3-Clause](./LICENSE)，脚手架来自 [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template)；设计参考 [GameBridge](https://github.com/FelPikachu/GameBridge)（仅思路，未复制代码，见 [NOTICE](./NOTICE)）。运行时依赖 [Legendary](https://github.com/derrod/legendary)（GPL-3.0，独立进程调用）。

“Epic”“Steam”“Steam Deck” 为各自权利人商标；本项目与上述公司无隶属关系。使用第三方客户端访问 Epic 服务可能违反其服务条款，请自行评估风险。

相关文档：[CHANGELOG](./CHANGELOG.md) · [CONTRIBUTING](./CONTRIBUTING.md) · [SECURITY](./SECURITY.md) · [NOTICE](./NOTICE)
