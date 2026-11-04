# EpicDeck

**在 Steam Deck 的游戏模式里,玩你 Epic 库里的游戏。**

EpicDeck 是一个 [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) 插件:登录 Epic 账号、浏览你自己的游戏库、下载安装、点一下就能玩,并且会自动把这些游戏变成 Steam 库里的一个条目——带封面、带图标、Windows 游戏由 Proton 跑起来。

不需要装 Epic 客户端,不需要退到桌面模式,不需要手动配 wine。

**当前版本 `0.8.6`** · BSD-3-Clause · SteamOS / Steam Deck · Python + Legendary

---

## 目录

- [为什么做这个](#为什么做这个)
- [功能](#功能)
- [安装](#安装)
- [第一次使用](#第一次使用)
- [日常怎么用](#日常怎么用)
- [数据放在哪](#数据放在哪)
- [架构](#架构)
- [几个绕不开的技术问题](#几个绕不开的技术问题)
- [开发与调试](#开发与调试)
- [版本号与发布](#版本号与发布)
- [已知限制与路线图](#已知限制与路线图)
- [常见问题](#常见问题)
- [安全与隐私](#安全与隐私)
- [贡献](#贡献)
- [开源协议](#开源协议)

---

## 为什么做这个

Epic 没有 Linux 客户端。想在 Steam Deck 上玩 Epic 的游戏,现有方案各有各的别扭:

| 方案 | 问题 |
|---|---|
| Epic 客户端 + wine | 要自己配前缀,游戏模式里几乎没法用 |
| Heroic Games Launcher | 桌面应用,游戏模式下体验割裂,要在两个界面之间来回切 |
| 手动 legendary + 手写脚本 | 能跑,但每个游戏都要手写启动脚本、自己找封面、自己算 appid |

EpicDeck 是把第三种的活干完,再把入口塞进游戏模式:所有操作都在 Quick Access 菜单(右侧那个 `···` 面板)里完成,下完的游戏直接出现在 Steam 库里,和原生游戏一样点开始。

底层下载/安装/启动交给 [Legendary](https://github.com/derrod/legendary)(成熟的 Epic 命令行客户端),EpicDeck 负责界面、Steam 集成和 Linux 上的适配。

---

## 功能

**账号**
- 网页授权登录 Epic,支持二维码 / 自动取授权码(不用手抄一长串 code)
- 显示账号昵称,支持登出;登录状态失效会单独提示

**游戏库**
- 读取账号下全部游戏,区分「已安装 / 未安装」,L1 / R1 肩键翻页
- 本地化标题、安装体积、游玩时长(后台补齐,不阻塞打开面板)
- 搜索、按名称/体积/添加时间排序

**下载与安装**
- 实时进度条、速度、剩余时间,支持取消
- 可选安装目录(内置磁盘列表 + 剩余空间)
- 装完自动加进 Steam 库

**启动**
- Windows 游戏自动套 Steam 自带的 Proton(GE-Proton 优先),实机验证可玩
- 每个游戏可以单独填启动参数,参数会写进 Steam 启动脚本,从库里点也开始生效
- 首选 Proton 版本可在设置里指定

**Steam 集成**
- 写入 `shortcuts.vdf`,注册为非 Steam 游戏
- 自动写入竖版封面 / 横版胶囊 / 详情页横幅 / 图标到 Steam 的 `grid` 目录
- 一键「重启 Steam 刷新游戏库」,也支持 `steam://` 直接拉起

**体验**
- **秒开**:游戏库快照缓存在内存 + 磁盘,打开面板立即出内容,后台静默刷新(实测冷抓取 3.95 s → 缓存命中 0 ms)
- **断开也有提示**:Epic 连不上时区分「网络问题」和「登录失效」,给建议 + 重试;有缓存时不清空列表
- 一键导出诊断日志(环境、登录状态、配置、插件日志打包)

---

## 安装

### 方式一:从 Release 装(推荐)

1. 到 [Releases](https://github.com/AvalonO98/EpicDeck/releases) 下载最新的 `EpicDeck-vX.Y.Z.zip`
2. 把 zip 传到 Steam Deck(任意目录,例如「下载」)
3. **桌面模式** → Decky Loader 菜单(齿轮)→ **开发者 / Developer** → 打开开发者模式
4. 点 **Install plugin from zip**,选择刚才的 zip
5. 回游戏模式,按 `···` 打开 Quick Access,就能看到 EpicDeck

> Legendary **不需要手动装**。首次使用若没检测到,面板里会出现「一键安装 Legendary」,会自动下载官方独立二进制(约 3 MB)到用户目录。

### 方式二:从源码构建

```bash
git clone https://github.com/AvalonO98/EpicDeck.git
cd EpicDeck
pnpm install
pnpm build          # 产出 dist/
pnpm package        # 打包成 EpicDeck-v<version>.zip
```

然后把生成的 zip 按上面第 3~5 步导入。

---

## 第一次使用

1. 打开 Quick Access → EpicDeck
2. 点「登录」,按提示在 Epic 授权页登录;插件会自动取回授权码并完成登录
   (取不到时可以把授权码粘贴进来,支持整段 JSON)
3. 选一个下载目录(会列出各磁盘剩余空间)
4. 在库里挑游戏 → 「安装」→ 看进度条
5. 装完自动进 Steam 库;若封面没显示,用设置里的「重启 Steam 刷新游戏库」

---

## 日常怎么用

- **库里点开始**:和原生 Steam 游戏一样。第一次启动 Windows 游戏会初始化 Proton 前缀,**黑屏 1~2 分钟是正常的**,之后就快了。
- **改启动参数**:进游戏详情页 → 启动参数,填一次即可,Steam 快捷方式会跟着更新。
- **不想用 Proton**:设置里可以关掉,或指定某个 Proton 版本(比如某个游戏在 GE 上更好)。
- **换封面**:设置里「补齐封面与图标」会重下一遍;也兼容 `decky-steamgriddb` 手动换图。
- **换下载目录**:设置 → 安装目录,只影响之后的新安装。
- **出问题时**:设置 → 「导出诊断日志」,把生成的 zip 发给 issue。

---

## 数据放在哪

| 内容 | 路径 |
|---|---|
| 插件配置 | `~/homebrew/settings/EpicDeck/epicdeck.json` |
| 游戏库快照(秒开用) | `~/homebrew/settings/EpicDeck/library.json` |
| 插件日志 | `~/homebrew/logs/EpicDeck/*.log` |
| Epic 登录 token / Legendary 配置 | `~/.config/legendary/` |
| 游戏安装目录 | 用户自选(默认见设置页) |
| Steam 启动脚本 | `~/homebrew/data/EpicDeck/launchers/<app_name>.sh` |
| Proton 包装脚本 | `~/homebrew/data/EpicDeck/proton/<app_name>.sh` |
| 封面图 / 图标 | `~/.local/share/Steam/userdata/<uid>/config/grid/` |

卸载插件不会删游戏,但这些脚本和配置需要手动清理。

---

## 架构

```
src/index.tsx                  插件入口(注册 QAM 面板 + 全屏路由)
  api.ts                       后端 callable 的类型化封装
  store.ts                     全局状态与库缓存(QAM / 大屏共用)
  components.tsx               通用组件:封面、滚动容器、按钮、焦点样式
  login.tsx                    登录流程(自动取授权码)
  qam.tsx                      侧边栏 QAM 面板(启动器 + 实时状态)
  fullscreen.tsx               全屏大屏页:库 / 下载 / 设置 / 详情
  geomnav.ts                   方向键几何导航(自研,接管摇杆/十字键)
  viewport.ts                  按页面元素真实尺寸算缩放与列数
  steammenu.tsx                STEAM 菜单入口注入(见下方已知问题)
  routes.ts                    路由常量
main.py                        Decky 插件入口,暴露 @callable 方法 + 事件
py_modules/
  config.py                    配置持久化(JSON,原子写)
  legendary.py                 Legendary CLI 封装:登录 / 库 / 下载 / 启动 / 卸载
  legendary_installer.py       Legendary 二进制自动下载(含镜像加速)
  steam.py                     shortcuts.vdf 二进制读写 + appid 算法 + steam:// 协议
  proton.py                    Windows 游戏的 Proton 包装脚本
  artwork.py                   下载 Epic 封面并写入 Steam grid 目录
  epic_api.py                  Epic 官方接口(游玩时长等)
  paths.py                     安装目录解析、磁盘列表、剩余空间
  clipboard.py                 ctypes 直连 libX11 读剪贴板
  xkey.py                      XTest 注入 Ctrl+A/Ctrl+C(自动取授权码用)
```

数据流向:

```
QAM 面板 / 全屏大屏页 ──callable──▶  main.py  ──子进程──▶  legendary (下载/启动)
        ▲                             │
        └──── 事件 ───────────────────┘  install_progress / library_patch / library_full / library_error

Steam ──启动──▶ launchers/<app>.sh ──legendary launch --wine──▶ proton/<app>.sh ──▶ Proton ──▶ 游戏
```

**后端 callable**(前端 `callable("name")` 对应后端同名方法):

`auth_status` `login` `get_login_url` `login_with_code` `begin_login` `login_poll` `cancel_login` `logout`
`list_games` `install` `cancel_install` `launch` `uninstall` `get_game_size`
`add_to_steam` `remove_from_steam` `is_in_steam` `sync_installed_to_steam` `refresh_steam` `launch_steam_game`
`get_settings` `set_setting` `get_install_dir_options` `resolve_install_dir` `complete_first_run`
`get_launch_args` `set_launch_args` `get_proton_options` `refresh_artwork`
`check_environment` `install_legendary` `get_legendary_version` `export_logs`

**事件**:`install_progress(app_name, state, percent, message, speed, eta)`、
`library_patch(patch, remaining)`、`library_full(games)`、`library_error(message, kind)`。
`state` 取值 `starting | downloading | done | error | cancelled`,非下载阶段(校验、补丁)的 `percent` 为 `-1`;`kind` 取值 `network | auth | unknown`。

---

## 几个绕不开的技术问题

这几条都是踩过坑之后定下来的,细节写在代码注释里。

**1. 为什么用 Legendary 而不是自己调 Epic API**
下载要处理分片、CDN、清单签名、断点续传,Legendary 已经做得很稳。EpicDeck 只做 UI 和 Linux/Steam 适配,不重复造轮子。Legendary 以独立二进制运行,与本项目进程隔离,它以 GPL-3.0 分发、不在本仓库内。

**2. 为什么不用 device code 登录**
试过 Epic 的 device code 流程,能拿到 token,但最后一步必然失败:
`errors.com.epicgames.account.oauth.authorization_code_not_for_your_client`。
授权码绑定了签发它的 client,而 Legendary 用自己的启动器 client 去兑换,对不上。所以走「用 Legendary 的 client 打开授权页 → 取回 `authorizationCode` → `legendary auth --code`」这条路。

**3. 为什么 Windows 游戏要额外包一层 Proton**
SteamOS 上没有 `wine`,Legendary 直接把 exe 交给 wine 会 `FileNotFoundError`。而 Steam 只对「目标本身就是 Windows exe」的快捷方式套 Proton,我们的快捷方式指向的是 bash 脚本,不会自动生效。
Legendary 的 `--wine` 参数后面其实只是「拼在 exe 前面的可执行命令」,不必真是 wine——于是为每个 Windows 游戏生成一个包装脚本,里面设好 `STEAM_COMPAT_*` 再 `exec proton waitforexitandrun "$@"`,由 Steam 自带的 Proton 执行。

**4. 封面图从哪来**
Steam 不会给非 Steam 条目找图。插件把 Epic 库元数据里的图直接下载进 `userdata/<uid>/config/grid/`:
`<appid>p.jpg`(竖版)、`<appid>.jpg`(横版)、`<appid>_hero.jpg`(详情页横幅)、`<appid>_icon.jpg`(图标)。
设备上没 Pillow,所以不转码,扩展名靠图片魔数判断;只补缺失的槽位,同一张图被两个槽位复用只下一次。

**5. 为什么打开面板原来要等 5 秒**
Decky 关闭 QAM 时会卸载内容组件,重开就要重新跑 `legendary list`(实测 3.95 s)+ 一次游玩时长请求(最长等 15 s)。现在后端保留库快照(内存 + `library.json`,版本号校验),打开即返回,过期先给旧数据再由后台 `library_full` 覆盖;前端也缓存上次渲染的列表,连 UI 重载都能秒出。

---

## 开发与调试

**目录结构**（根目录只放插件运行必需的文件 + 文档,其余归到子目录):

```
src/               前端 TypeScript(QAM 面板 + 全屏大屏页)
py_modules/        Python 后端模块(legendary / steam / proton / artwork …)
scripts/           构建、打包、部署脚本
assets/            图标等静态资源
main.py            Decky 插件入口(必须在根目录)
plugin.json        插件清单(必须在根目录)
package.json       依赖与版本号(必须在根目录)
decky.pyi          decky 模块的类型存根(供编辑器识别)
.github/           CI:push 到 main 只做构建校验,打 v* tag 才发 Release
```

```bash
pnpm install
pnpm build          # rollup 打包到 dist/
pnpm watch          # 监听
pnpm package        # scripts/build_zip.py:构建 + 组装 Decky 可导入的 zip
```

部署到 Deck(开发时用的方式,需要 SSH):

```bash
# 脚本都在 scripts/ 下
./scripts/deploy.sh                                  # 在 Deck 上跑
./scripts/deploy_from_windows.bat <Deck_IP>          # 在 Windows 上跑(.ps1 同)
ssh deck@steamdeck.local 'sudo systemctl restart plugin_loader'
```

调试要点:

- **改了 `package.json` 的 version,Decky 才会重新加载插件**;只改代码不升版本可能看不到变化。
- 后端日志:`~/homebrew/logs/EpicDeck/<时间>.log`;Steam 启动链路:`~/steam-<appid>.log`(需 `PROTON_LOG=1`)。
- 面板里「导出诊断日志」比手翻日志快。

---

## 版本号与发布

本项目在 `0.x` 阶段用三段式,但含义与语义化版本不同,按**改动性质**决定升哪一位:

| 改动 | 升哪一位 | 例子 |
|---|---|---|
| 修 bug、性能优化、文案与细节 | 小版本 | `0.8.0` → `0.8.1` |
| 新增功能 | 中版本 | `0.8.1` → `0.9.0` |
| 正式发布版(功能稳定) | 大版本 | `0.9.0` → `1.0.0` |

发布由 GitHub Actions 自动完成:推一个 `v*` 标签 → 构建 → 打包 → 创建 Release(见 `.github/workflows/release.yml`)。推 `main` 只跑构建检查,不发版。

```bash
git tag v0.8.1 && git push origin refs/tags/v0.8.1
```

变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 已知限制与路线图

**限制**
- 下载进度依赖 Legendary 输出的文本格式,解析偏差只会让百分比不准,不影响实际下载
- Steam 运行时会占用 `shortcuts.vdf`,新增条目后建议重启一次 Steam 才稳定
- 只支持 Epic 商城游戏;EOS 反作弊游戏、Epic 的 overlay(好友/成就/云存档)未做支持
- 一个账号;不支持多账号切换

**下一步**
- ProtonDB 可玩性徽章(库里和面板上标注 platinum / gold / borked),调研已完成
- 断点续传状态展示
- 自动更新提醒(检测新版本 → 跳转下载)
- 上架 Decky 插件商店

---

## 常见问题

**打开游戏一直黑屏?**
Windows 游戏第一次启动在初始化 Proton 前缀,通常 1~2 分钟,期间黑屏或无响应属正常。时间明显更长时,看 `~/steam-<appid>.log`。

**封面没出现?**
写入 `grid` 目录后要重启 Steam 才会读取。设置里点「重启 Steam 刷新游戏库」,或「补齐封面与图标」。

**提示「连不上 Epic 服务器」?**
插件区分了网络问题和登录失效。网络问题检查 Wi-Fi / 代理后重试;登录失效重新登录一次即可。有缓存时会继续显示上次的库,只是标记为旧数据。

**游戏装完不在库里?**
设置里确认「自动添加到 Steam」是开的;也可以在游戏详情页手动「添加到 Steam」。

**换设备 / 重装插件会丢什么?**
配置和登录态都在 `~/homebrew/settings/EpicDeck/` 与 `~/.config/legendary/`,同一台机器上重装插件不丢;换了机器要重新登录,游戏需重新安装(或迁移安装目录)。

---

## 安全与隐私

本项目**没有后端服务器**,所有数据都在你本机。

- 只硬编码 Epic 的**公开客户端 ID**(`34a02cf8...`),不含任何密钥
- 登录用的一次性授权码不保存,只留 Legendary 的 token
- 不收集遥测,不上报日志;诊断日志由你自己决定发给谁

详见 [SECURITY.md](./SECURITY.md)。

---

## 贡献

欢迎 issue 和 PR,尤其是实机测试反馈(不同 Proton 版本、不同机型、触屏/按键体验)。
提 issue 时请附上「导出诊断日志」的结果。

提交前请确认 `pnpm build` 通过,并遵循现有代码风格(后端注释用英文,面向用户的文案用中文)。
更多见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 开源协议

本项目基于 [BSD 3-Clause License](./LICENSE) 开源,来源于 [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template)(BSD 3-Clause)。

相关文档:

- [CHANGELOG.md](./CHANGELOG.md) — 版本变更记录
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献指南
- [SECURITY.md](./SECURITY.md) — 安全与隐私说明
- [NOTICE](./NOTICE) — 第三方版权与许可声明

### 第三方组件

| 组件 | 许可 | 用途 |
|---|---|---|
| [Legendary](https://github.com/derrod/legendary) | GPL-3.0 | Epic 下载/安装/启动引擎(独立运行时依赖,不在本仓库内) |
| [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) | BSD-3-Clause | 插件脚手架与构建配置 |
| [qrcode](https://github.com/soldair/node-qrcode) | MIT | 登录页二维码 |
| [react-icons](https://github.com/react-icons/react-icons) | MIT | 界面图标 |

### 商标与免责声明

"Epic"、"Epic Games" 是 Epic Games, Inc. 的商标;"Steam"、"Steam Deck" 是 Valve Corporation 的商标。本项目是社区开源项目,与上述公司无隶属、赞助或背书关系。

使用第三方客户端访问 Epic 服务可能违反其服务条款,请自行评估风险。本软件按「现状」提供,不附带任何担保。
