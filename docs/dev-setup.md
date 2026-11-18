# 开发环境搭建（新电脑）

本文是"换一台机器从零跑起来"的清单。每一步都给了验证命令和预期结果，
照着做能在 10 分钟内把仓库、依赖、测试、打包、部署这条链走通。

> 目标平台是 Steam Deck（SteamOS 3.x，Python 3.11）。Windows 只作为开发机，
> 前端产物与后端脚本在两边行为一致；打包、测试都可以在 Windows 上离线跑。

---

## 1. 需要的工具

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | **22.x**（CI 用 20，22 实测可用） | 跑 rollup / tsc |
| pnpm | **9.x** | 仓库有 `pnpm-lock.yaml`，`package.json` 里已声明 `packageManager: pnpm@9.15.9` |
| Python | **3.11+**（本机 3.13） | 后端脚本、回归、打包；**不需要第三方包** |
| Git | 2.40+ | 行尾规则见 `.gitattributes` |
| OpenSSH | 任意 | 部署到 Deck、推送 GitHub |

Python 侧没有任何 pip 依赖：`py_modules/` 全部是标准库，插件运行时依赖的 `decky`
由 Decky Loader 注入，离线测试里用 `scripts/smoke_backend.py` 里的 stub 顶替。

可选：`pip install paramiko`（只在 `.tools/dssh.py` 用密码登录设备时需要）。

---

## 2. 一次性安装

```bash
git clone git@github.com:AvalonO98/EpicDeck.git
cd EpicDeck

# 1) 用 corepack 装 pnpm（会自动读 package.json 的 packageManager）
corepack enable pnpm
corepack prepare pnpm@9.15.9 --activate
pnpm -v                       # 期望 9.15.9

# 2) 装依赖（严格按锁文件，和 CI 一致）
pnpm install --frozen-lockfile

# 3) 类型检查 + 构建
pnpm exec tsc --noEmit        # 期望：无输出
pnpm build                    # 期望：created dist in ~6s
```

国内网络下 `registry.npmjs.org` 拉 200 多个包可能很慢（单包元数据就要 7 秒）。
可以临时换镜像，锁文件里的 `integrity` 会照常校验：

```bash
pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com
```

---

## 3. GitHub 推送配置

一次性配好，之后 `git push` 就是一条命令。四条东西：**密钥、公钥、`~/.ssh/config`、remote**。

### 3.1 生成密钥（每台机器一把）

```bash
ssh-keygen -t ed25519 -N "" -C "epicdeck@$(hostname)" -f ~/.ssh/id_ed25519_epicdeck
```

不要复用其他项目的密钥：一把钥匙对应一台机器，泄露了只吊销一把。

### 3.2 把公钥加到 GitHub

```bash
cat ~/.ssh/id_ed25519_epicdeck.pub
```

两种加法，能力不同——**按用途选，别默认选第一种**：

| | 账号密钥（Settings → SSH and GPG keys） | 仓库级 Deploy key（Repo → Settings → Deploy keys） |
|---|---|---|
| 作用范围 | 账号下所有仓库 | 只有那一个仓库 |
| 能否 push | 能 | **必须勾 "Allow write access"**，否则只能拉 |
| 能否建 Release / 调 API | 能（另配 token） | **不能**，Release 只能在网页建 |
| 适合 | 个人开发机 | CI、单仓库只读或写入 |

判定方式：`ssh -T git@github.com` 回 `Hi <用户名>!` 是账号密钥，
回 `Hi <owner>/<repo>!` 是 deploy key。

### 3.3 `~/.ssh/config`（必需，22 端口经常被封）

很多网络（公司网、校园网、部分家宽）直接封 `github.com:22`，现象是：

```bash
ssh -T git@github.com
# ssh: connect to host github.com port 22: Connection refused
```

**这是端口不通，不是密钥错误**（密钥错是 `Permission denied (publickey)`）。
GitHub 官方支持 SSH over 443：

```sshconfig
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/id_ed25519_epicdeck
  IdentitiesOnly yes
```

`IdentitiesOnly yes` 很重要：不加的话 ssh 会把 agent 里所有钥匙挨个献给服务器，
很容易撞上 "Too many authentication failures"。

首次连接要核对主机指纹（GitHub 公布的是
`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`，ED25519）：

```bash
ssh-keyscan -p 443 -t ed25519 ssh.github.com >> ~/.ssh/known_hosts
ssh-keygen -lf ~/.ssh/known_hosts | grep ssh.github.com     # 对上再继续
```

### 3.4 验证

```bash
ssh -T git@github.com
# 期望：Hi <用户名>! You've successfully authenticated, but GitHub does not provide shell access.
```

看到 `Hi ...` 就通了（这条命令返回码是 1，属正常，别当失败）。

### 3.5 绑定远端与提交身份

```bash
git remote add origin git@github.com:<owner>/<repo>.git
git fetch origin main
git branch --set-upstream-to=origin/main main    # 之后 git status 会显示领先/落后几个提交

git config --global user.name  "<GitHub 用户名>"
git config --global user.email "<GitHub 用户名>@users.noreply.github.com"
```

`user.email` 用 GitHub 提供的 noreply 地址，提交里就不会泄露真实邮箱。
本仓库另外建议：

```bash
git config core.autocrlf false
git config core.quotepath false      # 中文文件名不显示成 \344\277\256
```

### 3.6 日常推送

```bash
git status                      # 先看改了什么
git add -A
git commit -F msg.txt           # 多行信息写文件，避免 shell 把反引号/尖括号吃掉
git push                        # 已设 upstream，不用再写 origin main
```

打版本标签并推送：

```bash
git tag -a v0.9.5 -m "EpicDeck 0.9.5"
git push origin v0.9.5
```

> 提交信息里有反引号、`<TabId>` 这类字符时**一定用 `-F 文件`**。直接用
> `git commit -m "…"` 会被 bash 当成命令替换，把信息改得面目全非（本项目踩过）。

### 3.7 报错对照

| 现象 | 含义 | 处理 |
|---|---|---|
| `Connection refused`（22 端口） | 网络封了端口 | 改用 3.3 的 443 配置 |
| `Permission denied (publickey)` | 端口通，但公钥没被接受 | 公钥没加到 GitHub / `IdentityFile` 指错 / 用了别的 key |
| `Host key verification failed` | 没记录过这个主机 | `ssh-keyscan` 写入 `known_hosts`，或先手动连一次确认指纹 |
| `Repository not found` | 认证过了但没权限 | deploy key 没勾 write access，或仓库名写错 |
| `Updates were rejected` | 远端有你没有的提交 | 先 `git pull --rebase`，别直接 `--force` |
| `fatal: not a git repository` | 当前目录不是仓库根 | `cd` 到仓库根，或 `git init` |

---

## 4. 验证环境是否真的可用

```bash
pnpm test                     # = python3 scripts/regression.py，期望 10/10
python scripts/regression.py --build   # 12/12（连 rollup 与 decky zip 一起验）
python scripts/smoke_backend.py        # 后端断言，期望 98/98
pnpm package                  # 产出 EpicDeck-v<版本>.zip（约 282 KB）
```

四条全绿说明：Node、pnpm、Python、打包链路都通了。

> `pnpm package` 在**受限沙箱**里可能失败：脚本要清空 `.pkg/` 暂存目录（一次删 58 个文件），
> 有些环境会拦"批量删除"并返回 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。这不是代码问题，
> 换到普通终端跑即可。

---

## 5. 部署到 Steam Deck（可选）

需要在 `~/.ssh/` 下有一把已装进设备 `authorized_keys` 的私钥。没有的话：

```bash
pip install paramiko
python scripts/install_deck_key.py        # 生成密钥（若没有）并用密码装进 authorized_keys
python scripts/install_deck_key.py --probe   # 只看 hostname / 系统 / IP
```

密码走 `DECK_PASSWORD` 环境变量或 `--password`，不传就依次试 SteamOS 的两个已知默认值。
设备地址默认 `steamdeck.local`（mDNS 时灵时不灵），可以 `--host 192.168.x.x` 或
`DECK_HOST=…` 指定。

之后：

```bash
# 在线确认（失败两次就停，不要循环重试）
ssh -i ~/.ssh/epicdeck_steamdeck deck@<设备IP> 'echo online'

# 后端 + 前端（tar 管道，避免多文件 scp 丢子目录）
cd epicdeck
tar czf - main.py package.json plugin.json py_modules/*.py dist/index.js \
  | ssh -i ~/.ssh/epicdeck_steamdeck deck@<设备IP> \
      'rm -rf /tmp/epd && mkdir -p /tmp/epd && tar xzf - -C /tmp/epd && \
       echo steamdeck | sudo -S sh -c "P=/home/deck/homebrew/plugins/EpicDeck; \
         cp -f /tmp/epd/main.py /tmp/epd/package.json /tmp/epd/plugin.json $P/; \
         cp -f /tmp/epd/py_modules/*.py $P/py_modules/; cp -f /tmp/epd/dist/index.js $P/dist/; \
         rm -rf $P/__pycache__ $P/py_modules/__pycache__; systemctl restart plugin_loader"'

# 只换前端（不重启 Steam）
scp -i ~/.ssh/epicdeck_steamdeck scripts/cdp_reload.py deck@<设备IP>:/tmp/
ssh -i ~/.ssh/epicdeck_steamdeck deck@<设备IP> 'cd /tmp && python3 cdp_reload.py EpicDeck'
```

判断前端真的换了：**设置页底部的版本号**，不要只看脚本打印的 `RELOADED`。

---

## 6. 实机调试（CDP）

Deck 上 Steam 自带 CEF 调试端口，`scripts/cdp_*.py` 就是通过它读 DOM、发按键、截图。
这些脚本要在**设备上**跑：

```bash
# 开发机上：把 JS 送进设备执行（会自动上传 cdp_eval.py）
python scripts/remote_eval.py probe.js
echo 'document.title' | python scripts/remote_eval.py -
```

`DECK_HOST` / `DECK_USER` / `DECK_KEY` 可覆盖默认的 `steamdeck.local` / `deck` /
`~/.ssh/epicdeck_steamdeck`。其余 `cdp_*.py` 需要拷到设备上跑：

```bash
scp -i ~/.ssh/epicdeck_steamdeck scripts/cdp_*.py deck@<设备IP>:/tmp/
ssh -i ~/.ssh/epicdeck_steamdeck deck@<设备IP> 'cd /tmp && python3 cdp_key.py down 1'
```

完整用法见 [CONTRIBUTING](../CONTRIBUTING.md) 的「实机调试」一节。三条必须记住的：

1. **不要注入 Escape** —— 会让 Steam 导航彻底失效，只能重启 Steam。
2. **不要用 JS `.focus()` 造状态** —— DOM 焦点到了、Steam 的 `gpfocus` 没动，后续按键会被
   路由到旧节点。验收要用真实点击（`Input.dispatchMouseEvent`）或真实按键。
3. **先查屏保** —— 屏保亮着时 CDP 注入的按键完全无效，现象和"导航坏了"一模一样。
   先看 `Screensaver_uid2` 页面的 `document.body.innerText`（有钟点就是还亮着），
   再用 `scripts/cdp_wake.py` 唤醒（`XTestFakeKeyEvent` 发一个 Shift）。

---

## 7. 新机器检查清单

- [ ] `node -v` → v22.x
- [ ] `pnpm -v` → 9.15.9（或 9.x）
- [ ] `python --version` → 3.11+
- [ ] `pnpm install --frozen-lockfile` 成功，`node_modules/.pnpm` 存在
- [ ] `pnpm exec tsc --noEmit` 无输出
- [ ] `pnpm build` 产出 `dist/index.js`
- [ ] `pnpm test` 10/10
- [ ] `python scripts/regression.py --build` 12/12
- [ ] `git config user.name` / `user.email` 已设
- [ ] `ssh -T git@github.com` 能认到账号（否则 push 会被 `Permission denied (publickey)` 挡住）
- [ ] `~/.ssh/epicdeck_steamdeck` 存在且能登录设备（部署才需要）

---

## 8. 这个仓库的特殊约定

- **行尾**：`.gitattributes` 强制源码 LF。Windows 上若用 CRLF，`scripts/deploy.sh`
  到 Deck 上会报 `pipefail: invalid option name`。
- **不入库**：`HANDOFF.md`（本地交接）、`dist/`、`EpicDeck-v*.zip`、`node_modules/`、
  `__pycache__/`。见 `.gitignore`。
- **版本号**：开发期用 `0.9.x-beta.N`，发布才改成 `0.9.x`；同时改 `README.md` 的版本行。
- **锁文件**：`pnpm-lock.yaml` 必须保持提交。改依赖后跑一次 `pnpm install` 再一起提交，
  否则 CI 的 `--frozen-lockfile` 会拒装。
