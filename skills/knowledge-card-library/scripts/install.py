#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""install.py — 把 knowledge-card-library 装进 DeepSeek Harness

做三件事：
  1. 复制技能到 ~/.agents/skills/knowledge-card-library
  2. 在 ~/.dsh/skills/ 建立链接（symlink 失败则用 Windows junction，再失败则提示手动）
  3. 初始化卡片库 ~/Desktop/知识卡片库

用法:
    python scripts/install.py [--force] [--no-init]
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent
NAME = "knowledge-card-library"
SKILL_STORE = Path.home() / ".agents" / "skills"
HARNESS_LINKS = Path.home() / ".dsh" / "skills"
LIB_HOME = Path("D:/知识卡片库")

if sys.platform == "win32":
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".git")


def copy_skill(force: bool) -> Path:
    dst = SKILL_STORE / NAME
    if dst.exists():
        if not force:
            print(f"  已存在，跳过复制: {dst}  （要覆盖加 --force）")
            return dst
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SRC, dst, ignore=IGNORE)
    print(f"  已复制到: {dst}")
    return dst


def _usable(link: Path) -> bool:
    """链接是否真的能读到内容（Windows 上 symlink 可能建成功但解析为空）。"""
    try:
        return bool(os.listdir(link))
    except OSError:
        return False


def link_skill(target: Path) -> str:
    HARNESS_LINKS.mkdir(parents=True, exist_ok=True)
    link = HARNESS_LINKS / NAME
    if link.is_symlink() or link.is_file():
        link.unlink()
    elif link.exists():
        shutil.rmtree(link)

    try:
        os.symlink(target, link, target_is_directory=True)
        if _usable(link):
            print(f"  已建立符号链接: {link} -> {target}")
            return "symlink"
        link.unlink()
        print("  符号链接解析为空，改用目录联接")
    except OSError as e:
        print(f"  符号链接不可用（{e.__class__.__name__}），改用目录联接")

    if sys.platform == "win32":
        ps = (
            "$l=Join-Path $env:USERPROFILE '.dsh\\skills\\" + NAME + "';"
            "$s='" + str(target).replace("'", "''") + "';"
            "if(Test-Path $l){Remove-Item $l -Force -Recurse};"
            "New-Item -ItemType Junction -Path $l -Target $s | Out-Null"
        )
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                           capture_output=True, text=True)
        if r.returncode == 0 and _usable(link):
            print(f"  已建立目录联接(junction): {link} -> {target}")
            return "junction"

    # 最后兜底：复制（会有两份副本，改完记得重装）
    if link.exists():
        shutil.rmtree(link)
    shutil.copytree(target, link, ignore=IGNORE)
    print(f"  链接不可用，已复制副本到: {link}（两份内容会各自独立）")
    return "copy"


def init_library():
    LIB_HOME.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(SRC / "scripts"))
    os.environ.setdefault("KCARD_HOME", str(LIB_HOME))
    import kcard
    for name in kcard.shelf_names():
        (LIB_HOME / "cards" / name).mkdir(parents=True, exist_ok=True)
    cat = kcard.build_index()
    print(f"  卡片库就绪: {LIB_HOME}（现有 {cat['count']} 张卡，"
          f"{len(kcard.shelf_names())} 个书架）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="覆盖已安装的技能")
    ap.add_argument("--no-init", action="store_true", help="不初始化卡片库")
    a = ap.parse_args()

    print("安装 knowledge-card-library")
    print(f"  源目录: {SRC}")
    dst = copy_skill(a.force)
    mode = link_skill(dst)
    if not a.no_init:
        init_library()
    print(f"\n完成（链接方式: {mode}）。重开会话后技能生效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
