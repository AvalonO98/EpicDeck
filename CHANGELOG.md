# Changelog

本项目的所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.6] - 2026-11-02

- 游戏列表显示预计安装体积：`未安装 · 安装后 44.6 GB`，详情页另外给出「需下载」与「安装后占用」
- 体积来自 Epic 构建清单（`legendary info`），逐个后台读取并缓存 30 天，列表里以「体积读取中 42/138」显示进度；可在设置里关掉，避免流量消耗
- 游戏名按语言优先显示译名：默认跟随 Steam 界面语言（读 `registry.vdf` 的 `language`），简体中文下 9 个游戏显示中文名，其余无译名的保持英文原名；设置里可手动指定语言
- 详情页打开时如果体积还没读到，会立刻单独读取该游戏，不必等后台队列

## [0.1.5] - 2026-11-02

- 游戏列表当前选中项增加高亮：蓝色描边 + 渐亮背景 + 标题变白 + 右侧箭头点亮，手柄移动焦点时一眼能看出停在哪一行

## [0.1.4] - 2026-11-02

本次聚焦 Steam Deck 手柄操作体验：把每行两个按钮改成「整行可聚焦 + 详情页」，并补齐搜索、排序和安装目录选择。

### 新增
- **搜索**：游戏库顶部搜索框，按标题或 app_name 实时过滤，显示「找到 N / 总数」
- **排序**：字母 A→Z、字母 Z→A、游玩时间（长→短）、最近添加
- **游玩时长**：通过 Epic library-service 的 playtime 接口读取真实游玩时间（复用 Legendary 保存的 access token），显示在列表与详情页
- **最近添加排序**：Epic 未提供「添加日期」，改为插件首次见到该游戏时记录时间戳（`first_seen`），新领取的游戏自然排在前面
- **安装目录选择**：详情页可直接选择安装位置（内置存储 / SD 卡，显示各自剩余空间），单个游戏可覆盖全局默认值
- 列表内直接标注「已安装 / 未安装 / 下载中」「游玩时长」「是否已加入 Steam」

### 变更
- **重做游戏库交互**：原来每行有「下载」「加Steam」两个可聚焦按钮，手柄上下切换焦点时会停在按钮上，
  滚动视图随即把封面和标题挤出可视区。现在整行是**单一聚焦目标**，按 A 进入详情页，所有操作（下载/启动/卸载/加 Steam）集中在详情页
- `install` callable 增加第二个参数 `install_dir`，支持按游戏指定安装目录，并在启动前校验目录存在且可写
- `get_install_dir_options` 改为返回带剩余空间的选项（`{path, label, free}`），并修正 SD 卡挂载路径识别（`/run/media/<user>/<label>`）
- `list_games` 一次性读取 `shortcuts.vdf` 并标记 `in_steam`，替代原先每行 138 次 `is_in_steam` 调用
- 安装进度状态提升到页面级，列表与详情页共享同一份进度

### 修复
- 修复详情页「加 Steam」在未安装时仍可点击的问题
- 修复游戏库顶部信息排版拥挤、状态文字被截断的问题

## [0.1.3] - 2026-11-02

首个 **实机跑通** 的版本:通过 SSH 连接 Steam Deck 逐项调试,登录、游戏库读取均已验证。

### 新增
- **授权码登录**:界面显示 Epic 授权页二维码 + 输入框,用户粘贴 `authorizationCode` 即可完成登录;支持直接粘贴整段 JSON 或网址,自动提取 32 位授权码
- 新增 `get_login_url` / `login_with_code` 两个 callable

### 变更
- **移除 device code 登录方案**。该方案能拿到 token,但 Epic 把授权码绑定到签发它的 client,
  Legendary 用启动器 client 兑换必然失败(`authorization_code_not_for_your_client`),属机制限制
- `list_games` 不再包含 Unreal Engine 内容(138 个游戏而非 162 项),并按已安装优先排序

### 修复
- 修复插件后端无法启动:`ModuleNotFoundError: No module named 'py_modules'`（Decky 不把插件目录加入 `sys.path`）
- 修复 `DECKY_SETTINGS_DIR` / `DECKY_RUNTIME_DIR` 常量名错误（应为 `DECKY_PLUGIN_*`）
- 修复 `CERTIFICATE_VERIFY_FAILED`:Decky sandbox 找不到 CA 证书，改为 certifi → 系统 CA → 降级三级兜底
- 修复 Legendary 二进制下载失败:`github.com` 不可达,改为「直连 → 镜像 → API 资产端点」多源尝试,每个源 10 秒快速失败
- 修复 `legendary auth --status` / `list-games` 命令不存在（正确为 `status` / `list`），旧命令会掉进交互式登录导致卡死
- 修复游戏标题显示成哈希值:`list --json` 的字段是 `app_title` 而非 `title`
- 修复 JSON 解析失败:`[Core] WARNING:` 日志混入 stdout 后按首个 `[` 切分导致解析崩溃,改为逐位置尝试合法 JSON 解码
- 修复 `_unload` 在初始化未完成时抛 `AttributeError`
- 前端登录按钮增加进行中状态,避免点击后无反馈

## [0.1.2] - 2026-11-02

### 新增
- 新增 `push` 到 `main` 分支时自动构建 + 打包验证（CI 健康检查，不发布）
- 发版时自动将 `package.json` 版本号同步为 tag 版本号，zip 文件名与 tag 保持一致
- `build_zip.py` 新增 `--version` 参数，供 CI 覆盖版本号

### 修复
- 修复 Release 中残留旧版本 zip 文件的问题（版本号不同步导致）

## [0.1.1] - 2026-11-02

### 修复
- 修复插件首次部署时卡在「加载中」的问题
  - 前端初始化改为并行执行，并为每个阶段增加独立超时兜底，避免后端调用阻塞导致界面无限等待
  - `check_environment` 增加异常保护，避免 `_resolve` 异常导致 callable 不返回
  - `auth_status` 的 `--status` 超时从 30 秒缩短至 15 秒
  - 子进程创建失败（文件不存在 / 无执行权限）统一转为 `LegendaryNotFound`，避免异常冒泡

## [0.1.0] - 2026-11-02

### 新增
- 首个正式发布版本
- Epic Games 登录（扫码 / 验证码 / 浏览器登录）
- 游戏库浏览（含封面图）
- 游戏下载（含进度、速度、ETA 显示）
- 添加到 Steam 启动
- 内置 Legendary 自动安装（无需 pip，适配 SteamOS 不可变文件系统）
- 日志导出功能，方便排错

[0.1.2]: https://github.com/AvalonO98/EpicDeck/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/AvalonO98/EpicDeck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AvalonO98/EpicDeck/releases/tag/v0.1.0
