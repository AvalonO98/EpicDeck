# 安全与隐私说明 (Security & Privacy)

EpicDeck 是一个本地运行的 Steam Deck 插件,不包含任何后端服务器,所有数据都存储在你的设备上。本文件说明项目如何处理敏感信息。

## 认证凭据

`py_modules/epic_oauth.py` 中包含两个常量:

- `DEVICE_CLIENT_ID`
- `DEVICE_CLIENT_SECRET`

**这两个值是 Epic Games 的公共客户端凭据**,对应 Fortnite Nintendo Switch 游戏客户端(`fortniteNewSwitchGameClient`)。它们是:

1. **公开的、非机密的** —— 这些值广泛存在于多个知名开源项目(EpicResearch、epicgames-freegames-node、Legendary、Heroic 等)中,是 Epic 官方客户端反编译得到的公共常量。
2. **不授予任何用户账号的访问权限** —— 它们仅用于向 Epic 的 OAuth 服务标识「这是一个 Epic 官方游戏客户端」,以便使用 device_code 授权流程。
3. **不含任何个人信息** —— 它们不是你的账号、密码、token 或密钥。

## 用户凭证的存储

- Epic 登录后产生的 **access token / refresh token / 账号信息**,由 **Legendary** 存储在其本地配置目录(通常 `~/.config/legendary/`),**不会**写入本仓库或提交到 Git。
- 插件自身仅保存非敏感设置(安装目录、是否自动加 Steam 等)到 Decky 的设置目录。

## 报告安全问题

如果你发现任何潜在的安全或隐私问题,请通过 GitHub Issues 报告,不要在 issue 中粘贴任何真实的 token、密码或账号信息。

## 免责声明

本项目非 Epic Games 官方产品,使用前请确认你了解并接受使用第三方客户端访问 Epic 服务的风险。请遵守 Epic Games 的服务条款。
