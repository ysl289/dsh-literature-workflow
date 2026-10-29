#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SAFETY.md 约束的自检（不碰网络，纯本地）。

跑法：
    py -3.13 src\\wechat\\_selftest_safety.py

覆盖 SAFETY.md 第一节的强制校验：
    - 目标行非空 -> 必须报错（assert_row_empty）
    - 已有行被改动 -> 必须报出 diff（diff_existing_rows）
以及 TSV 生成的列结构、以及 upload.py 里"不得存在删除/覆盖分支"的静态检查。
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import log_sheet as ls  # noqa: E402

PASS, FAIL = 0, 0


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}  {detail}")


def expect_raises(label, fn, needle=""):
    global PASS, FAIL
    try:
        fn()
    except Exception as exc:
        ok = needle in str(exc)
        if ok:
            PASS += 1
            print(f"  PASS  {label}  (报错：{str(exc)[:90]})")
        else:
            FAIL += 1
            print(f"  FAIL  {label}  报错内容不含 {needle!r}：{str(exc)[:120]}")
        return
    FAIL += 1
    print(f"  FAIL  {label}  本该报错却通过了！")


print("== 列号换算 ==")
check("A -> 1", ls.col_to_index("A") == 1)
check("H -> 8", ls.col_to_index("H") == 8)
check("U -> 21（SAFETY.md 的 21 列）", ls.col_to_index("U") == 21)
check("1 -> A", ls.index_to_col(1) == "A")
check("21 -> U", ls.index_to_col(21) == "U")
check("往返一致 1..60", all(ls.col_to_index(ls.index_to_col(i)) == i for i in range(1, 61)))

print("\n== SAFETY.md：目标行必须全空 ==")
try:
    ls.assert_row_empty(["", "", None, "  "], 5, "U")
    check("全空行（含 None/空白）-> 放行", True)
except Exception as exc:
    check("全空行（含 None/空白）-> 放行", False, str(exc))
expect_raises("有一格有内容 -> 必须中止", lambda: ls.assert_row_empty(["x"], 5, "U"), "不是空的")
expect_raises("第 21 列有内容 -> 必须中止",
              lambda: ls.assert_row_empty([""] * 20 + ["tail"], 5, "U"), "U")
try:
    ls.assert_row_empty([""] * 20 + ["tail"], 5, "U")
except ls.DataError as exc:
    check("错误信息点名 U 列，便于定位", "U" in str(exc), str(exc))
else:
    check("错误信息点名 U 列，便于定位", False, "没有报错")

print("\n== SAFETY.md：已有行逐格 diff ==")
before = [["a", "b"], ["c", "d"], ["", ""]]
check("完全没变 -> 无 diff", ls.diff_existing_rows(before, before, 3) == [])
after_mod = [["a", "b"], ["c", "CHANGED"], ["", ""]]
probs = ls.diff_existing_rows(before, after_mod, 3)
check("改了一格 -> 报出 1 条 diff", len(probs) == 1, str(probs))
check("diff 信息含行号列号", "第 2 行" in probs[0] and "B 列" in probs[0], str(probs))
after_short = [["a", "b"], ["c", "d"]]
check("行数变少也不崩", isinstance(ls.diff_existing_rows(before, after_short, 3), list))

print("\n== TSV 生成 ==")
entries = [{"a": "1", "b": "x\ty"}, {"a": None, "b": "中 文"}]
tsv = ls.build_tsv(entries, ["a", "b"])
lines = tsv.rstrip("\r\n").split("\r\n")
check("表头 + 2 行 = 3 行", len(lines) == 3, str(lines))
check("表头正确", lines[0] == "a\tb")
check("单元格里的制表符被替换（不破坏列结构）", lines[1] == "1\tx y", repr(lines[1]))
check("None -> 空字符串", lines[2].startswith("\t"), repr(lines[2]))
check("中文保留", "中 文" in lines[2])
check("列数一致（每行都 2 列）", all(len(ln.split("\t")) == 2 for ln in lines))

print("\n== upload.py：不得存在删除 / 覆盖分支（静态检查）==")
up = (Path(__file__).resolve().parent.parent / "blog" / "upload.py")
if up.is_file():
    src = up.read_text(encoding="utf-8")
    code_lines = [ln for ln in src.splitlines()
                  if ln.strip() and not ln.strip().startswith("#")]
    body = "\n".join(code_lines)
    # 只看代码，允许 docstring/注释里提到
    import re as _re
    docstrings = _re.findall(r'"""[\s\S]*?"""', body)
    code_only = body
    for d in docstrings:
        code_only = code_only.replace(d, "")
    check("没有 /delete 请求调用", "/delete/" not in code_only)
    check("没有 requests.*('/delete'", "delete" not in code_only.lower())
    check("没有 Remove-Item / shutil.rmtree / os.remove / unlink",
          not any(k in code_only for k in ("Remove-Item", "rmtree", "os.remove", "unlink")))
    check("没有 --delete 参数", '"--delete"' not in code_only)
    check("有同名冲突中止逻辑", "已中止" in code_only and "EXIT_CHECK_FAILED" in code_only)
    check("默认分组是 master_fin", 'SAFE_FOLDER = "master_fin"' in code_only)
else:
    check("找到 upload.py", False, str(up))

print()
print(f"结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)
