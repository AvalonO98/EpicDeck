# 安全与隐私说明 (Security & Privacy)

EpicDeck 是一个本地运行的 Steam Deck 插件,不包含任何后端服务器,所有数据都存储在你的设备上。本文件说明项目如何处理敏感信息。

## 认证凭据

插件中唯一硬编码的 Epic 相关常量是**公共客户端 ID**:

- `EPIC_CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a"`(`main.py`)

这是 Epic Games 启动器客户端的公开标识,Legendary / Heroic 等开源项目同样使用。它是:

1. **公开的、非机密的** —— 该值本就是客户端公开标识,不含任何密钥。
2. **不授予任何用户账号的访问权限** —— 它只用于把用户引导到 Epic 官方的授权页面。
3. **不含任何个人信息** —— 它不是你的账号、密码、token 或密钥。

此外还有 Legendary 客户端的**公开** client secret(`py_modules/legendary.py` 的
`EPIC_LAUNCHER_SECRET`)。它和上面的客户端 ID 一样,是 Legendary / Heroic 等开源启动器
共用的公开常量,**不是**用户密钥、也不属于本项目的机密。

**授权码是用户自己输入的**:登录时用户从 Epic 页面复制一次性授权码,插件把它交给
`legendary auth --code`。授权码一次性有效、很快过期,插件不会保存它。

> 早期版本曾使用 `fortniteNewSwitchGameClient` 的 device code 流程,但 Epic 的授权码
> 与 client 绑定,无法交由 Legendary 兑换,该方案已移除。

## 用户凭证的存储

- Epic 登录后产生的 **access token / refresh token / 账号信息**,由 **Legendary** 存储在其本地配置目录(通常 `~/.config/legendary/`),**不会**写入本仓库或提交到 Git。
- `~/.config/legendary/user.json` 含 refresh token,插件在写入后会把它设为 `0600`(仅当前用户可读)。
  Legendary 自己创建该文件时不受插件控制,可用 `chmod 600` 手动收紧。
- 插件自身仅保存非敏感设置(安装目录、是否自动加 Steam 等)到 Decky 的设置目录。
- 诊断导出(`export_logs`)只输出白名单里的排障设置,不含游戏名、游玩时长、标题/体积缓存,
  账号 ID 与显示名会做掩码。

## 网络请求

- 所有 HTTPS 请求都校验证书。**没有**"证书校验失败就关闭校验"的回退分支:带 Bearer token
  的请求在证书异常时直接失败,而不是降级成明文信任。

## 报告安全问题

如果你发现任何潜在的安全或隐私问题,请通过 GitHub Issues 报告,不要在 issue 中粘贴任何真实的 token、密码或账号信息。

## 免责声明

本项目非 Epic Games 官方产品,使用前请确认你了解并接受使用第三方客户端访问 Epic 服务的风险。请遵守 Epic Games 的服务条款。
