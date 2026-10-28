#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""制卡阶段的接线回归：脚本只出任务书/验收，正文由模型写，渲染不再管 cards。"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("dsh_literature_bridge_cards", HERE / "bridge.py")
assert spec and spec.loader
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

STUB = '''import json, sys
from pathlib import Path
args = sys.argv[1:]
report = Path(args[args.index("--report") + 1])
report.parent.mkdir(parents=True, exist_ok=True)
report.write_text("stub report\\n", encoding="utf-8")
Path(report.parent / "argv.json").write_text(json.dumps(args), encoding="utf-8")
print(json.dumps({"ok": True, "mode": "verify" if "--verify" in args else "sheet"}))
sys.exit(2 if ("--verify" in args and (report.parent / "force-fail").exists()) else 0)
'''


def make_root(tmp: Path) -> Path:
    root = tmp / "workflow"
    (root / "src" / "cards").mkdir(parents=True)
    (root / "src" / "cards" / "make_cards.py").write_text(STUB, encoding="utf-8")
    return root


class CardStageBridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = make_root(self.base)
        self.job = self.root / ".plugin-state" / "jobs" / "paper_test"
        self.job.mkdir(parents=True)
        self.extract = self.job / "paper.extract.json"
        self.extract.write_text(json.dumps({"meta": {"title": "T"}}), encoding="utf-8")
        self.library = self.base / "cards-lib"
        self.ctx = {"workflowRoot": str(self.root), "extractPath": str(self.extract),
                    "jobDir": str(self.job), "libraryHome": str(self.library)}

    def argv(self) -> list[str]:
        return json.loads((self.job / "artifacts" / "argv.json").read_text(encoding="utf-8"))

    def test_card_sheet_uses_task_sheet_mode_and_never_passes_write(self):
        result = bridge.dispatch("card-sheet", dict(self.ctx))
        self.assertTrue(result["ok"], result)
        argv = self.argv()
        self.assertNotIn("--write", argv)
        self.assertNotIn("--verify", argv)
        self.assertTrue(result["path"].endswith("制卡任务书.md"))
        self.assertEqual(result["libraryHome"], str(self.library))

    def test_cards_verify_blocks_when_cards_missing(self):
        ok = bridge.dispatch("cards-verify", dict(self.ctx))
        self.assertTrue(ok["ok"], ok)
        self.assertTrue(ok["path"].endswith("制卡报告.md"))
        (self.job / "artifacts" / "force-fail").write_text("1", encoding="utf-8")
        blocked = bridge.dispatch("cards-verify", dict(self.ctx))
        self.assertFalse(blocked["ok"])
        self.assertEqual(blocked["status"], "invalid")

    def test_cards_verify_hands_declared_skip_list_to_script(self):
        skips = self.job / "artifacts" / "制卡跳过.json"
        skips.parent.mkdir(parents=True, exist_ok=True)
        skips.write_text("[]", encoding="utf-8")
        bridge.dispatch("cards-verify", dict(self.ctx))
        self.assertIn("--skips", self.argv())

    def test_render_no_longer_accepts_cards(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.dispatch("render", dict(self.ctx, stages=["cards"]))

    def test_library_home_prefers_call_site_then_env(self):
        env_home = self.base / "from-env"
        with patch.dict(os.environ, {"KCARD_HOME": str(env_home)}):
            self.assertEqual(str(bridge._cards_library_home(dict(self.ctx))), str(self.library))
            self.assertEqual(str(bridge._cards_library_home({})), str(env_home))


if __name__ == "__main__":
    unittest.main()
