#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_page.py — 把卡片库导出成一个可双击打开的单文件浏览页

不依赖 dsh、不依赖网络：所有卡片正文内嵌在 HTML 里，双击就能搜、能读。
用法：python build_page.py [-o 输出路径]
"""

import argparse
import html
import json
import re
import sys
from pathlib import Path

HOME = Path.home() / "Desktop" / "知识卡片库"
CARDS = HOME / "cards"

if sys.platform == "win32":
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass


def parse(text):
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if kv:
            fm[kv.group(1)] = kv.group(2).strip().strip('"')
    return fm, m.group(2) or ""


def md_to_html(body: str) -> str:
    out, buf = [], []
    for line in body.splitlines():
        if line.startswith("## "):
            if buf:
                out.append("<p>" + inline(" ".join(buf)) + "</p>")
                buf = []
            out.append(f"<h3>{html.escape(line[3:].strip())}</h3>")
        elif line.strip().startswith(("- ", "* ")):
            if buf:
                out.append("<p>" + inline(" ".join(buf)) + "</p>")
                buf = []
            out.append("<li>" + inline(line.strip()[2:]) + "</li>")
        elif not line.strip():
            if buf:
                out.append("<p>" + inline(" ".join(buf)) + "</p>")
                buf = []
        else:
            buf.append(line.strip())
    if buf:
        out.append("<p>" + inline(" ".join(buf)) + "</p>")

    joined, i = [], 0
    while i < len(out):
        if out[i].startswith("<li>"):
            items = []
            while i < len(out) and out[i].startswith("<li>"):
                items.append(out[i]); i += 1
            joined.append("<ul>" + "".join(items) + "</ul>")
        else:
            joined.append(out[i]); i += 1
    return "".join(joined)


def inline(text: str) -> str:
    t = html.escape(text)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"\*(.+?)\*", r"<em>\1</em>", t)
    t = re.sub(r"\$\$(.+?)\$\$", r'<span class="fx">\1</span>', t, flags=re.S)
    t = re.sub(r"\$([^$]+?)\$", r"<code>\1</code>", t)
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default=str(HOME / "浏览.html"))
    a = ap.parse_args()

    cards = []
    for p in sorted(CARDS.glob("*.md")):
        fm, body = parse(p.read_text(encoding="utf-8"))
        cards.append({
            "id": fm.get("id") or p.stem,
            "zh": fm.get("title_zh") or "",
            "en": fm.get("title_en") or "",
            "school": fm.get("school") or "",
            "status": fm.get("status") or "draft",
            "tags": fm.get("tags") or "",
            "body": md_to_html(body),
            "raw": body,
        })

    data = json.dumps(cards, ensure_ascii=False).replace("</", "<\\/")

    page = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>知识卡片库</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&family=Noto+Sans+SC:wght@300;400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#fbf8f1;color:#1c1a17;font-family:"Noto Sans SC",sans-serif;
  display:grid;grid-template-columns:300px 1fr;height:100vh;overflow:hidden}
aside{border-right:1px solid #e4ddcd;padding:22px 16px;overflow:auto;background:#f6f1e6}
h1{font-family:"Noto Serif SC",serif;font-size:18px;font-weight:600;letter-spacing:.1em;margin-bottom:14px}
#q{width:100%;padding:8px 10px;border:1px solid #d8cfbc;border-radius:4px;background:#fff;
  font-family:inherit;font-size:13px;margin-bottom:12px}
.item{padding:9px 10px;border-radius:4px;cursor:pointer;margin-bottom:3px}
.item:hover{background:rgba(0,0,0,.045)}
.item.on{background:rgba(13,59,52,.1)}
.item .t{font-family:"Noto Serif SC",serif;font-size:14px;font-weight:600;line-height:1.4}
.item .m{font-family:"JetBrains Mono",monospace;font-size:9.5px;color:#8f8574;margin-top:3px;letter-spacing:.08em}
main{padding:44px 56px;overflow:auto}
h2{font-family:"Noto Serif SC",serif;font-size:40px;font-weight:700;line-height:1.2}
.sub{font-family:"Playfair Display",serif;font-size:16px;color:#0d3b34;margin-top:8px;letter-spacing:.04em}
.meta{font-family:"JetBrains Mono",monospace;font-size:10px;color:#8f8574;letter-spacing:.12em;margin-top:8px}
article{margin-top:34px;column-count:2;column-gap:56px;column-rule:1px solid #e4ddcd}
article h3{font-size:11.5px;font-weight:700;letter-spacing:.24em;color:#0d3b34;
  margin:0 0 10px;padding-bottom:7px;border-bottom:1px solid #e4ddcd;break-after:avoid}
article h3:not(:first-child){margin-top:26px}
article p,article li{font-size:15px;line-height:1.78;color:#332e27;margin-bottom:9px}
article ul{list-style:none}
article li{padding-left:14px;position:relative}
article li:before{content:"·";position:absolute;left:2px;color:#c9622f;font-weight:700}
article strong{color:#1c1a17}
article code{font-family:"JetBrains Mono",monospace;font-size:13px;color:#0d3b34;
  background:#eee7d8;padding:1px 4px;border-radius:3px}
.fx{display:block;font-family:"JetBrains Mono",monospace;color:#c9622f;text-align:center;
  padding:10px 0;margin:8px 0}
.empty{color:#8f8574;font-size:14px;margin-top:40px}
@media(max-width:820px){body{grid-template-columns:1fr;height:auto}aside{border-right:0;
  border-bottom:1px solid #e4ddcd}main{padding:28px 20px}article{column-count:1}}
</style></head>
<body>
<aside><h1>知识卡片库</h1>
  <input id="q" placeholder="搜索标题、编号、学派">
  <div id="list"></div></aside>
<main id="main"><div class="empty">从左边选一张卡</div></main>
<script>
const CARDS = __DATA__;
const list = document.getElementById('list');
const main = document.getElementById('main');
let cur = null;
function render(q){
  const kw = (q||'').trim().toLowerCase();
  list.innerHTML = '';
  CARDS.filter(c => !kw || [c.id,c.zh,c.en,c.school,c.tags].join(' ').toLowerCase().includes(kw))
    .forEach(c => {
      const d = document.createElement('div');
      d.className = 'item' + (cur && cur.id===c.id ? ' on' : '');
      d.innerHTML = '<div class="t"></div><div class="m"></div>';
      d.querySelector('.t').textContent = c.zh || c.id;
      d.querySelector('.m').textContent = c.id + ' · ' + c.status;
      d.onclick = () => open(c);
      list.appendChild(d);
    });
}
function open(c){
  cur = c;
  main.innerHTML = '<h2></h2><div class="sub"></div><div class="meta"></div><article></article>';
  main.querySelector('h2').textContent = c.zh || c.id;
  main.querySelector('.sub').textContent = c.en || '';
  main.querySelector('.meta').textContent = [c.id, c.school, c.status].filter(Boolean).join(' · ');
  main.querySelector('article').innerHTML = c.body;
  main.scrollTop = 0;
  render(document.getElementById('q').value);
}
document.getElementById('q').oninput = e => render(e.target.value);
render('');
if (CARDS.length) open(CARDS[0]);
</script>
</body></html>""".replace("__DATA__", data)

    out = Path(a.out)
    out.write_text(page, encoding="utf-8")
    print(f"已生成：{out}（{len(cards)} 张卡）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
