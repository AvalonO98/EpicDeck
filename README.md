# EpicDeck

**在 Steam Deck 的游戏模式里,玩你 Epic 库里的游戏。**

EpicDeck 是一个 [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) 插件:登录 Epic、浏览库、下载安装、点一下就能玩,并自动把游戏变成 Steam 库里的条目——带封面图标、Windows 游戏由 Proton 跑起来。不需要 Epic 客户端,不用退桌面模式,不用手配 wine。

**当前版本 `0.8.8`** · BSD-3-Clause · SteamOS / Steam Deck · Python + Legendary

---

## 功能

- **账号**:网页授权登录(二维码 / 自动取码)、显示昵称、登出、失效单独提示
- **游戏库**:已安装/未安装区分、L1/R1 翻页、搜索、排序、本地化标题、体积、游玩时长
- **下载安装**:实时进度/速度/剩余时间、可选安装目录(带剩余空间)、装完自动进 Steam 库
- **启动**:Windows 游戏自动套 Proton(GE 优先)、每个游戏单独填启动参数、可选 Proton 版本
- **Steam 集成**:写入 `shortcuts.vdf`、自动补封面/横幅/图标、一键重启 Steam 刷新
- **体验**:库快照缓存秒开(实测冷抓取 3.95 s → 缓存命中 0 ms)、断网区分「网络/登录失效」、一键导出诊断日志、设置页「数据位置」区块(每行可聚焦、按 A 复制)

---

## 安装

**方式一:从 Release 装(推荐)** —— 到 [Releases](https://github.com/AvalonO98/EpicDeck/releases) 下载最新 `EpicDeck-vX.Y.Z.zip` → 传进 Deck → 桌面模式 Decky → 开发者 → *Install plugin from zip*。

**方式二:从源码构建**:

```bash
git clone https://github.com/AvalonO98/EpicDeck.git && cd EpicDeck
pnpm install && pnpm build && pnpm package   # 产出 EpicDeck-v<version>.zip
```

> Legendary **不需要手动装**:首次使用没检测到,面板会出现「一键安装」,自动下载官方二进制(约 3 MB)。

---

## 第一次使用

打开 Quick Access → EpicDeck → 登录(按提示授权,取不到码可粘贴) → 选下载目录 → 挑游戏「安装」→ 装完自动进 Steam 库(封面没显示就「重启 Steam 刷新游戏库」)。

---

## 日常怎么用

- **库里点开始**:和原生游戏一样。Windows 游戏首次启动初始化 Proton 前缀,**黑屏 1~2 分钟正常**。
- **改启动参数 / 换 Proton / 换封面 / 换下载目录**:进设置或游戏详情页,改完 Steam 快捷方式跟着更新。
- **出问题**:设置 → 「导出诊断日志」,把 zip 发 issue。

---

## 数据放在哪

| 内容 | 路径 |
|---|---|
| 插件配置 / 库快照 | `~/homebrew/settings/EpicDeck/` |
| 插件日志 | `~/homebrew/logs/EpicDeck/*.log` |
| Epic 登录 token / Legendary 配置 | `~/.config/legendary/` |
| 游戏安装目录 | 用户自选(默认见设置页) |
| 启动脚本 / Proton 包装 / legendary / shim | `~/homebrew/data/EpicDeck/{launchers,proton,bin}/` |
| 封面图 / 图标 | `~/.local/share/Steam/userdata/<uid>/config/grid/` |
| 导出的诊断日志 | `~/epicdeck_logs/` |

这些路径在设置页「数据位置」区块都能看到,每行可聚焦、按 A 复制。

### 卸载与重装

Decky 卸载**只删** `~/homebrew/plugins/EpicDeck/`(代码本身)。游戏本体、存档、登录态、安装记录、Steam 快捷方式**全部保留**,重装后已装游戏自动识别、不用重新登录。启动脚本放在 `data/EpicDeck/`(不在插件目录),所以**卸载后现有条目仍能正常启动**(含时长统计与日志)。

彻底清理:先删 Steam 库里对应条目,再删 `~/homebrew/data/EpicDeck` 和 `~/homebrew/settings/EpicDeck`;**`~/.config/legendary/` 不要删**,删了等于丢登录态和安装记录。

---

## 架构

```
QAM 面板 / 全屏大屏页 ──callable──▶  main.py  ──子进程──▶  legendary (下载/启动)
        ▲                             │
        └──── 事件 ───────────────────┘  install_progress / library_patch / library_full / library_error

Steam ──启动──▶ launchers/<app>.sh ──legendary launch --wine──▶ proton/<app>.sh ──▶ Proton ──▶ 游戏
```

- **前端**(`src/`):`index.tsx` 入口、`api.ts` callable 封装、`store.ts` 状态与库缓存、`qam.tsx` 面板、`fullscreen.tsx` 大屏页、`geomnav.ts` 方向键几何导航、`viewport.ts` 缩放、`login.tsx` 登录
- **后端**(`main.py` + `py_modules/`):`legendary.py`(CLI 封装)、`steam.py`(shortcuts.vdf + appid)、`proton.py`(Proton 包装)、`artwork.py`(封面)、`epic_api.py`(游玩时长)、`config.py`(配置)、`legendary_installer.py`(二进制下载)、`launchshim.py`(两阶段启动,让 Steam 正确计时)、`paths.py`(路径解析)、`clipboard.py` / `xkey.py`(登录自动取码)

后端 callable 与事件清单见源码 `main.py` 顶部与 `src/api.ts`(保持与实现同步,此处不逐条罗列)。

---

## 几个绕不开的技术问题

1. **用 Legendary 而非自调 Epic API**:下载分片、CDN、清单签名、断点续传都交给成熟的 Legendary(独立二进制,GPL-3.0,不在本仓库)。
2. **不走 device code**:授权码绑定签发 client,Legendary 用自己的 client 兑换才对得上,所以走「Legendary client 打开授权页 → 取 `authorizationCode` → `legendary auth --code`」。
3. **Windows 游戏包一层 Proton**:SteamOS 没有 wine,而 Steam 只对「目标本身是 exe」的快捷方式套 Proton;于是为每个 Windows 游戏生成 `STEAM_COMPAT_*` 包装脚本再 `exec proton waitforexitandrun`。
4. **封面自己补**:Steam 不给非 Steam 条目找图,插件把 Epic 元数据的图下进 `grid/`(竖版/横版/横幅/图标),按图片魔数判断扩展名(设备无 Pillow)。

---

## 版本号与发布

`0.x` 阶段按**改动性质**升位:修 bug/优化 → 小版本(`0.8.1`);新增功能 → 中版本(`0.9.0`);正式发布 → `1.0.0`。发版由 CI 完成:push `main` 只跑构建检查,**push `v*` tag 才发 Release**(从 CHANGELOG 抽正文)。升版本改 `package.json` 的 version + `CHANGELOG.md` 加一节 + 同步 README。变更见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 已知限制与路线图

**限制**:只支持 Epic 商城游戏;下载进度依赖 Legendary 文本解析(偏差只影响百分比);新增条目后建议重启 Steam 稳定;EOS 反作弊、Epic overlay(好友/成就/云存档)、多账号暂不支持。

**下一步**:ProtonDB 徽章(调研已完成)、断点续传状态、自动更新提醒、上架 Decky 商店。

---

## 常见问题

- **一直黑屏?** Windows 游戏首次启动初始化 Proton,1~2 分钟属正常;更久看 `~/steam-<appid>.log`。
- **封面没出现?** 写 `grid/` 后要重启 Steam 才读取;设置里「重启 Steam 刷新游戏库」或「补齐封面与图标」。
- **连不上 Epic?** 区分网络问题与登录失效,前者查 Wi-Fi/代理后重试,后者重新登录;有缓存会继续显示旧库。
- **装完不在库里?** 确认「自动添加到 Steam」开着,或游戏详情页手动「添加到 Steam」。
- **重装插件丢什么?** 同机卸载重装什么都不丢(游戏/存档/登录/安装记录都在);换机器需重新登录、重装游戏。

---

## 安全与隐私

**没有后端服务器**,所有数据在本机。只硬编码 Epic 公开客户端 ID(`34a02cf8...`),不含密钥;一次性授权码不保存,只留 Legendary token;不收集遥测、不上报日志。详见 [SECURITY.md](./SECURITY.md)。

---

## 开源协议

基于 [BSD 3-Clause License](./LICENSE),来源于 [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template)。仓库内不含 MPL-2.0 或其他 copyleft 代码;对 [GameBridge](https://github.com/FelPikachu/GameBridge) 仅借鉴设计思路、未复制源码,详见 [NOTICE](./NOTICE)。

| 组件 | 许可 | 用途 |
|---|---|---|
| [Legendary](https://github.com/derrod/legendary) | GPL-3.0 | Epic 下载/安装/启动引擎(独立运行时依赖) |
| [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) | BSD-3-Clause | 插件脚手架 |
| [qrcode](https://github.com/soldair/node-qrcode) | MIT | 登录二维码 |
| [react-icons](https://github.com/react-icons/react-icons) | MIT | 界面图标 |

设计参考 [GameBridge](https://github.com/FelPikachu/GameBridge)(MPL-2.0),仅借鉴公开设计思路与踩坑结论,未复制源码。

"Epic"、"Steam"、"Steam Deck" 为各自权利人商标;本项目为社区开源项目,与上述公司无隶属关系。使用第三方客户端访问 Epic 服务可能违反其服务条款,请自行评估风险;本软件按「现状」提供,不附带担保。

---

相关文档:[CHANGELOG.md](./CHANGELOG.md) · [CONTRIBUTING.md](./CONTRIBUTING.md) · [SECURITY.md](./SECURITY.md) · [NOTICE](./NOTICE)
