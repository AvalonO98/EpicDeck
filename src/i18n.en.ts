// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// English strings added after the first pass. Kept in a separate file so the
// base map in i18n.ts stays reviewable; both are merged at module load.
//
// Keys are the Chinese source text (see i18n.ts for why). Strings that are only
// fragments of a longer sentence are translated as fragments too — they are
// concatenated next to each other in the UI.

export const EN_EXTRA: Record<string, string> = {
  // -- fragments used in sentences ---------------------------------------
  ",请尽快粘贴。": ", please paste it now.",
  "剩余 ": "Remaining ",
  "安装后 ": "Installs to ",
  "已占用 ": "On disk ",
  "下载中…": "Downloading…",
  "剩余时间 ": "ETA ",

  // -- login --------------------------------------------------------------
  "Epic Games 登录": "Epic Games sign-in",
  "Epic 账号": "Epic account",
  "Epic 账号与库概况": "Epic account and library",
  "尚未登录 Epic 账号": "Not signed in to Epic yet",
  "授权码": "Authorization code",
  "授权码只能使用一次且很快过期": "The code is single-use and expires quickly",
  "在 Steam 浏览器中登录（推荐）": "Sign in with Steam's browser (recommended)",
  "手机扫码登录": "Sign in on your phone",
  "用手机扫码 / 手动粘贴授权码": "Scan the code or paste the authorization code",
  "用手机或电脑打开下面的链接(也可扫码),登录你的 Epic 账号":
    "Open the link below on your phone or PC (or scan the code) and sign in to Epic",
  "登录后页面会显示一段内容,复制其中": "After signing in, the page shows a block of text — copy the",
  "粘贴到下面,点「完成登录」。": "Paste it below and press \"Finish signing in\".",
  "请先粘贴授权码": "Paste the authorization code first",
  "改用手动粘贴授权码": "Paste the code manually instead",
  "复制失败": "Could not copy",
  "剪贴板不可用，请手动记录这一行": "Clipboard unavailable — write this line down manually",
  "正在读取剪贴板…": "Reading clipboard…",
  "生成二维码中…": "Generating QR code…",
  "登录二维码": "Sign-in QR code",
  "正在登录…": "Signing in…",
  "正在等待登录…（约 20 秒后开始自动读取）":
    "Waiting for sign-in… (automatic capture starts in about 20 s)",
  "正在准备…": "Preparing…",
  "等待登录完成": "Waiting for sign-in",
  "全程不用复制或粘贴": "No copying or pasting needed",
  "不用复制，也不用回来粘贴": "Nothing to copy, nothing to paste back",
  "在弹出的 Steam 窗口里登录 Epic 账号就行，":
    "Just sign in to Epic in the Steam window that opened —",
  "点下面的按钮，在弹出的 Steam 窗口里登录 Epic 账号即可。登录完成后插件会自己把授权码读走，":
    "Press the button, then sign in to Epic in the Steam window. The plugin reads the authorization code itself,",
  "登录成功后浏览器会停在一个显示 JSON 的页面（":
    "After signing in, the browser stops on a page showing JSON (",
  "），那就是成功了，插件会自己把码取走并完成登录。看到这个页面后按":
    ") — that means it worked; the plugin takes the code from there. When you see that page, press",
  "一直没反应的话，可以「重新打开登录页」；也可以改用手机扫码，或自己复制那段 JSON 后点「立即读取剪贴板」。":
    "If nothing happens, reopen the sign-in page, sign in on your phone instead, or copy that JSON and press \"Read clipboard now\".",
  "关掉浏览器即可。": "You can close the browser.",
  "不需要重复登录": "No need to sign in again",
  "可以重新登录其他账号": "You can sign in with a different account",
  "已经登录": "Already signed in",
  "正在读取账号与游戏库…": "Reading account and library…",
  "正在重启 Steam": "Restarting Steam",
  "重启 Steam 刷新游戏库": "Restart Steam to refresh the library",
  "重启 Steam 后生效": "Takes effect after Steam restarts",
  "连接状态": "Connection",

  // -- library ------------------------------------------------------------
  "EpicDeck · Epic 游戏库": "EpicDeck · Epic library",
  "EpicDeck 游戏库": "EpicDeck library",
  "Epic 库中拥有": "In your Epic library",
  "游戏总数": "Games",
  "游戏库为空。请确认你的 Epic 账号下已拥有游戏（含免费领取的游戏）。":
    "Your library is empty. Make sure this Epic account owns games (including free ones).",
  "在游戏库里选一个没安装的游戏，点「下载并安装」。":
    "Pick a game you have not installed and press \"Download and install\".",
  "这个游戏已不在游戏库里。": "This game is no longer in your library.",
  "正在刷新游戏库…": "Refreshing library…",
  "正在读取游戏库…": "Reading library…",
  "正在读取游戏库…（首次会比较慢）": "Reading library… (the first time is slower)",
  "读取游戏库失败": "Could not read the library",
  "读取游戏库失败：": "Could not read the library: ",
  "读取游戏库超时：Epic 服务器没有响应":
    "Library read timed out — Epic's server did not respond",
  "未知错误": "Unknown error",
  "连不上 Epic 服务器": "Cannot reach Epic's servers",
  "登录状态已失效": "Sign-in expired",
  "请确认掌机已联网、代理（如有）可用；Epic 服务器偶发不稳定，稍后重试通常就好。":
    "Check that the Deck is online and any proxy works; Epic's servers are occasionally flaky, so retrying usually helps.",
  "凭证可能已过期或被吊销，请到「设置 → 账号」重新登录。":
    "The credentials may have expired or been revoked — sign in again from Settings → Account.",
  "可以重试一次；若反复失败，请到「设置 → 维护」导出诊断日志。":
    "Try once more; if it keeps failing, export diagnostics from Settings → Maintenance.",
  "刷新中…": "Refreshing…",
  "刷新失败": "Refresh failed",
  "加载中…": "Loading…",
  "正在重试…": "Retrying…",
  "读取失败:": "Read failed: ",
  "未知版本": "Unknown version",
  "未知": "Unknown",

  // -- detail / actions ---------------------------------------------------
  "添加进 Steam 的游戏会带封面，重启 Steam 后出现在「非 Steam 游戏」里":
    "Games added to Steam get box art and show up under \"Non-Steam games\" after Steam restarts",
  "非 Steam 快捷方式": "Non-Steam shortcut",
  "决定游戏是否出现在 Steam 库里": "Controls whether the game appears in your Steam library",
  "添加失败": "Could not add",
  "移除失败": "Could not remove",
  "已添加到 Steam": "Added to Steam",
  "已从 Steam 移除": "Removed from Steam",
  "已写入 Steam": "Written to Steam",
  "加入 Steam": "Add to Steam",
  "添加到 Steam": "Add to Steam",
  "从 Steam 移除": "Remove from Steam",
  "把已安装的游戏全部加入 Steam": "Add every installed game to Steam",
  "补齐封面与图标": "Fetch covers and icons",
  "封面已补齐": "Covers updated",
  "封面已是最新": "Covers already up to date",
  "封面下载失败": "Could not download covers",
  "自动下载封面图": "Download covers automatically",
  "把 Epic 的竖版封面/横幅写进 Steam 的 grid 目录":
    "Write Epic's portrait covers and heroes into Steam's grid folder",
  "下载完成后自动写入 Steam 的非 Steam 快捷方式":
    "Add a non-Steam shortcut automatically after install",
  "自动添加到 Steam": "Add to Steam automatically",
  "启动参数保存失败": "Could not save launch options",
  "已保存，下次启动生效": "Saved — applies on the next launch",
  "已保存，但 Steam 快捷方式未更新": "Saved, but the Steam shortcut was not updated",
  "来自 Legendary 配置（改这里会改为插件接管）":
    "From Legendary's config (editing here hands control to the plugin)",
  "追加在 legendary launch 之后，如 -windowed；留空即不添加":
    "Appended after legendary launch, e.g. -windowed; leave empty for none",
  "开始下载": "Starting download",
  "正在下载": "Downloading",
  "正在下载…": "Downloading…",
  "正在继续…": "Resuming…",
  "已卸载": "Uninstalled",
  "卸载失败": "Uninstall failed",
  "启动失败": "Launch failed",
  "Steam 启动失败，已改用后台启动": "Steam launch failed — started in the background instead",
  "取消下载": "Cancel download",
  "暂停": "Pause",
  "继续": "Resume",
  "空闲": "Idle",
  "云存档已同步": "Cloud saves synced",
  "本地存档已上传": "Local saves uploaded",
  "云端存档已下载": "Cloud saves downloaded",
  "双向同步完成": "Two-way sync finished",
  "云存档同步失败": "Cloud-save sync failed",
  "插帧设置失败": "Could not change frame generation",

  // -- downloads ----------------------------------------------------------
  "下载任务": "Downloads",
  "下载安装位置": "Install location",
  "下载位置已设置": "Install location set",
  "当前没有下载任务。": "No downloads right now.",
  "查看全部下载任务": "See all downloads",
  "下载设置（并发 / CDN / 清理缓存）": "Download settings (concurrency / CDN / cache)",
  "下载并发（越少越慢，也越省带宽）": "Concurrent downloads (fewer = slower, less bandwidth)",
  "自动（最快，约 25~30 MB/s）": "Automatic (fastest, ~25–30 MB/s)",
  "8 并发（约 15~20 MB/s）": "8 concurrent (~15–20 MB/s)",
  "4 并发（约 8~12 MB/s）": "4 concurrent (~8–12 MB/s)",
  "2 并发（约 4~8 MB/s）": "2 concurrent (~4–8 MB/s)",
  "1 并发（约 2~4 MB/s）": "1 concurrent (~2–4 MB/s)",
  "Legendary 没有精确限速，用并发数分档控速":
    "Legendary has no real rate limit; concurrency is the coarse throttle",
  "只能按档降速，做不到精确到 KB/s；数值是实测参考，实际受 CDN 和网络影响":
    "Steps rather than exact KB/s; the numbers are measured hints, real speed depends on the CDN and your connection",
  "首选 CDN 节点（留空 = 自动）": "Preferred CDN host (empty = automatic)",
  "只填主机名（不含 http://）。国内机器 Epic 通常已自动分配腾讯云节点，一般无需改":
    "Hostname only, without http://. Epic usually assigns a domestic Tencent Cloud node already, so this rarely needs changing",
  "例如 epicgames-download1-1251447533.file.myqcloud.com":
    "e.g. epicgames-download1-1251447533.file.myqcloud.com",
  "用明文 HTTP 下载": "Download over plain HTTP",
  "国内 CDN 本身走 http；对 https 节点强制明文可绕过部分 TLS 卡顿，但传输不加密（chunk 仍由 Legendary 校验哈希）":
    "Domestic CDNs already use http; forcing plaintext on an https node can dodge TLS stalls, but the transfer is unencrypted (chunks are still hash-verified)",
  "清理下载缓存": "Clear download cache",
  "删除残留的断点续传状态与临时文件（不影响已装游戏）":
    "Delete leftover resume state and temp files (installed games are untouched)",
  "缓存已清理": "Cache cleared",
  "清理失败": "Could not clear",

  // -- settings -----------------------------------------------------------
  "设置与账号": "Settings and account",
  "启动与兼容": "Launch and compatibility",
  "Steam 集成": "Steam integration",
  "维护": "Maintenance",
  "排查问题时用": "For troubleshooting",
  "诊断日志": "Diagnostic logs",
  "导出失败": "Export failed",
  "默认安装目录": "Default install directory",
  "新下载默认放这里，单个游戏可以单独指定":
    "New downloads go here; a single game can override it",
  "自定义路径": "Custom path",
  "自定义路径（可选）": "Custom path (optional)",
  "自定义路径（目录不存在会自动创建）": "Custom path (created if missing)",
  "填了就用它（例如 /run/media/deck/MySD/EpicGames），留空则用上面的位置；目录不存在会自动创建":
    "Used when filled in (e.g. /run/media/deck/MySD/EpicGames); empty uses the location above. Missing directories are created",
  "留空则使用上面的默认安装目录": "Empty means the default above",
  "例如 /run/media/deck/MySD/EpicGames": "e.g. /run/media/deck/MySD/EpicGames",
  "使用此位置并继续": "Use this location",
  "用默认位置（~/Games）": "Use the default (~/Games)",
  "先选个下载位置": "Choose where games install",
  "Epic 游戏体积很大，先确认装在哪里。之后可以在「设置 → 目录与语言」随时改，单个游戏也能单独指定。":
    "Epic games are large, so confirm where they go. You can change it later in Settings → Directories, or per game.",
  "Epic 游戏体积很大，先选一个下载安装的位置。选好之后可以在「设置 → 默认安装目录」里随时更改，单个游戏也能单独指定。":
    "Epic games are large, so pick an install location. You can change it later in Settings → Default install directory, or per game.",
  "新装的游戏默认用 ~/lsfg 包一层插帧；单个游戏可在详情页单独开关":
    "New games get the ~/lsfg wrapper by default; toggle it per game on the detail page",
  "默认开启小黄鸭插帧（LSFG-VK）": "Enable frame generation by default (LSFG-VK)",
  "插帧通过 ~/lsfg 包装实现，不是启动参数，所以游戏启动参数里看不到相关内容。":
    "Frame generation is a wrapper, not a launch option, so it never shows up in a game's launch options.",
  "Windows 游戏用 Proton 运行": "Run Windows games through Proton",
  "SteamOS 没有 wine；关掉这项 Windows 游戏会起不来":
    "SteamOS has no wine; turning this off means Windows games will not start",
  "Windows 版 Epic 游戏靠 Steam 自带的 Proton 启动":
    "Windows titles launch through Steam's own Proton",
  "逐个读取 Epic 清单来估算体积（每个游戏几秒、几 MB 流量，结果缓存 30 天）":
    "Read each Epic manifest to estimate size (a few seconds and MB per game, cached for 30 days)",
  "后台读取安装体积": "Read install sizes in the background",
  "游戏名语言": "Game title language",
  "在 Steam 菜单显示 EpicDeck": "Show EpicDeck in the Steam menu",
  "按 STEAM 键后，「库」下方多一个 EpicDeck 游戏库入口；下次打开菜单生效":
    "Adds an EpicDeck library entry under Library after pressing STEAM; applies the next time the menu opens",
  "卸载插件只删插件代码，下面这些都会保留":
    "Uninstalling the plugin only removes its code; everything below is kept",
  "全屏浏览、下载、启动、加进 Steam": "Browse, install, launch, and add to Steam",
  "欢迎使用 EpicDeck": "Welcome to EpicDeck",
  "打不开大屏页面": "Could not open the full-screen page",
  "查看": "View",
  "打开游戏库": "Open library",
  "按 A 复制": "Press A to copy",
  "已复制路径": "Path copied",
  "刷新磁盘": "Refresh disks",
  "刷新磁盘列表（刚插 SD 卡？）": "Refresh disks (just inserted an SD card?)",
  "请填写路径": "Enter a path first",
  "路径无效": "Invalid path",
  "已保存安装目录": "Install directory saved",
  "保存路径": "Save path",

  // -- dependencies -------------------------------------------------------
  "未检测到 Legendary(SteamOS 无 pip,无法用 pip 安装)。":
    "Legendary was not found (SteamOS has no pip, so it cannot be installed that way).",
  "SteamOS 没有 pip，插件会直接从 GitHub Releases 下载官方独立二进制（约 3 MB）。":
    "SteamOS has no pip, so the plugin downloads the official standalone binary from GitHub Releases (~3 MB).",
  "点击下方按钮,将自动从 GitHub Releases 下载官方独立二进制(约 3 MB,无需 Python)。":
    "Press the button below to download the official standalone binary from GitHub Releases (~3 MB, no Python needed).",
  "一键安装 Legendary": "Install Legendary",
  "重新安装 Legendary": "Reinstall Legendary",
  "缺少 Legendary": "Legendary missing",
  "缺少依赖": "Missing dependency",
  "Legendary 已就绪": "Legendary is ready",
  "环境正常": "Environment OK",
  "处理中": "Working…",
  "操作失败": "Action failed",
  "保存失败": "Save failed",
  "登出失败": "Sign-out failed",
  "已登出": "Signed out",
  "安装成功": "Installed",
  "安装失败": "Install failed",
  "登录成功": "Signed in",
  "登录失败": "Sign-in failed",
  "登录出错:": "Sign-in error: ",
  "启动登录失败:": "Could not start sign-in: ",
  "无法开始登录": "Could not start sign-in",
  "Proton、目录、封面、诊断日志": "Proton, directories, covers, diagnostics",
  // -- templated / late additions ----------------------------------------
  " · {0} 个游戏": " · {0} games",
  " · {0}更新": " · updated {0}",
  " · 当前 {0}": " · current {0}",
  " · 累计游玩 {0} 小时": " · {0} h played",
  "Legendary {0} 已安装": "Legendary {0} installed",
  "ProtonDB:{0}({1} 份报告)": "ProtonDB: {0} ({1} reports)",
  "{0} 分钟": "{0} min",
  "{0} 小时": "{0} h",
  "{0} 小时 {1} 分": "{0} h {1} m",
  "上一页 / 上一个标签": "Previous page / tab",
  "下一页 / 下一个标签": "Next page / tab",
  "体积读取中 {0}/{1}": "Reading sizes {0}/{1}",
  "删除了 {0} 个残留文件": "Removed {0} leftover files",
  "占用 {0}": "Uses {0}",
  "安装位置": "Install location",
  "已添加 {0} 个。{1}": "Added {0}. {1}",
  "已添加 {0} 个，失败 {1} 个（{2}）": "Added {0}, {1} failed ({2})",
  "当前显示的是上次加载的游戏库。": " Showing the library loaded earlier.",
  "更新 {0}/{1} 个。": "Updated {0}/{1}.",
  "未找到": "not found",
  "标题": "Titles",
  "正在下载（{0}）": "Downloading ({0})",
  "自定义路径（可选，例如 /run/media/deck/MySD/EpicGames）": "Custom path (optional, e.g. /run/media/deck/MySD/EpicGames)",
  "账号 ID {0}": "Account {0}",
  "（写入失败）": " (write failed)",
  "1. 用手机或电脑打开下面的链接(也可扫码),登录你的 Epic 账号": "1. Open the link below on your phone or PC (or scan the code) and sign in to Epic",
  "2. 登录后页面会显示一段内容,复制其中": "2. The page then shows a block of text — copy the",
  "3. 粘贴到下面,点「完成登录」。": "3. Paste it below and press \"Finish signing in\".",

  "的值(只复制那 32 位字符也可以)": " value (copying just those 32 characters is enough)",
  "下载并安装": "Download and install",
  "二维码生成失败:": "Could not generate the QR code: ",
  "共 {0} 个 · 已安装 {1}": "{0} games · {1} installed",
  "完成登录": "Finish signing in",
  "正在读取…": "Reading…",
  "正在读取可用磁盘…": "Reading available disks…",
  "没有匹配「{0}」的游戏": "No games match \"{0}\"",
  "自动 = 优先 GE-Proton，其次 Steam 自带的最新正式版": "Automatic = GE-Proton first, then Steam's newest stable Proton",
  "需下载 {0}": "Download {0}",

  "当前 {0}，点左侧在 Steam 里打开下载页": "Current {0} — press the button to open the download page in Steam",

  "刚刚": "just now",
  "{0} 分钟前": "{0} min ago",
  "{0} 小时前": "{0} h ago",
  "{0} 天前": "{0} d ago",

  // -- label maps (translated at the use site) ----------------------------
  "更新中": "Updating",
  "安装组件中": "Installing runtime",
  "出错": "Error",
  "字母 A → Z": "A → Z",
  "字母 Z → A": "Z → A",
  "游玩时间": "Playtime",
  "自动（跟随 Steam 语言）": "Automatic (follow Steam)",

  " · 版本 {0}": " · version {0}",
  "Legendary {0} · 插件 {1} · 数据目录 ~/homebrew/settings/EpicDeck": "Legendary {0} · plugin {1} · data ~/homebrew/settings/EpicDeck",

  // -- ProtonDB tiers (labels come from the backend in Chinese) ----------
  "白金": "Platinum",
  "黄金": "Gold",
  "白银": "Silver",
  "青铜": "Bronze",
  "不可用": "Borked",
  "待定": "Pending",

  // -- third-party titles -------------------------------------------------
  "中文名来源": "Chinese titles",
  "用 Steam 商店补全": "Fill in from the Steam store",
  "Epic 没有中文名时，尝试取 Steam 商店的官方中文名": "When Epic has no Chinese name, use the official one from Steam",

  "体积未知": "Size unknown",

};