"""Independent review tests of the actual guarded write helper."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from test_bridge import bridge


class GuardReviewTests(unittest.TestCase):
    def run_case(self, timeout_after_commit=False):
        info_tool={'name':'sheet.get_sheet_info','inputSchema':{'properties':{'file_id':{}},'required':['file_id']}}
        read_tool={'name':'sheet.get_cell_data','inputSchema':{'properties':{key:{} for key in (
            'file_id','sheet_id','start_row','end_row','start_col','end_col','return_csv','include_formula')},'required':['file_id','sheet_id']}}
        write_tool={'name':'sheet.set_range_value','inputSchema':{'properties':{'file_id':{},'sheet_id':{},'values':{}},'required':['file_id','sheet_id']}}
        with tempfile.TemporaryDirectory() as td:
            job=Path(td)/'jobs'/'review_job';job.mkdir(parents=True)
            receipt_path=job/'receipt.json';receipt={'bridge':bridge.VERSION,'entries':{}}
            grid={(0,0):{'row':0,'col':0,'value_type':'STRING','string_value':'标题'},
                  (4,25):{'row':4,'col':25,'value_type':'STRING','string_value':'','formula':'=IF(1,"","")'}}
            old=copy.deepcopy(grid);writes=[]
            class Client:
                def call_tool(self,name,args):
                    if name=='sheet.get_sheet_info':
                        return {'error':'','sheets':[{'sheet_id':'sheet','sheet_name':'Target','row_count':8,'col_count':26}]}
                    if name=='sheet.get_cell_data':
                        return {'error':'','cells':[copy.deepcopy(v) for (r,c),v in grid.items()
                            if args['start_row']<=r<=args['end_row'] and args['start_col']<=c<=args['end_col']]}
                    if name=='sheet.set_range_value':
                        intent=json.loads(receipt_path.read_text(encoding='utf-8'))
                        assert any(v['status']=='inflight' for v in intent['entries'].values())
                        assert len(args['values'])==21
                        assert all(v['row']==5 and (v['row'],v['col']) not in grid for v in args['values'])
                        writes.append(copy.deepcopy(args))
                        for v in args['values']:grid[(v['row'],v['col'])]=copy.deepcopy(v)
                        if timeout_after_commit:raise TimeoutError('response lost after commit')
                        return {'error':''}
                    raise AssertionError(name)
            client=Client();cells=[f'column-{n}' for n in range(21)]
            args=({},cells,job,receipt,receipt_path,client,info_tool,read_tool,write_tool,'doc','sheet','Target','https://docs.qq.com/sheet/target')
            result=bridge._publish_modern_sheet(*args)
            self.assertTrue(result['ok'],result)
            self.assertEqual(result['targetRow'],6)
            self.assertEqual(len(writes),1)
            self.assertEqual({k:grid[k] for k in old},old)
            again=bridge._publish_modern_sheet(*args)
            self.assertTrue(again['ok'],again)
            self.assertTrue(again['recovered'])
            self.assertEqual(len(writes),1)
            self.assertTrue(all(len(p.name)<100 for p in (job/'.sheet-append-audit').iterdir()))

    def test_inflight_receipt_precedes_single_write_and_retry_reads(self):
        self.run_case()

    def test_lost_response_is_reconciled_without_duplicate_write(self):
        self.run_case(timeout_after_commit=True)


if __name__=='__main__':unittest.main()
