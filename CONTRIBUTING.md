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
pnpm install          # 用 pnpm；lockfile 已提交，别用 npm 生成别的锁

# 类型检查(提交前必须通过)
npx tsc --noEmit      # 或 pnpm exec tsc --noEmit

# 构建(提交前必须通过)
pnpm build

# 离线回归(语法 + i18n 四查 + 内容检查 + 三个套件,共 10 项;加 --build 是 12 项)
python scripts/regression.py            # 加 --build 会连 rollup 和打包一起跑
python scripts/regression.py --tmpdir <dir>   # .pyc 与三个套件的临时目录都放这里(默认系统临时目录)
```

> 仓库已提交 `pnpm-lock.yaml`,CI 用 `pnpm install --frozen-lockfile`(并开了 `cache: pnpm`)。
> 改依赖后本地跑一次 `pnpm install` 把 lockfile 一起提交,否则 CI 会拒装。
> `setup-node` 的 `cache: pnpm`,这样构建才可复现。

### 目录约定

- 插件运行必需的文件(`main.py` / `plugin.json` / `package.json` / `py_modules/` / `dist/`)必须在仓库根目录,Decky 按这个结构加载。
- 构建、打包、部署脚本统一放在 `scripts/`,不要在根目录新增脚本。

### `scripts/` 里都是什么

| 脚本 | 用途 |
|---|---|
| `regression.py` | 总入口:Python 语法、i18n 覆盖/占位符/标签表/模块级 `t()`、未包裹中文、三个套件;`--build` 再加 rollup 与 zip |
| `smoke_backend.py` | 后端纯离线断言(148 项/99 条):下载状态机、清理守卫、快照持久化、SSL |
| `test_geomnav.py` | 几何导航状态机(`settleFocus` / `moveFocus` / `reverifyFocus` 等) |
| `test_i18n.py` | 语言与标题映射 |
| `build_zip.py` | 打 `EpicDeck-v<版本>.zip`(发布用,`--skip-build` 只打包) |
| `build_icon.py` | 从 `assets/icon.png` 生成 Decky 需要的尺寸 |
| `i18n_wrap.py` | 把新写的中文字面量包成 `t("…")` 的辅助脚本 |
| `cdp_*.py` | 实机调试(见下表),只在 Deck 上跑 |
| `cdp_wake.py` | 在 Deck 上发一次 XTest 按键把屏保唤醒(屏保期间注入的按键全部失效) |
| `remote_eval.py` | 在开发机上跑:把一段 JS 通过 ssh 送进设备执行,免去三层引号;缺 `cdp_eval.py` 会自动上传 |
| `install_deck_key.py` | 用密码登录一次设备,把公钥装进 `authorized_keys`(新机器第一步);`--probe` / `--run` 也能用 |
| `probe_*.js` | 手动排查用的零散探针(几何/焦点/滚动),按需 `cdp_eval.py` 加载 |
| `deploy_from_windows.{sh,ps1,bat}` | Windows → Deck 的部署入口 |


### 在真机上验证焦点与导航(CDP)

Game Mode 里没有 DevTools,但 Steam 自己开了 CEF 调试端口。`scripts/` 下的脚本就是
全部工具,**这些结论来自 2026-11-10 整晚的踩坑,照做能省几个小时**:

| 脚本 | 用途 |
|---|---|
| `python scripts/cdp_eval.py "<js>" [target]` | 在某个 CEF 页面里求值。读 `document.activeElement`、`__epicdeckNavLog`、某个元素的 `className` 等 |
| `python scripts/cdp_shot.py out.png "Steam 大屏幕模式"` | 截图。**插件 UI 挂在 `Steam 大屏幕模式` 这个 target 里,不是 `QuickAccess`**(QAM 关着时那边只有 60~70 个节点) |
| `python scripts/cdp_watch.py [秒]` / `--once` | 往每个上下文注入错误收集器(`error` / `unhandledrejection` / 过滤后的 `console.error`),写进 `localStorage` 跨重载留存;`--once` 取增量 |
| `python scripts/cdp_scrolltest.py down 26` | 连按方向键并逐次记录焦点文字 + 屏幕坐标 + 容器 `scrollTop`。"跳一格""卡住"只有看轨迹才看得出来 |
| `python scripts/cdp_key.py down 4` | 发**真实**按键(`Input.dispatchKeyEvent`)。支持 `down/up/left/right/enter` |
| `python scripts/cdp_nav_probe.py [--press 10]` | 打印 `geomnav` 看到的几何:当前焦点、候选表(strict/relaxed)、导航日志 |
| `python scripts/cdp_reload.py EpicDeck` | 只重载 EpicDeck(调 `DeckyPluginLoader.importPlugin()`),不用重启 Steam,也不用 root |

**验收导航用 `__epicdeckNavRC()`,不要用 `__epicdeckNav()`。**
前者走 `onRootDirection` 里那条真实路径(`moveFocusRowCol`,流式布局就是它),后者走几何版
`moveFocus`,**不是用户按键执行的那条代码** —— 2026-11-10 用错入口,得出了一个错误结论。
另外 CDP 发的键盘事件在 Steam 里会走它自己的键盘导航,和手柄不等价:同一段代码,
键盘按 14 次纹丝不动、`__epicdeckNavRC` 按一次就动。**方向键的最终验收只能靠人手**。

**`cdp_reload.py` 会骗人。** 它打印 `RESULT RELOADED` 时,日志里可能同时写着
`Plugin EpicDeck is already loaded and has requested to not be re-loaded` ——
前端模块根本没换。判据永远是设置页底部的版本号;要换 `dist/index.js` 最稳的是
`sudo systemctl restart plugin_loader`。

**三条硬规矩(违反任意一条,你看到的都是假象):**

1. **不要注入 `escape`**。CDP 发的 Escape 会让 Steam 的导航**彻底失效**,只能重启 Steam 才恢复。
   要验"返回",按真机 B 键,或者直接调页面自己的回调。
2. **不要用 `element.focus()` 造状态**。DOM 焦点会到,但 Steam 的 `gpfocus` 不动,
   接下来所有按键都被路由到旧节点上,表现是"按了没反应、日志也不增长"。
   验收必须用真实鼠标事件(`Input.dispatchMouseEvent`)或真实按键。
3. **先确认屏保没亮**。屏保亮着时 CDP 注入的按键会**完全失效**,现象和"导航坏了"一模一样
   (2026-11-10 一晚误判两次)。判据:读 `Screensaver_uid2` 页面的 `document.body.innerText`,
   非空就是屏保还亮着;发一个 Shift 键唤醒即可。

判断"这次按键有没有走我们自己的导航",看 `__epicdeckNavLog` 有没有新增,不要看别的标志位。

### 代码规范

- **前端**:TypeScript + React,使用 `@decky/ui` 提供的组件,遵循现有代码风格。
- **后端**:Python 3,类型清晰,异步方法用 `async`/`await`。
- **提交信息**:使用约定式提交(Conventional Commits),如 `feat:`、`fix:`、`chore:`、`docs:`。

### 提交前检查清单

- [ ] `npx tsc --noEmit` 通过(CI 里也会跑)
- [ ] `python scripts/regression.py` 10/10(改了后端再跑一遍 `scripts/smoke_backend.py`)
- [ ] `pnpm build` 通过,无 TS 错误
- [ ] 后端 Python 语法检查通过
- [ ] 改到焦点/导航:真机按过,并且是按上面的 CDP 规矩验的
- [ ] 没有引入新的隐私/密钥问题(参见 [SECURITY.md](./SECURITY.md))
- [ ] 新增依赖已同步到 `pnpm-lock.yaml`(改完跑一次 `pnpm install` 再提交)

## 许可证

贡献的代码将在 [BSD 3-Clause](./LICENSE) 许可证下发布。提交代码即表示你同意此条款。

## 致谢

本项目基于 [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) 构建,下载能力依托 [Legendary](https://github.com/derrod/legendary)。
