"""Small, compatible Tencent Docs MCP Streamable HTTP client.

The public surface intentionally mirrors the historical client used by the
literature workflow: ``endpoint``, ``token``, ``initialize()``,
``tools_list()``, ``call_tool()`` and an overridable ``_headers()`` method.
"""

from __future__ import annotations

import json
from typing import Any

import requests


CLIENT_PROTOCOL_VERSION = "2024-11-05"
REQUEST_TIMEOUT_SECONDS = 60


class McpError(RuntimeError):
    """Base error for transport, JSON-RPC, and remote MCP failures."""


class McpProtocolError(McpError):
    """The peer returned a response that does not satisfy the MCP protocol."""


class McpClient:
    """JSON-RPC client for MCP Streamable HTTP over POST."""

    def __init__(self, endpoint: str, token: str) -> None:
        self.endpoint = endpoint
        token = (token or "").strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        self.token = token
        self.session_id: str | None = None
        self.protocol_version: str | None = None
        self._id = 0
        self.s = requests.Session()

    def _headers(self) -> dict[str, str]:
        """Return request headers; callers may override Authorization for raw tokens."""
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        return headers

    @staticmethod
    def _header(headers: Any, name: str) -> str | None:
        if not headers:
            return None
        wanted = name.casefold()
        for key, value in headers.items():
            if str(key).casefold() == wanted:
                return str(value)
        return None

    def _post(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        if not self.token:
            raise McpError("MCP authorization token is missing.")

        is_notification = "id" not in payload
        request_id = payload.get("id")
        try:
            response = self.s.post(
                self.endpoint,
                headers=self._headers(),
                json=payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
                allow_redirects=False,
            )
        except requests.RequestException:
            # Avoid exposing request URLs, headers, or provider-controlled text.
            raise McpError("MCP transport request failed.") from None

        session_id = self._header(getattr(response, "headers", None), "Mcp-Session-Id")
        if session_id:
            self.session_id = session_id

        status = int(response.status_code)
        body = response.text or ""
        if status in (401, 403):
            raise McpError(f"MCP authorization failed (HTTP {status}).")
        if 300 <= status < 400:
            raise McpProtocolError("MCP redirects are not followed.")

        if is_notification:
            if status not in (200, 202, 204):
                raise McpError(f"MCP notification failed (HTTP {status}).")
            if body.strip():
                raise McpProtocolError("MCP returned a response body for a notification.")
            return None

        if status == 202:
            raise McpProtocolError(
                "MCP returned HTTP 202 without a request result; GET response streams are unsupported."
            )
        if status != 200:
            raise McpError(f"MCP request failed (HTTP {status}).")
        if not body.strip():
            raise McpProtocolError("MCP returned an empty body for a JSON-RPC request.")

        content_type = self._header(getattr(response, "headers", None), "Content-Type") or ""
        if "text/event-stream" in content_type.casefold():
            frames = self._parse_sse(body)
            if not frames:
                raise McpProtocolError("MCP returned an SSE stream without JSON-RPC frames.")
            mismatched_ids: list[Any] = []
            for frame in frames:
                if "id" not in frame:
                    # Server notifications or requests are not the answer to this RPC.
                    continue
                if not self._ids_equal(frame.get("id"), request_id):
                    mismatched_ids.append(frame.get("id"))
                    continue
                return self._validate_response(frame, request_id)
            if mismatched_ids:
                raise McpProtocolError("MCP SSE response id did not match the request id.")
            raise McpProtocolError("MCP SSE stream contained no response for the request id.")

        try:
            parsed = json.loads(body)
        except (TypeError, json.JSONDecodeError):
            raise McpProtocolError("MCP returned a non-JSON response.") from None
        if not isinstance(parsed, dict):
            raise McpProtocolError("MCP JSON response must be an object.")
        return self._validate_response(parsed, request_id)

    @staticmethod
    def _ids_equal(actual: Any, expected: Any) -> bool:
        # JSON-RPC ids are type-sensitive (notably, true is not numeric id 1).
        return type(actual) is type(expected) and actual == expected

    def _validate_response(self, response: dict[str, Any], request_id: Any) -> dict[str, Any]:
        if response.get("jsonrpc") != "2.0":
            raise McpProtocolError("MCP response is missing JSON-RPC version 2.0.")
        if "id" not in response or not self._ids_equal(response.get("id"), request_id):
            raise McpProtocolError("MCP response id did not match the request id.")
        if "error" in response:
            error = response.get("error")
            if isinstance(error, dict):
                code = error.get("code")
                message = self._redact(str(error.get("message") or "remote error"))
                raise McpError(f"MCP JSON-RPC error {code}: {message}")
            raise McpError("MCP returned a malformed JSON-RPC error.")
        if "result" not in response:
            raise McpProtocolError("MCP response contains neither result nor error.")
        return response

    def _redact(self, value: str) -> str:
        if self.token:
            value = value.replace(self.token, "[redacted]")
            value = value.replace(f"Bearer {self.token}", "[redacted]")
        return value

    @staticmethod
    def _parse_sse(body: str) -> list[dict[str, Any]]:
        """Parse SSE data fields and retain JSON object frames only."""
        frames: list[dict[str, Any]] = []
        data_lines: list[str] = []

        def flush() -> None:
            if not data_lines:
                return
            raw = "\n".join(data_lines)
            data_lines.clear()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                return
            if isinstance(frame, dict):
                frames.append(frame)

        for line in body.splitlines():
            if line == "":
                flush()
            elif line.startswith(":"):
                continue
            elif line.startswith("data:"):
                data = line[5:]
                if data.startswith(" "):
                    data = data[1:]
                data_lines.append(data)
        flush()
        return frames

    def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        notify: bool = False,
    ) -> dict[str, Any] | None:
        if notify:
            payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
            if params:
                payload["params"] = params
        else:
            self._id += 1
            payload = {
                "jsonrpc": "2.0",
                "id": self._id,
                "method": method,
                "params": params or {},
            }
        return self._post(payload)

    def initialize(self) -> dict[str, Any]:
        response = self.call("initialize", {
            "protocolVersion": CLIENT_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "dsh-literature-workflow", "version": "0.3.0"},
        })
        if not isinstance(response, dict):
            raise McpProtocolError("MCP initialize returned no JSON-RPC response.")
        result = response.get("result")
        if not isinstance(result, dict):
            raise McpProtocolError("MCP initialize result must be an object.")
        selected_version = result.get("protocolVersion")
        if not isinstance(selected_version, str) or not selected_version.strip():
            raise McpProtocolError("MCP initialize did not negotiate a protocol version.")
        if selected_version != CLIENT_PROTOCOL_VERSION:
            raise McpProtocolError("MCP selected an unsupported protocol version.")
        self.protocol_version = selected_version
        self.call("notifications/initialized", notify=True)
        return response

    def tools_list(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            params = {"cursor": cursor} if cursor is not None else {}
            response = self.call("tools/list", params)
            result = (response or {}).get("result")
            if not isinstance(result, dict):
                raise McpProtocolError("MCP tools/list result must be an object.")
            page = result.get("tools")
            if not isinstance(page, list) or any(not isinstance(tool, dict) for tool in page):
                raise McpProtocolError("MCP tools/list did not return a tools array.")
            tools.extend(page)
            next_cursor = result.get("nextCursor")
            if next_cursor in (None, ""):
                return tools
            if not isinstance(next_cursor, str):
                raise McpProtocolError("MCP tools/list nextCursor must be a string.")
            if next_cursor in seen_cursors:
                raise McpProtocolError("MCP tools/list returned a repeated nextCursor.")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def list_tools(self) -> list[dict[str, Any]]:
        """Backward-compatible alias for the historical method name."""
        return self.tools_list()

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = self.call("tools/call", {"name": name, "arguments": arguments})
        result = (response or {}).get("result")
        if not isinstance(result, dict):
            raise McpProtocolError("MCP tools/call result must be an object.")
        is_error = result.get("isError", False)
        if not isinstance(is_error, bool):
            raise McpProtocolError("MCP tools/call isError must be a boolean.")
        if is_error:
            raise McpError("MCP tool returned isError=true.")
        return result


TencentMcpClient = McpClient
