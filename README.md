# EpicDeck

一个 Steam Deck (Decky Loader) 插件:在游戏模式里登录 Epic Games、浏览游戏库、下载并启动游戏,并一键添加到 Steam 库。

## 功能

- **Epic 登录**:通过 Legendary 驱动 Epic 官方网页授权,登录后展示账号昵称
- **游戏库**:读取已购 + 已安装游戏列表,显示大小与安装状态
- **下载/启动/卸载**:实时进度条,支持取消
- **Windows 游戏走 Proton**:SteamOS 没有 `wine`,Windows 版游戏自动套一层 Steam 自带的 Proton(GF/GE 版本自动挑选)
- **Steam 集成**:把游戏注册为 Steam 非 Steam 游戏(写入 `shortcuts.vdf`),可重启 Steam 刷新,或通过 `steam://` 启动
- **封面自动补全**:把 Epic 的竖版封面/横幅/图标写进 Steam 的 `grid` 目录,非 Steam 条目不再只有灰底
- **秒开**:游戏库快照缓存在内存+磁盘(前端也缓存上次列表),打开面板立刻出内容,后台静默刷新
- **连不上有提示**:Epic 不通时显示错误卡片(网络/登录失效可区分)+「重试」;有缓存时不清空列表,只挂一条提示
- **诊断日志导出**:设置页「导出诊断日志」按钮,一键收集环境信息、登录状态、配置和插件日志,方便排错

## 架构

```
src/index.tsx         React/TS 前端(游戏模式 UI)
main.py               Python 后端(Decky 入口,暴露 callable 方法)
py_modules/config.py  插件配置持久化(JSON)
py_modules/legendary.py  Legendary CLI 封装(登录/库/下载/启动)
py_modules/steam.py   Steam shortcuts.vdf 读写 + steam:// 协议
py_modules/proton.py  Windows 游戏的 Proton 包装(生成 --wine 脚本)
py_modules/artwork.py 把 Epic 封面写进 Steam 的 grid 目录
py_modules/legendary_installer.py  Legendary 二进制自动下载(含镜像加速)
```

## 依赖

- Decky Loader(前端)
- [Legendary](https://github.com/derrod/legendary)(后端下载引擎)

**Legendary 无需手动安装**:SteamOS 没有 `pip` 且文件系统只读,`pip install legendary-gl` 无法使用。EpicDeck 已内置自动安装——首次使用若未检测到 Legendary,会在界面显示「一键安装 Legendary」按钮,自动从 GitHub Releases 下载官方独立二进制(约 3 MB,无需 Python)到用户目录。

如需手动安装(可选):

```bash
# 方式一:官方独立二进制(推荐,无需 pip)
# 从 https://github.com/derrod/legendary/releases 下载 legendary_linux_x64,
# 放到 ~/.local/bin/ 并 chmod +x

# 方式二:通过 Heroic Games Launcher(自带 legendary)
flatpak install flathub com.heroicgameslauncher.hgl
```

## 开发与构建

```bash
pnpm install
pnpm build        # 产出 dist/
pnpm watch        # 监听模式
```

### 打包为 Decky 可导入的 zip

```bash
pnpm package      # 等价于 python build_zip.py,生成 EpicDeck-v0.1.0.zip
```

打包脚本会先构建前端,再按 Decky 标准格式组装:

```
EpicDeck-v0.1.0.zip
└── EpicDeck/
    ├── dist/index.js    (必填)
    ├── package.json     (必填)
    ├── plugin.json      (必填)
    ├── main.py          (必填,Python 后端)
    ├── py_modules/      (后端模块)
    ├── README.md / LICENSE / SECURITY.md / NOTICE
    └── ...
```

### 自动发布到 GitHub Releases

仓库已配置 GitHub Actions(`.github/workflows/release.yml`)。推送一个 `v*` 标签即可自动构建并发布:

```bash
git tag v0.1.0
git push origin v0.1.0
```

CI 会自动:构建前端 → 打包 zip → 创建 Release 并附上 `EpicDeck-v0.1.0.zip`。用户可从 Release 页面下载 zip,再用下方「zip 导入」方式安装。

### 安装到 Steam Deck(zip 导入)

1. 把 `EpicDeck-v0.1.0.zip` 传到 Steam Deck(任意目录,如下载文件夹)
2. 桌面模式 → 打开 Decky Loader 菜单 → **设置(齿轮)→ 开发者(Developer)**
3. 打开「开发者模式」开关,点 **Install plugin from zip**
4. 选择 `EpicDeck-v0.1.0.zip` 完成安装
5. 回到游戏模式,Quick Access 菜单里即可看到 EpicDeck

> ⚠️ 首次使用前需安装 Legendary,见下方「依赖」章节。

## 插件 API 一览(前端 callable 对应后端方法)

| 前端 callable | 后端方法 | 说明 |
|---|---|---|
| `auth_status` | `auth_status()` | 登录状态 + 用户信息 |
| `get_login_url` | `get_login_url()` | 返回 Epic 授权码登录页地址 |
| `login_with_code` | `login_with_code(raw)` | 用授权码完成登录(可粘贴整段 JSON) |
| `login` | `login()` | 触发 Legendary 网页授权(需桌面模式) |
| `logout` | `logout()` | 删除本地 token |
| `list_games` | `list_games()` | 游戏库列表 |
| `install` | `install(app_name)` | 后台下载(事件 `install_progress`) |
| `launch` | `launch(app_name)` | 启动游戏 |
| `uninstall` | `uninstall(app_name)` | 卸载游戏 |
| `add_to_steam` | `add_to_steam(app_name)` | 生成启动脚本 + 写入 shortcuts.vdf |
| `remove_from_steam` | `remove_from_steam(app_name)` | 从 shortcuts.vdf 移除 |
| `is_in_steam` | `is_in_steam(app_name)` | 是否已添加到 Steam |
| `refresh_steam` | `refresh_steam()` | `steam://restart` 刷新库 |
| `get_proton_options` | `get_proton_options()` | 列出设备上可用的 Proton 版本 |
| `refresh_artwork` | `refresh_artwork(app_name)` | 给已在 Steam 的游戏补齐封面与图标 |
| `get_settings` / `set_setting` | 同上 | 配置读写 |

后端事件:`install_progress` (app_name, state, percent, message),state 为
`starting | downloading | done | error | cancelled`。

## 为什么不用 device code 登录

早期版本尝试过 Epic 的 device code 流程(`fortniteNewSwitchGameClient`),能拿到
token,但**最后一步必然失败**:

```
errors.com.epicgames.account.oauth.authorization_code_not_for_your_client
```

Epic 把授权码绑定到签发它的 client,而 Legendary 用自己的启动器 client
(`34a02cf8f4414e29b15921876da36f9a`)去兑换,两者不匹配。因此插件改为:
用户在该 client 的授权页登录 → 复制 `authorizationCode` → 插件调用
`legendary auth --code` 完成登录。授权码一次性有效且很快过期。

## Windows 游戏为什么需要 Proton

SteamOS 上没有 `wine`,`which wine` 是空的。Legendary 启动 Windows 游戏时会把可执行文件
交给 `wine` 运行,于是直接:

```
FileNotFoundError: [Errno 2] No such file or directory: 'wine'
```

Steam 自己那套 Proton 不会帮忙——它只对「目标本身是 Windows exe」的快捷方式套兼容层,
而这个快捷方式指向的是插件的 bash 启动脚本。

Legendary 留了个口子:`--wine` 后面的东西只是被当成「可执行命令」放在 exe 前面,
不必真的是 wine。所以插件会为每个 Windows 游戏生成一层包装:

```bash
# ~/homebrew/data/EpicDeck/proton/<app_name>.sh
unset WINEPREFIX
export STEAM_COMPAT_CLIENT_INSTALL_PATH="$HOME/.steam/steam"
export STEAM_COMPAT_DATA_PATH="$HOME/.steam/steam/steamapps/compatdata/<appid>"
exec "<Proton 目录>/proton" waitforexitandrun "$@"
```

启动脚本则改成 `legendary launch --wine <包装脚本> <app_name> "$@"`。

- 兼容层目录按 **Steam 快捷方式的 appid** 建,和库里那条目一一对应,存档在 `compatdata/<appid>/pfx`;
- 首次启动要初始化前缀,**黑屏 1~2 分钟属正常**;
- Proton 选择顺序:设置里指定 → `compatibilitytools.d` 里的 GE-Proton(版本最高)→ Steam 自带正式版;
- 可以在设置里关掉(例如改用其他包装脚本)。

## 封面图是怎么来的

Steam 不会给非 Steam 快捷方式自动找图,插件的做法是把 Epic 库元数据里的图下载到
`userdata/<uid>/config/grid/`:

| 文件 | 来源 | 位置 |
|---|---|---|
| `<appid>p.jpg` | `DieselGameBoxTall` 1200×1600 | 库列表的竖版封面 |
| `<appid>.jpg` | `DieselGameBox` 2560×1440 | 横版胶囊 |
| `<appid>_hero.jpg` | `DieselStoreFrontWide` | 游戏详情页横幅 |
| `<appid>_icon.jpg` | `Thumbnail`(缺失时退回竖版) | 小图标,写进快捷方式的 `icon` 字段 |

不转码(设备上没有 Pillow),扩展名按图片魔数判断。写完后需要重启 Steam 才会显示。
若想手动换图,已装 `decky-steamgriddb` 的话也可以用它。

## 已知限制与待办

- **下载进度解析**:依赖 Legendary 输出的 `Progress: xx%` 文本格式,版本差异可能导致进度条不准(不影响实际下载)
- **shortcuts.vdf 并发写**:Steam 运行时会持有该文件,添加后需重启 Steam 才稳定生效,插件已通过 `steam://restart` 提示
- **未实现**:下载断点续传状态展示、多账号切换

## 安全与隐私

本项目**不包含后端服务器**,所有数据存储在本地。详见 [SECURITY.md](./SECURITY.md)。

要点:
- 插件只硬编码 Epic 的**公开客户端 ID**(`34a02cf8...`),不含任何密钥。
- 登录用的授权码由你从 Epic 页面复制,一次性有效,插件不保存。
- Epic 登录 token 由 Legendary 存储在本地配置目录,不会提交到 Git。

## 参考项目

- [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) — 插件脚手架
- [Legendary](https://github.com/derrod/legendary) — Epic 命令行客户端
- [EpicResearch](https://github.com/MixV2/EpicResearch) — Epic OAuth/API 研究

## 开源协议

本项目基于 [BSD 3-Clause License](./LICENSE) 开源。

相关文档:

- [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献指南(如何提 issue、贡献代码、开发规范)
- [SECURITY.md](./SECURITY.md) — 安全与隐私说明(认证凭据、用户数据存储)
- [NOTICE](./NOTICE) — 第三方版权与许可声明(上游项目、依赖、商标)

### 商标与免责声明

"Epic"、"Epic Games" 为 Epic Games, Inc. 的商标;"Steam"、"Steam Deck" 为 Valve Corporation 的商标。本项目为社区开源项目,与上述公司无隶属、赞助或背书关系,使用前请自行评估并遵守相关服务条款。
