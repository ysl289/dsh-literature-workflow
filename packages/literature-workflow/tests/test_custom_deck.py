import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from test_bridge import bridge, sample_record, WORKFLOW


class CustomDeckTests(unittest.TestCase):
    def fixture(self, directory, stage='design'):
        job=Path(directory)/'job';job.mkdir()
        record=sample_record();extract=job/'paper.extract.json'
        extract.write_text(json.dumps(record,ensure_ascii=False),encoding='utf-8')
        pages=job/'pages.json';pages.write_text(json.dumps([{'page':1,'text':record['evidence'][0]['quote']}]),encoding='utf-8')
        prompt='给初学者讲清楚识别，用两栏和讲稿'
        fingerprint=hashlib.sha256(prompt.encode()).hexdigest()
        saved={'stage':stage,'prompt':prompt,'promptHash':fingerprint,'plan':{'theme':'teal','ratio':'16:9','slides':[
            {'title':'自定义识别页','bullets':['原文企业数据的分组比较'],'cols':2,'notes':'这是自定义的讲稿',
             'evidence':record['evidence'],'kv':[['处理组','政策影响组'],['对照组','比较基准']]}]}}
        plan_path=job/'stage-plan.json';plan_path.write_text(json.dumps(saved,ensure_ascii=False),encoding='utf-8')
        return {'workflowRoot':str(WORKFLOW),'jobDir':str(job),'extractPath':str(extract),'pagesPath':str(pages),
                'stages':[stage],'stagePlanPath':str(plan_path),'stagePromptHash':fingerprint},saved

    def test_real_custom_render_changes_content_and_preserves_extract(self):
        with tempfile.TemporaryDirectory() as td:
            ctx,saved=self.fixture(td)
            before=Path(ctx['extractPath']).read_bytes()
            result=bridge._render(ctx)
            self.assertTrue(result['ok'],result)
            self.assertEqual(result['artifacts'][0]['slideCount'],1)
            html=Path(result['artifacts'][0]['path']).read_text(encoding='utf-8')
            for text in ['自定义识别页','这是自定义的讲稿','处理组','cols-2','p.1']:
                self.assertIn(text,html)
            self.assertEqual(Path(ctx['extractPath']).read_bytes(),before)
            self.assertTrue(bridge._render(ctx)['artifacts'][0]['reused'])

    def test_plan_is_bound_to_job_stage_prompt_and_source_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            ctx,saved=self.fixture(td,'lecture')
            with self.assertRaises(bridge.BridgeError):bridge._render({**ctx,'stagePromptHash':'stale'})
            with self.assertRaises(bridge.BridgeError):bridge._render({**ctx,'stages':['design']})
            saved['plan']['slides'][0]['evidence']=[{'field':'data','page':1,'quote':'This quote is completely invented and absent from the paper.'}]
            Path(ctx['stagePlanPath']).write_text(json.dumps(saved),encoding='utf-8')
            with self.assertRaisesRegex(bridge.BridgeError,'引文'):bridge._render(ctx)
            self.assertFalse(list((Path(ctx['jobDir'])/'artifacts').glob('*.html')))


if __name__=='__main__':unittest.main()
