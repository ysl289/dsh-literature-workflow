"""Official Tencent Docs short-code authorization; never log tokens or codes.

Protocol source: https://cdn.addon.tencentsuite.com/static/tencent-docs.zip
tencent-docs/setup.sh (_tdoc_generate_auth_url and tdoc_fetch_token).
"""
import argparse
import json
import os
import secrets
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

ORIGIN = "https://docs.qq.com"
AUTH_PAGE = ORIGIN + "/scenario/open-claw.html"
TOKEN_LOOKUP = ORIGIN + "/oauth/v2/mcp/token/get"


class AuthError(Exception):
    def __init__(self, code):
        self.code = code


def official_url(value):
    u = urllib.parse.urlsplit(value)
    if u.scheme != "https" or u.netloc != "docs.qq.com" or u.username or u.password:
        raise AuthError("invalid_endpoint")
    return value


def request_json(url, data=None, form=False, headers=None):
    official_url(url)
    body = None if data is None else (urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode())
    headers = {"Accept": "application/json", **(headers or {})}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        # Do not follow redirects with authorization request bodies.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                raise AuthError("invalid_endpoint")
        response = urllib.request.build_opener(NoRedirect()).open(req, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        if "text/event-stream" in response.headers.get("Content-Type", ""):
            result = None
            total = 0
            for line in response:
                total += len(line)
                if total > 1024 * 1024:
                    break
                if line.startswith(b"data:"):
                    try:
                        event = json.loads(line[5:])
                    except ValueError:
                        continue
                    if isinstance(event, dict) and ("result" in event or "error" in event):
                        result = event
                        break
        else:
            result = json.loads(response.read(1024 * 1024))
    if not isinstance(result, dict):
        raise AuthError("invalid_response")
    return result


def validate_token(token, request=request_json):
    """Initialize only; do not read or modify any document while verifying login."""
    for scheme in ("raw", "bearer"):
        try:
            response = request(ORIGIN + "/openapi/mcp", {
                "jsonrpc": "2.0", "id": "literature-auth-check", "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                           "clientInfo": {"name": "literature-workflow", "version": "0.3.0"}},
            }, headers={"Authorization": token if scheme == "raw" else "Bearer " + token,
                        "Accept": "application/json, text/event-stream"})
        except json.JSONDecodeError:
            continue
        except AuthError as error:
            if error.code != "invalid_response":
                raise
            continue
        if isinstance(response.get("result"), dict) and response["result"].get("protocolVersion"):
            return scheme
    raise AuthError("token_validation_failed")


def save_token(dest, token):
    """Replace only after a complete token was received; never print credentials."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".tencent-auth-", suffix=".tmp", dir=dest.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(token, stream, ensure_ascii=False)
        os.replace(temp, dest)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def authorize(dest, emit, request=request_json, open_browser=webbrowser.open,
              sleep=time.sleep, clock=time.monotonic, save=save_token,
              make_code=lambda: secrets.token_hex(8), timeout=300, validate=validate_token):
    # Match the vendor's setup.sh protocol, not an assumed DCR/device pairing.
    code = make_code()
    complete = AUTH_PAGE + "?" + urllib.parse.urlencode({
        "nlc": "1", "authType": "1", "code": code, "mcp_source": "desktop",
    })
    lookup = TOKEN_LOOKUP + "?" + urllib.parse.urlencode({"code": code})
    expires = min(900, max(1, float(timeout)))
    deadline = clock() + expires
    progress = dict(userCode="", verificationURI=AUTH_PAGE, verificationURL=complete,
                    expiresAt=int(time.time() + expires))
    emit("waiting_approval", **progress)
    # Open before any network operation: a provider rejection cannot suppress the browser.
    try:
        opened = bool(open_browser(complete))
    except Exception:
        opened = False
    emit("waiting_approval", **progress, browserOpened=opened)
    network_errors = 0
    while clock() < deadline:
        sleep(min(3, max(0, deadline - clock())))
        if clock() >= deadline:
            break
        try:
            result = request(lookup)
            network_errors = 0
        except (urllib.error.URLError, TimeoutError, OSError):
            network_errors += 1
            if network_errors >= 3:
                raise AuthError("network_or_local_error")
            continue
        data = result.get("data") or {}
        if not isinstance(data, dict):
            raise AuthError("invalid_response")
        # Reject expiration before saving, including responses which still contain a token.
        if data.get("expired") is True:
            raise AuthError("expired_token")
        ret = str(result.get("ret", result.get("retcode", "")))
        if ret == "11510":
            continue
        if ret == "400006":
            raise AuthError("expired_token")
        if ret == "400007":
            raise AuthError("vip_required")
        token = data.get("token")
        if ret not in ("0", "") or not isinstance(token, str) or not token:
            raise AuthError("token_failed")
        emit("validating")
        scheme = validate(token)
        emit("saving")
        save(dest, {"access_token": token, "obtained_at": int(time.time()),
                    "authorization_method": "tencent_official_short_code", "auth_scheme": scheme})
        emit("completed")
        return
    raise AuthError("timeout")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--save", required=True)
    args = parser.parse_args()
    def emit(status, **values):
        print(json.dumps({"status": status, **values}, ensure_ascii=False), flush=True)
    try:
        authorize(args.save, emit)
        return 0
    except Exception as error:
        # Provider response bodies, exception URLs and credentials must never enter host logs.
        code = error.code if isinstance(error, AuthError) else "network_or_local_error"
        emit("failed", errorCode=code)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
