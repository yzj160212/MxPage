#!/usr/bin/env python3
"""从上游最新 release tag 全量重建本地加固分支（默认 ``local``）。

分支模型
--------

    origin/main      上游纯镜像，一个自己的提交都不放
    origin/toolbox   工具链 + workflow（默认分支），永不重建
    origin/local     <上游 tag> + 1 个加固提交，每次从 tag 全量重建

remote 遵循 GitHub 惯例：``origin`` 是你的 fork，``upstream`` 是官方仓库。

``local`` 每次都从 tag 重建，历史永远线性，唯一可能冲突的是 ``security.patch``。
整个过程在**临时 worktree** 里进行，工作区、``main`` 和未提交改动都不受影响。

用法
----

    tools/local/sync_local.py                 # 最新 tag -> fork/local
    tools/local/sync_local.py --tag v0.3.3    # 指定 tag
    tools/local/sync_local.py --dry-run       # 只看会做什么
    tools/local/sync_local.py --no-push       # 本地重建，检查后再手动推

退出码：0 无事可做或成功，1 冲突/失败，2 环境或配置有问题。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_REL = "tools/local/local.config.json"


def log(msg: str = "") -> None:
    print(msg, flush=True)


def die(msg: str, code: int = 2) -> "NoReturn":  # type: ignore[name-defined]
    log(f"error: {msg}")
    raise SystemExit(code)


def run(args, cwd: Path, check: bool = True, input_text: str | None = None):
    proc = subprocess.run(args, cwd=str(cwd), check=False, input=input_text,
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and proc.returncode != 0:
        die(f"{' '.join(args)} 失败:\n{(proc.stderr or proc.stdout).strip()}")
    return proc


def load_config() -> dict:
    path = ROOT / CONFIG_REL
    if not path.exists():
        die(f"{CONFIG_REL} 不存在")
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def tag_key(tag: str, pattern: str) -> tuple[int, ...]:
    m = re.match(pattern, tag)
    if not m:
        return (0, 0, 0)
    return tuple(int(g) for g in m.groups() if g and g.isdigit()) or (0, 0, 0)


def conflicted_files(worktree: Path) -> list[str]:
    out = run(["git", "status", "--porcelain"], worktree).stdout
    return [line[3:].strip() for line in out.splitlines()
            if line[:2].strip() in {"U", "AA", "DU", "UD", "AU", "UA", "DD"}]


def conflict_help(worktree: Path, tag: str, conflicted: list[str], patch_rel: str) -> None:
    log()
    log(f"CONFLICT: {patch_rel} 打不到 {tag} 上。")
    for name in conflicted:
        log(f"  conflicted: {name}")
    log()
    log("上游改动了补丁改写过的那一行。手工处理：")
    log(f"  1. cd {worktree}   （tag 是 detached 检出）")
    log("  2. 把安全加固的语义重新落到改动后的代码上")
    log("  3. git diff " + tag + " > " + patch_rel + "    （回到 toolbox 分支覆盖补丁）")
    log("  4. tools/local/sync_local.py --force")


def install_assets(repo: Path, worktree: Path, cfg: dict) -> None:
    """把构建定义复制进重建后的分支。

    推送只会触发「被推的那个 ref 里存在」的 workflow，而 local 是从上游 tag 重建的，
    里面没有我们的 workflow。漏了这步的表现是：同步成功、分支更新了、构建永远不启动。
    """
    workflow_rel = cfg["build"]["workflow"]
    src = repo / workflow_rel
    if not src.exists():
        die(f"{workflow_rel} 缺失，无法接上构建", 1)
    dst = worktree / workflow_rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    log(f"installed workflow at {workflow_rel}")

    for rel in cfg["build"].get("assets", []):
        src = repo / rel
        if not src.exists():
            die(f"{rel} 缺失，构建会跑不起来", 1)
        dst = worktree / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if src.suffix == ".sh" or dst.name.endswith(".py"):
            dst.chmod(dst.stat().st_mode | 0o755)
        log(f"installed {rel}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=str(ROOT), help="fork 检出根目录（默认本仓库）")
    ap.add_argument("--tag", default=None, help="要基于的上游 tag（默认最新 release tag）")
    ap.add_argument("--upstream", default="upstream", help="官方仓库的 remote 名（默认 upstream）")
    ap.add_argument("--target", default="origin", help="local 分支推到哪个 remote（默认 origin）")
    ap.add_argument("--worktree", default=None, help="临时 worktree 路径（默认系统临时目录）")
    ap.add_argument("--no-push", action="store_true", help="只本地重建，不推")
    ap.add_argument("--dry-run", action="store_true", help="只报告会做什么，不改任何东西")
    ap.add_argument("--force", action="store_true", help="即使已基于目标 tag 也重建")
    ap.add_argument("--keep-worktree", action="store_true", help="保留临时 worktree")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists():
        die(f"{repo} 不是 git 检出")
    cfg = load_config()
    build_branch = cfg["repo"]["build_branch"]
    tag_re = cfg["repo"].get("tag_regex", r"^v?(\d+)\.(\d+)\.(\d+)$")
    patch_rel = cfg["patch"]

    if not (repo / patch_rel).exists():
        die(f"{patch_rel} 缺失；工具链应该在 {cfg['repo']['tooling_branch']} 分支上，你在对的分支吗？")

    touched = run(["git", "status", "--porcelain", "--", "tools/local"], repo).stdout.strip()
    if touched and not args.dry_run:
        die("tools/local 有未提交改动；先提交，重建才能读到确定的补丁：\n" + touched)

    if not args.dry_run:
        log(f"fetching {args.upstream} …")
        run(["git", "fetch", args.upstream, "--tags", "--prune"], repo)

    tags = [t.strip() for t in run(["git", "tag", "--list"], repo).stdout.splitlines()
            if re.match(tag_re, t.strip())]
    if args.tag:
        target_tag = args.tag
    elif tags:
        target_tag = max(tags, key=lambda t: tag_key(t, tag_re))
    else:
        die("没找到上游 release tag")

    # local 永远是「tag + 1 个加固提交」，所以它基于哪个 tag 可以从分支本身推出来，
    # 不需要任何状态文件。CI 里只有 origin/local（没有本地 local 分支），本地反之。
    branch_ref = None
    for ref in (f"refs/remotes/{args.target}/{build_branch}", f"refs/heads/{build_branch}"):
        if run(["git", "rev-parse", "--verify", ref], repo, check=False).returncode == 0:
            branch_ref = ref
            break
    synced = None
    if branch_ref:
        parent = run(["git", "rev-parse", f"{branch_ref}^"], repo, check=False)
        if parent.returncode == 0:
            sha = parent.stdout.strip()
            synced = next((t for t in tags if run(["git", "rev-parse", t], repo).stdout.strip() == sha),
                          f"<unknown:{sha[:9]}>")

    log(f"newest upstream tag: {target_tag}   current {build_branch} built on: {synced or '(branch absent)'}")

    if not args.force and synced and tag_key(target_tag, tag_re) < tag_key(synced, tag_re):
        die(f"{target_tag} 比当前 {build_branch} 的基底 {synced} 更旧，拒绝倒退", 1)

    patch = (repo / patch_rel).read_text(encoding="utf-8")

    if args.dry_run:
        log(f"[dry-run] 会基于 {target_tag} 重建 {build_branch}：")
        log(f"  patch     {patch_rel}  ({len(patch.splitlines())} 行)")
        log(f"  workflow  {cfg['build']['workflow']}")
        log(f"  assets    {', '.join(cfg['build'].get('assets', []))}")
        log(f"  然后 push 到 {args.target}/{build_branch}")
        return 0

    worktree = Path(args.worktree) if args.worktree else Path(tempfile.mkdtemp(prefix="mxpage-local-"))
    if worktree.exists() and any(worktree.iterdir()):
        die(f"worktree 路径 {worktree} 非空")
    worktree.parent.mkdir(parents=True, exist_ok=True)

    log(f"creating scratch worktree at {worktree}")
    added = run(["git", "worktree", "add", "--detach", "-f", str(worktree), target_tag], repo, check=False)
    if added.returncode != 0:
        die("创建 worktree 失败:\n" + added.stderr.strip(), 1)

    try:
        log(f"applying {patch_rel} …")
        applied = run(["git", "apply", "--3way", "--whitespace=nowarn", "-"], worktree,
                      check=False, input_text=patch)
        if applied.returncode != 0:
            conflict_help(worktree, target_tag, conflicted_files(worktree), patch_rel)
            args.keep_worktree = True
            log("\n(worktree 保留着让你解决冲突)")
            return 1
        log("security patch applied cleanly")

        install_assets(repo, worktree, cfg)

        run(["git", "add", "-A"], worktree)
        if not run(["git", "status", "--porcelain"], worktree).stdout.strip():
            die("补丁没有产生任何改动 —— 没东西可提交", 1)

        run(["git", "commit", "-qm", f"local: 基于上游 {target_tag} 的本地加固构建",
             "-m", f"Rebuilt on upstream {target_tag} from {patch_rel}.\n\n"
                   "补丁内容见该文件；上游改动到补丁所覆盖的行时，sync_local.py 会停下来提示。"],
            worktree)
        commit = run(["git", "rev-parse", "HEAD"], worktree).stdout.strip()
        new_tree = run(["git", "rev-parse", "HEAD^{tree}"], worktree).stdout.strip()
        log(f"committed {commit[:9]} on top of {target_tag}")

        # 是否真的需要更新，不能只看「基底 tag 一样」：补丁或 workflow 改过也要重建。
        # 比较重建结果的 tree 与现有分支的 tree，内容一致才算无事可做。
        existing_tree = None
        for ref in (f"refs/remotes/{args.target}/{build_branch}", f"refs/heads/{build_branch}"):
            probe = run(["git", "rev-parse", "--verify", f"{ref}^{{tree}}"], repo, check=False)
            if probe.returncode == 0:
                existing_tree = probe.stdout.strip()
                break
        if existing_tree == new_tree and not args.force:
            log(f"nothing to do — {build_branch} 内容无变化（tree {new_tree[:9]}）")
            return 0

        moved = run(["git", "branch", "-f", build_branch, commit], repo, check=False)
        if moved.returncode != 0:
            die(f"更新 {build_branch} 失败（是不是在别处检出了？）:\n{moved.stderr.strip()}", 1)
        log(f"branch {build_branch} -> {commit[:9]}  (base {target_tag})")

        if args.no_push:
            log(f"--no-push: 本地已重建，确认后跑 `git push --force-with-lease {args.target} {build_branch}`")
            return 0

        log(f"pushing {build_branch} to {args.target} …")
        run(["git", "fetch", args.target], repo, check=False)  # 让 --force-with-lease 有最新租约
        push = run(["git", "push", "--force-with-lease", args.target, f"{build_branch}:{build_branch}"], repo, check=False)
        if push.returncode != 0:
            die("push 失败:\n" + (push.stderr or push.stdout).strip(), 1)
        log((push.stderr or push.stdout).strip())
        log(f"done — {build_branch} is {target_tag} + local hardening")
        return 0
    finally:
        if not args.keep_worktree:
            run(["git", "worktree", "remove", "--force", str(worktree)], repo, check=False)
            if worktree.exists() and worktree.name.startswith("mxpage-local-"):
                shutil.rmtree(worktree, ignore_errors=True)
        else:
            log(f"scratch worktree left at {worktree}")


if __name__ == "__main__":
    sys.exit(main())