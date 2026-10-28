#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""selftest.py — kcard 引擎自测（不需要外部依赖）

覆盖：初始化、ingest 收录、查重四态、两道闸门、自动归架、编号、
改书架、索引分组、体检、浏览页、frontmatter 往返、正文不被改写。

用法:
    python scripts/selftest.py
"""

import io
import json
import os
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

TMP = Path(tempfile.mkdtemp(prefix="kcard-selftest-"))
SRC = Path(tempfile.mkdtemp(prefix="kcard-src-"))
os.environ["KCARD_HOME"] = str(TMP)
# 用清单副本，避免自测把「数字经济」写进真正的 taxonomy.json
TAX_COPY = TMP / "taxonomy.json"
shutil.copyfile(HERE.parent / "taxonomy.json", TAX_COPY)
os.environ["KCARD_TAXONOMY"] = str(TAX_COPY)

import kcard  # noqa: E402

PASS, FAIL = [], []

BODY = """
## 核心命题

企业必须先有内部研究能力，才能看懂并利用外部科学知识；吸收能力是研发投入的副产品。

## 提出者与出处

Cohen, W. M., & Levinthal, D. A. (1990). Administrative Science Quarterly, 35(1), 128-152.

## 机制

- 外部知识先要能被识别，识别需要内部相关的知识存量
- 存量越高，单位投入的可得知识越多

## 关键概念

- **吸收能力**：识别、消化、商业化外部知识的能力
"""


def ok(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"  {detail}" if detail and not cond else ""))


def run(*argv):
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = kcard.main(list(argv))
    return rc, buf.getvalue()


def make_card(name, title_zh, title_en, type_="theory", status="verified",
              locator="第 128-129 页", body=BODY, aliases=None):
    p = SRC / name
    al = json.dumps(aliases or [], ensure_ascii=False)
    p.write_text(f"""---
type: {type_}
title_zh: {title_zh}
title_en: {title_en}
aliases: {al}
status: {status}
first_source:
  citation: Cohen & Levinthal (1990), ASQ 35(1), 128-152.
  locator: {locator}
tags: ["创新", "企业理论"]
---

{body}
""", encoding="utf-8")
    return p


def main():
    print(f"临时库: {TMP}\n")

    print("[1] 初始化")
    rc, _ = run("init")
    ok("init 退出码 0", rc == 0, f"rc={rc}")
    ok("cards 目录存在", (TMP / "cards").is_dir())
    ok("rendered 目录存在", (TMP / "rendered").is_dir())
    ok("按 taxonomy 建出书架目录", (TMP / "cards" / "知识转换").is_dir()
       and (TMP / "cards" / "信息与合约").is_dir())

    print("[2] new 已移除")
    rc, out = run("new", "--title", "吸收能力")
    ok("new 返回退出码 4", rc == 4, f"rc={rc}")
    ok("new 提示改用 ingest", "ingest" in out)

    print("[3] ingest 收录")
    src = make_card("c1.md", "吸收能力", "Absorptive Capacity", aliases=["企业吸收能力"])
    before = src.read_text(encoding="utf-8").split("---", 2)[2]
    rc, out = run("ingest", str(src), "--shelf", "知识转换")
    ok("ingest 退出码 0", rc == 0, f"rc={rc} {out[:200]}")
    card = TMP / "cards" / "知识转换" / "T-0001-absorptive-capacity.md"
    ok("落在指定书架目录", card.exists(), str(card))
    text = card.read_text(encoding="utf-8") if card.exists() else ""
    ok("自动分配 id", "id: T-0001" in text)
    ok("写入 shelf 字段", "shelf: 知识转换" in text)
    parsed = kcard.load_card(card) if card.exists() else {}
    ok("正文未被改写", parsed.get("_body", "").strip() == before.strip())
    ok("first_source 可解析", isinstance(parsed.get("first_source"), dict))
    ok("库外源文件保留（不擅删）", src.exists())

    print("[3b] 重写同一张卡")
    n_before = len(list((TMP / "cards").rglob("*.md")))
    rc, out = run("ingest", str(card), "--shelf", "知识转换", "--force")
    ok("重写退出码 0", rc == 0, f"rc={rc} {out[:150]}")
    ok("标记 rewritten", '"rewritten": true' in out, out[:150])
    ok("不产生第二份", len(list((TMP / "cards").rglob("*.md"))) == n_before)

    print("[4] 查重四态")
    r = kcard.check_title("吸收能力")
    ok("同名 -> duplicate", r["verdict"] == "duplicate", r["verdict"])
    r = kcard.check_title("企业吸收能力")
    ok("别名命中 -> duplicate", r["verdict"] == "duplicate", r["verdict"])
    ok("别名命中分 >= 0.97", r["candidates"][0]["score"] >= 0.97, str(r["candidates"][0]["score"]))
    r = kcard.check_title(en="Absorptive Capacity Theory")
    ok("英文剥后缀 -> duplicate", r["verdict"] == "duplicate", r["verdict"])
    r = kcard.check_title("组织吸收能力")
    ok("近义变体 -> suspect", r["verdict"] == "suspect", f'{r["verdict"]} {r["candidates"][0]["score"]}')
    r = kcard.check_title("干中学")
    ok("无关概念 -> new", r["verdict"] == "new", r["verdict"])

    print("[5] 查重闸门")
    dup = make_card("dup.md", "吸收能力理论", "Absorptive Capacity")
    rc, out = run("ingest", str(dup), "--shelf", "知识转换")
    ok("重复卡被拦截（退出码 3）", rc == 3, f"rc={rc}")
    ok("被拦截时不产生新文件", len(list((TMP / "cards").rglob("*.md"))) == 1)
    ok("被拦截时保留源文件", dup.exists())

    print("[6] 质量闸门")
    thin = make_card("thin.md", "路径依赖", "Path Dependence", body="\n## 核心命题\n\n待补。\n")
    rc, out = run("ingest", str(thin), "--shelf", "创新激励")
    ok("正文过短被拦截", rc == 3, f"rc={rc}")
    ok("给出具体问题清单", "issues" in out and "正文" in out)
    bad = make_card("bad.md", "路径依赖", "Path Dependence", locator="待核")
    rc, out = run("ingest", str(bad), "--shelf", "创新激励")
    ok("verified 但 locator 待核被拦截", rc == 3, f"rc={rc}")
    pathloc = make_card("path.md", "路径依赖", "Path Dependence",
                        locator=r"C:\Users\me\Downloads\full.md")
    rc, out = run("ingest", str(pathloc), "--shelf", "创新激励")
    ok("locator 是本地路径被拦截", rc == 3, f"rc={rc}")
    skel = make_card("skel.md", "路径依赖", "Path Dependence",
                     body=BODY + "\n## 前提假设\n\n- 待补：这个理论在什么条件下成立\n")
    rc, out = run("ingest", str(skel), "--shelf", "创新激励")
    ok("骨架卡（留「待补」）被拦截", rc == 3, f"rc={rc}")
    ok("拦截理由点名待补", "待补" in out)

    print("[7] 自动归架")
    auto = make_card("auto.md", "团队生产中的搭便车", "Free Riding in Team Production",
                     locator="第 12 页",
                     body=BODY + "\n## 边界与误用\n\n- 道德风险与监督成本有关，搭便车源于不可观测。\n")
    rc, out = run("ingest", str(auto))
    ok("不给 --shelf 也能收录", rc == 0, f"rc={rc} {out[:200]}")
    ok("判定为「信息与合约」", "信息与合约" in out, out[:200])
    ok("给出自动判定提示", "自动判定" in out)

    print("[8] 编号与形态")
    e = make_card("e.md", "干中学", "Learning by Doing", type_="effect",
                  locator="第 3 页", body=BODY)
    rc, out = run("ingest", str(e), "--shelf", "创新激励")
    ok("effect 收录成功", rc == 0, f"rc={rc}")
    ok("effect 用 E 前缀", (TMP / "cards" / "创新激励" / "E-0001-learning-by-doing.md").exists())
    ok("形态各自编号", sorted(c["id"] for c in kcard.load_all()) == ["E-0001", "T-0001", "T-0002"],
       str(sorted(c["id"] for c in kcard.load_all())))

    print("[9] 别名追加")
    rc, _ = run("alias", "T-0001", "组织吸收能力")
    ok("alias 退出码 0", rc == 0)
    r = kcard.check_title("组织吸收能力")
    ok("追加后变为 duplicate", r["verdict"] == "duplicate", r["verdict"])

    print("[10] 改书架")
    rc, out = run("shelf", "T-0001", "创新激励")
    ok("shelf 退出码 0", rc == 0, out[:200])
    ok("文件已移动", (TMP / "cards" / "创新激励" / "T-0001-absorptive-capacity.md").exists())
    ok("旧位置已清空", not (TMP / "cards" / "知识转换" / "T-0001-absorptive-capacity.md").exists())
    moved = kcard.load_card(TMP / "cards" / "创新激励" / "T-0001-absorptive-capacity.md")
    ok("frontmatter 同步更新", moved.get("shelf") == "创新激励", str(moved.get("shelf")))

    print("[11] 索引")
    cat = kcard.build_index()
    ok("catalog 计数为 3", cat["count"] == 3, str(cat["count"]))
    ok("catalog 带 shelf 字段", all("shelf" in c for c in cat["cards"]))
    idx = TMP / "INDEX.md"
    ok("INDEX.md 生成", idx.exists())
    md = idx.read_text(encoding="utf-8") if idx.exists() else ""
    ok("INDEX 有书架总览", "书架总览" in md)
    ok("INDEX 按书架分组", "## 创新激励" in md)
    ok("INDEX 含卡片名", "吸收能力" in md)

    print("[12] 浏览页")
    ok("浏览.html 生成", (TMP / "浏览.html").exists())
    html = (TMP / "浏览.html").read_text(encoding="utf-8") if (TMP / "浏览.html").exists() else ""
    ok("浏览页内嵌卡片数据", "Absorptive Capacity" in html)
    ok("浏览页按书架分组", "创新激励" in html)
    ok("浏览页未泄漏库绝对路径", str(TMP) not in html)

    print("[12b] 关系网")
    ok("关系网.html 生成", (TMP / "关系网.html").exists())
    ok("关系网-3D.html 生成", (TMP / "关系网-3D.html").exists())
    g2 = (TMP / "关系网.html").read_text(encoding="utf-8") if (TMP / "关系网.html").exists() else ""
    g3 = (TMP / "关系网-3D.html").read_text(encoding="utf-8") if (TMP / "关系网-3D.html").exists() else ""
    ok("2D 页标记 mode=2d", '"mode": "2d"' in g2)
    ok("3D 页标记 mode=3d", '"mode": "3d"' in g3)
    ok("3D 页有自动旋转开关", 'id="c-auto"' in g3 and 'id="c-auto"' not in g2)
    ok("两页互相链接", "关系网-3D.html" in g2 and "关系网.html" in g3)
    ok("关系网内嵌卡片数据", "Absorptive Capacity" in g2)
    ok("关系用直线+箭头画方向", "lineTo(sx1, sy1)" in g2 and "function arrowHead" in g2)
    ok("并列关系用虚线", "setLineDash([5, 4])" in g2)
    ok("边是有向的（s/t 字段）", "e.s === id" in g2 and "byId[e.t]" in g2)
    ok("页头区分对数与边数", "条有向边" in g2)
    ok("有书架领域图层", "function territoryPath" in g2 and "drawTerritories" in g2)
    ok("左栏可按关系类型筛选", 'id="types"' in g2 and 'id="b-all-type"' in g2)
    ok("右侧清单按对方卡归并", "function pairGroups" in g2 and "双向声明" in g2)
    ok("有使用说明按钮", 'id="b-help"' in g2 and "怎么读" in g2)
    ok("说明书弹层在关系网页", 'id="help"' in g2 and "这张图怎么读" in g2)
    ok("说明书没串到浏览页", 'id="help"' not in (TMP / "浏览.html").read_text(encoding="utf-8"))
    ok("关系网未泄漏库绝对路径", str(TMP) not in g2 and str(TMP) not in g3)

    print("[13] 体检")
    rc, out = run("doctor")
    d = json.loads(out)
    ok("doctor 能跑通", "summary" in d)
    ok("无重复 id", d["summary"]["duplicate_id"] == 0, str(d["summary"]["duplicate_id"]))
    ok("无缺书架", d["summary"]["missing_shelf"] == 0, str(d["summary"]["missing_shelf"]))
    ok("无扁平遗留", d["summary"]["legacy_flat"] == 0, str(d["summary"]["legacy_flat"]))
    ok("书架与目录一致", d["summary"]["shelf_mismatch"] == 0, str(d["summary"]["shelf_mismatch"]))
    ok("无骨架卡", d["summary"]["skeleton"] == 0, str(d["summary"]["skeleton"]))
    ok("无坏 locator", d["summary"]["bad_locator"] == 0, str(d["summary"]["bad_locator"]))
    ok("检出孤岛卡", d["summary"]["isolated"] == 3, str(d["summary"]["isolated"]))

    print("[14] 扁平旧结构兼容")
    legacy = TMP / "cards" / "C-0001-legacy.md"
    legacy.write_text("""---
id: C-0001
type: concept
title_zh: 外部性
title_en: Externality
status: draft
first_source:
  citation: 旧卡
  locator: 第 1 页
---

## 核心命题

一方的行为未经市场定价地影响另一方。这也是一张足够长的旧卡正文，用来验证扁平目录仍能被读到。

## 机制

- 私人成本与社会成本背离
""", encoding="utf-8")
    cards = kcard.load_all(include_drafts=True)
    ok("扁平目录的卡仍被读到", any(c["id"] == "C-0001" for c in cards))
    rc, out = run("doctor")
    d = json.loads(out)
    ok("旧扁平卡被标 legacy_flat", d["summary"]["legacy_flat"] == 1, str(d["summary"]["legacy_flat"]))
    ok("旧扁平卡被标 missing_shelf", d["summary"]["missing_shelf"] == 1, str(d["summary"]["missing_shelf"]))
    legacy.unlink()

    print("[15] frontmatter 往返")
    fm = {
        "id": "T-0099", "type": "theory", "shelf": "知识属性", "title_zh": "知识的非竞争性",
        "title_en": "Non-rivalry of Ideas", "aliases": ["思想的非竞争性", "Non-rivalry"],
        "slug": "non-rivalry-of-ideas", "status": "verified", "confidence": "high",
        "school": "新增长理论", "era": "1990-", "authors": ["Romer, P. M."],
        "style": {"cover": "#1b2a4a", "accent": "#a8791f",
                  "display_font": '"Noto Sans SC",sans-serif', "leading": "1.7"},
        "first_source": {"citation": "Romer (1990), JPE 98(5), S71-S102.",
                         "locator": "第 S74-S75 页（非竞争性与排他性的区分）"},
        "sources": [{"citation": "Arora et al. (2023), NBER WP 31899.",
                     "locator": "PDF 第 40-41 页", "role": "引用"}],
        "relations": [{"type": "应用于", "target": "M-0001", "note": "越接近纯非竞争性越难直接卖"}],
        "tags": ["增长", "知识"], "created": "2026-10-20", "updated": "2026-10-21",
    }
    emitted = kcard.emit_frontmatter(fm)
    back, _ = kcard.parse_frontmatter(emitted + "\n\n## 核心命题\n\n测试。\n")
    ok("往返后字段数一致", len(back) == len(fm), f"{len(back)} vs {len(fm)}")
    ok("往返后嵌套 dict 一致", back.get("style") == fm["style"], str(back.get("style")))
    ok("往返后 dict 列表一致", back.get("sources") == fm["sources"], str(back.get("sources")))
    ok("往返后 relations 一致", back.get("relations") == fm["relations"], str(back.get("relations")))
    ok("往返后字符串列表一致", back.get("tags") == fm["tags"])

    print("[16] 新领域：加书架 / 改名")
    rc, out = run("taxonomy", "add", "数字经济", "--desc", "平台与数据要素",
                  "--keywords", "数据要素", "平台")
    ok("taxonomy add 退出码 0", rc == 0, f"rc={rc} {out[:200]}")
    ok("新书架目录已建", (TMP / "cards" / "数字经济").is_dir())
    ok("taxonomy.json 已写入", "数字经济" in TAX_COPY.read_text(encoding="utf-8"))
    ok("书架清单包含新架", "数字经济" in kcard.shelf_names())
    rc, out = run("taxonomy", "add", "数字经济")
    ok("重复加架被拒绝", rc == 4, f"rc={rc}")

    newc = make_card("data.md", "数据要素的规模报酬", "Increasing Returns to Data",
                     locator="第 2821 页",
                     body=BODY + "\n## 关联与争议\n\n- 数据需要匹配场景，不能像论文一样直接复制\n")
    rc, out = run("ingest", str(newc), "--shelf", "数字经济")
    ok("可收录进新书架", rc == 0, f"rc={rc} {out[:200]}")
    ok("落在新书架目录", any((TMP / "cards" / "数字经济").glob("*.md")))
    ok("未知书架报错带提示", "taxonomy add" in run("shelf", "T-0001", "不存在的架")[1])

    rc, out = run("taxonomy", "rename", "数字经济", "数字与数据")
    ok("taxonomy rename 退出码 0", rc == 0, f"rc={rc} {out[:200]}")
    ok("旧目录已消失", not (TMP / "cards" / "数字经济").exists())
    ok("新目录已有卡", any((TMP / "cards" / "数字与数据").glob("*.md")))
    moved_data = next(iter((TMP / "cards" / "数字与数据").glob("*.md")), None)
    ok("卡片 shelf 字段同步改写",
       moved_data is not None and kcard.load_card(moved_data).get("shelf") == "数字与数据",
       str(moved_data))
    ok("改名后清单更新", "数字与数据" in kcard.shelf_names() and "数字经济" not in kcard.shelf_names())
    ok("未归类兜底可收卡", run("ingest", str(make_card(
        "loose.md", "待定主题的一条观察", "An Unclassified Observation", locator="第 9 页")),
        "--shelf", "未归类")[0] == 0)

    print("[17] 迁移安全：卡片只用 id 互链")
    ok("卡片内无绝对路径", str(TMP) not in text)

    print(f"\n通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项: " + ", ".join(FAIL))
    shutil.rmtree(TMP, ignore_errors=True)
    shutil.rmtree(SRC, ignore_errors=True)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
