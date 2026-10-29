"""Zotero storage 目录定位（严格只读）。

三级定位策略（返回 8 位 storage key 以及 D:\\zotero\\storage\\<KEY> 目录）：

  (a) in-storage   —— PDF 本身就在 storage 目录下，取它的父目录；
  (b) filename-scan—— 按文件名在 storage 下递归精确匹配，取匹配文件父目录；
  (c) local-api    —— Zotero 7 本地 API（默认 http://127.0.0.1:23119/api/users/0）
                      按标题 / 附件名查 storage key（需要 Zotero 运行并开启本地通信）；
  (d) sqlite-ro    —— 只读兜底：读 zotero.sqlite 的 itemAttachments 表（绝不写入）。

安全约定：
  * 本模块不做任何写操作、不创建文件、不删除文件；
  * 打开 zotero.sqlite 只用只读 URI（mode=ro / immutable=1），绝不加写锁；
  * Zotero 运行时 zotero.sqlite 处于 WAL 模式且被占用，`mode=ro` 会报 database is locked，
    此时把 sqlite（+ -wal/-shm）复制到临时目录再只读打开，读完立即删除副本；
  * 任何异常都降级为「定位失败 + 人工兜底提示」，不向上抛栈。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------- 默认配置

DEFAULT_DATA_DIR = r"D:\zotero"
DEFAULT_STORAGE_DIR = r"D:\zotero\storage"
DEFAULT_API_BASE = "http://127.0.0.1:23119/api/users/0"

KEY_RE = re.compile(r"^[A-Z0-9]{8}$")

MANUAL_HINT = (
    "人工兜底：1) 在 Zotero 里右键该条目 →「显示文件」，地址栏里的 D:\\zotero\\storage\\<KEY>\\ "
    "就是目标目录；2) 确认 Zotero 已开启「设置 → 高级 → 允许其他应用与本机 Zotero 通信」后重试；"
    "3) 直接用 --storage-key <8位KEY> 指定目录。"
)


@dataclass
class LocateResult:
    """定位结果。ok=False 时 storage_dir/key 为 None，detail 里带人工兜底提示。"""

    ok: bool
    storage_dir: Optional[str] = None
    key: Optional[str] = None
    method: str = "none"          # in-storage | filename-scan | local-api | sqlite-ro | none
    detail: str = ""
    attempts: List[str] = field(default_factory=list)
    ambiguous: bool = False

    @property
    def dir_exists(self) -> bool:
        return bool(self.storage_dir) and os.path.isdir(self.storage_dir)


# ---------------------------------------------------------------- 小工具


def _norm(p: str) -> str:
    """Windows 大小写/分隔符不敏感的比较键（不做 realpath，避免网络盘卡顿）。"""
    return os.path.normcase(os.path.normpath(os.path.abspath(p)))


def _is_under(child: str, parent: str) -> bool:
    c, p = _norm(child), _norm(parent)
    return c == p or c.startswith(p.rstrip("\\/") + os.sep)


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().casefold()


def project_root() -> str:
    """src/pdf2md/zotero_locate.py → 工作流根目录。"""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    """读工作流 config.json；缺失/损坏时返回默认值，不抛异常。"""
    cfg: Dict[str, Any] = {
        "storageDir": DEFAULT_STORAGE_DIR,
        "dataDir": DEFAULT_DATA_DIR,
        "localApiBase": DEFAULT_API_BASE,
    }
    p = path or os.path.join(project_root(), "config.json")
    try:
        with open(p, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        z = raw.get("zotero", {}) if isinstance(raw, dict) else {}
        if z.get("storageDir"):
            cfg["storageDir"] = str(z["storageDir"])
        if z.get("dataDir"):
            cfg["dataDir"] = str(z["dataDir"])
        if z.get("localApiBase"):
            cfg["localApiBase"] = str(z["localApiBase"])
    except FileNotFoundError:
        pass
    except Exception:
        # 配置坏了也要能跑：退回默认路径
        pass
    cfg["sqlitePath"] = os.path.join(str(cfg["dataDir"]), "zotero.sqlite")
    return cfg


# ---------------------------------------------------------------- (a)(b) 文件系统


def _try_in_storage(pdf_path: str, storage_dir: str) -> Optional[LocateResult]:
    parent = os.path.dirname(os.path.abspath(pdf_path))
    if _is_under(parent, storage_dir):
        key = os.path.basename(parent)
        return LocateResult(
            ok=True,
            storage_dir=parent,
            key=key if KEY_RE.match(key) else None,
            method="in-storage",
            detail=f"PDF 已在 storage 内，父目录 = {parent}",
        )
    return None


def _try_filename_scan(filename: str, storage_dir: str) -> Tuple[Optional[LocateResult], str]:
    """在 storage 下递归找同名文件。返回 (结果, 说明)。只读遍历，遇到无权限目录跳过。"""
    if not os.path.isdir(storage_dir):
        return None, f"storage 目录不存在：{storage_dir}"

    target = _norm_name(filename)
    hits: List[str] = []
    walk_errors: List[str] = []

    def _onerror(err: OSError) -> None:  # 沙箱/ACL 拒绝的子目录直接跳过
        walk_errors.append(f"{getattr(err, 'filename', '?')}: {getattr(err, 'strerror', err)}")

    for root, dirs, files in os.walk(storage_dir, onerror=_onerror):
        for fn in files:
            if _norm_name(fn) == target:
                hits.append(os.path.join(root, fn))

    if not hits:
        note = f"storage 下未找到同名文件（{filename}）"
        if walk_errors:
            note += f"；{len(walk_errors)} 个子目录无权限已跳过"
        return None, note

    hits.sort()
    chosen = hits[0]
    parent = os.path.dirname(chosen)
    key = os.path.basename(parent)
    detail = f"按文件名在 storage 内精确匹配到 {chosen}"
    if len(hits) > 1:
        detail += f"（命中 {len(hits)} 处，取第一处：{'; '.join(hits[1:4])}）"
    return (
        LocateResult(
            ok=True,
            storage_dir=parent,
            key=key if KEY_RE.match(key) else None,
            method="filename-scan",
            detail=detail,
            ambiguous=len(hits) > 1,
        ),
        detail,
    )


# ---------------------------------------------------------------- (c) Zotero 本地 API


def _api_session(api_base: str, timeout: float):
    import requests  # 延迟导入：缺 requests 时其它层级仍可用

    sess = requests.Session()
    sess.headers.update({"Zotero-API-Version": "3", "Accept": "application/json"})
    return sess, timeout


def _match_name(candidate: str, target: str) -> bool:
    a, b = _norm_name(candidate), _norm_name(target)
    if not a or not b:
        return False
    if a == b:
        return True
    if a.endswith(".pdf") and b.endswith(".pdf"):
        return os.path.splitext(a)[0] == os.path.splitext(b)[0]
    return os.path.splitext(a)[0] == os.path.splitext(b)[0]


def locate_via_api(
    filename: str,
    title: Optional[str] = None,
    *,
    api_base: str = DEFAULT_API_BASE,
    timeout: float = 6.0,
    max_children_probes: int = 8,
) -> Tuple[Optional[str], str]:
    """用 Zotero 7 本地 API 按 标题/附件名 找 attachment key（= storage 目录名）。

    返回 (key 或 None, 说明)。任何网络/解析异常都吞掉并写进说明。
    """
    try:
        sess, timeout = _api_session(api_base, timeout)
    except Exception as exc:  # requests 不可用
        return None, f"本地 API 不可用（{type(exc).__name__}: {exc}）"

    def _get(path: str, **params):
        r = sess.get(api_base + path, params=params, timeout=timeout)
        r.raise_for_status()
        return r.json()

    notes: List[str] = []
    stem = os.path.splitext(os.path.basename(filename))[0]

    # c1: 先按标题找顶层条目，再查它的 attachments（最可靠）
    queries = [q for q in (title, stem) if q]
    for q in queries:
        try:
            tops = _get("/items", q=q[:200], qmode="titleCreatorYear", format="json", limit=25)
        except Exception as exc:
            notes.append(f"API 查询失败（q={q[:40]!r}: {type(exc).__name__}: {exc}）")
            continue
        for item in (tops or [])[:max_children_probes]:
            key = item.get("key")
            if not key:
                continue
            try:
                kids = _get(f"/items/{key}/children", format="json", limit=50)
            except Exception as exc:
                notes.append(f"children 查询失败（{key}: {type(exc).__name__}）")
                continue
            for kid in kids or []:
                d = kid.get("data", {}) or {}
                if d.get("itemType") != "attachment":
                    continue
                if _match_name(d.get("filename") or "", filename) or _match_name(d.get("title") or "", filename):
                    return kid.get("key"), f"本地 API：按标题命中条目 {key}，其附件 key={kid.get('key')}"
        notes.append(f"API 按标题未命中（q={q[:40]!r}）")

    # c2: 直接按附件名搜
    try:
        atts = _get("/items", q=stem[:200], qmode="everything", itemType="attachment",
                    format="json", limit=25)
        for att in atts or []:
            d = att.get("data", {}) or {}
            if _match_name(d.get("filename") or "", filename) or _match_name(d.get("title") or "", filename):
                return att.get("key"), f"本地 API：按附件名直接命中 key={att.get('key')}"
        notes.append("API 按附件名未命中")
    except Exception as exc:
        notes.append(f"API 附件查询失败（{type(exc).__name__}: {exc}）")

    return None, "；".join(notes) if notes else "本地 API 无结果"


# ---------------------------------------------------------------- (d) sqlite 只读兜底


def _sqlite_query(db_uri: str, filename: str, timeout: float) -> Optional[str]:
    con = sqlite3.connect(db_uri, uri=True, timeout=timeout)
    try:
        cur = con.execute(
            "SELECT items.key, itemAttachments.path "
            "FROM itemAttachments JOIN items ON items.itemID = itemAttachments.itemID "
            "WHERE itemAttachments.path LIKE 'storage:%'"
        )
        rows = cur.fetchall()
    finally:
        con.close()
    for key, path in rows:
        stored = str(path or "")[len("storage:"):]
        if _match_name(os.path.basename(stored), filename):
            return str(key)
    return None


def _temp_dir_for_copy(prefix: str = "zotero-ro-") -> Optional[str]:
    """建一个我们自己的临时目录。

    实测本机 `tempfile.mkdtemp()` 建出的目录**不可写**（在其内写文件报 PermissionError），
    会让 sqlite 复制兜底静默失败，所以先用 os.makedirs 建目录，最后才退回 mkdtemp。
    """
    base = tempfile.gettempdir()
    for i in range(8):
        cand = os.path.join(base, f"{prefix}{os.getpid()}_{i}")
        if os.path.exists(cand):
            continue
        try:
            os.makedirs(cand)
            return cand
        except Exception:
            continue
    try:
        return tempfile.mkdtemp(prefix=prefix)
    except Exception:
        return None


def _dispose_temp_dir(path: Optional[str]) -> None:
    """清理我们自己刚建的临时目录：只删自己复制的那几个文件，再删空目录。

    刻意不用 shutil.rmtree —— 安全红线要求禁止任何递归删除。
    """
    if not path:
        return
    for name in ("zotero.sqlite", "zotero.sqlite-wal", "zotero.sqlite-shm"):
        f = os.path.join(path, name)
        if os.path.isfile(f):
            try:
                os.remove(f)
            except Exception:
                pass
    try:
        os.rmdir(path)          # 只有目录为空时才成功，绝不会连带删掉别的东西
    except Exception:
        pass


def locate_via_sqlite(
    filename: str,
    *,
    sqlite_path: str,
    timeout: float = 2.0,
    allow_copy: bool = True,
    max_copy_bytes: int = 400 * 1024 * 1024,
) -> Tuple[Optional[str], str]:
    """只读读 zotero.sqlite 的 itemAttachments。返回 (key 或 None, 说明)。

    读取阶梯（都不带写锁）：
      1. 无 -wal 时 → file:...?mode=ro&immutable=1（最快、绝对安全）
      2. file:...?mode=ro        （正确但 Zotero 运行时可能 database is locked）
      3. 复制 sqlite(+ -wal/-shm) 到临时目录后只读打开（Zotero 运行时也能拿到最新数据）
      4. 最后手段：原库 immutable=1（可能读到 WAL 未合并的旧数据，会在说明里标注）
    """
    if not os.path.isfile(sqlite_path):
        return None, f"sqlite 不存在：{sqlite_path}"

    wal = sqlite_path + "-wal"
    has_wal = os.path.isfile(wal) and os.path.getsize(wal) > 0
    notes: List[str] = []

    ladder: List[Tuple[str, str, bool]] = []
    if not has_wal:
        ladder.append((f"file:{sqlite_path}?mode=ro&immutable=1", "immutable-ro", False))
    ladder.append((f"file:{sqlite_path}?mode=ro", "ro", False))
    if allow_copy:
        ladder.append(("__copy__", "copy-ro", False))
    ladder.append((f"file:{sqlite_path}?mode=ro&immutable=1", "immutable-ro(may-be-stale)", True))

    for uri, label, maybe_stale in ladder:
        tmpdir = None
        try:
            if uri == "__copy__":
                size = os.path.getsize(sqlite_path)
                if size > max_copy_bytes:
                    notes.append(f"{label}: 跳过（库 {size/1e6:.0f}MB 超过复制上限）")
                    continue
                tmpdir = _temp_dir_for_copy()
                if not tmpdir:
                    notes.append(f"{label}: 无法创建临时目录")
                    continue
                copy = os.path.join(tmpdir, "zotero.sqlite")
                shutil.copy2(sqlite_path, copy)
                for suffix in ("-wal", "-shm"):
                    if os.path.isfile(sqlite_path + suffix):
                        try:
                            shutil.copy2(sqlite_path + suffix, copy + suffix)
                        except Exception:
                            pass
                uri = f"file:{copy}?mode=ro"
            key = _sqlite_query(uri, filename, timeout)
            if key:
                extra = "（注意：可能读到 WAL 未合并的旧数据）" if maybe_stale else ""
                return key, f"sqlite 只读({label}) 命中 key={key}{extra}"
            notes.append(f"{label}: 未命中")
        except Exception as exc:
            notes.append(f"{label}: {type(exc).__name__}: {exc}")
        finally:
            _dispose_temp_dir(tmpdir)

    return None, "sqlite 兜底失败 → " + "；".join(notes)


# ---------------------------------------------------------------- 主入口


def locate_storage_dir(
    pdf_path: str,
    *,
    storage_dir: Optional[str] = None,
    api_base: Optional[str] = None,
    sqlite_path: Optional[str] = None,
    title: Optional[str] = None,
    use_api: bool = True,
    use_sqlite: bool = True,
    timeout: float = 6.0,
) -> LocateResult:
    """定位 pdf 对应的 Zotero storage 目录。永不抛异常。"""
    cfg = load_config()
    storage_dir = storage_dir or cfg["storageDir"]
    api_base = api_base or cfg["localApiBase"]
    sqlite_path = sqlite_path or cfg["sqlitePath"]

    pdf_abs = os.path.abspath(pdf_path)
    filename = os.path.basename(pdf_abs)
    attempts: List[str] = []

    if not os.path.isfile(pdf_abs):
        attempts.append(f"[路径] 文件不存在：{pdf_abs}")
    else:
        res = _try_in_storage(pdf_abs, storage_dir)
        if res:
            res.attempts = ["(a) in-storage 命中"]
            if res.storage_dir and not os.path.isdir(res.storage_dir):
                res.detail += "；警告：该目录当前不存在"
            return res
        attempts.append(f"(a) in-storage: 不在 {storage_dir} 下")

    res, note = _try_filename_scan(filename, storage_dir)
    if res:
        res.attempts = attempts + [f"(b) filename-scan 命中"]
        if not res.dir_exists:
            res.ok = False
            res.detail = f"{res.detail}；但目录不存在"
            res.attempts.append("(b) 目录已消失")
            return _failed(res.attempts, res.detail)
        return res
    attempts.append(f"(b) filename-scan: {note}")

    if use_api:
        key, api_note = locate_via_api(filename, title=title, api_base=api_base, timeout=timeout)
        attempts.append(f"(c) local-api: {api_note}")
        if key:
            target = os.path.join(storage_dir, key)
            return LocateResult(
                ok=True,
                storage_dir=target,
                key=key,
                method="local-api",
                detail=f"{api_note} → {target}"
                + ("" if os.path.isdir(target) else "；警告：本地未见该 storage 子目录（附件可能未下载/未同步）"),
                attempts=attempts,
            )

    if use_sqlite:
        key, sq_note = locate_via_sqlite(filename, sqlite_path=sqlite_path)
        attempts.append(f"(d) sqlite-ro: {sq_note}")
        if key:
            target = os.path.join(storage_dir, key)
            return LocateResult(
                ok=True,
                storage_dir=target,
                key=key,
                method="sqlite-ro",
                detail=f"{sq_note} → {target}"
                + ("" if os.path.isdir(target) else "；警告：本地未见该 storage 子目录"),
                attempts=attempts,
            )

    return _failed(attempts, f"三级定位全部失败（文件：{filename}）")


def _failed(attempts: List[str], detail: str) -> LocateResult:
    return LocateResult(
        ok=False,
        storage_dir=None,
        key=None,
        method="none",
        detail=f"{detail}。{MANUAL_HINT}",
        attempts=attempts,
    )


def locate_by_key(key: str, *, storage_dir: Optional[str] = None) -> LocateResult:
    """人工指定 storage key 时的入口（--storage-key）。"""
    cfg = load_config()
    storage_dir = storage_dir or cfg["storageDir"]
    target = os.path.join(storage_dir, key.strip())
    exists = os.path.isdir(target)
    return LocateResult(
        ok=bool(KEY_RE.match(key.strip())),
        storage_dir=target,
        key=key.strip(),
        method="manual-key",
        detail=f"人工指定 key={key}；目录{'存在' if exists else '不存在（写入时会自动创建）'}" if KEY_RE.match(key.strip())
        else f"非法 storage key：{key!r}（应为 8 位大写字母/数字）",
        attempts=["(manual) --storage-key"],
    )


def _main(argv: Optional[List[str]] = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="zotero_locate.py",
        description="定位 PDF 对应的 Zotero storage 目录（只读；绝不写入 D:\\zotero）",
        epilog="示例：py -3.13 zotero_locate.py \"D:\\zotero\\storage\\C4SLQIPW\\xxx.pdf\"",
    )
    ap.add_argument("pdf", help="PDF 路径（真实路径或工作区里的副本）")
    ap.add_argument("--title", default=None, help="标题，用于本地 API 按标题反查 storage key")
    ap.add_argument("--storage-key", default=None, help="直接指定 8 位 storage key，跳过自动定位")
    ap.add_argument("--storage-dir", default=None, help="覆盖 storage 根目录（默认取 config.json）")
    ap.add_argument("--no-api", action="store_true", help="不使用 Zotero 本地 API")
    ap.add_argument("--no-sqlite", action="store_true", help="不使用 sqlite 只读兜底")
    ap.add_argument("--quiet", action="store_true", help="只输出一行结果")
    args = ap.parse_args(argv)

    if args.storage_key:
        r = locate_by_key(args.storage_key, storage_dir=args.storage_dir)
    else:
        r = locate_storage_dir(
            args.pdf,
            storage_dir=args.storage_dir,
            title=args.title,
            use_api=not args.no_api,
            use_sqlite=not args.no_sqlite,
        )
    if args.quiet:
        print(json.dumps({"ok": r.ok, "method": r.method, "key": r.key,
                          "storage_dir": r.storage_dir, "detail": r.detail},
                         ensure_ascii=False))
    else:
        print(f"ok={r.ok} method={r.method} key={r.key}")
        print(f"storage_dir={r.storage_dir}")
        print(f"detail={r.detail}")
        for a in r.attempts:
            print("  -", a)
    return 0 if r.ok else 1


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    raise SystemExit(_main())
