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

## 3. 验证环境是否真的可用

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

## 4. 部署到 Steam Deck（可选）

需要在 `~/.ssh/` 下有一把已装进设备 `authorized_keys` 的私钥。没有的话：

```bash
pip install paramiko
python .tools/dssh.py          # 用设备密码把公钥装进 authorized_keys（密码默认 steamdeck）
```

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

## 5. 实机调试（CDP）

Deck 上 Steam 自带 CEF 调试端口，`scripts/cdp_*.py` 就是通过它读 DOM、发按键、截图。
这些脚本要在**设备上**跑：

```bash
scp -i ~/.ssh/epicdeck_steamdeck scripts/cdp_*.py deck@<设备IP>:/tmp/
ssh -i ~/.ssh/epicdeck_steamdeck deck@<设备IP> 'cd /tmp && python3 cdp_eval.py "document.title"'
```

完整用法见 [CONTRIBUTING](../CONTRIBUTING.md) 的「实机调试」一节。三条必须记住的：

1. **不要注入 Escape** —— 会让 Steam 导航彻底失效，只能重启 Steam。
2. **不要用 JS `.focus()` 造状态** —— DOM 焦点到了、Steam 的 `gpfocus` 没动，后续按键会被
   路由到旧节点。验收要用真实点击（`Input.dispatchMouseEvent`）或真实按键。
3. **先查屏保** —— 屏保亮着时 CDP 注入的按键完全无效，现象和"导航坏了"一模一样。
   用 `XTestFakeKeyEvent` 发一个 Shift 唤醒（`/tmp/xwake.py`，`ctypes` 调 libXtst）。

---

## 6. 新机器检查清单

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

## 7. 这个仓库的特殊约定

- **行尾**：`.gitattributes` 强制源码 LF。Windows 上若用 CRLF，`scripts/deploy.sh`
  到 Deck 上会报 `pipefail: invalid option name`。
- **不入库**：`HANDOFF.md`（本地交接）、`dist/`、`EpicDeck-v*.zip`、`node_modules/`、
  `__pycache__/`。见 `.gitignore`。
- **版本号**：开发期用 `0.9.x-beta.N`，发布才改成 `0.9.x`；同时改 `README.md` 的版本行。
- **锁文件**：`pnpm-lock.yaml` 必须保持提交。改依赖后跑一次 `pnpm install` 再一起提交，
  否则 CI 的 `--frozen-lockfile` 会拒装。
