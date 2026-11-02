# MxPage 本地加固版（fork 说明）

上游：[ziguishian/MxPage](https://github.com/ziguishian/MxPage) —— 开源 AI 电商图片工作台。
本 fork **不是汉化版**（上游界面本来就是中文），而是在上游代码之上加了一层**安全加固**，
并自动跟随上游发版重新构建。

产物只针对 **Apple Silicon (arm64)**，ad-hoc 签名、未公证，个人自用。

## 三条分支，各管一件事

| 分支 | 内容 | 会不会被重建 |
| --- | --- | --- |
| `main` | 上游纯镜像，一个自己的提交都不放 | 不重建 |
| `toolbox` | 工具链 + 两个 workflow（**默认分支**） | 不重建 |
| `local` | `<上游 tag>` + `1` 个加固提交 | 每次从 tag 全量重建 |

- `main` 保持纯净 → GitHub 的「Sync fork」按钮永远安全，不会变成「丢弃你的提交」。
- `local` 每次重建 → 永远线性、不累积 merge 冲突；唯一可能冲突的只有 `security.patch`。

## 加固了什么

全部收敛在一个文件里：`tools/local/security.patch`。应用对象是上游代码，改动很小。

| 位置 | 问题 | 加固 |
| --- | --- | --- |
| `lib/storage/asset-manager.ts` | `readStorageFile` 直接 `path.join(STORAGE_ROOT, 用户输入)`，`..` 可越出根目录，读取进程可读的任意文件 | 增加 `realpath` + 根目录前缀断言，符号链接也被拦 |
| `app/api/files/[...path]` | 公开 GET 路由未校验路径段 | 显式拒绝 `..`/`.`/分隔符/NUL/绝对路径段，返回 400 |
| `middleware.ts`（新增） | 除 Agent 路由外的写接口没有跨站校验；`sameOrigin` 信任 Host，可被 DNS rebinding 绕过 | 全 `/api` 要求 loopback Host；写请求要求同源 Origin 与 `Sec-Fetch-Site` |
| `lib/agent/http.ts` | `sameOrigin` 用 Host 反推可信来源 | 增加 loopback Host 白名单 |
| `desktop/agent-policy.cjs` | 路径校验用 `path.resolve`，批准目录内的符号链接可越界 | 改用 `realpathSync` |

同时新增 3 个回归测试文件（12 例），`npm test` 会一起跑：

- `tests/storage-path-traversal.test.ts` —— 越界、符号链接、正常读取
- `tests/api-origin-guard.test.ts` —— DNS rebinding、跨站写、同源放行
- `tests/desktop-policy.test.ts` —— 批准目录内的符号链接越界

**未覆盖的已知项**（上游层面的设计取舍，本 fork 未改）：上游返回的图片 URL 下载无 SSRF 校验；
打包 `asar: false` + ad-hoc 签名；`package-lock.json` 混用了 `registry.npmmirror.com` 的部分条目
（都有 integrity 锚定）。这些不影响本机单用户使用。

## 自动跟版怎么走

```
GitHub 定时任务（每天 UTC 03:23 / 15:23）
  │  比对上游最新 release tag 与 local 分支的父提交
  │  已最新 → 只写心跳提交 .watch/last-check
  ▼  发现新版
从上游新 tag 全量重建 local（应用 security.patch + 复制 workflow）
  ▼
显式 dispatch local-build.yml（bot 推送不会触发 workflow，dispatch 才会）
  ▼
macos-15 runner：Node 24 → 依赖 → 测试 → Next 构建 → electron-builder arm64 zip → 校验 → 发 Release
  ▼
Release 里的 MxPage-<version>-macos-arm64.zip
```

## 本机操作

```bash
# 重建 local 分支（本地看结果，不推）
python3 tools/local/sync_local.py --no-push
python3 tools/local/sync_local.py            # 通了就推，并会自动跟上游

# 本地构建（需要 Node 24；本脚本会自动用 /opt/homebrew/opt/node@24）
bash tools/local/build-local.sh             # 产出 dist-desktop/MxPage-<version>-macos-arm64.zip

# 装到 /Applications（不传参数就取 fork 的最新 release）
bash tools/local/install.sh
bash tools/local/install.sh /path/to/MxPage-0.3.3-macos-arm64.zip
```

## 三个必须知道的代价

1. **只支持 arm64**（Apple Silicon）。Intel 机器跑不了这个包。
2. **ad-hoc 签名**：没有 Developer ID 就无法公证，首次打开会被 Gatekeeper 拦一次，
   需要右键 → 打开，或 `xattr -dr com.apple.quarantine "/Applications/MxPage.app"`。
3. **不要用 `brew upgrade --cask` 装官方版覆盖它**。官方版不带加固补丁；要用官方版就先
   `brew uninstall --cask mxpage`。

## 上游改动到补丁所在行时

`sync_local.py` 会停下来打印冲突文件，并保留临时 worktree：

```
CONFLICT: tools/local/security.patch 打不到 v0.3.4 上。
  conflicted: lib/storage/asset-manager.ts
```

处理：进 worktree 把加固语义重新落到改动后的代码上 → 在 `toolbox` 分支用
`git diff <tag> > tools/local/security.patch` 覆盖补丁 → `tools/local/sync_local.py --force`。
这是设计行为，不要改成自动吞掉冲突。

## 为什么 `main` 上什么都不能放

`main` 一旦有自己的提交，GitHub 页面上 fork 的按钮就从「更新分支」变成「丢弃 N 个提交」，
一次误点就没了。所以工具链全部放在 `toolbox`，上游同步永远走 `main`。