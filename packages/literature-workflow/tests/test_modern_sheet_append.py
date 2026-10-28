"""Offline safety tests for sparse modern Tencent sheet registration."""
import tempfile
import unittest
from pathlib import Path

from test_bridge import bridge


def _tool(name, properties, required):
    return {"name": name, "inputSchema": {"properties": {key: {} for key in properties},
                                           "required": required}}


INFO_TOOL = _tool("sheet.get_sheet_info", ["file_id"], ["file_id"])
CELL_TOOL = _tool("sheet.get_cell_data", [
    "file_id", "sheet_id", "start_row", "end_row", "start_col", "end_col",
    "return_csv", "include_formula",
], ["file_id", "sheet_id"])
WRITE_TOOL = _tool("sheet.set_range_value", ["file_id", "sheet_id", "values"], ["file_id", "sheet_id"])


class FakeSheet:
    def __init__(self, initial=None, *, mutate_on_read=None, write_mode="apply"):
        self.cells = {(0, 0): {"value_type": "STRING", "string_value": "header"}}
        self.cells.update(initial or {})
        self.mutate_on_read = mutate_on_read
        self.write_mode = write_mode
        self.read_count = 0
        self.writes = []

    def call_tool(self, name, args):
        if name == INFO_TOOL["name"]:
            return {"error": "", "sheets": [{"sheet_id": "tab-1", "sheet_name": "October",
                                               "row_count": 8, "column_count": 26}]}
        if name == CELL_TOOL["name"]:
            self.read_count += 1
            if self.mutate_on_read == self.read_count:
                self.cells[(6, 2)] = {"value_type": "STRING", "string_value": "concurrent edit"}
            selected = []
            for (row, col), value in sorted(self.cells.items()):
                if (args["start_row"] <= row <= args["end_row"]
                        and args["start_col"] <= col <= args["end_col"]):
                    selected.append({"row": row, "col": col, **value})
            return {"error": "", "cells": selected, "csv_data": "", "trace_id": "offline"}
        if name == WRITE_TOOL["name"]:
            self.writes.append(args)
            if self.write_mode == "error_without_commit":
                return {"error": "simulated lost response"}
            for cell in args["values"]:
                self.cells[(cell["row"], cell["col"])] = {
                    "value_type": cell["value_type"],
                    "string_value": cell["string_value"],
                }
            return {"error": ""}
        raise AssertionError(f"unexpected tool call: {name}")


def _publish(client, job, receipt, cells):
    receipt.setdefault("bridge", bridge.VERSION)
    return bridge._publish_modern_sheet(
        {}, cells, job, receipt, job / "receipt.json", client, INFO_TOOL, CELL_TOOL,
        WRITE_TOOL, "doc-1", "tab-1", "October", "https://docs.qq.com/sheet/example",
    )


class ModernSheetAppendTests(unittest.TestCase):
    def test_appends_after_last_typed_value_in_all_26_columns_and_verifies_old_cells(self):
        row = [f"value-{i}" for i in range(21)]
        initial = {
            (0, 0): {"value_type": "STRING", "string_value": "teacher header"},
            (2, 4): {"value_type": "BOOL", "bool_value": False},
            (4, 3): {"value_type": "FORMULA", "formula": "=1+1", "number_value": 2},
            # The formula evaluates to an empty string, but still occupies the
            # farthest used row in a column beyond U.
            (5, 25): {"value_type": "STRING", "string_value": "", "formula": '=IF(1=1,"",0)'},
        }
        client = FakeSheet(initial)
        with tempfile.TemporaryDirectory() as td:
            job = Path(td) / "job"
            job.mkdir()
            receipt = {"bridge": bridge.VERSION, "entries": {}}
            result = _publish(client, job, receipt, row)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "published")
        self.assertEqual(result["targetRow"], 7)
        self.assertFalse(result["atomicAppend"])
        self.assertEqual(len(client.writes), 1)
        self.assertEqual([v["col"] for v in client.writes[0]["values"]], list(range(21)))
        self.assertTrue(all(v["row"] == 6 and v["value_type"] == "STRING"
                            for v in client.writes[0]["values"]))
        self.assertEqual(client.cells[(0, 0)]["string_value"], "teacher header")
        self.assertEqual(client.cells[(2, 4)]["bool_value"], False)
        self.assertEqual(client.cells[(4, 3)]["formula"], "=1+1")
        self.assertEqual(client.cells[(5, 25)]["formula"], '=IF(1=1,"",0)')
        self.assertEqual(client.cells[(6, 20)]["string_value"], row[-1])

    def test_deduplicates_exact_existing_21_cell_row_without_writing(self):
        row = [f"same-{i}" for i in range(21)]
        initial = {(2, col): {"value_type": "STRING", "string_value": value}
                   for col, value in enumerate(row)}
        client = FakeSheet(initial)
        with tempfile.TemporaryDirectory() as td:
            job = Path(td) / "job"
            job.mkdir()
            result = _publish(client, job, {"bridge": bridge.VERSION, "entries": {}}, row)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["deduplicated"])
        self.assertEqual(result["targetRow"], 3)
        self.assertEqual(client.writes, [])

    def test_prepared_intent_rebases_after_precommit_change_before_any_write(self):
        row = [f"fresh-{i}" for i in range(21)]
        client = FakeSheet({(5, 0): {"value_type": "STRING", "string_value": "last"}},
                           mutate_on_read=2)
        with tempfile.TemporaryDirectory() as td:
            job = Path(td) / "job"
            job.mkdir()
            receipt = {"bridge": bridge.VERSION, "entries": {}}
            first = _publish(client, job, receipt, row)
            self.assertEqual(first["status"], "conflict")
            self.assertEqual(client.writes, [])
            self.assertIn("prepared", {entry["status"] for entry in receipt["entries"].values()})

            client.mutate_on_read = None
            second = _publish(client, job, receipt, row)
        self.assertTrue(second["ok"], second)
        self.assertEqual(second["targetRow"], 8)
        self.assertEqual(len(client.writes), 1)
        self.assertEqual(client.cells[(6, 2)]["string_value"], "concurrent edit")

    def test_uncertain_write_is_reconciled_read_only_on_retry(self):
        row = [f"uncertain-{i}" for i in range(21)]
        client = FakeSheet(write_mode="error_without_commit")
        with tempfile.TemporaryDirectory() as td:
            job = Path(td) / "job"
            job.mkdir()
            receipt = {"bridge": bridge.VERSION, "entries": {}}
            first = _publish(client, job, receipt, row)
            self.assertEqual(first["status"], "uncertain")
            self.assertEqual(len(client.writes), 1)

            client.write_mode = "apply"
            second = _publish(client, job, receipt, row)
        self.assertEqual(second["status"], "uncertain")
        self.assertEqual(len(client.writes), 1)


if __name__ == "__main__":
    unittest.main()
