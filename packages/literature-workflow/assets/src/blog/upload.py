#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把单文件 HTML 演示页上传到自建站点的分组目录（站点根地址由 --base 或 DSH_BLOG_BASE 指定）。

站点类型：nginx 反代 + Flask 风格 JSON 接口的单页应用（不是 WordPress/GitBook）。
全部走 HTTP 接口，**不使用浏览器**（本机沙箱禁止命名管道，Chrome/Playwright 起不来）。

接口（均为实测确认，见 docs/blog-and-log-notes.md）：
    POST /login                      JSON {account, password}          -> 200 {"success":true,...} / 401
    GET  /check_auth                                                 -> {"success":true,"logged_in":true}
    GET  /get_groups                                                 -> {"success":true,"groups":[...]}
    GET  /mainblog                                                   -> {"success":true,"pages":[{"filename","display_name","group"},...]}
    POST /blogupload                 multipart: file, name, group     -> {"success":true,"msg":"上传成功！"}
    GET  /view/<group>/<filename>    最终可访问 URL（实测匿名也可访问）
    （站点另有 /delete/... 与 /create_group；本脚本**刻意不实现、不调用**，见下）

**关键行为（实测）**：服务端从表单字段 ``name`` 推导落盘文件名（空格→下划线，自动补 .html），
**不**用 multipart 里的 filename。重名**不覆盖**，而是静默追加序号（``x.html`` -> ``x_1.html``）
并把 display_name 也改成 "x 1"。也就是说服务端层面对别人的文件是安全的，**但你会拿到一个
和预期不一样的文件名**。为遵守 SAFETY.md 第四节，本脚本在**上传前**就检查同名文件：

    同名文件已存在 -> **立即中止，不上传**（退出码 2），并打印已存在的条目供人工判断。
    本脚本**没有**任何覆盖分支、**没有**任何删除分支。

用法：
    # 只读：列出目标分组的文件
    py -3.13 src\\blog\\upload.py --list --folder master_fin

    # 演练：三项检查（登录 / 分组存在 / 目标名未被占用），不上传
    py -3.13 src\\blog\\upload.py --file "staging\\design_demo.html" --name design_Bertrand_2004.html --folder master_fin --dry-run

    # 真上传（同名已存在时会中止）
    py -3.13 src\\blog\\upload.py --file "staging\\design_demo.html" --name design_Bertrand_2004.html --folder master_fin

**安全约束（SAFETY.md）**：默认且只允许写 ``master_fin``；要写别的分组必须显式加
``--allow-other-folder``。脚本不覆盖、不删除、不改动站点上任何既有内容。

凭据（**只从命令行/环境变量读，绝不写入任何文件**）：
    1) --account / --password
    2) 环境变量 BLOG_ACCOUNT / BLOG_PASSWORD
    注意：**不再**支持从 config.json 读口令 —— config.json 是会被提交的文件，
    把口令放进去就等于写进了仓库。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

sys.stdout.reconfigure(encoding="utf-8")
# stderr 也要设，否则中文报错在 GBK 控制台上会变成乱码
try:
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover - 某些被重定向的 stderr 不支持
    pass

try:
    import requests
except ImportError:  # pragma: no cover
    print("错误：需要 requests。py -3.13 已自带；请用 py -3.13 运行本脚本。", file=sys.stderr)
    raise SystemExit(3)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = PROJECT_ROOT / "config.json"

DEFAULT_BASE = os.environ.get("DSH_BLOG_BASE", "")
DEFAULT_FOLDER = "master_fin"
# SAFETY.md 第四节：只上传 master_fin。其它分组需显式 --allow-other-folder。
SAFE_FOLDER = "master_fin"
TIMEOUT = 30
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) blog-uploader/1.0 (+requests)"

# 老师定的命名规范：design_作者_年份.html / PPT_作者_年份.html，同学年多篇加小写序号
NAMING_RE = re.compile(r"^(design|Design|PPT)_[A-Za-z0-9\-']+_\d{4}[a-z]?\.html$")

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CHECK_FAILED = 2


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def mask(value: str | None) -> str:
    """脱敏展示，绝不回显明文口令。"""
    if not value:
        return "(空)"
    return "***"


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.is_file():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception as exc:  # 配置坏了不应该让脚本崩
        print(f"警告：读取 config.json 失败（{exc}），改用默认值。", file=sys.stderr)
        return {}


def predict_filename(name: str) -> str:
    """镜像服务端的 name -> 落盘文件名 推导规则（实测：空格→下划线，补 .html）。

    这只是**预测**；真实文件名一律以上传后回查 /mainblog 的结果为准。
    """
    stem = (name or "").strip().replace(" ", "_")
    if not stem:
        return ""
    if not stem.lower().endswith((".html", ".htm")):
        stem += ".html"
    elif stem.lower().endswith(".htm"):
        stem += "l"  # .htm -> .htm l   ==> .html
    return stem


def safe_name_ok(name: str) -> str | None:
    """返回拒绝原因；None 表示放行。防目录穿越与非法扩展名。"""
    if not name or not name.strip():
        return "名称为空"
    bad = set('/\\:*?"<>|\0')
    hit = bad & set(name)
    if hit:
        return f"名称含非法字符 {sorted(hit)}（会破坏 URL/路径）"
    if name.strip().startswith("."):
        return "名称不能以点开头"
    if ".." in name:
        return "名称不能包含 '..'"
    if not name.strip().lower().endswith((".html", ".htm")):
        return "只允许 .html / .htm 扩展名"
    return None


# --------------------------------------------------------------------------- #
# 站点客户端
# --------------------------------------------------------------------------- #
class UploadError(RuntimeError):
    pass


class BlogClient:
    def __init__(self, base: str, account: str, password: str) -> None:
        self.base = base.rstrip("/")
        self.account = account
        self._password = password
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        self.account_name: str | None = None

    # -- 内部 -------------------------------------------------------------- #
    def _json(self, resp: requests.Response) -> dict[str, Any]:
        try:
            return resp.json()
        except ValueError:
            snippet = resp.text[:200].replace("\n", " ")
            raise UploadError(f"服务端返回的不是 JSON（HTTP {resp.status_code}）：{snippet!r}") from None

    # -- 接口 -------------------------------------------------------------- #
    def login(self) -> str:
        """登录并保持 cookie。失败抛 UploadError，消息里给出可操作的原因。"""
        try:
            resp = self.s.post(
                f"{self.base}/login",
                json={"account": self.account, "password": self._password},
                timeout=TIMEOUT,
            )
        except requests.RequestException as exc:
            raise UploadError(f"连不上 {self.base}（{type(exc).__name__}: {exc}）") from None

        if resp.status_code == 401:
            raise UploadError("账号或密码错误（HTTP 401）。请检查 --account/--password 或 BLOG_ACCOUNT/BLOG_PASSWORD。")
        if resp.status_code != 200:
            raise UploadError(f"登录失败：HTTP {resp.status_code} {resp.text[:200]!r}")

        data = self._json(resp)
        if not data.get("success"):
            raise UploadError(f"登录失败：{data.get('error') or data.get('message') or data}")
        self.account_name = data.get("account") or self.account
        return self.account_name

    def check_auth(self) -> bool:
        data = self._json(self.s.get(f"{self.base}/check_auth", timeout=TIMEOUT))
        return bool(data.get("success") and data.get("logged_in"))

    def get_groups(self) -> list[str]:
        data = self._json(self.s.get(f"{self.base}/get_groups", timeout=TIMEOUT))
        if not data.get("success"):
            raise UploadError(f"/get_groups 返回失败：{data}")
        return list(data.get("groups") or [])

    def list_pages(self) -> list[dict[str, Any]]:
        resp = self.s.get(f"{self.base}/mainblog", timeout=TIMEOUT)
        data = self._json(resp)
        if not data.get("success"):
            raise UploadError(f"/mainblog 返回失败：{data}")
        return list(data.get("pages") or [])

    def find(self, group: str, filename: str) -> dict[str, Any] | None:
        for page in self.list_pages():
            if page.get("group") == group and page.get("filename") == filename:
                return page
        return None

    def upload(self, file_path: Path, name: str, group: str) -> dict[str, Any]:
        if not file_path.is_file():
            raise UploadError(f"文件不存在：{file_path}")
        size = file_path.stat().st_size
        if size == 0:
            raise UploadError(f"文件是空的：{file_path}")
        if size > 16 * 1024 * 1024:
            raise UploadError(f"文件 {size / 1048576:.1f} MB 超过站点 16 MB 上限")

        content = file_path.read_bytes()
        # multipart 的 filename 服务端不用于命名（命名看 name 字段），这里保持一致以便日志可读
        files = {"file": (predict_filename(name), content, "text/html")}
        data = {"name": name.strip(), "group": group}
        try:
            resp = self.s.post(f"{self.base}/blogupload", files=files, data=data, timeout=120)
        except requests.RequestException as exc:
            raise UploadError(f"上传请求失败（{type(exc).__name__}: {exc}）") from None
        if resp.status_code != 200:
            raise UploadError(f"上传失败：HTTP {resp.status_code} {resp.text[:300]!r}")
        payload = self._json(resp)
        if not payload.get("success"):
            raise UploadError(f"上传被拒绝：{payload.get('msg') or payload.get('error') or payload}")
        payload["_bytes_sent"] = len(content)
        return payload

    def view_url(self, group: str, filename: str) -> str:
        return f"{self.base}/view/{quote(group, safe='')}/{quote(filename, safe='')}"

    def verify_public(self, url: str) -> tuple[bool, int, int]:
        """匿名 GET 验证文件真的能访问。返回 (ok, status, bytes)。"""
        try:
            resp = requests.get(url, timeout=TIMEOUT, allow_redirects=True,
                                headers={"User-Agent": UA})
        except requests.RequestException as exc:
            print(f"  警告：验证 GET 失败（{type(exc).__name__}: {exc}）", file=sys.stderr)
            return False, 0, 0
        return resp.status_code == 200, resp.status_code, len(resp.content)


# --------------------------------------------------------------------------- #
# 子命令实现
# --------------------------------------------------------------------------- #
def resolve_credentials(args, cfg: dict[str, Any]) -> tuple[str, str]:
    """口令**只**来自命令行或环境变量。

    刻意不支持从 config.json 读口令：config.json 是仓库里的文件，
    把口令放进去等于把口令写进了会被提交的内容。
    """
    account = args.account or os.environ.get("BLOG_ACCOUNT") or ""
    password = args.password or os.environ.get("BLOG_PASSWORD") or ""
    return account, password


def resolve_base(args, cfg: dict[str, Any]) -> str:
    blog_cfg = cfg.get("blog") or {}
    return (args.base or os.environ.get("BLOG_BASE")
            or blog_cfg.get("baseUrl") or DEFAULT_BASE).rstrip("/")


def cmd_list(client: BlogClient, folder: str) -> int:
    groups = client.get_groups()
    pages = [p for p in client.list_pages() if p.get("group") == folder]
    print(f"分组 {folder!r} 共 {len(pages)} 个文件（站点共 {len(groups)} 个分组）")
    for page in sorted(pages, key=lambda p: p.get("filename", "")):
        print(f"  {page['filename']:<60}  {client.view_url(folder, page['filename'])}")
    return EXIT_OK


def cmd_dry_run(client: BlogClient, args) -> int:
    """三项检查：登录成功 + 文件夹存在 + 目标名可用。不上传。"""
    folder, name = args.folder, args.name
    predicted = predict_filename(name)
    print(f"[dry-run] 站点   : {client.base}")
    print(f"[dry-run] 分组   : {folder}")
    print(f"[dry-run] 源文件 : {args.file}")
    print(f"[dry-run] 目标名 : {name}  ->  预计文件名 {predicted}")
    print()

    failures: list[str] = []

    # 1) 登录
    print("检查 1/3 登录 ...")
    try:
        who = client.login()
        print(f"  OK  登录成功，账号 = {who}")
    except UploadError as exc:
        print(f"  FAIL  {exc}")
        return EXIT_CHECK_FAILED  # 登录失败后面没法查

    if not client.check_auth():
        print("  FAIL  /check_auth 未确认登录态")
        failures.append("登录态未保持")

    # 2) 分组存在
    print(f"检查 2/3 分组 {folder!r} 是否存在 ...")
    groups = client.get_groups()
    pages = client.list_pages()
    groups_with_files = {p.get("group") for p in pages}
    if folder in groups:
        print(f"  OK  分组存在（站点共 {len(groups)} 个分组，该分组已有 "
              f"{sum(1 for p in pages if p.get('group') == folder)} 个文件）")
    else:
        print(f"  FAIL  分组 {folder!r} 不存在")
        near = [g for g in groups if g.lower() == folder.lower()]
        if near:
            print(f"        大小写不同但相近的分组：{near}  ← 注意分组名大小写敏感")
        print(f"        现有分组：{sorted(groups)}")
        failures.append(f"分组 {folder!r} 不存在")

    # 3) 目标名可用
    print(f"检查 3/3 目标名 {predicted!r} 是否可用 ...")
    existing = [p for p in pages if p.get("group") == folder]
    taken = next((p for p in existing if p.get("filename") == predicted), None)
    if taken:
        print(f"  TAKEN 该分组已有同名文件（display_name={taken.get('display_name')!r}）")
        print("         站点重名**不覆盖**，会静默改名成 "
              f"{predicted[:-5]}_1.html —— 上传不会丢数据，但文件名不会再等于目标名。")
        failures.append(f"目标名 {predicted!r} 已被占用（上传后会变成 _1）")
    else:
        print("  OK  该分组没有同名文件，上传后会落在预测文件名上")

    # 命名规范提示
    if not NAMING_RE.match(predicted):
        print(f"\n提示：{predicted!r} 不符合命名规范 design_作者_年份.html / PPT_作者_年份.html"
              "（同学年多篇加小写序号）")

    print()
    if failures:
        print(f"[dry-run] 结果：未通过（{len(failures)} 项）")
        for item in failures:
            print(f"  - {item}")
        return EXIT_CHECK_FAILED
    print("[dry-run] 结果：三项检查全部通过，可以真上传（去掉 --dry-run）")
    return EXIT_OK


def cmd_upload(client: BlogClient, args) -> int:
    folder, name = args.folder, args.name
    file_path = Path(args.file)
    predicted = predict_filename(name)

    print(f"登录 {client.base} ...")
    who = client.login()
    print(f"  登录成功，账号 = {who}")
    if not client.check_auth():
        print("错误：登录态未保持，中止。", file=sys.stderr)
        return EXIT_ERROR

    if folder not in client.get_groups():
        print(f"错误：分组 {folder!r} 不存在，请先用 --list 查看。", file=sys.stderr)
        return EXIT_ERROR

    existing = [p for p in client.list_pages() if p.get("group") == folder]
    before = {p.get("filename") for p in existing}

    # ---- SAFETY.md 第四节：上传前检查同名文件，已存在就中止，绝不覆盖 ----
    clash = next((p for p in existing if p.get("filename") == predicted), None)
    if clash is not None:
        print()
        print("!! 已中止：目标分组里已存在同名文件，按 SAFETY.md 第四节不上传、不覆盖。", file=sys.stderr)
        print(f"   分组       : {folder}", file=sys.stderr)
        print(f"   冲突文件名 : {clash.get('filename')}", file=sys.stderr)
        print(f"   显示名     : {clash.get('display_name')}", file=sys.stderr)
        print(f"   现有 URL   : {client.view_url(folder, clash.get('filename', ''))}", file=sys.stderr)
        print("   说明：站点本身不覆盖（会改成 ..._1.html），但那会得到一个非预期的文件名，"
              "所以这里直接停下。", file=sys.stderr)
        print("   建议：换一个符合规范的名字（同学年多篇加小写序号，如 ...2025b），"
              "或先人工确认该文件是否就是本人的。", file=sys.stderr)
        return EXIT_CHECK_FAILED

    print(f"上传 {file_path} -> {folder}/{predicted} ...")
    result = client.upload(file_path, name, folder)
    print(f"  服务端：{result.get('msg') or result.get('message') or 'ok'}（已发送 {result['_bytes_sent']} 字节）")

    # 回查真实文件名（理论上不该变，因为上面已经排除了同名冲突）
    after = [p for p in client.list_pages() if p.get("group") == folder]
    new_entries = [p for p in after if p.get("filename") not in before]
    if not new_entries:
        print("错误：上传接口返回成功，但 /mainblog 里找不到新文件。请人工到站点确认。", file=sys.stderr)
        return EXIT_ERROR

    entry = new_entries[0] if len(new_entries) == 1 else max(
        new_entries, key=lambda p: p.get("filename", ""))
    actual = entry.get("filename", "")
    url = client.view_url(folder, actual)

    print()
    print(f"  真实文件名 : {actual}")
    print(f"  显示名     : {entry.get('display_name')}")
    print(f"  访问 URL   : {url}")
    if actual != predicted:
        print()
        print("  ！注意：服务端把文件名改名了（预计 "
              f"{predicted}，实际 {actual}）。原因通常是该名字已被占用（站点不覆盖、只追加序号）。")

    ok, status, size = client.verify_public(url)
    if ok:
        print(f"  验证       : GET {url} -> 200（{size} 字节），公开可访问 ✓")
    else:
        print(f"  验证       : GET {url} -> HTTP {status}，**未能确认可访问**", file=sys.stderr)

    print()
    print("  提示：本脚本不提供删除功能。如需清理，请在网页上人工操作。")

    if args.json_out:
        Path(args.json_out).write_text(json.dumps({
            "group": folder, "filename": actual, "display_name": entry.get("display_name"),
            "url": url, "predicted_filename": predicted, "renamed": actual != predicted,
            "verified_status": status, "verified_bytes": size,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  结果已写入 : {args.json_out}")

    return EXIT_OK if ok else EXIT_ERROR


# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="upload.py",
        description="把 HTML 演示页上传到自建站点的分组目录（--base / DSH_BLOG_BASE，纯 HTTP，不用浏览器）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法：", 1)[-1],
    )
    p.add_argument("--file", help="要上传的本地 HTML 文件")
    p.add_argument("--name", help="站点上的文件名/显示名（服务端据此推导落盘名，空格变下划线）")
    p.add_argument("--folder", default=None,
                   help=f"目标分组，默认 {DEFAULT_FOLDER}；写别的分组必须加 --allow-other-folder")
    p.add_argument("--allow-other-folder", action="store_true",
                   help=f"显式放开「只写 {SAFE_FOLDER}」的限制（SAFETY.md 第四节）")
    p.add_argument("--base", default=None, help=f"站点根地址，默认 {DEFAULT_BASE}")
    p.add_argument("--account", default=None, help="账号（也可用环境变量 BLOG_ACCOUNT）")
    p.add_argument("--password", default=None,
                   help="口令（也可用环境变量 BLOG_PASSWORD；不会写入任何文件）")
    p.add_argument("--dry-run", action="store_true",
                   help="只检查「登录成功 + 分组存在 + 目标名未占用」，不上传")
    p.add_argument("--list", action="store_true", help="列出该分组的文件后退出（只读）")
    p.add_argument("--json-out", default=None, help="把上传结果（含 URL）写成 JSON 文件")
    p.add_argument("--strict-naming", action="store_true",
                   help="不符合 design_作者_年份.html 规范时直接报错退出")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config()
    if not args.folder:
        args.folder = (cfg.get("blog") or {}).get("folder") or DEFAULT_FOLDER
    base = resolve_base(args, cfg)
    account, password = resolve_credentials(args, cfg)

    # SAFETY.md 第四节：只上传 master_fin。只读的 --list 不受限（读不会改任何东西）。
    is_write = not (args.dry_run or args.list)
    if is_write and args.folder != SAFE_FOLDER and not args.allow_other_folder:
        print(f"错误：本脚本只允许**上传**到 {SAFE_FOLDER!r}（SAFETY.md 第四节）。"
              f"要上传到 {args.folder!r} 必须显式加 --allow-other-folder。", file=sys.stderr)
        return EXIT_ERROR

    if not account or not password:
        print("错误：缺少登录凭据。请用 --account/--password 或环境变量 "
              "BLOG_ACCOUNT/BLOG_PASSWORD 提供。", file=sys.stderr)
        return EXIT_ERROR

    if not (args.dry_run or args.list):
        for required in ("file", "name"):
            if not getattr(args, required):
                print(f"错误：缺少 --{required}（或改用 --dry-run/--list）。", file=sys.stderr)
                return EXIT_ERROR
        reason = safe_name_ok(args.name)
        if reason:
            print(f"错误：--name 不合法：{reason}", file=sys.stderr)
            return EXIT_ERROR
        if not NAMING_RE.match(predict_filename(args.name)):
            msg = (f"--name 不符合命名规范 design_作者_年份.html / PPT_作者_年份.html"
                   f"（同学年多篇加小写序号 b、c…）；实得 {predict_filename(args.name)!r}")
            if args.strict_naming:
                print(f"错误：{msg}", file=sys.stderr)
                return EXIT_ERROR
            print(f"警告：{msg}")

    client = BlogClient(base, account, password)
    print(f"（口令 {mask(password)}，账号 {account} —— 口令不写入任何文件）")
    try:
        if args.list:
            return cmd_list(client, args.folder)
        if args.dry_run:
            return cmd_dry_run(client, args)
        return cmd_upload(client, args)
    except UploadError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_ERROR
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
