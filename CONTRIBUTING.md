# 贡献指南 (Contributing)

感谢你考虑为 EpicDeck 做贡献!这是一个面向 Steam Deck 玩家的开源项目,欢迎任何形式的帮助:报告 bug、改进文档、提交代码。

## 行为准则

请保持友善与尊重。我们期望所有参与者:

- 使用包容、友好的语言
- 尊重不同观点与经验
- 建设性地接受反馈

## 如何报告问题 (Issue)

在提交 issue 前,请先:

1. 搜索已有的 [Issues](https://github.com/AvalonO98/EpicDeck/issues),确认没有重复。
2. 使用清晰的标题,描述问题或建议。

**Bug 报告**请包含:

- Steam Deck 系统版本(SteamOS 版本)
- Decky Loader 版本
- Legendary 版本(`legendary --version`)
- 复现步骤
- 期望行为 vs 实际行为
- 相关日志(如有)

> ⚠️ **隐私提醒**:请勿在 issue 中粘贴任何真实的 Epic 账号、密码、token、refresh token 或设备授权码。

## 如何提交代码 (Pull Request)

1. Fork 本仓库,克隆到本地。
2. 创建你的特性分支:`git checkout -b feature/你的改动`。
3. 进行修改并提交(提交信息请用简洁、描述性的语言)。
4. 推送分支并提交 Pull Request。

### 开发环境

```bash
# 安装依赖
pnpm install

# 构建(提交前必须通过)
pnpm build

# 后端语法检查(提交前必须通过)
python -c "import ast; [ast.parse(open(f, encoding='utf-8').read()) for f in ['main.py','py_modules/config.py','py_modules/legendary.py','py_modules/steam.py','py_modules/epic_oauth.py']]"
```

### 代码规范

- **前端**:TypeScript + React,使用 `@decky/ui` 提供的组件,遵循现有代码风格。
- **后端**:Python 3,类型清晰,异步方法用 `async`/`await`。
- **提交信息**:使用约定式提交(Conventional Commits),如 `feat:`、`fix:`、`chore:`、`docs:`。

### 提交前检查清单

- [ ] `pnpm build` 通过,无 TS 错误
- [ ] 后端 Python 语法检查通过
- [ ] 没有引入新的隐私/密钥问题(参见 [SECURITY.md](./SECURITY.md))
- [ ] 新增依赖已同步更新 `pnpm-lock.yaml`

## 许可证

贡献的代码将在 [BSD 3-Clause](./LICENSE) 许可证下发布。提交代码即表示你同意此条款。

## 致谢

本项目基于 [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) 构建,下载能力依托 [Legendary](https://github.com/derrod/legendary)。
