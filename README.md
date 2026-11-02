# EpicDeck

一个 Steam Deck (Decky Loader) 插件:在游戏模式里登录 Epic Games、浏览游戏库、下载并启动游戏,并一键添加到 Steam 库。

## 功能

- **Epic 登录**:通过 Legendary 驱动 Epic 官方网页授权,登录后展示账号昵称
- **游戏库**:读取已购 + 已安装游戏列表,显示大小与安装状态
- **下载/启动/卸载**:实时进度条,支持取消
- **Steam 集成**:把游戏注册为 Steam 非 Steam 游戏(写入 `shortcuts.vdf`),可重启 Steam 刷新,或通过 `steam://` 启动

## 架构

```
src/index.tsx         React/TS 前端(游戏模式 UI)
main.py               Python 后端(Decky 入口,暴露 callable 方法)
py_modules/config.py  插件配置持久化(JSON)
py_modules/legendary.py  Legendary CLI 封装(登录/库/下载/启动)
py_modules/steam.py   Steam shortcuts.vdf 读写 + steam:// 协议
```

## 依赖

- Decky Loader(前端)
- [Legendary](https://github.com/derrod/legendary)(后端下载引擎)

在 Steam Deck 桌面模式安装 Legendary:

```bash
# 方式一:pip
pip install legendary-gl

# 方式二:通过 Heroic Games Launcher 安装(自带 legendary 二进制)
flatpak install flathub com.heroicgameslauncher.hgl
```

## 开发与构建

```bash
pnpm install
pnpm build        # 产出 dist/
pnpm watch        # 监听模式
```

### 安装到 Steam Deck(开发者模式)

1. Decky 开启开发者模式(设置 → 开发者 → 打开开发者模式)
2. 将项目打包为 zip,或直接把 `dist/` + `main.py` + `py_modules/` 放到插件目录
3. 在 Decky 插件菜单重载

## 插件 API 一览(前端 callable 对应后端方法)

| 前端 callable | 后端方法 | 说明 |
|---|---|---|
| `auth_status` | `auth_status()` | 登录状态 + 用户信息 |
| `login` | `login()` | 触发 Legendary 网页授权 |
| `logout` | `logout()` | 删除本地 token |
| `list_games` | `list_games()` | 游戏库列表 |
| `install` | `install(app_name)` | 后台下载(事件 `install_progress`) |
| `launch` | `launch(app_name)` | 启动游戏 |
| `uninstall` | `uninstall(app_name)` | 卸载游戏 |
| `add_to_steam` | `add_to_steam(app_name)` | 生成启动脚本 + 写入 shortcuts.vdf |
| `remove_from_steam` | `remove_from_steam(app_name)` | 从 shortcuts.vdf 移除 |
| `is_in_steam` | `is_in_steam(app_name)` | 是否已添加到 Steam |
| `refresh_steam` | `refresh_steam()` | `steam://restart` 刷新库 |
| `get_settings` / `set_setting` | 同上 | 配置读写 |

后端事件:`install_progress` (app_name, state, percent, message),state 为
`starting | downloading | done | error | cancelled`。

## 已知限制与待办

- **下载进度解析**:依赖 Legendary 输出的 `Progress: xx%` 文本格式,版本差异可能导致进度条不准(不影响实际下载)
- **shortcuts.vdf 并发写**:Steam 运行时会持有该文件,添加后需重启 Steam 才稳定生效,插件已通过 `steam://restart` 提示
- **未实现**:下载断点续传状态展示、多账号切换

## 安全与隐私

本项目**不包含后端服务器**,所有数据存储在本地。详见 [SECURITY.md](./SECURITY.md)。

要点:
- `py_modules/epic_oauth.py` 中的 `DEVICE_CLIENT_ID` / `DEVICE_CLIENT_SECRET` 是 Epic 的**公开**客户端凭据(Fortnite Switch 客户端),非个人密钥,广泛存在于 Legendary/Heroic/EpicResearch 等开源项目。
- Epic 登录 token 由 Legendary 存储在本地配置目录,不会提交到 Git。

## 参考项目

- [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) — 插件脚手架
- [Legendary](https://github.com/derrod/legendary) — Epic 命令行客户端
- [EpicResearch](https://github.com/MixV2/EpicResearch) — Epic OAuth/API 研究(device code 流程参考)

## 开源协议

本项目基于 [BSD 3-Clause License](./LICENSE) 开源。

相关文档:

- [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献指南(如何提 issue、贡献代码、开发规范)
- [SECURITY.md](./SECURITY.md) — 安全与隐私说明(认证凭据、用户数据存储)
- [NOTICE](./NOTICE) — 第三方版权与许可声明(上游项目、依赖、商标)

### 商标与免责声明

"Epic"、"Epic Games" 为 Epic Games, Inc. 的商标;"Steam"、"Steam Deck" 为 Valve Corporation 的商标。本项目为社区开源项目,与上述公司无隶属、赞助或背书关系,使用前请自行评估并遵守相关服务条款。
