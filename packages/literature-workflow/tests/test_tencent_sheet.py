"""Offline checks for modern Tencent discovery; all document writes are forbidden."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from test_bridge import bridge

TARGET = 'https://docs.qq.com/sheet/DTHRhWHFwaGJPTWtL'


class ModernSheetTests(unittest.TestCase):
    def run_probe(self, found=None, info=None, extra=None, header=True):
        calls = []
        found = found if found is not None else {'list': [{'file_id': 'correct', 'url': TARGET}]}
        info = info if info is not None else {'error': '', 'sheets': [
            {'sheet_name': 'other', 'sheet_id': 'first', 'row_count': 8, 'column_count': 26},
            {'sheet_name': '2026年9月', 'sheet_id': 'chosen', 'row_count': 8, 'column_count': 26}]}

        class Client:
            def __init__(self, *args):
                self.cells = {}
                # SAFETY.md 把第 1 行留给老师的表头；夹具默认带表头，空表另有专门用例。
                if header:
                    for col in range(21):
                        self.cells[(0, col)] = {'value_type': 'STRING', 'string_value': f'header-{col}'}
            def initialize(self): pass
            def list_tools(self):
                return [
                    {'name': 'manage.search_file', 'inputSchema': {
                        'properties': {'search_key': {}}, 'required': ['search_key']}},
                    {'name': 'sheet.get_sheet_info', 'inputSchema': {
                        'properties': {'file_id': {}}, 'required': ['file_id']}},
                    {'name': 'sheet.get_cell_data', 'inputSchema': {
                        'properties': {key: {} for key in ('file_id', 'sheet_id', 'start_row', 'end_row',
                                                           'start_col', 'end_col', 'return_csv', 'include_formula')},
                        'required': ['file_id', 'sheet_id']}},
                    {'name': 'sheet.set_range_value', 'inputSchema': {
                        'properties': {'file_id': {}, 'sheet_id': {}, 'values': {}},
                        'required': ['file_id', 'sheet_id']}},
                    {'name': 'sheet.operation_sheet', 'inputSchema': {
                        'properties': {'file_id': {}, 'js_script': {}}, 'required': ['file_id', 'js_script']}},
                ]
            def call_tool(self, name, args):
                calls.append((name, args))
                if name == 'manage.search_file': return found
                if name == 'sheet.get_sheet_info': return info
                if name == 'sheet.get_cell_data':
                    cells = [dict(row=row, col=col, value_type=value['value_type'],
                                  string_value=value.get('string_value', ''),
                                  number_value=value.get('number_value', 0),
                                  bool_value=value.get('bool_value', False),
                                  formula=value.get('formula', ''))
                             for (row, col), value in self.cells.items()
                             if args['start_row'] <= row <= args['end_row']
                             and args['start_col'] <= col <= args['end_col']]
                    return {'error': '', 'cells': cells, 'csv_data': '', 'trace_id': 'offline'}
                if name == 'sheet.set_range_value':
                    for value in args['values']:
                        self.cells[(value['row'], value['col'])] = value
                    return {'error': ''}
                raise AssertionError('Unexpected tool: ' + name)

        module = SimpleNamespace(McpClient=Client, MCP_ENDPOINT='https://example.invalid', DOC_TITLE='fixture')
        with tempfile.TemporaryDirectory() as td:
            job = Path(td) / 'job'
            job.mkdir()
            receipt = {'bridge': bridge.VERSION,
                       'entries': {'blog:existing': {'status': 'verified'}}}
            ctx = {'workflowRoot': td, 'auth': {'tencentToken': 'fixture'}, **(extra or {})}
            with patch.object(bridge, '_import_file', return_value=module):
                result = bridge._publish_sheet(ctx, ['cell'] * 21, job, receipt, job / 'receipt.json')
        return result, calls

    def test_exact_document_named_tab_and_guarded_write(self):
        result, calls = self.run_probe()
        self.assertEqual(result['status'], 'published')
        self.assertEqual(result['targetRow'], 2)
        self.assertEqual(result['target']['sheetId'], 'chosen')
        self.assertEqual(sum(name == 'sheet.set_range_value' for name, _ in calls), 1)
        write = next(args for name, args in calls if name == 'sheet.set_range_value')
        self.assertEqual(len(write['values']), 21)
        self.assertTrue(all(value['row'] == 1 for value in write['values']))
        self.assertTrue(all(value['value_type'] == 'STRING' for value in write['values']))
        self.assertEqual(sum(name == 'sheet.get_cell_data' for name, _ in calls), 4)

    def test_empty_sheet_is_refused_to_protect_the_header_row(self):
        result, calls = self.run_probe(header=False)
        self.assertEqual(result['status'], 'needs_setup')
        self.assertEqual(result['reasonCode'], 'sheet_header_missing')
        self.assertEqual(sum(name == 'sheet.set_range_value' for name, _ in calls), 0)

    def test_wrong_or_ambiguous_document_never_reads_any_sheet(self):
        for found in [{'list': [{'file_id': 'other', 'url': TARGET + 'wrong'}]},
                      {'list': [{'file_id': v, 'url': TARGET} for v in ['a', 'b']]}]:
            with self.subTest(found=found):
                result, calls = self.run_probe(found=found)
                self.assertEqual(result['status'], 'needs_setup')
                self.assertEqual(len(calls), 1)

    def test_tab_mismatch_and_server_error_stop(self):
        for info, extra in [({'error': 'not permitted', 'sheets': []}, {}),
                            ({'error': '', 'sheets': [{'sheet_name': 'other', 'sheet_id': 'x'}]}, {}),
                            (None, {'sheetId': 'wrong'})]:
            with self.subTest(info=info, extra=extra):
                result, calls = self.run_probe(info=info, extra=extra)
                self.assertEqual(result['status'], 'needs_setup')
                self.assertEqual(len(calls), 2)

    def test_blocked_publish_exposes_immutable_manual_bundle(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / 'workflow'
            root.mkdir()
            job = Path(td) / 'job'
            job.mkdir()
            ctx = {'workflowRoot': str(root), 'jobDir': str(job), 'stages': ['sheet']}
            with patch.object(bridge, '_load_record', return_value=({}, root)), \
                 patch.object(bridge, 'validate_record', return_value={'ok': True}), \
                 patch.object(bridge, '_make_tsv', return_value=(['x'] * 21, [], {'row': ['x'] * 21})), \
                 patch.object(bridge, '_publish_sheet', return_value={'ok': False, 'status': 'needs_setup'}):
                result = bridge._action_publish(ctx)
            self.assertFalse(result['ok'])
            self.assertEqual(result['status'], 'needs_setup')
            self.assertEqual(Path(result['tsvPath']).read_text(encoding='utf-8').strip().split('\t'), ['x'] * 21)
            self.assertTrue(Path(result['registrationPath']).exists())
            self.assertIsNone(result['receiptPath'])


if __name__ == '__main__':
    unittest.main()
