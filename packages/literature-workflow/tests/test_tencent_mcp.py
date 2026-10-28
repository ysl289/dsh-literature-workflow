import importlib.util
import json
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "lib" / "tencent_mcp.py"
spec = importlib.util.spec_from_file_location("tencent_mcp", MODULE_PATH)
tencent_mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tencent_mcp)


class FakeResponse:
    def __init__(self, status=200, body="", headers=None):
        self.status_code = status
        self.text = body
        self.headers = headers or {}


class FakeSession:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def post(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        reply = self.responses.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply


def rpc_response(request_id, result=None, error=None):
    response = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        response["error"] = error
    else:
        response["result"] = result
    return json.dumps(response)


class TencentMcpTransportTests(unittest.TestCase):
    def client(self, *responses, token="fixture-token"):
        client = tencent_mcp.McpClient("https://example.invalid/mcp", token)
        client.s = FakeSession(*responses)
        return client

    def test_notifications_accept_empty_202_and_204_without_json_rpc_id(self):
        for status in (202, 204):
            with self.subTest(status=status):
                client = self.client(FakeResponse(status, ""))
                self.assertIsNone(client.call("notifications/initialized", notify=True))
                payload = client.s.calls[0][1]["json"]
                self.assertNotIn("id", payload)
                self.assertEqual(payload["method"], "notifications/initialized")

    def test_notification_with_response_body_is_a_protocol_error(self):
        client = self.client(FakeResponse(202, '{"jsonrpc":"2.0"}'))
        with self.assertRaises(tencent_mcp.McpProtocolError):
            client.call("notifications/initialized", notify=True)

    def test_empty_202_for_request_is_not_a_successful_result(self):
        client = self.client(FakeResponse(202, ""))
        with self.assertRaisesRegex(tencent_mcp.McpProtocolError, "GET response streams are unsupported"):
            client.call("tools/list")

    def test_request_requires_http_200_and_nonempty_json_response(self):
        for response in (FakeResponse(204, ""), FakeResponse(200, ""), FakeResponse(201, "{}")):
            with self.subTest(status=response.status_code, body=response.text):
                client = self.client(response)
                with self.assertRaises(tencent_mcp.McpError):
                    client.call("tools/list")

    def test_json_response_must_match_json_rpc_request_id(self):
        client = self.client(FakeResponse(200, rpc_response(2, {"tools": []})))
        with self.assertRaisesRegex(tencent_mcp.McpProtocolError, "id did not match"):
            client.call("tools/list")

    def test_json_response_returns_matching_result_envelope(self):
        client = self.client(FakeResponse(200, rpc_response(1, {"tools": []})))
        self.assertEqual(client.call("tools/list"), {
            "jsonrpc": "2.0", "id": 1, "result": {"tools": []},
        })

    def test_sse_uses_matching_json_rpc_frame_and_ignores_other_frames(self):
        body = (
            'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
            'event: message\ndata: {"jsonrpc":"2.0","id":88,"result":{"ignored":true}}\n\n'
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n'
        )
        client = self.client(FakeResponse(200, body, {"Content-Type": "text/event-stream"}))
        result = client.call("tools/list")
        self.assertEqual(result["result"], {"tools": []})

    def test_sse_with_only_wrong_id_is_rejected(self):
        body = 'data: {"jsonrpc":"2.0","id":2,"result":{}}\n\n'
        client = self.client(FakeResponse(200, body, {"Content-Type": "text/event-stream"}))
        with self.assertRaisesRegex(tencent_mcp.McpProtocolError, "SSE response id"):
            client.call("tools/list")

    def test_initialize_negotiates_version_saves_session_and_sends_initialized_notification(self):
        init = {"protocolVersion": tencent_mcp.CLIENT_PROTOCOL_VERSION, "capabilities": {}}
        client = self.client(
            FakeResponse(200, rpc_response(1, init), {"Mcp-Session-Id": "session-fixture"}),
            FakeResponse(204, ""),
        )
        result = client.initialize()
        self.assertEqual(result["result"]["protocolVersion"], tencent_mcp.CLIENT_PROTOCOL_VERSION)
        self.assertEqual(client.protocol_version, tencent_mcp.CLIENT_PROTOCOL_VERSION)
        self.assertEqual(client.session_id, "session-fixture")

        first_payload = client.s.calls[0][1]["json"]
        self.assertEqual(first_payload["params"]["protocolVersion"], tencent_mcp.CLIENT_PROTOCOL_VERSION)
        second = client.s.calls[1][1]
        self.assertNotIn("id", second["json"])
        self.assertEqual(second["headers"]["Mcp-Session-Id"], "session-fixture")
        self.assertEqual(second["headers"]["MCP-Protocol-Version"], tencent_mcp.CLIENT_PROTOCOL_VERSION)

    def test_initialize_rejects_missing_or_unsupported_negotiated_version(self):
        for result in ({}, {"protocolVersion": "2099-01-01"}):
            with self.subTest(result=result):
                client = self.client(FakeResponse(200, rpc_response(1, result)))
                with self.assertRaises(tencent_mcp.McpProtocolError):
                    client.initialize()

    def test_tools_list_follows_next_cursor_until_last_page(self):
        client = self.client(
            FakeResponse(200, rpc_response(1, {"tools": [{"name": "one"}], "nextCursor": "page-2"})),
            FakeResponse(200, rpc_response(2, {"tools": [{"name": "two"}]})),
        )
        self.assertEqual(client.tools_list(), [{"name": "one"}, {"name": "two"}])
        self.assertEqual(client.s.calls[1][1]["json"]["params"], {"cursor": "page-2"})

    def test_tools_list_rejects_repeated_cursor(self):
        client = self.client(
            FakeResponse(200, rpc_response(1, {"tools": [], "nextCursor": "same"})),
            FakeResponse(200, rpc_response(2, {"tools": [], "nextCursor": "same"})),
        )
        with self.assertRaisesRegex(tencent_mcp.McpProtocolError, "repeated nextCursor"):
            client.tools_list()

    def test_tool_error_is_never_returned_as_success(self):
        client = self.client(FakeResponse(200, rpc_response(1, {"isError": True, "content": []})))
        with self.assertRaisesRegex(tencent_mcp.McpError, "isError=true"):
            client.call_tool("unsafe", {})

    def test_auth_header_can_be_overridden_for_raw_token(self):
        client = self.client(FakeResponse(200, rpc_response(1, {"ok": True})))
        original_headers = client._headers

        def raw_headers():
            headers = original_headers()
            headers["Authorization"] = client.token
            return headers

        client._headers = raw_headers
        client.call("tools/list")
        self.assertEqual(client.s.calls[0][1]["headers"]["Authorization"], "fixture-token")

    def test_provider_and_network_errors_never_include_token(self):
        client = self.client(FakeResponse(401, "authorization rejected: fixture-token"))
        with self.assertRaises(tencent_mcp.McpError) as caught:
            client.call("tools/list")
        self.assertNotIn("fixture-token", str(caught.exception))

        client = self.client(requests_error())
        with self.assertRaises(tencent_mcp.McpError) as caught:
            client.call("tools/list")
        self.assertNotIn("fixture-token", str(caught.exception))


def requests_error():
    # Import through the module so the test needs no live server or network.
    return tencent_mcp.requests.ConnectionError("failed for https://fixture-token.invalid")


if __name__ == "__main__":
    unittest.main()
