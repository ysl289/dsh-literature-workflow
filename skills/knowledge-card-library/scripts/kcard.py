#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kcard.py — 知识卡片库本地引擎（纯标准库，零依赖）

卡片正文一律由模型整篇写好，本引擎**不生成任何正文骨架**。它只负责：
校验、编号、归架、索引、体检、浏览。

命令:
  init       初始化卡片库（建目录 + 建书架）
  check      查重（返回 JSON 判定，供模型复核）
  ingest     校验并收录一张已写好的卡片（md 文件）
  shelves    列出书架与卡片分布
  shelf      把某张卡改到另一个书架（同时移动文件）
  list       列出卡片（可按书架 / 形态 / 标签筛）
  show       查看单卡
  alias      给卡片追加别名
  reindex    重建 catalog.json、INDEX.md、浏览.html 与两张关系网
  browse     只重建浏览页 浏览.html
  doctor     体检：重复 id、断链、缺字段、缺书架、近重复、孤岛卡

环境变量:
  KCARD_HOME  卡片库根目录，默认 ~/Desktop/知识卡片库
"""

import argparse
import difflib
import json
import os
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------- 基础设置

if sys.platform == "win32":
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

SKILL_ROOT = Path(__file__).resolve().parent.parent


def taxonomy_file() -> Path:
    """书架清单位置。KCARD_TAXONOMY 可覆盖（自测用临时副本，不污染真清单）。"""
    env = os.environ.get("KCARD_TAXONOMY")
    return Path(env).expanduser() if env else SKILL_ROOT / "taxonomy.json"

TYPE_CODE = {"theory": "T", "mechanism": "M", "effect": "E", "concept": "C"}
TYPE_NAME = {"T": "理论", "M": "机制", "E": "效应", "C": "概念"}
TYPE_ORDER = ["T", "M", "E", "C"]
TYPE_ALIAS = {
    "理论": "theory", "机制": "mechanism", "效应": "effect", "概念": "concept",
    "T": "theory", "M": "mechanism", "E": "effect", "C": "concept",
    "theory": "theory", "mechanism": "mechanism", "effect": "effect", "concept": "concept",
    "t": "theory", "m": "mechanism", "e": "effect", "c": "concept",
}


def resolve_type(raw: str):
    if not raw:
        return None
    k = str(raw).strip()
    return TYPE_ALIAS.get(k) or TYPE_ALIAS.get(k.lower()) or TYPE_ALIAS.get(k.upper())


SUFFIX_ZH = ["理论", "假说", "假设", "效应", "定律", "模型", "定理", "悖论", "原理", "框架", "命题"]
SUFFIX_EN = ["theory", "hypothesis", "effect", "law", "model", "theorem", "paradox", "principle", "framework"]

TH_DUP = 0.92
TH_SUSPECT = 0.72

REQUIRED_FIELDS = ["id", "type", "shelf", "title_zh", "slug", "status", "created", "updated"]
UNCLASSIFIED = "未归类"

EXIT_OK, EXIT_BLOCKED, EXIT_ERROR = 0, 3, 4

ID_RE = re.compile(r"^([TMEC])-(\d{4})$")


def home() -> Path:
    # KCARD_HOME 优先；DSH_CARDS_HOME 是面板侧的同一个变量，两个都认，
    # 免得面板读一个库、引擎写另一个库（审计 #2）。
    env = os.environ.get("KCARD_HOME") or os.environ.get("DSH_CARDS_HOME")
    return Path(env).expanduser() if env else Path("D:/知识卡片库")


def cards_dir() -> Path:
    return home() / "cards"


def drafts_dir() -> Path:
    return home() / "drafts"


def rendered_dir() -> Path:
    return home() / "rendered"


def meta_path() -> Path:
    return home() / ".kcard" / "meta.json"


def catalog_path() -> Path:
    return home() / "catalog.json"


def index_path() -> Path:
    return home() / "INDEX.md"


def browse_path() -> Path:
    return home() / "浏览.html"


def today() -> str:
    return date.today().isoformat()


# ---------------------------------------------------------------- 分类：书架

_TAX_CACHE = {}


def taxonomy() -> dict:
    """书架清单。缺 taxonomy.json 时退化为「未归类」单一书架。"""
    key = str(taxonomy_file())
    if key in _TAX_CACHE:
        return _TAX_CACHE[key]
    data = {"shelves": []}
    try:
        data = json.loads(taxonomy_file().read_text(encoding="utf-8"))
    except Exception:
        pass
    shelves = [s for s in (data.get("shelves") or []) if s.get("name")]
    shelves.sort(key=lambda s: (s.get("order", 99), s["name"]))
    data["shelves"] = shelves
    _TAX_CACHE[key] = data
    return data


def shelf_names() -> list:
    return [s["name"] for s in taxonomy()["shelves"]]


def shelf_meta(name: str) -> dict:
    for s in taxonomy()["shelves"]:
        if s["name"] == name:
            return s
    return {}


def resolve_shelf(raw: str):
    """书架名 / key 都能认。"""
    if not raw:
        return None
    k = str(raw).strip()
    for s in taxonomy()["shelves"]:
        if k == s["name"] or k.lower() == str(s.get("key", "")).lower():
            return s["name"]
    if k == UNCLASSIFIED:
        return UNCLASSIFIED
    return None


def card_shelf(card) -> str:
    """frontmatter 的 shelf 优先，其次看文件所在目录名。"""
    s = card.get("shelf")
    if s:
        return str(s).strip()
    p = Path(card.get("_path", ""))
    if p.parent != cards_dir() and p.parent.name:
        return p.parent.name
    return ""


def auto_shelf(title="", en="", aliases=None, tags=None, body="") -> dict:
    """按书架关键词打分，给出建议书架。只做建议，最终由 --shelf 或 frontmatter 决定。"""
    hay = " ".join([str(title or ""), str(en or ""),
                    " ".join(str(a) for a in (aliases or [])),
                    " ".join(str(t) for t in (tags or [])),
                    str(body or "")[:4000]]).lower()
    scores = []
    for s in taxonomy()["shelves"]:
        hits, words = 0, []
        for kw in s.get("keywords") or []:
            c = hay.count(str(kw).lower())
            if c:
                hits += c
                words.append(str(kw))
        scores.append({"shelf": s["name"], "score": hits, "hit_words": words[:6]})
    scores.sort(key=lambda x: -x["score"])
    best = scores[0] if scores else {"shelf": None, "score": 0, "hit_words": []}
    runner = scores[1]["score"] if len(scores) > 1 else 0
    return {
        "shelf": best["shelf"] if best["score"] >= 2 and best["score"] > runner else None,
        "score": best["score"],
        "runner_up": runner,
        "hit_words": best["hit_words"],
        "ranking": [s for s in scores if s["score"] > 0][:4],
    }


# ---------------------------------------------------------------- 文本归一化

def _has_cjk(s: str) -> bool:
    return any(ord(c) > 0x2E80 for c in s)


def normalize(s: str) -> str:
    """归一化：全角转半角、去标点空白、转小写、剥前后缀。"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", str(s)).lower()
    s = "".join(c for c in s if c.isalnum() or _has_cjk(c))
    if s.startswith("the"):
        s = s[3:]
    changed = True
    while changed:
        changed = False
        for suf in SUFFIX_ZH + SUFFIX_EN:
            if s.endswith(suf) and len(s) > len(suf) + 1:
                s = s[:-len(suf)]
                changed = True
    return s


def bigrams(s: str) -> set:
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def sim(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    r = difflib.SequenceMatcher(None, a, b).ratio()
    j = jaccard(bigrams(a), bigrams(b))
    return min(0.95, max(r, j) * 0.98)


# ---------------------------------------------------------------- frontmatter

def _scalar(raw: str):
    s = raw.strip()
    if not s:
        return None
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if not inner:
            return []
        return [_unquote(x.strip()) for x in _split_commas(inner)]
    if len(s) > 1 and s[0] == s[-1] == '"':
        try:
            return json.loads(s)
        except Exception:
            return s[1:-1]
    if len(s) > 1 and s[0] == s[-1] == "'":
        return s[1:-1]
    if s in ("true", "True"):
        return True
    if s in ("false", "False"):
        return False
    if s in ("null", "~"):
        return None
    return s


def _unquote(s: str) -> str:
    if len(s) > 1 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


def _split_commas(s: str) -> list:
    out, buf, quote = [], "", None
    for c in s:
        if quote:
            buf += c
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c
            buf += c
        elif c == ",":
            out.append(buf)
            buf = ""
        else:
            buf += c
    if buf.strip():
        out.append(buf)
    return out


def _parse_block(block: list):
    items = [l for l in block if l.strip()]
    if not items:
        return None
    stripped = [l.strip() for l in items]
    if any(s == "-" or s.startswith("- ") for s in stripped):
        out, cur = [], None
        for s in stripped:
            if s.startswith("-"):
                content = s[1:].strip()
                if content and ":" in content and content[0] not in "\"'":
                    k, _, v = content.partition(":")
                    cur = {k.strip(): _scalar(v)}
                    out.append(cur)
                else:
                    cur = None
                    out.append(_scalar(content) if content else None)
            elif isinstance(cur, dict) and ":" in s:
                k, _, v = s.partition(":")
                cur[k.strip()] = _scalar(v)
        return out
    d = {}
    for s in stripped:
        if ":" in s:
            k, _, v = s.partition(":")
            d[k.strip()] = _scalar(v)
    return d


def parse_frontmatter(text: str):
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end < 0:
        return {}, text
    fm, i = {}, 1
    while i < end:
        line = lines[i]
        if not line.strip() or line.strip().startswith("#") or ":" not in line:
            i += 1
            continue
        key, _, rest = line.partition(":")
        key, rest = key.strip(), rest.strip()
        if rest:
            fm[key] = _scalar(rest)
            i += 1
            continue
        block, j = [], i + 1
        while j < end and (not lines[j].strip() or lines[j][:1] in (" ", "\t")):
            block.append(lines[j])
            j += 1
        fm[key] = _parse_block(block)
        i = j
    return fm, "\n".join(lines[end + 1:])


def js_json(obj) -> str:
    """嵌进 <script> 的安全 JSON。

    卡片标题是用户随便写的，只要有人写个 `</script><img onerror=...>`，
    出图页面就变成可执行页面（审计 #3）。这里把 </ 和 <!-- 一并打断，
    顺带处理 JS 里当换行用的 U+2028/U+2029。
    """
    text = json.dumps(obj, ensure_ascii=False)
    return (text.replace("</", "<\\/")
                .replace("<!--", "<\\!--")
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029"))


def yq(s) -> str:
    s = "" if s is None else str(s)
    if s == "":
        return '""'
    if re.search(r"[:#\[\]{}&*?|><=!%@`,\"]", s) or s != s.strip():
        # 值里有双引号时优先用 YAML 单引号，避免写成 "\"Noto Sans SC\",sans-serif"
        if '"' in s and "'" not in s:
            return "'" + s + "'"
        return json.dumps(s, ensure_ascii=False)
    return s


FIELD_ORDER = ["id", "type", "shelf", "title_zh", "title_en", "aliases", "slug", "status",
               "confidence", "school", "era", "origin_country", "motif", "cover_layout",
               "style", "authors", "first_source", "sources", "relations", "tags",
               "created", "updated"]


def emit_frontmatter(fm: dict) -> str:
    """把字段写回 YAML。支持标量 / 字符串列表 / 字典列表 / 一层字典。"""
    lines = ["---"]
    keys = [k for k in FIELD_ORDER if k in fm] + [k for k in fm if k not in FIELD_ORDER]
    for k in keys:
        v = fm[k]
        if isinstance(v, list):
            if not v:
                lines.append(f"{k}: []")
            elif all(not isinstance(x, dict) for x in v):
                lines.append(f"{k}: " + json.dumps([str(x) for x in v], ensure_ascii=False))
            else:
                lines.append(f"{k}:")
                for item in v:
                    if isinstance(item, dict):
                        first = True
                        for ik, iv in item.items():
                            lines.append(("  - " if first else "    ") + f"{ik}: {yq(iv)}")
                            first = False
                    else:
                        lines.append(f"  - {yq(item)}")
        elif isinstance(v, dict):
            lines.append(f"{k}:")
            for ik, iv in v.items():
                lines.append(f"  {ik}: {yq(iv)}")
        elif isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        else:
            lines.append(f"{k}: {yq(v)}")
    lines.append("---")
    return "\n".join(lines)


# ---------------------------------------------------------------- 读写卡片

def load_card(path: Path):
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None
    fm, body = parse_frontmatter(text)
    if not fm.get("id"):
        return None
    fm["_path"] = str(path)
    fm["_body"] = body
    return fm


def load_all(include_drafts=False):
    """递归读取 cards/ 下的所有 md，兼容旧的扁平结构。"""
    out = []
    dirs = [cards_dir()] + ([drafts_dir()] if include_drafts else [])
    for d in dirs:
        if not d.exists():
            continue
        for p in sorted(d.rglob("*.md")):
            c = load_card(p)
            if c:
                out.append(c)
    return out


def find_card(card_id: str):
    for c in load_all(include_drafts=True):
        if str(c.get("id")).lower() == str(card_id).lower():
            return c
    return None


def card_keys(card) -> list:
    keys = []
    for f in ("title_zh", "title_en", "slug"):
        v = card.get(f)
        if v:
            keys.append((f, normalize(str(v))))
    for a in card.get("aliases") or []:
        if a:
            keys.append(("aliases", normalize(str(a))))
    return [(f, k) for f, k in keys if k]


def query_keys(title=None, en=None, aliases=None, slug=None) -> list:
    q = []
    for f, v in (("title_zh", title), ("title_en", en), ("slug", slug)):
        if v:
            q.append((f, normalize(v)))
    for a in aliases or []:
        if a:
            q.append(("aliases", normalize(a)))
    return [(f, k) for f, k in q if k]


# ---------------------------------------------------------------- 查重

def score_card(qkeys, card) -> dict:
    best, best_field, best_q = 0.0, None, None
    exact_alias = False
    for qf, qk in qkeys:
        for cf, ck in card_keys(card):
            s = sim(qk, ck)
            if s >= 0.999 and cf == "aliases":
                exact_alias = True
            if s > best:
                best, best_field, best_q = s, cf, qf
    if exact_alias:
        best = max(best, 0.97)
    return {"score": round(best, 4), "matched_field": best_field, "query_field": best_q,
            "exact_alias": exact_alias}


def check_title(title=None, en=None, aliases=None, slug=None):
    qkeys = query_keys(title, en, aliases, slug)
    if not qkeys:
        raise SystemExit("check 至少需要 --title / --en / --aliases 之一")
    cards = load_all()
    scored = []
    for c in cards:
        r = score_card(qkeys, c)
        if r["score"] <= 0:
            continue
        scored.append({
            "id": c.get("id"),
            "title_zh": c.get("title_zh"),
            "title_en": c.get("title_en"),
            "type": c.get("type"),
            "shelf": card_shelf(c),
            "status": c.get("status"),
            "score": r["score"],
            "matched_field": r["matched_field"],
            "exact_alias": r["exact_alias"],
            "definition": first_section(c.get("_body", ""), "核心命题")
            or first_section(c.get("_body", ""), "一句话定义"),
            "path": c.get("_path"),
        })
    scored.sort(key=lambda x: -x["score"])
    top = scored[:5]
    best = top[0]["score"] if top else 0.0
    if best >= TH_DUP:
        verdict = "duplicate"
    elif best >= TH_SUSPECT:
        verdict = "suspect"
    else:
        verdict = "new"
    return {
        "query": {"title": title, "en": en, "aliases": aliases, "normalized": [k for _, k in qkeys]},
        "library_size": len(cards),
        "verdict": verdict,
        "thresholds": {"duplicate": TH_DUP, "suspect": TH_SUSPECT},
        "candidates": top,
        "next": {
            "duplicate": "不入库；在既有卡 sources 追加本次出处，并复核确属同一理念",
            "suspect": "必须打开候选卡正文，读核心命题与边界后再定 variant/related/new",
            "new": "可以入库；写完正文后 ingest，并至少挂一条 relations",
        }[verdict],
    }


def first_section(body: str, heading: str, limit=120) -> str:
    if not body:
        return ""
    m = re.search(r"^##\s*" + re.escape(heading) + r"\s*$(.*?)(?=^##\s|\Z)", body, re.M | re.S)
    if not m:
        return ""
    txt = re.sub(r"\s+", " ", m.group(1)).strip()
    return txt[:limit]


# ---------------------------------------------------------------- 索引

def shelf_dir(name: str) -> Path:
    return cards_dir() / (name or UNCLASSIFIED)


class EmptyLibraryBlocked(RuntimeError):
    """扫到 0 张卡但旧 catalog 有卡时抛出：宁可停下，也不许把好 catalog 覆盖成空的。"""


def _guard_empty_library(new_count: int) -> None:
    """0 张卡不许覆盖一份有卡的 catalog（审计 #1）。

    这就是「以为卡片全丢了」的机制：库路径指错 → 扫到 0 张 → 照样写
    catalog.json(count:0) → 面板显示 0 张，而卡其实躺在另一个目录里。
    """
    try:
        old = json.loads(catalog_path().read_text(encoding="utf-8"))
        old_count = int(old.get("count") or len(old.get("cards") or []))
    except Exception:
        return
    if new_count == 0 and old_count > 0:
        raise EmptyLibraryBlocked(
            f"扫到 0 张卡，但 {catalog_path()} 里记着 {old_count} 张。\n"
            f"当前库目录：{home()}\n"
            f"这通常不是「卡没了」，而是路径指错了。已拒绝覆盖——"
            f"先确认 KCARD_HOME / DSH_CARDS_HOME 指向真正的卡片库。"
        )


def compute_catalog():
    """扫 cards/ 算出 catalog 结构与全量卡片，不写任何文件。

    build_index（五件全落盘）与 cmd_graph（只重建两张关系网）共用这段目录加载逻辑。
    """
    cards = load_all(include_drafts=True)
    _guard_empty_library(len(cards))
    cat = {"schema": 2, "generated_at": today(), "home": str(home()),
           "shelves": shelf_names(), "count": len(cards), "cards": []}
    for c in cards:
        cat["cards"].append({
            "id": c.get("id"),
            "type": c.get("type"),
            "code": TYPE_CODE.get(str(c.get("type")), "?"),
            "shelf": card_shelf(c) or UNCLASSIFIED,
            "title_zh": c.get("title_zh"),
            "title_en": c.get("title_en"),
            "aliases": c.get("aliases") or [],
            "slug": c.get("slug"),
            "status": c.get("status"),
            "confidence": c.get("confidence"),
            "school": c.get("school"),
            "tags": c.get("tags") or [],
            "sources": len(c.get("sources") or []),
            "relations": len(c.get("relations") or []),
            "created": c.get("created"),
            "updated": c.get("updated"),
            "path": c.get("_path"),
            "norm_keys": [k for _, k in card_keys(c)],
        })
    cat["cards"].sort(key=lambda x: (x["shelf"],
                                     TYPE_ORDER.index(x["code"]) if x["code"] in TYPE_ORDER else 9,
                                     str(x["id"])))
    return cat, cards


def build_index():
    cat, cards = compute_catalog()
    # 先留一份旧 catalog：后面任何一步写失败都要能退回去（审计 #1 回滚）。
    try:
        old_catalog = catalog_path().read_text(encoding="utf-8")
    except Exception:
        old_catalog = None
    try:
        catalog_path().write_text(json.dumps(cat, ensure_ascii=False, indent=2), encoding="utf-8")
        write_index_md(cat)
        write_browse_html(cat, cards)
        write_graph_html(cat, cards)
        write_graph_html(cat, cards, mode="3d")
    except Exception:
        if old_catalog is not None:
            try:
                catalog_path().write_text(old_catalog, encoding="utf-8")
            except Exception:
                pass
        raise
    return cat


def _group_by_shelf(cards):
    order = {n: i for i, n in enumerate(shelf_names())}
    groups = {}
    for c in cards:
        groups.setdefault(c["shelf"], []).append(c)
    return sorted(groups.items(), key=lambda kv: (order.get(kv[0], 99), kv[0]))


def write_index_md(cat):
    groups = _group_by_shelf(cat["cards"])
    lines = ["# 知识卡片库索引", "",
             f"共 {cat['count']} 张 · {len(groups)} 个书架 · 更新于 {cat['generated_at']}", ""]

    lines += ["## 书架总览", "",
              "| 书架 | 张数 | " + " | ".join(TYPE_NAME[c] for c in TYPE_ORDER) + " | 一句话 |",
              "| --- | --- | " + " | ".join("---" for _ in TYPE_ORDER) + " | --- |"]
    for name, items in groups:
        counts = {c: sum(1 for x in items if x["code"] == c) for c in TYPE_ORDER}
        desc = (shelf_meta(name).get("desc") or "")[:40]
        lines.append(f"| {name} | {len(items)} | " +
                     " | ".join(str(counts[c]) if counts[c] else "" for c in TYPE_ORDER) +
                     f" | {desc} |")
    lines.append("")

    for name, items in groups:
        desc = shelf_meta(name).get("desc") or ""
        lines += [f"## {name} · {len(items)}", ""]
        if desc:
            lines += [f"> {desc}", ""]
        lines += ["| id | 名称 | 英文 | 形态 | 证据 | 标签 | 来源数 |",
                  "| --- | --- | --- | --- | --- | --- | --- |"]
        for c in items:
            tags = "、".join(c["tags"]) if c["tags"] else ""
            lines.append(f"| {c['id']} | {c['title_zh']} | {c['title_en'] or ''} | "
                         f"{TYPE_NAME.get(c['code'], '?')} | {c['confidence'] or ''} | "
                         f"{tags} | {c['sources']} |")
        lines.append("")

    tag_count = {}
    for c in cat["cards"]:
        for t in c["tags"]:
            tag_count[t] = tag_count.get(t, 0) + 1
    if tag_count:
        cloud = " ".join(f"{t}({n})" for t, n in sorted(tag_count.items(), key=lambda x: -x[1]))
        lines += ["## 标签", "", cloud, ""]
    index_path().write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------- 浏览页

def _md_inline(text: str) -> str:
    import html as _html
    t = _html.escape(text)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", t)
    return t


def _split_sections(body: str):
    parts = re.split(r"^##\s+(.+)$", body or "", flags=re.M)
    return [(parts[i].strip(), parts[i + 1].strip()) for i in range(1, len(parts), 2)]


def md_to_html(body: str) -> str:
    """极简 markdown → html：## 章节、段落、列表、粗体、行内码、公式原样保留。"""
    out = []
    for title, text in _split_sections(body):
        out.append(f"<h3>{_md_inline(title)}</h3>")
        for chunk in re.split(r"(\$\$[\s\S]+?\$\$)", text):
            chunk = chunk.strip()
            if not chunk:
                continue
            if chunk.startswith("$$") and chunk.endswith("$$"):
                out.append(f'<div class="fx">{_md_inline(chunk)}</div>')
                continue
            for para in re.split(r"\n{2,}", chunk):
                para = para.strip()
                if not para:
                    continue
                lines = [l.strip() for l in para.splitlines() if l.strip()]
                if lines and all(l.startswith(("- ", "* ")) for l in lines):
                    out.append("<ul>" + "".join(f"<li>{_md_inline(l[2:])}</li>" for l in lines) + "</ul>")
                elif para.startswith(">"):
                    out.append("<blockquote>" + _md_inline(para.lstrip("> ")) + "</blockquote>")
                else:
                    out.append(f"<p>{_md_inline(para)}</p>")
    return "".join(out)


BROWSE_CSS = """
*{margin:0;padding:0;box-sizing:border-box}
body{background:#fbf8f1;color:#1c1a17;font-family:"Noto Sans SC",system-ui,sans-serif;
  display:grid;grid-template-columns:308px 1fr;height:100vh;overflow:hidden}
aside{border-right:1px solid #e4ddcd;padding:20px 14px;overflow:auto;background:#f6f1e6}
h1{font-family:"Noto Serif SC",serif;font-size:17px;font-weight:700;letter-spacing:.1em}
.tot{font-family:"JetBrains Mono",monospace;font-size:9.5px;color:#8f8574;letter-spacing:.12em;margin:4px 0 14px}
#q{width:100%;padding:8px 10px;border:1px solid #d8cfbc;border-radius:4px;background:#fff;
  font-family:inherit;font-size:13px;margin-bottom:14px;outline:none}
#q:focus{border-color:#0d3b34}
.sh{display:flex;justify-content:space-between;align-items:baseline;cursor:pointer;
  font-family:"Noto Serif SC",serif;font-size:13px;font-weight:700;letter-spacing:.08em;
  color:#0d3b34;padding:9px 6px 5px;border-bottom:1px solid #e4ddcd;margin-top:8px;user-select:none}
.sh span{font-family:"JetBrains Mono",monospace;font-size:9px;color:#8f8574;font-weight:400}
.sh .arw{display:inline-block;transition:transform .18s;font-size:9px;color:#8f8574;margin-right:5px}
.sh.closed .arw{transform:rotate(-90deg)}
.grp.closed .item{display:none}
.item{padding:8px 9px;border-radius:4px;cursor:pointer;margin-top:2px}
.item:hover{background:rgba(0,0,0,.045)}
.item.on{background:rgba(13,59,52,.1)}
.item .t{font-family:"Noto Serif SC",serif;font-size:13.5px;font-weight:600;line-height:1.4}
.item .m{font-family:"JetBrains Mono",monospace;font-size:9px;color:#8f8574;margin-top:3px;letter-spacing:.08em}
main{padding:42px 54px;overflow:auto}
.tagline{font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.14em;color:#c9622f}
h2{font-family:"Noto Serif SC",serif;font-size:38px;font-weight:700;line-height:1.2;margin-top:8px}
.sub{font-family:"Playfair Display",serif;font-size:15px;color:#0d3b34;margin-top:6px;letter-spacing:.04em}
.meta{font-family:"JetBrains Mono",monospace;font-size:10px;color:#8f8574;letter-spacing:.1em;margin-top:10px}
.chips{margin-top:14px;display:flex;gap:7px;flex-wrap:wrap}
.chip{font-size:11px;padding:3px 9px;border:1px solid #d8cfbc;border-radius:99px;color:#6d6455}
article{margin-top:30px;column-count:2;column-gap:52px;column-rule:1px solid #e4ddcd}
article h3{font-size:11px;font-weight:700;letter-spacing:.22em;color:#0d3b34;margin:0 0 9px;
  padding-bottom:6px;border-bottom:1px solid #e4ddcd;break-after:avoid}
article h3:not(:first-child){margin-top:24px}
article p,article li{font-size:14.5px;line-height:1.78;color:#332e27;margin-bottom:8px}
article ul{list-style:none}
article li{padding-left:14px;position:relative}
article li:before{content:"·";position:absolute;left:2px;color:#c9622f;font-weight:700}
article strong{color:#1c1a17}
article code{font-family:"JetBrains Mono",monospace;font-size:12.5px;color:#0d3b34;
  background:#eee7d8;padding:1px 4px;border-radius:3px}
article blockquote{border-left:2px solid #d8cfbc;padding-left:12px;color:#6d6455;font-size:13.5px;margin-bottom:10px}
.fx{font-family:"JetBrains Mono",monospace;color:#c9622f;text-align:center;padding:8px 0;margin:6px 0;
  border-top:1px solid #e4ddcd;border-bottom:1px solid #e4ddcd}
.empty{color:#8f8574;font-size:14px;margin-top:36px}
@media(max-width:860px){body{grid-template-columns:1fr;height:auto}aside{border-right:0;
  border-bottom:1px solid #e4ddcd}main{padding:26px 18px}article{column-count:1}}
"""

BROWSE_JS = """
const CARDS=/*__CARDS__*/[];
const byId={};CARDS.forEach(c=>byId[c.id]=c);
const listEl=document.getElementById('list'),mainEl=document.getElementById('main'),
      qEl=document.getElementById('q');
const groups=[],seen={};
CARDS.forEach(c=>{if(!seen[c.shelf]){seen[c.shelf]=[];groups.push(c.shelf)}seen[c.shelf].push(c)});
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[m]})}
function build(){
  listEl.innerHTML='';
  groups.forEach(function(g){
    const items=seen[g],wrap=document.createElement('div');wrap.className='grp';
    const h=document.createElement('div');h.className='sh';
    h.innerHTML='<span style="flex:1"><span class="arw">&#9660;</span>'+esc(g)+'</span><span>'+items.length+'</span>';
    h.onclick=function(){wrap.classList.toggle('closed');h.classList.toggle('closed')};
    wrap.appendChild(h);
    items.forEach(function(c){
      const d=document.createElement('div');d.className='item';d.dataset.id=c.id;
      d.innerHTML='<div class="t">'+esc(c.zh)+'</div><div class="m">'+esc(c.id)+' &middot; '+esc(c.type)+'</div>';
      d.onclick=function(){show(c.id)};wrap.appendChild(d);
    });
    listEl.appendChild(wrap);
  });
}
function show(id){
  const c=byId[id];if(!c)return;
  document.querySelectorAll('.item').forEach(function(e){e.classList.toggle('on',e.dataset.id===id)});
  mainEl.innerHTML='<div class="tagline">'+esc(c.id)+' &middot; '+esc(c.shelf)+' &middot; '+esc(c.type)+'</div>'+
    '<h2>'+esc(c.zh)+'</h2><div class="sub">'+esc(c.en||'')+'</div>'+
    '<div class="meta">'+esc(c.school||'')+' &middot; '+esc(c.status||'')+' &middot; 来源 '+c.sources+' 条</div>'+
    (c.tags&&c.tags.length?'<div class="chips">'+c.tags.map(function(t){return '<span class="chip">'+esc(t)+'</span>'}).join('')+'</div>':'')+
    '<article>'+c.html+'</article>';
  mainEl.scrollTop=0;
}
qEl.oninput=function(){
  const k=qEl.value.trim().toLowerCase();
  document.querySelectorAll('.item').forEach(function(e){
    const c=byId[e.dataset.id];
    const hay=(c.zh+' '+c.en+' '+c.id+' '+(c.school||'')+' '+(c.tags||[]).join(' ')).toLowerCase();
    e.style.display=(!k||hay.indexOf(k)>=0)?'':'none';
  });
  document.querySelectorAll('.grp').forEach(function(w){
    const vis=Array.prototype.some.call(w.querySelectorAll('.item'),function(e){return e.style.display!=='none'});
    w.style.display=vis?'':'none';
  });
};
build();
if(CARDS.length)show(CARDS[0].id);
"""


def write_browse_html(cat, cards):
    by_id = {str(c.get("id")): c for c in cards}
    data = []
    for row in cat["cards"]:
        c = by_id.get(str(row["id"])) or {}
        data.append({
            "id": row["id"], "zh": row["title_zh"], "en": row["title_en"],
            "shelf": row["shelf"], "type": TYPE_NAME.get(row["code"], row["code"]),
            "status": row["status"], "school": row["school"], "tags": row["tags"],
            "sources": row["sources"], "html": md_to_html(c.get("_body", "")),
        })
    js = BROWSE_JS.replace("/*__CARDS__*/[]", js_json(data))
    page = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>知识卡片库 · {cat['count']} 张</title>
<style>{BROWSE_CSS}</style></head>
<body>
<aside><h1>知识卡片库</h1>
  <div class="tot">{cat['count']} 张 · {len(_group_by_shelf(cat['cards']))} 个书架 · {cat['generated_at']}</div>
  <input id="q" placeholder="搜标题、编号、学派、标签">
  <div id="list"></div></aside>
<main id="main"><div class="empty">从左边选一张卡</div></main>
<script>{js}</script>
</body></html>
"""
    browse_path().write_text(page, encoding="utf-8")


# ---------------------------------------------------------------- 关系网

SHELF_PALETTE = ["#0f6e56", "#185fa5", "#ba7517", "#534ab7", "#d4537e",
                 "#639922", "#993c1d", "#5f5e5a"]
SOFT_TYPES = ("互补", "对立")


def graph_path() -> Path:
    return home() / "关系网.html"


def shelf_colors() -> dict:
    names = [s["name"] for s in taxonomy()["shelves"]]
    for n in shelf_names():
        if n not in names:
            names.append(n)
    out = {}
    for i, n in enumerate(names):
        out[n] = SHELF_PALETTE[i % len(SHELF_PALETTE)]
    out[UNCLASSIFIED] = "#b4b2a9"
    return out


def build_graph_data(cat, cards) -> dict:
    """节点=卡片，边=relations。

    关系是**有向**的：卡片 A 上写「应用于 → B」，画成 A→B 的箭头。
    两张卡互指时会出现两条方向相反的边（例如 A 应用于 B、B 的前置是 A），
    这正是要看的信息，不能合并成一条无向边。
    """
    by_id = {str(c.get("id")): c for c in cards}
    ids = {str(r["id"]) for r in cat["cards"]}
    rendered = home() / "rendered"
    nodes = []
    for row in cat["cards"]:
        c = by_id.get(str(row["id"])) or {}
        body = c.get("_body", "")
        nodes.append({
            "id": row["id"], "zh": row["title_zh"], "en": row["title_en"] or "",
            "shelf": row["shelf"], "form": TYPE_NAME.get(row["code"], row["code"]),
            "status": row["status"] or "", "conf": row["confidence"] or "",
            "school": row["school"] or "", "tags": row["tags"],
            "def": first_section(body, "核心命题") or first_section(body, "一句话定义"),
            "src": row["sources"],
            # 有卡片图才给「看这张卡」的入口，别点进去 404
            "shot": (rendered / (str(row["id"]) + ".html")).exists(),
        })
    seen = set()
    edges = []
    for row in cat["cards"]:
        src_id = str(row["id"])
        c = by_id.get(src_id) or {}
        for r in (c.get("relations") or []):
            if not isinstance(r, dict):
                continue
            tgt = str(r.get("target") or "").strip()
            if not tgt or tgt == src_id or tgt not in ids:
                continue
            t = str(r.get("type") or "").strip() or "相关"
            key = (src_id, tgt, t)
            if key in seen:
                continue
            seen.add(key)
            edges.append({"s": src_id, "t": tgt, "label": t,
                          "soft": t in SOFT_TYPES,
                          "note": str(r.get("note") or "").strip()})
    pairs = len({tuple(sorted([e["s"], e["t"]])) for e in edges})
    return {"nodes": nodes, "edges": edges, "pairs": pairs, "colors": shelf_colors()}


GRAPH_ASSETS = SKILL_ROOT / "assets"


def graph3d_path() -> Path:
    return home() / "关系网-3D.html"


def _asset(name: str) -> str:
    try:
        return (GRAPH_ASSETS / name).read_text(encoding="utf-8")
    except Exception:
        return ""


def write_graph_html(cat, cards, mode="2d"):
    """同一套数据与引擎，两种投影：2D 平面 / 3D 透视。输出都是单文件、可离线打开。

    版式：左「读图控制台」/ 中画布 / 右「关系清单」。
    读图只靠三件事——点（一张卡）、线（一条关系，箭头指方向）、颜色（书架 / 关系类型）。
    """
    data = build_graph_data(cat, cards)
    data["mode"] = "3d" if mode == "3d" else "2d"
    is3d = data["mode"] == "3d"
    js = _asset("graph.js").replace("/*__DATA__*/null", js_json(data))
    css = _asset("graph.css")
    title = "知识卡片关系网 · 3D" if is3d else "知识卡片关系网"
    pairs = data.get("pairs", 0)
    stat = f"{len(data['nodes'])} 张卡 · {pairs} 对关系 · {len(data['edges'])} 条有向边"
    other = "关系网.html" if is3d else "关系网-3D.html"
    other_label = "2D 版" if is3d else "3D 版"
    eb = "KNOWLEDGE CARDS · 3D" if is3d else "KNOWLEDGE CARDS"
    auto_row = ('      <label class="sw"><input type="checkbox" id="c-auto">'
                '<span>自动旋转</span></label>\n') if is3d else ""
    page = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · {stat}</title>
<style>{css}</style></head>
<body>
<div id="app">
  <aside id="rail">
    <div class="brand">
      <div class="eb">{eb}</div>
      <h1>知识卡片关系网</h1>
      <div class="stat" id="stat">{stat}</div>
    </div>

    <div class="grp">
      <div class="grp-h"><span>书架</span><button class="mini" id="b-all-shelf">全显</button></div>
      <div id="legend"></div>
    </div>

    <div class="grp">
      <div class="grp-h"><span>关系类型</span><button class="mini" id="b-all-type">全显</button></div>
      <div id="types"></div>
    </div>

    <div class="grp">
      <div class="grp-h"><span>视图</span><span class="note">点＝只看 · Shift＝叠加</span></div>
      <label class="sw"><input type="checkbox" id="c-label" checked><span>卡片名字</span></label>
      <label class="sw"><input type="checkbox" id="c-terr" checked><span>书架领域</span><em>2D</em></label>
{auto_row}    </div>

    <div class="foot">
      <button id="b-fit">{'重置视角' if is3d else '适应窗口'}</button>
      <button id="b-reset">重排</button>
      <a href="{other}">{other_label}</a>
      <button id="b-fs">全屏</button>
      <button id="b-help" class="wide">怎么读</button>
    </div>
  </aside>

  <div id="stage">
    <canvas id="cv" aria-label="知识卡片关系网，可拖动、缩放、点选"></canvas>
    <div id="status"></div>
    <aside id="panel" aria-label="卡片关系清单"></aside>
  </div>
</div>

<div id="help">
  <div class="help-card">
    <button class="help-x" id="help-x">&times;</button>
    <h2>这张图怎么读</h2>
    <div class="sub">只有三件事：点、线、颜色 · 按 Esc 关闭</div>

    <h3>一 · 圆点＝一张卡</h3>
    <p>点越大，这张卡挂的关系越多，越靠这张网的中心。点外面有一圈<b>橙色虚线</b>，说明它还没挂任何关系——
       孤立卡在检索时几乎翻不到，值得补一条。</p>

    <h3>二 · 线＝一条关系，箭头指向被提到的那张卡</h3>
    <p>每条关系都是有方向的：从「写这条关系的卡」出发，指向「它提到的另一张卡」。箭头画在终点，光点也往那个方向游。</p>
    <div class="types" id="help-types"></div>
    <p><b>实线</b>是结构关系（前置 / 应用于 / 上位 / 下位），<b>虚线</b>是并列关系（互补 / 对立 / 相关）。</p>

    <h3>三 · 两张卡之间有两条线，是正常的</h3>
    <p>因为它俩各自写了对方：一张说「我以它为前置」，另一张说「我被用在它那里」。
       前置与应用于、上位与下位常常是同一件事的两面。右侧清单会把它们归到同一张卡下，并标一个「双向声明」。</p>

    <h3>四 · 颜色</h3>
    <p>点的颜色＝书架（这张卡属于哪一类）；同一个书架的卡会被聚成一片带虚线的「领域」，上方写着书架名。
       线的颜色＝关系类型。</p>

    <h3>操作</h3>
    <ul>
      <li>点卡片：右侧列出它与每一张卡的关系，以及当初写下的理由；有卡片图的卡会多一个「看这张卡」，点开就是那张 A4 卡</li>
      <li>左栏点书架 / 关系类型：只看这一类；按住 <code>Shift</code> 点可以叠加；「全显」复位</li>
      <li>滚轮缩放；放大到 2.4 倍以上，所有关系文字都会显示</li>
      <li>{'拖动空白处旋转视角，滚轮缩放' if is3d else '拖动空白处平移，拖动卡片可调整位置'}</li>
      <li>左栏底部「全屏」：图铺满整块屏幕，取景会重新算一遍</li>
      <li>按 <code>Esc</code> 关掉右侧清单</li>
    </ul>
  </div>
</div>
<script>{js}</script>
</body></html>
"""
    target = graph3d_path() if is3d else graph_path()
    target.write_text(page, encoding="utf-8")


# ---------------------------------------------------------------- 编号

def next_id(code: str) -> str:
    meta = {}
    if meta_path().exists():
        try:
            meta = json.loads(meta_path().read_text(encoding="utf-8"))
        except Exception:
            meta = {}
    counters = meta.setdefault("counters", {})
    used = counters.get(code, 0)
    for c in load_all(include_drafts=True):
        cid = str(c.get("id") or "")
        m = re.match(rf"^{code}-(\d+)$", cid)
        if m:
            used = max(used, int(m.group(1)))
    nxt = used + 1
    counters[code] = nxt
    meta.setdefault("schema", 2)
    meta.setdefault("created", today())
    meta["updated"] = today()
    meta_path().parent.mkdir(parents=True, exist_ok=True)
    meta_path().write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"{code}-{nxt:04d}"


def slugify(title_en=None, title_zh=None) -> str:
    if title_en:
        s = unicodedata.normalize("NFKC", title_en).lower()
        s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
        if s:
            return s
    if title_zh:
        s = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKC", title_zh).lower()).strip("-")
        if s:
            return s
        return "card"
    return "card"


def log(entry: dict):
    entry["ts"] = today()
    p = home() / ".kcard" / "log.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- ingest 收录

def _looks_like_path(s: str) -> bool:
    t = str(s or "")
    return bool(re.search(r"[A-Za-z]:[\\/]", t) or re.search(r"\.(md|pdf|txt|docx?)$", t, re.I))


def _quality_issues(fm, body) -> list:
    """入库前的硬性检查。返回阻断项（不通过就不收）。"""
    issues = []
    secs = _split_sections(body)
    if len(body.strip()) < 80:
        issues.append("正文为空或过短（<80 字），需要整篇写完再入库")
    if len(secs) < 2:
        issues.append(f"正文只有 {len(secs)} 个 ## 章节，理论条目至少需要 2 个（如核心命题 + 机制）")
    placeholders = body.count("待补") + body.count("待核")
    if placeholders:
        issues.append(f"正文还有 {placeholders} 处「待补/待核」占位——这是骨架不是卡片，"
                      f"引擎不再接受未写完的卡")
    fs = fm.get("first_source") or {}
    if not isinstance(fs, dict):
        issues.append("first_source 格式不对，应为 citation / locator 两个字段")
    else:
        loc = str(fs.get("locator") or "").strip()
        if not loc:
            issues.append("first_source.locator 为空，出处必须定位到页码/章节/表图编号")
        elif loc in ("待核", "待补") and str(fm.get("status")) == "verified":
            issues.append("status 是 verified，但 first_source.locator 仍是「待核」——要么补出处，要么降为 draft")
        elif _looks_like_path(loc):
            issues.append(f"first_source.locator 是本地文件路径（{loc[:40]}），要写成页码/章节/表图编号")
    if not str(fm.get("title_en") or "").strip():
        issues.append("缺 title_en，英文名用于查重与跨库对接")
    return issues


def cmd_ingest(args):
    src = Path(args.file).expanduser()
    if not src.exists():
        print(json.dumps({"error": f"文件不存在: {src}"}, ensure_ascii=False))
        return EXIT_ERROR
    text = src.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(text)
    if not fm:
        print(json.dumps({"error": "缺少 frontmatter（文件要以 --- 开头）"}, ensure_ascii=False))
        return EXIT_ERROR

    title = fm.get("title_zh") or fm.get("title")
    if not title:
        print(json.dumps({"error": "缺 title_zh"}, ensure_ascii=False))
        return EXIT_ERROR
    t = resolve_type(args.type or fm.get("type"))
    if t not in TYPE_CODE:
        print(json.dumps({"error": f"未知形态 {args.type or fm.get('type')}，可用 theory/mechanism/effect/concept"},
                         ensure_ascii=False))
        return EXIT_ERROR

    aliases = [str(a) for a in (fm.get("aliases") or []) if a]
    slug = str(fm.get("slug") or "").strip() or slugify(fm.get("title_en"), title)
    warnings = []

    # 1) 查重闸门
    if not args.force:
        res = check_title(title, fm.get("title_en"), aliases, slug)
        if res["verdict"] in ("duplicate", "suspect"):
            res["blocked"] = True
            res["hint"] = "未入库。确认是新理念后加 --force，或改为并入 / 建链。"
            print(json.dumps(res, ensure_ascii=False, indent=2))
            return EXIT_BLOCKED

    # 2) 质量闸门
    issues = _quality_issues(fm, body)
    if issues:
        print(json.dumps({"blocked": True, "reason": "quality", "issues": issues,
                          "hint": "补全后重新 ingest"}, ensure_ascii=False, indent=2))
        return EXIT_BLOCKED

    # 3) 编号
    code = TYPE_CODE[t]
    old_id = str(fm.get("id") or "").strip()
    if old_id:
        m = ID_RE.match(old_id)
        if not m:
            print(json.dumps({"error": f"id 格式不合规: {old_id}（应为 T-0001 这种）"}, ensure_ascii=False))
            return EXIT_ERROR
        if m.group(1) != code:
            print(json.dumps({"error": f"id 前缀 {m.group(1)} 与形态 {t}({code}) 不一致"}, ensure_ascii=False))
            return EXIT_ERROR
        cid = old_id
    else:
        cid = next_id(code)

    # 4) 归架
    shelf = resolve_shelf(args.shelf) if args.shelf else None
    if args.shelf and not shelf:
        print(json.dumps({"error": f"未知书架 {args.shelf}", "shelves": shelf_names(),
                          "hint": "这个领域确实不在现有书架里，就先 kcard.py taxonomy add "
                                  "<名称> --desc \"...\" --keywords ...，再重跑 ingest"},
                         ensure_ascii=False))
        return EXIT_ERROR
    if not shelf:
        shelf = resolve_shelf(fm.get("shelf"))
        if not shelf:
            sug = auto_shelf(title, fm.get("title_en"), aliases, fm.get("tags"), body)
            if not sug["shelf"]:
                print(json.dumps({"error": "无法确定书架", "suggestion": sug,
                                  "shelves": shelf_names(),
                                  "hint": "用 --shelf 指定现有书架；若这是新领域，"
                                          "先 kcard.py taxonomy add <名称> --desc \"...\" --keywords ..."},
                                 ensure_ascii=False, indent=2))
                return EXIT_ERROR
            shelf = sug["shelf"]
            warnings.append(f"书架由关键词自动判定为「{shelf}」"
                            f"（命中 {'、'.join(sug['hit_words'])}），"
                            f"如不对用 kcard.py shelf {cid} <书架> 调整")

    # 5) 落盘：只补 frontmatter 必需字段，正文一个字不改
    fm["id"] = cid
    fm["type"] = t
    fm["shelf"] = shelf
    fm["title_zh"] = title
    fm["slug"] = slug
    fm["status"] = args.status or fm.get("status") or "draft"
    fm["created"] = str(fm.get("created") or today())
    fm["updated"] = today()
    if not fm.get("aliases"):
        fm["aliases"] = []
    for f in REQUIRED_FIELDS:
        if not fm.get(f):
            warnings.append(f"字段 {f} 为空")

    out_dir = shelf_dir(shelf)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{cid}-{slug}.md"

    # 同 id 只能存在一份：允许「重写这张卡」（源文件或目标路径就是它），其余一律拦
    if old_id:
        try:
            keep = {src.resolve(), out.resolve()}
        except Exception:
            keep = set()
        others = [c for c in load_all(include_drafts=True)
                  if str(c.get("id")).lower() == cid.lower()
                  and Path(c["_path"]).resolve() not in keep]
        if others:
            print(json.dumps({"error": f"id {cid} 已被占用: {others[0]['_path']}",
                              "hint": "重写同一张卡时，请保持 id 与 slug 不变；换 slug 会生成第二份"},
                             ensure_ascii=False))
            return EXIT_ERROR

    rewriting = out.exists()
    payload = emit_frontmatter({k: v for k, v in fm.items() if not k.startswith("_")}) \
        + "\n\n" + body.lstrip("\n")
    if not payload.endswith("\n"):
        payload += "\n"
    out.write_text(payload, encoding="utf-8")

    # 源文件若在库内且不是目标文件，视为草稿迁移，删除
    try:
        inside = home().resolve() in src.resolve().parents
    except Exception:
        inside = False
    if inside and src.resolve() != out.resolve():
        src.unlink(missing_ok=True)

    log({"action": "ingest", "id": cid, "title": title, "shelf": shelf, "path": str(out)})
    build_index()
    print(json.dumps({"ingested": cid, "shelf": shelf, "path": str(out),
                      "rewritten": rewriting, "id_assigned": not bool(old_id),
                      "warnings": warnings,
                      "next": "补 relations → 再跑一次 reindex"}, ensure_ascii=False, indent=2))
    return EXIT_OK


# ---------------------------------------------------------------- 其他命令

def cmd_init(args):
    for d in (cards_dir(), drafts_dir(), rendered_dir(), home() / ".kcard"):
        d.mkdir(parents=True, exist_ok=True)
    for name in shelf_names():
        shelf_dir(name).mkdir(parents=True, exist_ok=True)
    if not meta_path().exists():
        meta_path().write_text(json.dumps({"schema": 2, "created": today(), "counters": {}},
                                          ensure_ascii=False, indent=2), encoding="utf-8")
    build_index()
    print(json.dumps({"home": str(home()), "cards": str(cards_dir()),
                      "shelves": shelf_names(), "ok": True}, ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_check(args):
    res = check_title(args.title, args.en, args.aliases, args.slug)
    if not args.shelf:
        res["shelf_suggestion"] = auto_shelf(args.title, args.en, args.aliases, None, "")
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_shelves(args):
    cards = load_all(include_drafts=True)
    counts = {}
    for c in cards:
        s = card_shelf(c) or UNCLASSIFIED
        counts[s] = counts.get(s, 0) + 1
    rows = []
    for s in taxonomy()["shelves"]:
        rows.append({"name": s["name"], "key": s.get("key"), "desc": s.get("desc"),
                     "count": counts.pop(s["name"], 0), "registered": True})
    for name, n in counts.items():
        rows.append({"name": name, "key": None, "desc": "未在 taxonomy.json 登记",
                     "count": n, "registered": name != UNCLASSIFIED})
    print(json.dumps({"count": len(rows), "cards": len(cards), "shelves": rows},
                     ensure_ascii=False, indent=2))
    return EXIT_OK


def _write_taxonomy(data: dict):
    payload = {"schema": data.get("schema", 2), "updated": today(),
               "note": data.get("note", ""), "axes": data.get("axes", {}),
               "shelves": data["shelves"]}
    taxonomy_file().write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                               encoding="utf-8")
    _TAX_CACHE.clear()


def _shelf_counts():
    counts = {}
    for c in load_all(include_drafts=True):
        s = card_shelf(c) or UNCLASSIFIED
        counts[s] = counts.get(s, 0) + 1
    return counts


def cmd_taxonomy(args):
    """书架清单管理：新领域来了，加一个书架；名字起歪了，改一个。"""
    action = getattr(args, "action", "list") or "list"
    data = taxonomy()
    shelves = [dict(s) for s in data["shelves"]]

    if action == "list":
        counts = _shelf_counts()
        rows = [{"name": s["name"], "key": s.get("key"), "order": s.get("order"),
                 "desc": s.get("desc"), "keywords": s.get("keywords") or [],
                 "count": counts.pop(s["name"], 0)} for s in shelves]
        for name, n in counts.items():
            rows.append({"name": name, "registered": False, "count": n})
        print(json.dumps({"file": str(taxonomy_file()), "count": len(rows), "shelves": rows},
                         ensure_ascii=False, indent=2))
        return EXIT_OK

    if action == "add":
        name = str(args.name).strip()
        if not name:
            print(json.dumps({"error": "书架名不能为空"}, ensure_ascii=False))
            return EXIT_ERROR
        if len(name) > 12 or re.search(r"[\\/:*?\"<>|]", name):
            print(json.dumps({"error": f"书架名不合规: {name}（≤12 字，不能含路径字符）"},
                             ensure_ascii=False))
            return EXIT_ERROR
        if any(s["name"] == name for s in shelves):
            print(json.dumps({"error": f"书架已存在: {name}", "shelves": [s["name"] for s in shelves]},
                             ensure_ascii=False))
            return EXIT_ERROR
        key = str(args.key or name).strip()
        if any(str(s.get("key")) == key for s in shelves):
            print(json.dumps({"error": f"key 已被占用: {key}"}, ensure_ascii=False))
            return EXIT_ERROR
        order = args.order if args.order else max([s.get("order", 0) for s in shelves] + [0]) + 1
        shelves.append({"name": name, "key": key, "order": order,
                        "desc": args.desc or "", "keywords": [k for k in (args.keywords or []) if k]})
        data["shelves"] = shelves
        _write_taxonomy(data)
        shelf_dir(name).mkdir(parents=True, exist_ok=True)
        build_index()
        print(json.dumps({"added": name, "key": key, "order": order,
                          "dir": str(shelf_dir(name)),
                          "shelves": [s["name"] for s in shelves],
                          "next": f"把卡放进来：kcard.py ingest <文件> --shelf {name}"},
                         ensure_ascii=False, indent=2))
        return EXIT_OK

    if action == "rename":
        old = resolve_shelf(args.old)
        if not old or old == UNCLASSIFIED:
            print(json.dumps({"error": f"未知书架 {args.old}",
                              "shelves": [s["name"] for s in shelves]}, ensure_ascii=False))
            return EXIT_ERROR
        new = str(args.new).strip()
        if len(new) > 12 or re.search(r"[\\/:*?\"<>|]", new):
            print(json.dumps({"error": f"书架名不合规: {new}"}, ensure_ascii=False))
            return EXIT_ERROR
        if any(s["name"] == new for s in shelves):
            print(json.dumps({"error": f"书架已存在: {new}"}, ensure_ascii=False))
            return EXIT_ERROR
        src, dst = shelf_dir(old), shelf_dir(new)
        if dst.exists() and any(dst.iterdir()):
            print(json.dumps({"error": f"目标目录非空: {dst}"}, ensure_ascii=False))
            return EXIT_ERROR
        moved = 0
        for c in load_all(include_drafts=True):
            if (card_shelf(c) or UNCLASSIFIED) != old:
                continue
            p = Path(c["_path"])
            text = p.read_text(encoding="utf-8")
            if re.search(r"^shelf:.*$", text, re.M):
                text = re.sub(r"^shelf:.*$", f"shelf: {new}", text, count=1, flags=re.M)
            else:
                text = re.sub(r"^(id:.*)$", r"\1\nshelf: " + new, text, count=1, flags=re.M)
            p.write_text(text, encoding="utf-8")
            if p.parent == src:
                dst.mkdir(parents=True, exist_ok=True)
                p.rename(dst / p.name)
                moved += 1
        if src.exists():
            try:
                src.rmdir()
            except OSError:
                pass
        for s in shelves:
            if s["name"] == old:
                s["name"] = new
                if str(s.get("key")) == old:
                    s["key"] = new
        data["shelves"] = shelves
        _write_taxonomy(data)
        build_index()
        print(json.dumps({"renamed": [old, new], "moved_files": moved,
                          "shelves": [s["name"] for s in shelves]}, ensure_ascii=False, indent=2))
        return EXIT_OK

    print(json.dumps({"error": f"未知动作 {action}"}, ensure_ascii=False))
    return EXIT_ERROR


def cmd_shelf(args):
    c = find_card(args.id)
    if not c:
        print(json.dumps({"error": f"未找到 {args.id}"}, ensure_ascii=False))
        return EXIT_ERROR
    shelf = resolve_shelf(args.shelf)
    if not shelf:
        print(json.dumps({"error": f"未知书架 {args.shelf}", "shelves": shelf_names(),
                          "hint": "确实需要新书架就先 kcard.py taxonomy add <名称> --desc ..."},
                         ensure_ascii=False))
        return EXIT_ERROR
    src = Path(c["_path"])
    text = src.read_text(encoding="utf-8")
    if re.search(r"^shelf:.*$", text, re.M):
        new_text = re.sub(r"^shelf:.*$", f"shelf: {shelf}", text, count=1, flags=re.M)
    else:
        new_text = re.sub(r"^(id:.*)$", r"\1\nshelf: " + shelf, text, count=1, flags=re.M)
    new_text = re.sub(r"^updated:.*$", f"updated: {today()}", new_text, count=1, flags=re.M)
    dst_dir = shelf_dir(shelf)
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / src.name
    dst.write_text(new_text, encoding="utf-8")
    if src.resolve() != dst.resolve():
        src.unlink()
    log({"action": "shelf", "id": c.get("id"), "to": shelf})
    build_index()
    print(json.dumps({"ok": True, "id": c.get("id"), "shelf": shelf, "path": str(dst)},
                     ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_list(args):
    cards = load_all(include_drafts=True)
    if args.type:
        t = resolve_type(args.type) or args.type
        cards = [c for c in cards if c.get("type") == t]
    if args.shelf:
        s = resolve_shelf(args.shelf) or args.shelf
        cards = [c for c in cards if (card_shelf(c) or UNCLASSIFIED) == s]
    if args.tag:
        cards = [c for c in cards if args.tag in (c.get("tags") or [])]
    rows = [{"id": c.get("id"), "title": c.get("title_zh"), "type": c.get("type"),
             "shelf": card_shelf(c) or UNCLASSIFIED, "status": c.get("status"),
             "sources": len(c.get("sources") or []), "tags": c.get("tags") or []}
            for c in cards]
    print(json.dumps({"count": len(rows), "cards": rows}, ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_show(args):
    c = find_card(args.id)
    if not c:
        print(json.dumps({"error": f"未找到 {args.id}"}, ensure_ascii=False))
        return EXIT_ERROR
    print(json.dumps({k: v for k, v in c.items() if not k.startswith("_")},
                     ensure_ascii=False, indent=2))
    print("\n--- body ---\n" + c.get("_body", ""))
    return EXIT_OK


def cmd_alias(args):
    c = find_card(args.id)
    if not c:
        print(json.dumps({"error": f"未找到 {args.id}"}, ensure_ascii=False))
        return EXIT_ERROR
    p = Path(c["_path"])
    text = p.read_text(encoding="utf-8")
    aliases = [str(a) for a in (c.get("aliases") or [])]
    if args.alias in aliases:
        print(json.dumps({"ok": True, "unchanged": True, "aliases": aliases}, ensure_ascii=False))
        return EXIT_OK
    aliases.append(args.alias)
    new_line = "aliases: " + json.dumps(aliases, ensure_ascii=False)
    text = re.sub(r"^aliases:.*$", new_line, text, count=1, flags=re.M)
    text = re.sub(r"^updated:.*$", f"updated: {today()}", text, count=1, flags=re.M)
    p.write_text(text, encoding="utf-8")
    build_index()
    print(json.dumps({"ok": True, "id": c.get("id"), "aliases": aliases}, ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_reindex(args):
    cat = build_index()
    g = build_graph_data(cat, load_all(include_drafts=True))
    print(json.dumps({"count": cat["count"], "shelves": len(_group_by_shelf(cat["cards"])),
                      "catalog": str(catalog_path()), "index": str(index_path()),
                      "browse": str(browse_path()), "graph": str(graph_path()),
                      "graph3d": str(graph3d_path()), "pairs": g["pairs"],
                      "relations": len(g["edges"])}, ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_graph(args):
    # 只重建关系网两张页：catalog / INDEX / 浏览页一律不动，复用 compute_catalog 的目录加载。
    cat, cards = compute_catalog()
    write_graph_html(cat, cards)
    write_graph_html(cat, cards, mode="3d")
    g = build_graph_data(cat, cards)
    print(json.dumps({"graph": str(graph_path()), "graph3d": str(graph3d_path()),
                      "nodes": len(g["nodes"]), "pairs": g["pairs"],
                      "edges": len(g["edges"])},
                     ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_browse(args):
    cat = build_index()
    print(json.dumps({"browse": str(browse_path()), "count": cat["count"]}, ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_doctor(args):
    cards = load_all(include_drafts=True)
    known = set(shelf_names())
    problems = {"duplicate_id": [], "missing_field": [], "broken_relation": [],
                "near_duplicate": [], "isolated": [], "no_locator": [],
                "missing_shelf": [], "unknown_shelf": [], "shelf_mismatch": [],
                "legacy_flat": [], "no_body": [], "skeleton": [], "bad_locator": []}
    ids = {}
    # 第一遍先收全 id，第二遍才校验 relations——否则指向"排在后面"的卡会被误判为断链
    for c in cards:
        cid = str(c.get("id"))
        if cid in ids:
            problems["duplicate_id"].append([cid, ids[cid], c.get("_path")])
        ids[cid] = c.get("_path")
    for c in cards:
        cid = str(c.get("id"))
        for f in REQUIRED_FIELDS:
            if not c.get(f):
                problems["missing_field"].append({"id": cid, "field": f})
        fs = c.get("first_source") or {}
        loc = str(fs.get("locator") or "").strip() if isinstance(fs, dict) else ""
        if not loc or loc in ("待核", "待补"):
            problems["no_locator"].append(cid)
        body = c.get("_body") or ""
        if len(body.strip()) < 80 or len(_split_sections(body)) < 2:
            problems["no_body"].append(cid)
        if body.count("待补") + body.count("待核") >= 2:
            problems["skeleton"].append(cid)
        if loc and _looks_like_path(loc):
            problems["bad_locator"].append(cid)

        declared = str(c.get("shelf") or "").strip()
        p = Path(c.get("_path", ""))
        on_disk = "" if p.parent == cards_dir() else p.parent.name
        if not declared:
            problems["missing_shelf"].append(cid)
        elif declared not in known:
            problems["unknown_shelf"].append({"id": cid, "shelf": declared})
        if on_disk == "":
            problems["legacy_flat"].append(cid)
        elif declared and declared != on_disk:
            problems["shelf_mismatch"].append({"id": cid, "field": declared, "dir": on_disk})

        rels = c.get("relations") or []
        if not rels:
            problems["isolated"].append(cid)
        for r in rels:
            if isinstance(r, dict) and r.get("target") and str(r["target"]) not in ids:
                problems["broken_relation"].append({"from": cid, "target": r.get("target")})

    for i in range(len(cards)):
        for j in range(i + 1, len(cards)):
            a, b = cards[i], cards[j]
            if str(a.get("id")) == str(b.get("id")):
                continue
            r = score_card(card_keys(a), b)
            if r["score"] >= 0.85:
                problems["near_duplicate"].append({
                    "a": a.get("id"), "b": b.get("id"),
                    "a_title": a.get("title_zh"), "b_title": b.get("title_zh"),
                    "score": r["score"],
                })
    summary = {k: len(v) for k, v in problems.items()}
    out = {"cards": len(cards),
           "shelves": {n: sum(1 for c in cards if (card_shelf(c) or UNCLASSIFIED) == n) for n in known},
           "summary": summary, "problems": problems}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return EXIT_OK if not any(summary.values()) else 1


# ---------------------------------------------------------------- CLI

def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "new":
        print(json.dumps({
            "removed": "new 命令已移除",
            "why": "卡片正文一律由模型整篇写完，引擎不再生成骨架",
            "how": "先写好 md（frontmatter + 正文），再跑 kcard.py ingest <文件> --shelf <书架>",
            "shelves": shelf_names(),
        }, ensure_ascii=False, indent=2))
        return EXIT_ERROR

    p = argparse.ArgumentParser(prog="kcard", description="知识卡片库本地引擎")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="初始化卡片库（建目录 + 建书架）")
    sub.add_parser("reindex", help="重建 catalog.json / INDEX.md / 浏览.html / 关系网.html / 关系网-3D.html")
    sub.add_parser("browse", help="只重建浏览页 浏览.html")
    sub.add_parser("graph", help="只重建关系网 关系网.html 与 关系网-3D.html")
    sub.add_parser("doctor", help="体检")
    sub.add_parser("shelves", help="列出书架与卡片分布")

    pc = sub.add_parser("check", help="查重")
    pc.add_argument("--title", help="中文名")
    pc.add_argument("--en", help="英文名")
    pc.add_argument("--aliases", nargs="*", help="别名（空格分隔）")
    pc.add_argument("--slug", help="slug")
    pc.add_argument("--shelf", help="给了则跳过书架建议（不给时才附带书架建议）")

    pi = sub.add_parser("ingest", help="校验并收录一张已写好的卡片")
    pi.add_argument("file", help="卡片 md 文件路径")
    pi.add_argument("--shelf", help="书架（不给则读 frontmatter，再不行按关键词判定）")
    pi.add_argument("--type", help="形态，覆盖 frontmatter")
    pi.add_argument("--status", choices=["draft", "verified", "disputed"])
    pi.add_argument("--force", action="store_true", help="跳过查重闸门")

    psh = sub.add_parser("shelf", help="改书架并移动文件")
    psh.add_argument("id")
    psh.add_argument("shelf")

    pt = sub.add_parser("taxonomy", help="书架清单管理（新领域加书架 / 改书架名）")
    tsub = pt.add_subparsers(dest="action", required=True)
    tsub.add_parser("list", help="列出书架与卡片数")
    ta = tsub.add_parser("add", help="新增书架")
    ta.add_argument("name")
    ta.add_argument("--key", help="英文键（可省略，默认与名称相同）")
    ta.add_argument("--desc", help="一句话说明这个书架装什么")
    ta.add_argument("--keywords", nargs="*", help="自动归架用的关键词")
    ta.add_argument("--order", type=int, help="排序位（默认排最后）")
    tr = tsub.add_parser("rename", help="改书架名（同时移动目录、改写卡片字段）")
    tr.add_argument("old")
    tr.add_argument("new")

    pl = sub.add_parser("list", help="列出卡片")
    pl.add_argument("--shelf")
    pl.add_argument("--type")
    pl.add_argument("--tag")

    ps = sub.add_parser("show", help="查看单卡")
    ps.add_argument("id")

    pa = sub.add_parser("alias", help="追加别名")
    pa.add_argument("id")
    pa.add_argument("alias")

    args = p.parse_args(argv)
    handler = {
        "init": cmd_init, "check": cmd_check, "ingest": cmd_ingest, "list": cmd_list,
        "show": cmd_show, "alias": cmd_alias, "reindex": cmd_reindex, "doctor": cmd_doctor,
        "shelves": cmd_shelves, "shelf": cmd_shelf, "browse": cmd_browse,
        "graph": cmd_graph, "taxonomy": cmd_taxonomy,
    }[args.cmd]
    try:
        return handler(args)
    except EmptyLibraryBlocked as e:
        # 空库拒写走独立的退出码，面板能据此显示「路径不对」而不是「0 张卡」。
        print(json.dumps({"blocked": True, "reason": "empty-library",
                          "error": str(e), "home": str(home())},
                         ensure_ascii=False, indent=2))
        return EXIT_BLOCKED


if __name__ == "__main__":
    sys.exit(main())
