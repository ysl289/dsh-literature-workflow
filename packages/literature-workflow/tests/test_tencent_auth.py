import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("tencent_auth", Path(__file__).parents[1] / "lib" / "tencent_auth.py")
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


class OfficialAuthorizationTests(unittest.TestCase):
    def fixture(self, replies, save=None):
        calls, progress, opened = [], [], []
        now = [0]
        responses = iter(replies)
        def request(url, data=None, form=False):
            calls.append((url, data, form))
            return next(responses)
        def sleep(seconds):
            now[0] += seconds
        def emit(status, **kwargs):
            progress.append({"status": status, **kwargs})
        def open_browser(url):
            self.assertFalse(calls, "browser must open before any network request")
            opened.append(url)
            return True
        options = dict(emit=emit, request=request, open_browser=open_browser, sleep=sleep,
                       clock=lambda: now[0], make_code=lambda: "fixture-auth-code", timeout=30,
                       validate=lambda token: "raw")
        if save:
            options['save'] = save
        return options, calls, progress, opened

    def test_official_pending_then_verified_saved_without_registration_or_redirect(self):
        saved = []
        options, calls, progress, opened = self.fixture([
            {"ret": 11510}, {"ret": 0, "data": {"token": "PRIVATE_TOKEN"}},
        ], save=lambda dest, token: saved.append((dest, token)))
        auth.authorize("fixture.json", **options)
        self.assertEqual(progress[-1], {"status": "completed"})
        self.assertEqual(saved[0][1]['access_token'], 'PRIVATE_TOKEN')
        self.assertEqual(saved[0][1]['auth_scheme'], 'raw')
        self.assertEqual(len(calls), 2)
        self.assertTrue(all('/oauth/v2/mcp/token/get?code=' in row[0] and row[1] is None for row in calls))
        self.assertIn('authType=1', opened[0])
        self.assertIn('mcp_source=desktop', opened[0])
        self.assertTrue(progress[1]['browserOpened'])
        output = json.dumps(progress)
        for private in ['PRIVATE_TOKEN', 'PRIVATE_REFRESH', 'PRIVATE_DEVICE']:
            self.assertNotIn(private, output)

    def test_denied_and_provider_errors_never_save_or_claim_connected(self):
        for error in [400006, 400007, 99999]:
            saved = []
            options, _, progress, _ = self.fixture([{'ret': error, 'msg': 'PRIVATE_RESPONSE'}], save=lambda *v: saved.append(v))
            with self.assertRaises(auth.AuthError):
                auth.authorize('fixture.json', **options)
            self.assertFalse(saved)
            self.assertNotIn('completed', [x['status'] for x in progress])

    def test_pending_expires_and_does_not_write(self):
        options, _, progress, _ = self.fixture([{'ret': 11510}] * 20, save=lambda *v: self.fail('must not save'))
        with self.assertRaises(auth.AuthError) as caught:
            auth.authorize('fixture.json', **options)
        self.assertEqual(caught.exception.code, 'timeout')
        self.assertNotIn('completed', [x['status'] for x in progress])

    def test_write_failure_is_not_completed(self):
        def save(*args):
            raise PermissionError('fixture')
        options, _, progress, _ = self.fixture([{'ret': 0, 'data': {'token': 'PRIVATE_TOKEN'}}], save=save)
        with self.assertRaises(PermissionError):
            auth.authorize('fixture.json', **options)
        self.assertNotIn('completed', [x['status'] for x in progress])

    def test_browser_failure_keeps_a_link_and_does_not_claim_opened(self):
        options, _, progress, _ = self.fixture([{'ret': 0, 'data': {'token': 'fixture'}}], save=lambda *v: None)
        options['open_browser'] = lambda _: False
        auth.authorize('fixture.json', **options)
        self.assertFalse(progress[1]['browserOpened'])
        self.assertIn('verificationURL', progress[1])

    def test_expired_token_and_failed_validation_never_overwrite_saved_credentials(self):
        for result in [{'ret': 0, 'data': {'token': 'fixture', 'expired': True}},
                       {'ret': 0, 'data': {'token': 'fixture'}}]:
            options, _, progress, _ = self.fixture([result], save=lambda *v: self.fail('must not save'))
            def reject(_):
                raise auth.AuthError('token_validation_failed')
            options['validate'] = reject
            with self.assertRaises(auth.AuthError):
                auth.authorize('fixture.json', **options)
            self.assertNotIn('completed', [x['status'] for x in progress])

    def test_mcp_validation_uses_initialize_only_and_preserves_working_header_scheme(self):
        calls = []
        def request(url, data, headers):
            calls.append((url, data, headers))
            if headers['Authorization'].startswith('Bearer '):
                return {'result': {'protocolVersion': '2024-11-05'}}
            raise json.JSONDecodeError('fixture non-JSON rejection', '', 0)
        self.assertEqual(auth.validate_token('PRIVATE_TOKEN', request), 'bearer')
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(row[1]['method'] == 'initialize' for row in calls))

    def test_save_uses_complete_atomic_file(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / 'token.json'
            dest.write_text('{"access_token":"old"}', encoding='utf-8')
            auth.save_token(dest, {'access_token': 'fixture'})
            self.assertEqual(json.loads(dest.read_text())['access_token'], 'fixture')
            self.assertEqual(len(list(Path(folder).iterdir())), 1)

    def test_rejects_non_official_endpoint(self):
        for url in ['http://docs.qq.com/token', 'https://docs.qq.com.evil.example/token', 'https://user@docs.qq.com/token']:
            with self.assertRaises(auth.AuthError):
                auth.official_url(url)


if __name__ == '__main__':
    unittest.main()
