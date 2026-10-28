#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""motifs.py — 机制母题图形

不是按国家套模板，而是按**这个理论自己的机制形状**取形：
  gate    闸门：外部知识要穿过自身能力才变成可吸收量
  copy    复制：一份变两份，原件不减少（非竞争性）
  fork    分叉：一个源头分出多条通道
  ladder  阶梯：逐级递进、边际递减
  loop    回路：正反馈自我强化
  stack   堆叠：层层累积
  contrast 对照：两种情形并置
  flow    流转：单向传导，逐段损耗

卡片在 frontmatter 写 `motif: gate`，渲染器据此取形；没写则回落到国家徽记。
每个图形 viewBox 160×160，stroke=currentColor，由外层控制颜色与大小。
"""

MOTIF_NAMES = {
    "gate": "闸门",
    "copy": "复制",
    "fork": "分叉",
    "ladder": "阶梯",
    "loop": "回路",
    "stack": "堆叠",
    "contrast": "对照",
    "flow": "流转",
}


def _svg(body: str) -> str:
    return (
        '<svg viewBox="0 0 160 160" fill="none" stroke="currentColor" '
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
        f'{body}</svg>'
    )


def _arrow(x1, y1, x2, y2, dash=""):
    d = ' stroke-dasharray="4 4"' if dash else ""
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"{d}/>'
            f'<path d="M{x2 - 7},{y2 - 4} L{x2},{y2} L{x2 - 7},{y2 + 4}"/>')


# 闸门：一个点穿过两道竖线，出来变成实心块
def gate() -> str:
    return _svg(
        '<circle cx="26" cy="80" r="9"/>'
        + _arrow(38, 80, 60, 80)
        + '<line x1="70" y1="46" x2="70" y2="114" stroke-width="2.4"/>'
        + '<line x1="84" y1="46" x2="84" y2="114" stroke-width="2.4"/>'
        + _arrow(92, 80, 112, 80)
        + '<rect x="118" y="66" width="28" height="28"/>'
        + '<line x1="52" y1="124" x2="118" y2="124" stroke-width="1" opacity=".45"/>'
        + '<text x="52" y="140" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">门槛</text>'
    )


# 复制：一份原样不动，旁边多出两份
def copy() -> str:
    return _svg(
        '<rect x="14" y="58" width="34" height="44"/>'
        + _arrow(52, 80, 74, 80)
        + '<rect x="82" y="36" width="34" height="44"/>'
        + '<rect x="82" y="88" width="34" height="44" stroke-dasharray="4 4"/>'
        + '<path d="M104,80 L118,80" stroke-width="1" opacity=".5"/>'
        + '<text x="14" y="122" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">原件不减</text>'
    )


# 分叉：一条主线分出三条
def fork() -> str:
    return _svg(
        '<circle cx="22" cy="80" r="8"/>'
        + _arrow(32, 80, 58, 80)
        + '<line x1="58" y1="80" x2="76" y2="80"/>'
        + '<path d="M76,80 C92,80 92,38 108,38"/>'
        + '<path d="M76,80 L108,80"/>'
        + '<path d="M76,80 C92,80 92,122 108,122"/>'
        + '<rect x="110" y="28" width="30" height="20"/>'
        + '<rect x="110" y="70" width="30" height="20"/>'
        + '<rect x="110" y="112" width="30" height="20"/>'
        + '<text x="22" y="112" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">一个源</text>'
    )


# 阶梯：逐级上升，台阶越来越窄
def ladder() -> str:
    return _svg(
        '<path d="M16,126 L46,126 L46,100 L76,100 L76,74 L106,74 L106,48 L136,48"/>'
        + '<path d="M136,48 L136,32" stroke-dasharray="3 4"/>'
        + '<circle cx="46" cy="100" r="2.6" fill="currentColor"/>'
        + '<circle cx="76" cy="74" r="2.6" fill="currentColor"/>'
        + '<circle cx="106" cy="48" r="2.6" fill="currentColor"/>'
        + '<text x="16" y="144" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">边际递减</text>'
    )


# 回路：自我强化
def loop() -> str:
    return _svg(
        '<path d="M46,58 A34,34 0 1,1 46,102"/>'
        + '<path d="M46,58 L34,46 M46,58 L58,46"/>'
        + '<circle cx="80" cy="80" r="6" fill="currentColor"/>'
        + '<text x="60" y="146" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">正反馈</text>'
    )


# 堆叠：层层累积
def stack() -> str:
    return _svg(
        '<rect x="30" y="104" width="100" height="20"/>'
        + '<rect x="40" y="78" width="80" height="20"/>'
        + '<rect x="52" y="52" width="56" height="20"/>'
        + '<rect x="66" y="28" width="28" height="18"/>'
        + '<text x="30" y="146" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">存量累积</text>'
    )


# 对照：两种情形并置
def contrast() -> str:
    return _svg(
        '<rect x="14" y="40" width="54" height="72"/>'
        + '<rect x="92" y="40" width="54" height="72"/>'
        + '<line x1="80" y1="28" x2="80" y2="124" stroke-dasharray="4 5" opacity=".6"/>'
        + '<text x="30" y="136" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">A</text>'
        + '<text x="112" y="136" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">B</text>'
    )


# 流转：单向传导，逐段变细
def flow() -> str:
    return _svg(
        '<path d="M14,80 L58,80" stroke-width="3"/>'
        + _arrow(58, 80, 78, 80)
        + '<path d="M82,80 L120,80" stroke-width="1.8"/>'
        + _arrow(120, 80, 140, 80)
        + '<circle cx="146" cy="80" r="4" fill="currentColor"/>'
        + '<text x="14" y="112" font-size="9" stroke="none" fill="currentColor" '
          'opacity=".7" font-family="sans-serif">逐段损耗</text>'
    )


BUILDERS = {
    "gate": gate, "copy": copy, "fork": fork, "ladder": ladder,
    "loop": loop, "stack": stack, "contrast": contrast, "flow": flow,
}


def pick_motif(card) -> str:
    """按卡片声明的母题取形；未声明返回空串（调用方回落）。"""
    key = str(card.get("motif") or "").strip().lower()
    fn = BUILDERS.get(key)
    return fn() if fn else ""


def motif_name(card) -> str:
    key = str(card.get("motif") or "").strip().lower()
    return MOTIF_NAMES.get(key, "")
