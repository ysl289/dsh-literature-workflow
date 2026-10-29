#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_cards.py — 文献工作流的「制卡」阶段

这一阶段**不生成卡片**（骨架式建卡已废弃：脚本吐模板、模型填空，只会把模板带进正文）。
它做三件事：

  1. 查重：从 extract.json 的 economic_theories 逐条比对卡片库
  2. 出任务书：为每个理论生成一节《制卡任务书》，写清该归哪个书架、机制是什么形状、
     该用哪种版式，并要求动笔前先交一份《制卡前判定.json》（用/不用、怎么用、原文在哪）
  3. 验收：模型把卡写完之后，按「判定书 + 出任务书时的快照」分桶验收——
     本次新建 / 并入既有 / 声明跳过 / 库里已有 / 未入库

用法:
    # 出任务书（默认，不写库；同时写出候选查重快照）
    python src/cards/make_cards.py --extract staging/xxx.extract.json

    # 模型写完卡、交完判定书之后验收
    python src/cards/make_cards.py --extract staging/xxx.extract.json --verify

    # 验收通过后重出图（只重出「本次新建」的卡）
    python src/cards/make_cards.py --extract staging/xxx.extract.json --verify --render

判定书与快照默认都放在报告同目录：
    制卡前判定.json      {"bridge":"0.1.0","citation":"…","theories":[
                          {"theory":"技术转移理论","usage":"core","verdict":"build",
                           "evidence":[{"page":1,"quote":"…"}],"shelf":"知识转换","reason":"…"}]}
    制卡候选快照.json    {"generatedAt":"ISO8601","citation":"…","theories":[
                          {"zh":"…","en":"…","verdict":"new","score":0.62,"near":"T-0007","shelf":"知识转换"}]}
"""

import argparse
import datetime as _dt
import json
import re
import subprocess
import sys
from pathlib import Path

SKILL = Path.home() / ".dsh" / "skills" / "knowledge-card-library"
if not SKILL.exists():
    SKILL = Path.home() / ".agents" / "skills" / "knowledge-card-library"
KCARD = SKILL / "scripts" / "kcard.py"
RENDER = SKILL / "scripts" / "render_card_single.py"

if sys.platform == "win32":
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

USAGE_VALUES = ("core", "supporting", "background", "extension")
VERDICT_VALUES = ("build", "merge", "skip_existing", "skip_declared")
USAGE_ROW = ("| 文中用法 | （必填）core / supporting / background / extension | "
             "逐条给页码与原文短引；没有原文证据就写 background |")
VERDICT_ROW = ("| 判定 | （必填）build / merge / skip_existing / skip_declared | "
               "background 或无原文证据 → skip_declared；库里已有 → skip_existing |")


def run(script, args):
    """调脚本，返回 (退出码, 解析后的 JSON 或 None, 原始输出)。"""
    r = subprocess.run([sys.executable, str(script)] + args,
                       capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout or "").strip()
    try:
        return r.returncode, json.loads(out), out
    except Exception:                                   # noqa: BLE001
        return r.returncode, None, (out or r.stderr or "").strip()


def norm_name(value) -> str:
    """理论名比对用的归一化：去空白、忽略大小写。"""
    return re.sub(r"\s+", "", str(value or "")).strip().casefold()


def parse_theory(s: str):
    """'向下倾斜的需求曲线假说（Downward-Sloping Demand Curve Hypothesis）'"""
    m = re.match(r"^(.*?)[（(](.*?)[）)]\s*$", str(s).strip())
    return (m.group(1).strip(), m.group(2).strip()) if m else (str(s).strip(), "")


MOTIF_HINT = [
    ("吸收|门槛|准入|筛选|过滤|识别|转化|门槛", "gate", "闸门：外部的东西要穿过自身能力才变成可用的量"),
    ("复制|非竞争|规模报酬|边际成本为零|拷贝", "copy", "复制：一份原样不动，旁边多出几份"),
    ("渠道|通道|路径|分流|替代|多条", "fork", "分叉：一个源头分出多条通道"),
    ("递减|分层|分级|筛选|阶梯|门槛递增", "ladder", "阶梯：逐级上升，台阶越来越窄"),
    ("反馈|路径依赖|累积因果|自我强化|循环", "loop", "回路：正反馈自我强化"),
    ("积累|存量|叠加|人力资本|层层", "stack", "堆叠：层层累积"),
    ("对照|对立|对比|两难|权衡|vs|两种情形", "contrast", "对照：两种情形并置"),
    ("传导|溢出|流转|传递|扩散|损耗", "flow", "流转：单向传导，逐段变细"),
]

EDITION_HINT = [
    ("假设|前提|术语|符号", "ledger", "账簿：假设多、术语多、条目多"),
    ("渠道|步骤|流程|机制", "band", "横幅：机制、渠道、流程类"),
    ("对照|对立|两难", "atlas", "图册：对照、对立、分叉结构"),
]


def guess_motif(text: str):
    for pat, key, why in MOTIF_HINT:
        if re.search(pat, text):
            return key, why
    return "", "判断不出机制形状 → 用提出者徽记兜底"


def guess_edition(text: str):
    for pat, key, why in EDITION_HINT:
        if re.search(pat, text):
            return key, why
    return "atelier", "工坊：成体系的理论卡（默认）"


def build_snapshot(citation: str, verdicts: list[dict]) -> dict:
    """出任务书时的查重快照——验收分桶的基线，验收阶段绝不覆盖它。"""
    return {
        "generatedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "citation": citation,
        "theories": [
            {
                "zh": v["zh"],
                "en": v.get("en") or "",
                "verdict": v["verdict"],
                "score": round(float(v.get("score") or 0), 4),
                "near": v.get("near") or "",
                "shelf": v.get("shelf") or "（未判定）",
            }
            for v in verdicts
        ],
    }


def write_snapshot(path: Path, citation: str, verdicts: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_snapshot(citation, verdicts)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_sheet(theories, citation, meta, shelves, verdicts,
                judgement_path: Path | None = None,
                snapshot_path: Path | None = None):
    """把查重结果写成一张可执行的制卡任务书。"""
    lines = [
        f"# 制卡任务书：{meta.get('first_author_surname', '')} {meta.get('year', '')}".strip(),
        "",
        f"- 文献：{citation}",
        f"- 候选理论：{len(theories)} 个",
        "",
        "> 这张表是**给写卡的人看的**，不是卡片本身。每一节都要填完再动笔；",
        "> 填不出来的那一栏，就是这张卡会难看的地方。",
        "> 动笔前必须先交《制卡前判定》——见文末第四节。",
        "",
    ]

    todo = [v for v in verdicts if v["verdict"] != "duplicate"]
    skip = [v for v in verdicts if v["verdict"] == "duplicate"]

    lines += ["## 一、理论清单（逐条判定，先判定再动笔）", "",
              "> 每个理论都要在《制卡前判定.json》里出现一条；判定 build / merge 的才写卡。", ""]
    for i, v in enumerate(verdicts, 1):
        blob = " ".join([v["zh"], v["en"], v.get("hint", "")])
        motif, motif_why = guess_motif(blob)
        edition, edition_why = guess_edition(blob)
        lines += [
            f"### {i}. {v['zh']}" + (f"（{v['en']}）" if v["en"] else ""),
            "",
            "| 项 | 值 | 说明 |",
            "| --- | --- | --- |",
            f"| 查重 | `{v['verdict']}` | "
            + (f"最接近 {v['near']}（{v['score']:.2f}），写卡时对照差异" if v.get("near")
               else "库内无相近条目") + " |",
            f"| 建议书架 | **{v['shelf']}** | "
            + (f"命中关键词：{'、'.join(v['hits'])}" if v.get("hits") else "按内容判断后自行定架")
            + " |",
            f"| 机制形状 | `{motif or '（自己判断）'}` | {motif_why} |",
            f"| 建议版式 | `{edition}` | {edition_why} |",
            USAGE_ROW,
            VERDICT_ROW,
            "",
        ]
        if v["verdict"] == "duplicate":
            lines += [
                f"**库里已有：命中 {v['near']} {v.get('near_title', '')}（{v['score']:.2f}）。"
                f"判定写 `skip_existing`；不写新卡，在既有卡 `sources` 追加本次出处。**",
                "",
            ]
        else:
            lines += [
                "写卡前必须想清这四件事（想不清就先别写）：",
                "",
                "1. **命题**：一句话，24–46 字，能独立站住。它会成为封面大字。",
                "2. **前提**：这个理论在什么条件下成立？哪些是隐含假设？",
                "3. **机制**：从 A 到 B 分几步？写成 `1. 2. 3.`，渲染器会排成链条。",
                "4. **可形式化的量**：有就写公式 + 符号表；没有就整节不写，不要硬凑。",
                "",
            ]

    if skip:
        lines += ["## 二、跳过：库里已有", "",
                  "| 理论 | 命中卡 | 分数 | 要做的事 |",
                  "| --- | --- | --- | --- |",
                  ]
        for v in skip:
            lines.append(f"| {v['zh']} | {v['near']} {v.get('near_title', '')} | "
                         f"{v['score']:.2f} | 不写新卡；在既有卡 `sources` 追加本次出处 |")
        lines.append("")
        lines.append("**跳过清单必须写进制卡报告**——不写，用户会以为漏做了。")
        lines.append("")

    lines += [
        "## 三、写完之后",
        "",
        "```bash",
        "# 1. 收录（脚本会校验正文完整、出处有 locator、与库内不重复）",
        f"python {KCARD} ingest <卡片.md> --shelf <书架>",
        "",
        "# 2. 挂关系（至少一条，否则是孤立卡）",
        "#    在 frontmatter 的 relations 里写，反向边也要补",
        "",
        "# 3. 重出索引与关系网",
        f"python {KCARD} reindex",
        "",
        "# 4. 出图（先看一眼封面，再决定要不要改 motif / edition）",
        f"python {RENDER} <卡片id>",
        "```",
        "",
        "出图后自检五问（见 `references/design-doctrine.md` 第八节）：命题立不立得住、",
        "图形说得出机制、两卡并排看得出区别、章节在讲论证不是在填表、有没有该删的一节。",
        "",
    ]

    judge = str(judgement_path) if judgement_path else "制卡前判定.json"
    snap = str(snapshot_path) if snapshot_path else "制卡候选快照.json"
    lines += [
        "## 四、动笔前必须提交制卡前判定",
        "",
        "动笔之前，先把判定书写到（JSON，字段名不要改）：",
        "",
        "```",
        judge,
        "```",
        "",
        "```json",
        '{"bridge":"0.1.0","citation":"…","theories":[',
        '  {"theory":"技术转移理论","usage":"core","verdict":"build",',
        '   "evidence":[{"page":1,"quote":"原文短引"}],"shelf":"知识转换","reason":"为什么这样判"}',
        "]}",
        "```",
        "",
        "- `usage` 必填：`core` / `supporting` / `background` / `extension`",
        "- `verdict` 必填：`build` / `merge` / `skip_existing` / `skip_declared`",
        "- **background 或没有原文证据 → `skip_declared`**，并在 `reason` 写清为什么",
        "- `build` / `merge` 必须给至少一条 `evidence`：`page` 为整数页码（≥1），`quote` 为原文短引",
        "- 库里已有（本任务书的查重命中）→ `skip_existing`",
        f"- 本任务书生成时的候选查重快照：`{snap}`（验收分桶用，不要手改）",
        "",
        "缺判定书、或判定不合法（理论名对不上 / verdict 越界 / skip_declared 没理由 /",
        "build·merge 没有原文证据），验收会报「判定书错误」并拒绝通过。",
        "",
    ]
    return "\n".join(lines)


def load_skip_map(path: str | None) -> dict[str, str]:
    """读取声明跳过清单：[{theory, reason}]。"""
    skip_map: dict[str, str] = {}
    if not path:
        return skip_map
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except Exception:                                  # noqa: BLE001
        raw = []
    for item in (raw if isinstance(raw, list) else []):
        if isinstance(item, dict) and str(item.get("theory") or "").strip():
            skip_map[str(item["theory"]).strip()] = str(item.get("reason") or "").strip()
    return skip_map


def legacy_verify(verdicts, meta, citation, report: Path, skip_path, do_render: bool,
                  note: str = "") -> int:
    """旧验收路径：只按「当前查重是否 duplicate」报已入库 / 跳过 / 未入库。

    保留给没有判定书的历史任务（有 制卡跳过.json 时尤其需要）。
    """
    lines = [f"# 制卡报告：{meta.get('first_author_surname', '')} {meta.get('year', '')}".strip(),
             "", f"- 文献：{citation}", ""]
    if note:
        lines += [f"> {note}", ""]
    done, missing, skipped, declared = [], [], [], []
    skip_map = load_skip_map(skip_path)

    def declared_reason(zh: str) -> str | None:
        for key, reason in skip_map.items():
            if key == zh or key in zh or zh in key:
                return reason
        return None

    for v in verdicts:
        if v["verdict"] == "duplicate":
            skipped.append(v)
            continue
        reason = declared_reason(v["zh"])
        if reason is not None:
            if reason:
                declared.append((v["zh"], reason))
            else:
                missing.append(v["zh"])
            continue
        _, res, _ = run(KCARD, ["check", "--title", v["zh"]] +
                        (["--en", v["en"]] if v["en"] else []))
        top = ((res or {}).get("candidates") or [{}])[0]
        if (res or {}).get("verdict") == "duplicate" and top.get("id"):
            done.append((v["zh"], top["id"], top.get("title_zh", "")))
        else:
            missing.append(v["zh"])

    lines += ["## 已入库", "", "| 理论 | 卡片 | 标题 |", "| --- | --- | --- |"]
    lines += [f"| {zh} | {cid} | {name} |" for zh, cid, name in done] or ["| — | — | — |"]
    lines += ["", "## 跳过：库中已有", "", "| 理论 | 命中卡 | 分数 |", "| --- | --- | --- |"]
    lines += [f"| {v['zh']} | {v['near']} {v['near_title']} | {v['score']:.2f} |"
              for v in skipped] or ["| — | — | — |"]
    lines += ["", "## 跳过：已声明不建卡（需复核理由）", "", "| 理论 | 理由 |", "| --- | --- |"]
    lines += [f"| {zh} | {reason} |" for zh, reason in declared] or ["| — | — |"]
    if missing:
        lines += ["", "## 未入库（需要补写）", ""] + [f"- {z}" for z in missing]
    lines += ["", "## 设计三件套自检", "",
              "逐张确认：命题 24–46 字 / `motif` 与机制形状一致 / `edition` 与结构一致。",
              "缺任一项，重出图时版式会退回默认，两张卡并排就会看出是模板。", ""]

    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(lines), encoding="utf-8")
    print(f"报告：{report}")
    print(f"已入库 {len(done)} / 跳过 {len(skipped)} / 声明跳过 {len(declared)} / 未入库 {len(missing)}")

    if do_render and done:
        for _, cid, _ in done:
            code, _, out = run(RENDER, [cid])
            print(("  出图 " if code == 0 else "  出图失败 ") + cid + ("" if code == 0 else f"：{out[:120]}"))
    print("OK")
    return 0 if not missing else 2


def validate_judgement(obj, verdicts) -> tuple[list[dict], list[str]]:
    """校验并归一化判定书条目；返回 (entries, errors)。"""
    errors: list[str] = []
    if not isinstance(obj, dict) or not isinstance(obj.get("theories"), list):
        return [], ["顶层必须是 JSON 对象，且 `theories` 必须是数组"]

    index: dict[str, dict] = {}
    for v in verdicts:
        index[norm_name(v["zh"])] = v
        if v.get("en"):
            index.setdefault(norm_name(v["en"]), v)

    entries: list[dict] = []
    seen: set[str] = set()
    for i, item in enumerate(obj["theories"], 1):
        where = f"theories[{i}]"
        if not isinstance(item, dict):
            errors.append(f"{where}：必须是对象")
            continue
        theory = str(item.get("theory") or "").strip()
        if not theory:
            errors.append(f"{where}：缺 `theory`")
            continue
        where = theory
        v = index.get(norm_name(theory))
        if v is None:
            errors.append(f"{where}：理论名不在本次候选理论里")
            continue
        key = norm_name(v["zh"])
        if key in seen:
            errors.append(f"{where}：在判定书里重复出现")
            continue
        seen.add(key)

        usage = str(item.get("usage") or "").strip()
        if usage not in USAGE_VALUES:
            errors.append(f"{where}：`usage` 必须是 {' / '.join(USAGE_VALUES)}")
        verdict = str(item.get("verdict") or "").strip()
        if verdict not in VERDICT_VALUES:
            errors.append(f"{where}：`verdict` 必须是 {' / '.join(VERDICT_VALUES)}")
            continue
        reason = str(item.get("reason") or "").strip()
        if verdict == "skip_declared" and not reason:
            errors.append(f"{where}：`skip_declared` 必须给 `reason`")

        evidence = item.get("evidence")
        evidence = evidence if isinstance(evidence, list) else []
        if verdict in ("build", "merge"):
            valid = [e for e in evidence
                     if isinstance(e, dict)
                     and isinstance(e.get("page"), int) and not isinstance(e.get("page"), bool)
                     and e["page"] >= 1
                     and str(e.get("quote") or "").strip()]
            if not valid:
                errors.append(f"{where}：`{verdict}` 必须给至少一条 `evidence`"
                              "（`page` 为 ≥1 的整数，`quote` 非空）")
            else:
                for j, e in enumerate(evidence, 1):
                    ok = (isinstance(e, dict)
                          and isinstance(e.get("page"), int) and not isinstance(e.get("page"), bool)
                          and e["page"] >= 1 and str(e.get("quote") or "").strip())
                    if not ok:
                        errors.append(f"{where}：`evidence[{j}]` 无效（`page` 为 ≥1 的整数，"
                                      "`quote` 非空）")
            if usage == "background":
                errors.append(f"{where}：`usage=background` 必须 `skip_declared`，不能 `{verdict}`")

        entries.append({
            "theory": v["zh"], "en": v.get("en") or "",
            "usage": usage, "verdict": verdict, "reason": reason,
            "evidence": evidence, "shelf": str(item.get("shelf") or "").strip(),
            "current": v,
        })
    return entries, errors


def _report_head(meta, citation) -> list[str]:
    return [f"# 制卡报告：{meta.get('first_author_surname', '')} {meta.get('year', '')}".strip(),
            "", f"- 文献：{citation}", ""]


def _write_and_report(report: Path, lines: list[str]) -> None:
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(lines), encoding="utf-8")
    print(f"报告：{report}")


def verify_with_judgement(meta, citation, report: Path, judgement_path: Path,
                          snapshot_path: Path, verdicts, do_render: bool) -> int:
    """判定书模式验收：按「判定书 × 出任务书时快照 × 当前查重」分桶。"""
    lines = _report_head(meta, citation)

    # ---- 读判定书 ----
    try:
        obj = json.loads(judgement_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:                            # noqa: BLE001
        lines += ["## 判定书错误", "",
                  f"- `{judgement_path}` 无法解析：{type(exc).__name__}",
                  "", "修好判定书后重新 finish。", ""]
        _write_and_report(report, lines)
        print("判定书错误：JSON 无法解析")
        return 2
    entries, errors = validate_judgement(obj, verdicts)
    if errors:
        lines += ["## 判定书错误", "", "| 理论 / 条目 | 问题 |", "| --- | --- |"]
        lines += [f"| {e.split('：', 1)[0] if '：' in e else '判定书'} | "
                  f"{e.split('：', 1)[1] if '：' in e else e} |" for e in errors]
        lines += ["", "修好判定书后重新 finish；缺原文证据的理论一律 `skip_declared`。", ""]
        _write_and_report(report, lines)
        print(f"判定书错误 {len(errors)} 处，验收不通过")
        for e in errors[:10]:
            print(f"  - {e}")
        return 2

    judge_by = {norm_name(e["theory"]): e for e in entries}

    # ---- 读出任务书时的快照 ----
    snapshot_exists = snapshot_path.is_file()
    snap_entries: list[dict] = []
    snapshot_note = ""
    if snapshot_exists:
        try:
            snap_obj = json.loads(snapshot_path.read_text(encoding="utf-8-sig"))
            if isinstance(snap_obj, dict) and isinstance(snap_obj.get("theories"), list):
                snap_entries = [s for s in snap_obj["theories"] if isinstance(s, dict)]
            else:
                snapshot_note = "快照结构不可用，按缺快照处理"
        except Exception:                                # noqa: BLE001
            snapshot_note = "快照无法解析，按缺快照处理"
    else:
        snapshot_note = "缺快照"

    snap_by: dict[str, dict] = {}
    for s in snap_entries:
        if s.get("zh"):
            snap_by[norm_name(s["zh"])] = s
        if s.get("en"):
            snap_by.setdefault(norm_name(s["en"]), s)

    created, merged, existing, declared, missing, undecided, warnings = [], [], [], [], [], [], []

    for v in verdicts:
        key = norm_name(v["zh"])
        e = judge_by.get(key)
        snap = snap_by.get(key) or (snap_by.get(norm_name(v.get("en"))) if v.get("en") else None)
        snap_verdict = str(snap.get("verdict") or "").strip().lower() if snap else None
        snap_duplicate = snap_verdict == "duplicate"
        snap_unknown = snapshot_exists and snap is None
        basis = ""
        if not snapshot_exists:
            basis = "缺快照"
        elif snap_unknown:
            basis = "快照无此条"

        if e is None:
            if snap_unknown:
                undecided.append((v["zh"], "快照里没有这一条"))
            elif snap is None:
                undecided.append((v["zh"], "判定书与快照都没有这一条"))
            elif snap_duplicate:
                existing.append({"zh": v["zh"], "near": v["near"], "score": v["score"],
                                 "title": v.get("near_title", ""),
                                 "why": "出任务书时已 duplicate（判定书未列，无需新建）"})
            else:
                undecided.append((v["zh"], f"快照为 `{snap_verdict}`，判定书未出现"))
            continue

        verdict = e["verdict"]
        if verdict == "skip_declared":
            declared.append((e["theory"], e["reason"]))
            if snap_duplicate:
                existing.append({"zh": v["zh"], "near": v["near"], "score": v["score"],
                                 "title": v.get("near_title", ""),
                                 "why": "出任务书时已 duplicate（判定 skip_declared）"})
            continue
        if verdict == "skip_existing":
            existing.append({"zh": v["zh"], "near": v["near"], "score": v["score"],
                             "title": v.get("near_title", ""),
                             "why": "判定 skip_existing" if v["near"] else "判定 skip_existing（当前未命中，需复核）"})
            continue

        # build / merge
        current_hit = bool(v.get("near")) and (
            v["verdict"] == "duplicate" or (verdict == "merge" and v["verdict"] == "suspect"))
        if snap_duplicate:
            existing.append({"zh": v["zh"], "near": v["near"], "score": v["score"],
                             "title": v.get("near_title", ""),
                             "why": f"出任务书时已 duplicate（判定 {verdict}，未计入新建）"})
            if verdict == "build":
                warnings.append(f"{v['zh']}：判定 build，但出任务书时查重已是 duplicate，未计入本次新建")
            if verdict == "merge" and current_hit:
                merged.append({"zh": v["zh"], "id": v["near"], "title": v.get("near_title", ""),
                               "judged": verdict})
            continue
        if not current_hit:
            missing.append((e["theory"], verdict, "当前查重未命中"))
            continue
        created.append({"zh": e["theory"], "id": v["near"], "title": v.get("near_title", ""),
                        "judged": verdict, "basis": basis})
        if verdict == "merge":
            merged.append({"zh": e["theory"], "id": v["near"], "title": v.get("near_title", ""),
                           "judged": verdict})

    # ---- 报告 ----
    if snapshot_note:
        lines += [f"> {snapshot_note}：判定书里的 build/merge 按「本次新建」处理。", ""]
    if warnings:
        lines += ["## 警告", ""] + [f"- {w}" for w in warnings] + [""]

    lines += ["## 本次新建", "",
              "| 理论 | 卡片 | 标题 | 判定 | 依据 |",
              "| --- | --- | --- | --- | --- |"]
    lines += [f"| {c['zh']} | {c['id']} | {c['title']} | {c['judged']} | "
              f"{c['basis'] or '快照当时不是 duplicate'} |" for c in created] or ["| — | — | — | — | — |"]
    lines += [""]

    lines += ["## 并入既有", "", "| 理论 | 既有卡 | 标题 |", "| --- | --- | --- |"]
    lines += [f"| {m['zh']} | {m['id']} | {m['title']} |" for m in merged] or ["| — | — | — |"]
    lines += [""]

    lines += ["## 跳过：库里已有", "", "| 理论 | 命中卡 | 分数 | 依据 |", "| --- | --- | --- | --- |"]
    lines += [f"| {x['zh']} | {x['near']} {x['title']} | {x['score']:.2f} | {x['why']} |"
              for x in existing] or ["| — | — | — | — |"]
    lines += [""]

    lines += ["## 跳过：已声明不建卡（需复核理由）", "", "| 理论 | 理由 |", "| --- | --- |"]
    lines += [f"| {zh} | {reason} |" for zh, reason in declared] or ["| — | — |"]
    lines += [""]

    if missing:
        lines += ["## 未入库（需要补写）", ""]
        lines += [f"- {zh}（判定 {judged}：{why}）" for zh, judged, why in missing]
        lines += [""]

    if undecided:
        lines += ["## 未判定（需补）", ""]
        lines += [f"- {zh}（{why}）" for zh, why in undecided]
        lines += [""]

    lines += ["## 设计三件套自检", "",
              "逐张确认：命题 24–46 字 / `motif` 与机制形状一致 / `edition` 与结构一致。",
              "缺任一项，重出图时版式会退回默认，两张卡并排就会看出是模板。", ""]

    summary = (f"本次新建 {len(created)} / 并入 {len(merged)} / 声明跳过 {len(declared)} / "
               f"库里已有 {len(existing)} / 未入库 {len(missing) + len(undecided)}")
    lines += ["## 汇总", "", summary, ""]
    _write_and_report(report, lines)
    print(summary)
    for zh, why in undecided:
        print(f"  未判定：{zh}（{why}）")

    if do_render and created:
        for card in created:
            code, _, out = run(RENDER, [card["id"]])
            print(("  出图 " if code == 0 else "  出图失败 ") + card["id"] +
                  ("" if code == 0 else f"：{out[:120]}"))
    print("OK")
    return 0 if not missing and not undecided else 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extract", required=True)
    ap.add_argument("--verify", action="store_true", help="验收：检查卡是否已入库、设计三件套是否齐全")
    ap.add_argument("--render", action="store_true", help="验收通过后重出图")
    ap.add_argument("--report", default=None)
    ap.add_argument("--judgement", default=None,
                    help="制卡前判定书 JSON；默认 = 报告同目录 制卡前判定.json")
    ap.add_argument("--snapshot", default=None,
                    help="候选查重快照 JSON；默认 = 报告同目录 制卡候选快照.json")
    ap.add_argument("--skips", default=None,
                    help="声明不建卡的清单 JSON：[{theory, reason}]；验收时这些理论不计为未入库")
    a = ap.parse_args()

    if not KCARD.exists():
        print(f"FAILED: 找不到 kcard.py（{KCARD}）")
        return 1

    ex = json.loads(Path(a.extract).read_text(encoding="utf-8-sig"))
    meta = ex.get("meta") or {}
    citation = ex.get("apa_citation") or meta.get("title") or ""
    theories = ex.get("economic_theories") or []
    if not theories:
        print("SKIP: extract.json 里没有 economic_theories")
        return 0

    report = Path(a.report) if a.report else Path(a.extract).with_name("制卡任务书.md")
    judgement_path = Path(a.judgement) if a.judgement else report.parent / "制卡前判定.json"
    snapshot_path = Path(a.snapshot) if a.snapshot else report.parent / "制卡候选快照.json"

    shelves = set()
    _, tax, _ = run(KCARD, ["taxonomy", "list"])
    for row in (tax or {}).get("shelves", []) if isinstance(tax, dict) else []:
        if isinstance(row, dict) and row.get("name"):
            shelves.add(row["name"])
        elif isinstance(row, str):
            shelves.add(row)

    verdicts = []
    for t in theories:
        zh, en = parse_theory(t)
        if not zh:
            continue
        q = ["check", "--title", zh]
        if en:
            q += ["--en", en]
        _, res, raw = run(KCARD, q)
        res = res or {}
        cands = res.get("candidates") or []
        top = cands[0] if cands else {}
        verdicts.append({
            "zh": zh, "en": en,
            "verdict": res.get("verdict") or "unknown",
            "score": float(top.get("score") or 0),
            "near": top.get("id", ""),
            "near_title": top.get("title_zh", ""),
            "shelf": (res.get("shelf_suggestion") or {}).get("shelf")
                     or (res.get("shelf_suggestion") or {}).get("name") or "（未判定）",
            "hits": (res.get("shelf_suggestion") or {}).get("hit_words") or [],
            "hint": raw[:400],
        })

    if not a.verify:
        write_snapshot(snapshot_path, citation, verdicts)
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(build_sheet(theories, citation, meta, shelves, verdicts,
                                      judgement_path, snapshot_path), encoding="utf-8")
        todo = sum(1 for v in verdicts if v["verdict"] != "duplicate")
        print(f"任务书：{report}")
        print(f"快照：{snapshot_path}（{len(verdicts)} 条）")
        print(f"判定书应写到：{judgement_path}")
        print(f"待写 {todo} / 跳过 {len(verdicts) - todo}")
        print("OK")
        return 0

    # ---- 验收 ----
    if not judgement_path.is_file():
        if a.skips:
            return legacy_verify(verdicts, meta, citation, report, a.skips, a.render,
                                 note="未提供制卡前判定书，按 --skips 旧路径验收。")
        snapshot_all_duplicate = False
        if snapshot_path.is_file():
            try:
                snap_obj = json.loads(snapshot_path.read_text(encoding="utf-8-sig"))
                rows = snap_obj.get("theories") if isinstance(snap_obj, dict) else None
                snapshot_all_duplicate = (isinstance(rows, list) and bool(rows) and all(
                    isinstance(s, dict) and str(s.get("verdict") or "").strip().lower() == "duplicate"
                    for s in rows))
            except Exception:                            # noqa: BLE001
                snapshot_all_duplicate = False
        if snapshot_all_duplicate:
            return legacy_verify(verdicts, meta, citation, report, None, a.render,
                                 note="缺制卡前判定.json；快照里所有候选都是 duplicate，退化为旧行为。")
        lines = _report_head(meta, citation)
        lines += ["## 缺制卡前判定.json", "",
                  f"先写 `{judgement_path}`（格式见任务书第四节），再 finish 验收。",
                  f"- 快照：`{snapshot_path}`",
                  "- 只有「出任务书时全部 duplicate」的历史任务才允许不带判定书退化验收。",
                  "", "判定书缺失，验收不通过。", ""]
        _write_and_report(report, lines)
        print("缺制卡前判定.json，验收不通过")
        return 2

    return verify_with_judgement(meta, citation, report, judgement_path, snapshot_path,
                                 verdicts, a.render)


if __name__ == "__main__":
    sys.exit(main())
