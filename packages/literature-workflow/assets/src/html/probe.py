#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probe —— 用真实浏览器量版式，替掉"像素估算"

v1 的自检全靠 `estimate_page_height()` 把 CSS 折算成像素再相加。它只判上界、
不判下界，而且 deckkit 的 `fitBody()` 会在运行时把正文偷偷缩到 0.6 倍——
缩了也看不见。结果就是：报告说"余量 47px，通过"，投影出来下半页一片空白。

这里的做法：deckkit 带了一个 `?probe=1` 开关，打开后逐页把正文的自然高度
（scrollHeight）与可用高度（clientHeight）量出来，塞进 `<title>`；本模块用
无头浏览器 `--dump-dom` 把标题读回来。

拿不到浏览器就返回 {}，调用方降级为"未实测"，不阻塞出成品。
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

__all__ = ["probe_deck", "available"]

_CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def _chrome() -> str | None:
    for c in _CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    return None


def available() -> bool:
    return _chrome() is not None


def probe_deck(html_path: str | Path, timeout: int = 120) -> dict:
    """返回 {页号: {need, avail, inner_over, title}}；失败返回 {}。"""
    chrome = _chrome()
    if not chrome:
        return {}
    p = Path(html_path)
    if not p.exists():
        return {}
    url = p.resolve().as_uri() + "?probe=1"
    cmd = [
        chrome, "--headless=new", "--no-sandbox", "--disable-gpu",
        "--hide-scrollbars", "--window-size=1400,820",
        "--virtual-time-budget=8000", "--dump-dom", url,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        return {}
    m = re.search(r"PROBE:(\[.*?\])</title>", r.stdout, re.S)
    if not m:
        return {}
    try:
        rows = json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}
    return {int(r["i"]): r for r in rows if isinstance(r, dict) and "i" in r}
