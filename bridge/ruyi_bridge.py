#!/usr/bin/env python3
"""
ruyi-mcp Python Bridge — JSON-RPC over stdio.

Translates JSON-RPC requests from the Node.js MCP server into ruyipage API calls.
One long-lived process: receives JSON lines on stdin, writes JSON responses on stdout.

Protocol:
  Request:  {"id": <int>, "method": "<string>", "params": {<object>}}
  Response: {"id": <int>, "result": <any>} | {"id": <int>, "error": {"code": <int>, "message": "<string>", "data": "<traceback>"}}
  Notify:   {"id": null, "method": "<string>", "params": {<object>}}   (fire-and-forget, no response)
"""

import sys
import json
import traceback
import os
import shutil
import socket
import ipaddress
import math
import random
import signal
import subprocess
import time
import tempfile
import hashlib
import re
import uuid
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qsl, urlsplit

# Force UTF-8 JSON-RPC stdio on Windows. Qidian and other Chinese sites may
# return non-ASCII / non-BMP text; relying on the console code page makes Node
# decode mojibake or lets Python die with UnicodeEncodeError.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", newline="\n")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", newline="\n")

# ---------------------------------------------------------------------------
# ruyipage imports — all optional to allow graceful error if not installed
# ---------------------------------------------------------------------------
try:
    from ruyipage import FirefoxPage, FirefoxOptions, Settings
    from ruyipage import NoneElement
    DebuggerError = RuntimeError
    RuyiBreakpoint = None
    RUYIPAGE_AVAILABLE = True
except ImportError:
    RUYIPAGE_AVAILABLE = False
    FirefoxPage = None  # type: ignore
    FirefoxOptions = None  # type: ignore
    Settings = None  # type: ignore
    NoneElement = None  # type: ignore
    DebuggerError = RuntimeError  # type: ignore
    RuyiBreakpoint = None  # type: ignore


# ---------------------------------------------------------------------------
# JSON-safe serialization
# ---------------------------------------------------------------------------
def _serialize(obj: Any, depth: int = 0) -> Any:
    """Convert Python objects to JSON-safe types, recursively."""
    if depth > 10:
        return "<max depth exceeded>"
    if obj is None:
        return None
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        if math.isnan(obj):
            return "NaN"
        if math.isinf(obj):
            return "Infinity" if obj > 0 else "-Infinity"
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, (list, tuple)):
        return [_serialize(x, depth + 1) for x in obj[:100]]  # cap at 100 items
    if isinstance(obj, dict):
        return {str(k): _serialize(v, depth + 1) for k, v in list(obj.items())[:100]}
    if hasattr(obj, "to_dict") and callable(getattr(obj, "to_dict", None)):
        try:
            return _serialize(obj.to_dict(), depth + 1)
        except Exception:
            pass
    # For ruyipage objects (elements, tabs, etc.), try common attributes
    if hasattr(obj, 'text') and callable(getattr(obj, 'text', None)):
        try:
            return {"text": str(getattr(obj, 'text', '')), "html": str(getattr(obj, 'html', ''))}
        except Exception:
            pass
    if hasattr(obj, 'id'):
        try:
            return {"id": str(obj.id)}
        except Exception:
            pass
    return str(obj)[:1000]


def _allocate_loopback_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


_MISSING = object()


def _normalize_debugger_port(value: Any) -> Optional[int]:
    """Validate an RDP port before it reaches Firefox or a socket client."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("debuggerPort must be an integer between 1 and 65535")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError("debuggerPort must be an integer between 1 and 65535")
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("debuggerPort must be an integer between 1 and 65535") from exc
    if not 1 <= port <= 65535:
        raise ValueError("debuggerPort must be an integer between 1 and 65535")
    return port


def _normalize_auto_resume_after(value: Any, *, default: Optional[float] = 60) -> Optional[float]:
    """Normalize the watchdog value while preserving an explicit zero/false."""
    if value is _MISSING:
        return default
    if value is None or value is False:
        return None
    if isinstance(value, bool):
        raise ValueError("autoResumeAfter must be a finite number >= 0")
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("autoResumeAfter must be a finite number >= 0") from exc
    if not math.isfinite(seconds) or seconds < 0 or seconds > 3600:
        raise ValueError("autoResumeAfter must be a finite number between 0 and 3600")
    return None if seconds == 0 else seconds


def _debugger_value(value: Any, depth: int = 0) -> Any:
    """JSON-safe debugger values. RemoteObject keeps actor for expand()."""
    if depth > 4:
        return "<max depth exceeded>"
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    class_name = type(value).__name__
    if class_name == "RemoteObject":
        return {
            "type": "remoteObject",
            "className": getattr(value, "class_name", "Object"),
            "actor": getattr(value, "actor", None),
            "truncated": bool(getattr(value, "truncated", False)),
            "preview": _debugger_value(getattr(value, "value", None), depth + 1),
        }
    if isinstance(value, dict):
        return {
            str(key): _debugger_value(item, depth + 1)
            for key, item in list(value.items())[:80]
        }
    if isinstance(value, (list, tuple)):
        return [_debugger_value(item, depth + 1) for item in value[:80]]
    return str(value)[:1000]


_DEBUG_SECRET_KEY_RE = re.compile(
    r"(?:token|cookie|secret|password|passwd|authorization|credential|session|api[-_]?key|jwt)",
    re.IGNORECASE,
)


def _redact_debug_value(value: Any, *, key: str = "", depth: int = 0) -> Any:
    """Create a bounded, redacted copy suitable for debugger evidence."""
    if depth > 6:
        return "<max depth exceeded>"
    if key and _DEBUG_SECRET_KEY_RE.search(key):
        return "<redacted>"
    if type(value).__name__ == "RemoteObject":
        return {
            "type": "remoteObject",
            "className": getattr(value, "class_name", "Object"),
            "actor": getattr(value, "actor", None),
            "truncated": bool(getattr(value, "truncated", False)),
            "preview": _redact_debug_value(
                getattr(value, "value", None), depth=depth + 1
            ),
        }
    if isinstance(value, str):
        if key.lower() in {"source", "sourcetext", "body", "requestbody", "responsebody"}:
            return {"sha256": _sha256_text(value), "length": len(value)}
        # URLs are reduced to origin/path and query keys; arbitrary source
        # strings are hashed rather than copied into shared evidence.
        if re.match(r"^[a-z][a-z0-9+.-]*://", value, re.IGNORECASE):
            return _safe_url(value)
        value = re.sub(
            r"(?i)(bearer\s+|basic\s+)[^\s,;]+",
            r"\1<redacted>",
            value,
        )
        if len(value) > 512:
            return {"sha256": _sha256_text(value), "length": len(value)}
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    if isinstance(value, dict):
        return {
            str(k): _redact_debug_value(v, key=str(k), depth=depth + 1)
            for k, v in list(value.items())[:100]
        }
    if isinstance(value, (list, tuple)):
        return [_redact_debug_value(v, depth=depth + 1) for v in value[:100]]
    return _debugger_value(value, depth)


def _paused_to_dict(state: Any) -> dict[str, Any]:
    frame = getattr(state, "frame", None)
    return {
        "why": getattr(state, "why", ""),
        "message": getattr(state, "message", None),
        "url": getattr(state, "url", "") or "",
        "line": getattr(state, "line", None),
        "column": getattr(frame, "column", None) if frame is not None else None,
        "displayName": getattr(frame, "display_name", None) if frame is not None else None,
        "frameActor": getattr(frame, "actor", None) if frame is not None else None,
        "isException": bool(getattr(state, "is_exception", False)),
        "conditionFailed": bool(getattr(state, "condition_failed", False)),
        "exception": _debugger_value(getattr(state, "exception", None)),
        "pauseActor": getattr(state, "pause_actor", None),
    }


def _frame_to_dict(frame: Any) -> dict[str, Any]:
    return {
        "actor": getattr(frame, "actor", ""),
        "displayName": getattr(frame, "display_name", ""),
        "type": getattr(frame, "type", ""),
        "url": getattr(frame, "url", "") or "",
        "line": getattr(frame, "line", None),
        "column": getattr(frame, "column", None),
        "oldest": bool(getattr(frame, "oldest", False)),
    }


def _source_to_dict(source: Any) -> dict[str, Any]:
    actor = getattr(source, "actor", "")
    return {
        "url": getattr(source, "url", "") or "",
        "actor": actor,
        "sourceActor": actor,
        "introductionType": getattr(source, "introduction_type", None),
        "blackBoxed": bool(getattr(source, "is_black_boxed", False)),
    }


_RESULT_MODES = frozenset({"metadata", "schema", "body"})
_CAPTURE_STOP_MODES = frozenset({"discard", "metadata"})
_HANDOFF_STATE_KINDS = frozenset({"cookies", "storage"})
_CASE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")
_HANDOFF_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,95}$")
_GIT_SHA_PATTERN = re.compile(r"^[a-f0-9]{7,40}$")
_COOKIE_NAME_PATTERN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,4096}$")
_COOKIE_DOMAIN_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
PUBLIC_BASE_SHA = "788d7af28dd9ec4e91d79470cd30030aac3f8aba"
CONTROL_PLANE_SERVICE = "ruyi-mcp"
_HEADER_ALLOWLIST = frozenset({
    "content-type",
    "content-length",
    "content-encoding",
    "cache-control",
    "etag",
    "last-modified",
})

# Browser calls that may block while the JavaScript thread is paused are
# dispatched on a daemon worker.  The main JSON-RPC reader must remain free to
# accept debugger control commands (resume/step/scope) while such a call is
# waiting for a paused page.
_ASYNC_METHODS = frozenset({
    "page.navigate",
    "page.new",
    "page.reload",
    "script.evaluate",
    "debug.wait_paused",
    "dom.click",
    "dom.input",
    "human.click",
    "human.drag",
    "human.input",
    "human.move",
    "human.scroll",
    "page.snapshot",
    "page.act",
})
_AGENT_DOM_PATH = Path(__file__).resolve().parent / "agent_dom.js"
_AGENT_DOM_JS = _AGENT_DOM_PATH.read_text(encoding="utf-8")
_AGENT_ACT_OPS = frozenset({
    "CLICK",
    "TYPE_TEXT",
    "SELECT",
    "SCROLL_UP",
    "SCROLL_DOWN",
    "WAIT",
    "DONE",
    "BLOCKED",
    "DRAG",
})
_AGENT_INDEX_OPS = frozenset({"CLICK", "TYPE_TEXT", "SELECT", "DRAG"})
_AGENT_SNAPSHOT_LIMIT = 250
class FrameTargetError(ValueError):
    """A requested frame is absent from the selected page's current tree."""


def _normalize_result_mode(value: Any, *, default: str = "metadata") -> str:
    mode = default if value is None else str(value).strip().lower()
    if mode not in _RESULT_MODES:
        raise ValueError(
            "resultMode must be one of metadata, schema, or body"
        )
    return mode


def _normalize_capture_stop_mode(value: Any) -> str:
    mode = "discard" if value is None else str(value).strip().lower()
    if mode not in _CAPTURE_STOP_MODES:
        raise ValueError("mode must be one of discard or metadata")
    return mode


def _sha256_text(value: Any) -> str:
    if isinstance(value, bytes):
        raw = value
    elif isinstance(value, str):
        raw = value.encode("utf-8", errors="replace")
    else:
        raw = str(value).encode("utf-8", errors="replace")
    return hashlib.sha256(raw).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_git_head(repo_root: Path) -> str:
    """Resolve HEAD without spawning git; release installs may override it."""
    configured = os.environ.get("RUYI_MCP_LOCAL_HEAD", "").strip().lower()
    if configured:
        if not _GIT_SHA_PATTERN.fullmatch(configured):
            raise ValueError("RUYI_MCP_LOCAL_HEAD must be a 7-40 character lowercase Git SHA")
        return configured

    dot_git = repo_root / ".git"
    git_dir = dot_git
    if dot_git.is_file():
        marker = dot_git.read_text(encoding="utf-8").strip()
        if not marker.lower().startswith("gitdir:"):
            raise RuntimeError(f"Unsupported .git file: {dot_git}")
        git_dir = Path(marker.split(":", 1)[1].strip())
        if not git_dir.is_absolute():
            git_dir = (repo_root / git_dir).resolve()

    head_path = git_dir / "HEAD"
    if not head_path.is_file():
        raise RuntimeError(
            "Cannot resolve localHeadSha; set RUYI_MCP_LOCAL_HEAD for packaged installs"
        )
    head = head_path.read_text(encoding="utf-8").strip()
    if head.startswith("ref:"):
        ref_name = head.split(":", 1)[1].strip()
        common_dir = git_dir
        common_marker = git_dir / "commondir"
        if common_marker.is_file():
            common_dir = Path(
                common_marker.read_text(encoding="utf-8").strip()
            )
            if not common_dir.is_absolute():
                common_dir = (git_dir / common_dir).resolve()
        head = ""
        for ref_root in (git_dir, common_dir):
            ref_path = ref_root / Path(ref_name)
            if ref_path.is_file():
                head = ref_path.read_text(encoding="utf-8").strip()
                break
        if not head:
            packed_refs = common_dir / "packed-refs"
            if packed_refs.is_file():
                for line in packed_refs.read_text(encoding="utf-8").splitlines():
                    if not line or line.startswith(("#", "^")):
                        continue
                    sha, _, candidate_ref = line.partition(" ")
                    if candidate_ref == ref_name:
                        head = sha
                        break
    head = head.lower()
    if not _GIT_SHA_PATTERN.fullmatch(head):
        raise RuntimeError("Cannot resolve a valid localHeadSha from repository metadata")
    return head


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _safe_proxy(value: Any) -> dict:
    raw = str(value or "").strip()
    if not raw:
        return {"mode": "direct", "credentials": "none"}
    if raw.lower() == "system":
        return {"mode": "system", "credentials": "external-ref"}

    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme in {"socks5h", "socks"}:
        scheme = "socks5"
    if scheme not in {"http", "https", "socks5"} or not parsed.hostname:
        raise ValueError("proxy must use http, https, or socks5 with an explicit host")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("proxy has an invalid port") from exc
    endpoint = parsed.hostname
    if port is not None:
        endpoint = f"{endpoint}:{port}"
    return {
        "mode": scheme,
        "endpoint": endpoint[:512],
        "credentials": "omitted" if parsed.username or parsed.password else "none",
    }


def _write_json_atomic(path: Path, payload: Any) -> tuple[int, str]:
    raw = (
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        ) + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    except Exception:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return len(raw), hashlib.sha256(raw).hexdigest()


def _safe_url(value: Any) -> dict:
    """Return route metadata without query values or user-info credentials."""
    raw = str(value or "")
    try:
        parsed = urlsplit(raw)
        scheme = parsed.scheme.lower()
        if parsed.hostname and scheme in {"http", "https", "ws", "wss"}:
            host = parsed.hostname
            try:
                if parsed.port is not None:
                    host = f"{host}:{parsed.port}"
            except ValueError:
                pass
            prefix = f"{parsed.scheme}://{host}" if parsed.scheme else host
            safe = f"{prefix}{parsed.path or '/'}"
        elif scheme == "about":
            safe = f"about:{parsed.path.split('?', 1)[0]}"
        elif scheme:
            # data:, blob:, file:, and custom URLs can carry arbitrary page
            # source, filesystem paths, or opaque capability values in path.
            safe = f"{scheme}:"
        else:
            safe = parsed.path or raw.split("?", 1)[0]
        query_keys = sorted({key for key, _ in parse_qsl(parsed.query, keep_blank_values=True)})
    except Exception:
        safe = raw.split("?", 1)[0]
        query_keys = []
    return {
        "url": safe[:2048],
        "queryKeys": query_keys[:50],
    }


def _declared_write_root() -> Optional[Path]:
    """Return the caller-declared evidence/workspace root, if configured.

    Fail closed: a configured-but-invalid root raises instead of silently
    falling back to unanchored writes.
    """
    configured = os.environ.get("RUYI_MCP_WORKSPACE_ROOT", "").strip()
    if not configured:
        return None
    root = Path(configured).expanduser()
    raw = str(root)
    if (
        not root.is_absolute()
        or raw.startswith(("\\\\", "//"))
        or ".." in raw.replace("\\", "/").split("/")
    ):
        raise ValueError(
            "RUYI_MCP_WORKSPACE_ROOT must be an absolute, non-UNC path without '..' segments"
        )
    return root.resolve()


def _contained_output_path(value: Any, label: str = "outputFile", *, kind: str = "file") -> str:
    """Validate a caller-supplied output path with shared containment rules.

    Floor rules (always enforced):
      1. absolute path only (relative paths rejected)
      2. no '..' traversal segments
      3. no UNC paths (\\\\host\\share or //host/share)
      4. no root-level writes ('file' kind also rejects files whose parent is
         a filesystem root; 'directory' kind rejects roots themselves)

    Anchor rule (when RUYI_MCP_WORKSPACE_ROOT is set): the resolved path must
    stay within the declared workspace root.
    """
    if kind not in {"file", "directory"}:
        raise ValueError("kind must be 'file' or 'directory'")
    raw = str(value or "").strip()
    if not raw:
        raise ValueError(f"{label} is required")
    expanded = os.path.expanduser(raw).strip()
    if not os.path.isabs(expanded):
        raise ValueError(f"{label} must be an absolute path")
    if expanded.startswith(("\\\\", "//")):
        raise ValueError(f"{label} must not be a UNC path")
    if ".." in expanded.replace("\\", "/").split("/"):
        raise ValueError(f"{label} must not contain '..' path segments")

    path_obj = Path(expanded)
    remainder = str(path_obj)[len(path_obj.anchor):]
    if not remainder:
        raise ValueError(f"{label} must not target a filesystem root")
    if kind == "file" and "/" not in remainder and "\\" not in remainder:
        raise ValueError(f"{label} must not write a file directly at a filesystem root")

    resolved = path_obj.resolve()
    anchor = _declared_write_root()
    if anchor is not None and not _path_is_within(resolved, anchor):
        raise ValueError(f"{label} must stay within the declared workspace root: {anchor}")
    return str(resolved)


def _is_valid_cookie_domain(value: Any) -> bool:
    """Accept an ASCII DNS host or IP literal, with an optional DNS leading dot."""
    if not isinstance(value, str) or not value or value != value.strip():
        return False
    leading_dot = value.startswith(".")
    candidate = value[1:] if leading_dot else value
    if (
        not candidate
        or candidate.startswith(".")
        or candidate.endswith(".")
        or len(candidate) > 253
        or not candidate.isascii()
    ):
        return False

    try:
        ipaddress.ip_address(candidate)
        return not leading_dot
    except ValueError:
        pass

    # Do not reinterpret a malformed dotted-quad as a DNS name.
    if re.fullmatch(r"[0-9.]+", candidate):
        return False
    return all(
        _COOKIE_DOMAIN_LABEL_PATTERN.fullmatch(label) is not None
        for label in candidate.split(".")
    )


def _cookie_host_from_page_url(value: Any) -> str:
    """Derive a host-only cookie domain from an unambiguous HTTP(S) page URL."""
    try:
        parsed = urlsplit(str(value or ""))
        hostname = parsed.hostname
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            "Domainless cookie export requires a valid HTTP(S) page URL"
        ) from exc
    if parsed.scheme.lower() not in {"http", "https"} or not hostname:
        raise RuntimeError(
            "Domainless cookie export requires a valid HTTP(S) page URL"
        )
    if not _is_valid_cookie_domain(hostname) or hostname.startswith("."):
        raise RuntimeError(
            "Domainless cookie export could not derive a valid host-only domain"
        )
    return hostname


def _safe_headers(headers: Any) -> dict[str, str]:
    """Expose only an explicit metadata allowlist of HTTP headers."""
    if isinstance(headers, dict):
        items = headers.items()
    elif isinstance(headers, (list, tuple)):
        items = []
        for item in headers:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            value = item.get("value", "")
            if isinstance(value, dict):
                value = value.get("value", "")
            items.append((name, value))
    else:
        return {}

    result: dict[str, str] = {}
    for raw_name, raw_value in items:
        name = str(raw_name or "").lower()
        if name in _HEADER_ALLOWLIST:
            if isinstance(raw_value, dict):
                raw_value = raw_value.get("value", "")
            result[name] = str(raw_value)[:512]
    return result


def _body_schema(value: Any, content_type: str | None = None) -> dict:
    """Describe a body without returning body values to the MCP client."""
    if value is None:
        return {"state": "unavailable", "reason": "unknown"}

    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
        raw = value
    else:
        text = value if isinstance(value, str) else str(value)
        raw = text.encode("utf-8", errors="replace")

    result: dict[str, Any] = {
        "state": "available",
        "length": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    normalized_content_type = str(content_type or "").lower()
    stripped = text.lstrip()
    if "json" in normalized_content_type or stripped.startswith(("{", "[")):
        try:
            decoded = json.loads(text)
            if isinstance(decoded, dict):
                result["format"] = "json-object"
                result["topLevelKeys"] = sorted(str(key) for key in decoded.keys())[:100]
            elif isinstance(decoded, list):
                result["format"] = "json-array"
                result["itemCount"] = len(decoded)
            else:
                result["format"] = "json-scalar"
            return result
        except (TypeError, ValueError):
            result["format"] = "json-invalid"
            return result

    if "application/x-www-form-urlencoded" in normalized_content_type:
        result["format"] = "form"
        try:
            result["topLevelKeys"] = sorted({key for key, _ in parse_qsl(text, keep_blank_values=True)})[:100]
        except Exception:
            result["format"] = "form-invalid"
        return result

    result["format"] = "text" if isinstance(value, str) else "binary-or-unknown"
    return result


# ---------------------------------------------------------------------------
# Default paths
# ---------------------------------------------------------------------------
def _discover_firefox_path() -> str:
    """Resolve Firefox without embedding a developer-specific absolute path."""
    configured = os.environ.get("RUYI_FIREFOX_PATH", "").strip()
    if configured:
        return configured

    candidates: list[Path] = []
    if os.name == "nt":
        browser_root = Path.home() / "AppData" / "Local" / "ruyipage" / "browsers"
        if browser_root.is_dir():
            candidates.extend(sorted(browser_root.glob("firefox-*/firefox/firefox.exe"), reverse=True))

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    return shutil.which("firefox") or shutil.which("firefox.exe") or ""


DEFAULT_FIREFOX_PATH = _discover_firefox_path()
DEFAULT_PROFILE_ROOT = Path(__file__).resolve().parents[1] / "browser-profiles"
_WINDOWS_SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"


def _pid_is_alive(pid: int) -> bool:
    """Return whether *pid* still exists. Never raises into callers."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        tasklist = _WINDOWS_SYSTEM32 / "tasklist.exe"
        try:
            completed = subprocess.run(
                [str(tasklist), "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        stdout = (completed.stdout or "").strip()
        if not stdout or stdout.upper().startswith("INFO:"):
            return False
        return str(pid) in stdout
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _kill_process_tree(pid: int) -> None:
    """Best-effort kill of *pid* and its children. Owned Firefox only."""
    if not isinstance(pid, int) or pid <= 0:
        return
    if os.name == "nt":
        taskkill = _WINDOWS_SYSTEM32 / "taskkill.exe"
        try:
            subprocess.run(
                [str(taskkill), "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return


def _firefox_pids_using_profile(profile: Path) -> list[int]:
    """Find leftover firefox/plugin-container processes bound to *profile*."""
    if os.name != "nt":
        return []
    powershell = _WINDOWS_SYSTEM32 / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not powershell.is_file():
        return []
    needle = str(profile.resolve()).lower()
    script = (
        "$rows = Get-CimInstance Win32_Process -Filter "
        "\"Name='firefox.exe' or Name='plugin-container.exe'\"; "
        "foreach ($row in $rows) { if ($row.CommandLine) { "
        "Write-Output (($row.ProcessId.ToString()) + [char]9 + $row.CommandLine) } }"
    )
    try:
        completed = subprocess.run(
            [str(powershell), "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    pids: list[int] = []
    for line in (completed.stdout or "").splitlines():
        if "\t" not in line:
            continue
        pid_text, command = line.split("\t", 1)
        if needle not in command.lower():
            continue
        try:
            pid = int(pid_text.strip())
        except ValueError:
            continue
        if pid > 0:
            pids.append(pid)
    return pids


def _reap_owned_firefox(pid: Optional[int], profile: Optional[Path]) -> Optional[dict[str, Any]]:
    """Kill leftover owned Firefox after quit. Never used for attach sessions."""
    targets: list[int] = []
    if isinstance(pid, int) and pid > 0:
        targets.append(pid)
    if profile is not None:
        for extra in _firefox_pids_using_profile(profile):
            if extra not in targets:
                targets.append(extra)
    if not targets:
        return None
    killed: list[int] = []
    already_exited: list[int] = []
    still_alive: list[int] = []
    for target in targets:
        if not _pid_is_alive(target):
            already_exited.append(target)
            continue
        _kill_process_tree(target)
        if _pid_is_alive(target):
            still_alive.append(target)
        else:
            killed.append(target)
    return {
        "attempted": True,
        "pids": targets,
        "killed": killed,
        "alreadyExited": already_exited,
        "stillAlive": still_alive,
    }


def _coerce_fingerprint_kwargs(fp: Any, profile_path: Optional[Path]) -> dict[str, Any]:
    """Map MCP fingerprint object onto ruyiPage smart_fingerprint kwargs."""
    if not isinstance(fp, dict) or not fp:
        return {}
    kwargs: dict[str, Any] = {}
    str_keys = {
        "proxyHost": "proxy_host",
        "proxyUser": "proxy_user",
        "proxyPwd": "proxy_pwd",
        "requireCountry": "require_country",
        "webrtcLocalIpv4": "webrtc_local_ipv4",
        "webrtcLocalIpv6": "webrtc_local_ipv6",
        "webrtcPublicIpv4": "webrtc_public_ipv4",
        "webrtcPublicIpv6": "webrtc_public_ipv6",
        "geolocationPermission": "geolocation_permission",
    }
    int_keys = {
        "proxyPort": "proxy_port",
        "firefoxVersion": "firefox_version",
    }
    float_keys = {
        "geolocationLatitude": "geolocation_latitude",
        "geolocationLongitude": "geolocation_longitude",
        "geolocationAccuracy": "geolocation_accuracy",
        "geolocationAltitude": "geolocation_altitude",
        "geolocationAltitudeAccuracy": "geolocation_altitude_accuracy",
        "geolocationHeading": "geolocation_heading",
        "geolocationSpeed": "geolocation_speed",
    }
    for src, dest in str_keys.items():
        value = fp.get(src)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            kwargs[dest] = text
    for src, dest in int_keys.items():
        value = fp.get(src)
        if value is None or value == "":
            continue
        kwargs[dest] = int(value)
    for src, dest in float_keys.items():
        value = fp.get(src)
        if value is None or value == "":
            continue
        kwargs[dest] = float(value)
    if "geolocationEnabled" in fp and fp["geolocationEnabled"] is not None:
        kwargs["geolocation_enabled"] = bool(fp["geolocationEnabled"])
    timestamp = fp.get("geolocationTimestamp")
    if timestamp is not None and timestamp != "":
        kwargs["geolocation_timestamp"] = timestamp
    if fp.get("manualGeo") is not None:
        kwargs["manual_geo"] = fp["manualGeo"]
    if profile_path is not None:
        kwargs["userdir"] = str(profile_path)
    return kwargs



def _managed_profile_root() -> Path:
    """Return the absolute parent directory for bridge-owned Firefox profiles."""
    configured = os.environ.get("RUYI_MCP_PROFILE_ROOT", "").strip()
    root = Path(configured).expanduser() if configured else DEFAULT_PROFILE_ROOT
    if not root.is_absolute():
        raise ValueError("RUYI_MCP_PROFILE_ROOT must be an absolute path")
    return root.resolve()


def _explicit_profile_path(value: Any) -> Optional[Path]:
    """Canonicalize a caller-owned profile path without creating it."""
    if value is None or not str(value).strip():
        return None
    profile = Path(str(value).strip()).expanduser()
    if not profile.is_absolute():
        raise ValueError("profilePath must be an absolute path")
    return profile.resolve()


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# RuyiBridge
# ---------------------------------------------------------------------------
class RuyiBridge:
    """JSON-RPC bridge wrapping the ruyipage browser control plane."""

    def __init__(self):
        self.page: Optional[FirefoxPage] = None
        self.opts: Optional[FirefoxOptions] = None
        self._attached_existing = False
        self.pages: dict[int, Any] = {}          # pageIdx → FirefoxPage/Tab
        self._next_page_idx: int = 0
        self._breakpoints: list[dict] = []        # soft breakpoint registry
        self._preload_scripts: dict[str, str] = {}  # scriptId → script text
        self._fingerprint_ctx: Any = None
        self._capture_stats: dict[int, dict[str, Any]] = {}
        self._intercept_modes: dict[int, str] = {}
        self._profile_path: Optional[Path] = None
        self._managed_profile: Optional[Path] = None
        self._managed_profile_root: Optional[Path] = None
        self._browser_path: Optional[Path] = None
        self._proxy_url: Optional[str] = None
        self._headless: bool = False
        self._private_mode: bool = False
        self._connection_address: Optional[str] = None
        self._connection_port: Optional[int] = None
        self._owned_firefox_pid: Optional[int] = None
        self._debugger_enabled: bool = False
        # Whether Firefox was launched/configured with an RDP server.  This is
        # distinct from _debugger_enabled, which represents the current MCP
        # client connection and can be toggled by debug.disable.
        self._debugger_server_enabled: bool = False
        self._debugger_port: Optional[int] = None
        self._debugger_auto_resume_after: Optional[float] = 60
        self._native_breakpoints: list[dict[str, Any]] = []
        self._next_breakpoint_id: int = 1
        self._debugger_lock = threading.RLock()
        self._rpc_write_lock = threading.Lock()
        self._worker_lock = threading.Lock()
        self._workers: set[threading.Thread] = set()
        self._shutdown_requested = False
        self._debug_evidence_root: Optional[Path] = None
        self._debug_evidence_case_id: Optional[str] = None
        self._debug_evidence_run_id: Optional[str] = None
        self._debug_evidence_path: Optional[Path] = None
        self._debug_evidence_lock = threading.Lock()
        self._debug_evidence_count = 0
        self._agent_snapshots: dict[str, dict[str, Any]] = {}
        self._bidi_trace_active = False
        self._bidi_trace_launch = False
        self._bidi_trace_output: Optional[str] = None

        self._handlers = {
            # Browser lifecycle
            "browser.launch":        self._launch,
            "browser.quit":          self._quit,
            "browser.status":        self._status,
            "download.set_behavior": self._set_download_behavior,
            # Page management
            "page.navigate":         self._navigate,
            "page.new":              self._new_tab,
            "page.close":            self._close_tab,
            "page.select":           self._select_tab,
            "page.list":             self._list_tabs,
            "page.reload":           self._reload,
            "page.screenshot":       self._screenshot,
            "page.clear_data":       self._clear_data,
            "page.snapshot":         self._page_snapshot,
            "page.act":              self._page_act,
            # Script execution
            "script.evaluate":       self._evaluate,
            "script.add_preload":    self._add_preload,
            "script.remove_preload": self._remove_preload,
            "script.list_preloads":  self._list_preloads,
            # Network
            "network.requests":      self._list_requests,
            "network.capture_start": self._capture_start,
            "network.capture_stop":  self._capture_stop,
            "network.capture_wait":  self._capture_wait,
            # Cookies
            "cookie.get":            self._get_cookies,
            "cookie.set":            self._set_cookies,
            "cookie.delete":         self._delete_cookies,
            # Anti-detection / fingerprint
            "fingerprint.set":       self._set_fingerprint,
            "proxy.set":             self._set_proxy,
            "emulation.geo":         self._set_geolocation,
            "emulation.timezone":    self._set_timezone,
            "emulation.locale":      self._set_locale,
            "emulation.useragent":   self._set_useragent,
            # Cloudflare
            "cf.handle":             self._handle_cf,
            # Console
            "console.get":           self._get_console,
            # DOM interaction
            "dom.select":            self._dom_select,
            "dom.info":              self._dom_get_info,
            "dom.input":             self._dom_input,
            "dom.click":             self._dom_click,
            # Human simulation
            "human.move":            self._human_move,
            "human.click":           self._human_click,
            "human.drag":            self._human_drag,
            "human.scroll":          self._human_scroll,
            "human.input":           self._human_input,
            # Session export
            "session.export":        self._export_session,
            "bidi_trace.start": self._bidi_trace_start,
            "bidi_trace.stop": self._bidi_trace_stop,
            "bidi_trace.results": self._bidi_trace_results,
            # Frame
            "frame.list":            self._frame_list,
            "frame.select":          self._frame_select,
            # Intercept
            "intercept.start_req":   self._intercept_start_req,
            "intercept.start_resp":  self._intercept_start_resp,
            "intercept.wait":        self._intercept_wait,
            "intercept.stop":        self._intercept_stop,
            # WebSocket
            "ws.inject":             self._ws_inject,
            "ws.collect":            self._ws_collect,
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _prepare_profile(
        self, params: dict, existing_only: bool
    ) -> tuple[Optional[Path], str]:
        """Choose a caller-owned or bridge-owned profile for one launch."""
        profile = _explicit_profile_path(params.get("profilePath"))
        if profile is not None:
            self._profile_path = profile
            return profile, "external"

        # Attach-only never starts Firefox and must not create data on disk.
        if existing_only:
            self._profile_path = None
            return None, "attached"

        root = _managed_profile_root()
        root.mkdir(parents=True, exist_ok=True)
        profile = Path(tempfile.mkdtemp(prefix="session-", dir=str(root))).resolve()
        if profile.parent != root or not _path_is_within(profile, root):
            raise RuntimeError("managed Firefox profile escaped RUYI_MCP_PROFILE_ROOT")

        self._profile_path = profile
        self._managed_profile = profile
        self._managed_profile_root = root
        return profile, "managed"

    def _cleanup_managed_profile(self) -> Optional[dict]:
        """Delete only the profile directory allocated by this bridge instance."""
        profile = self._managed_profile
        root = self._managed_profile_root
        self._managed_profile = None
        self._managed_profile_root = None
        if profile is None:
            return None

        result: dict[str, Any] = {"attempted": True, "removed": False}
        if (
            root is None
            or profile == root
            or profile.parent != root
            or not _path_is_within(profile, root)
        ):
            result["error"] = "managed profile path validation failed"
            return result

        last_error = ""
        for attempt in range(5):
            try:
                if not profile.exists():
                    result["removed"] = True
                    return result
                shutil.rmtree(profile)
                result["removed"] = not profile.exists()
                if result["removed"]:
                    return result
            except OSError as exc:
                last_error = str(exc)
                if attempt < 4:
                    time.sleep(0.15)

        if last_error:
            result["error"] = last_error[:300]
        return result

    @staticmethod
    def _normalize_page_idx(page_idx: Any = 0) -> int:
        idx = page_idx if page_idx is not None else 0
        if isinstance(idx, bool):
            raise ValueError("pageIdx must be an integer")
        try:
            return int(idx)
        except (TypeError, ValueError) as exc:
            raise ValueError("pageIdx must be an integer") from exc

    def _get_page(self, page_idx: Any = 0) -> Any:
        idx = self._normalize_page_idx(page_idx)
        if idx not in self.pages:
            raise ValueError(f"Invalid pageIdx: {idx}. Available: {list(self.pages.keys())}")
        return self.pages[idx]

    @staticmethod
    def _attribute(obj: Any, name: str, default: Any = None) -> Any:
        try:
            return getattr(obj, name, default)
        except Exception:
            return default

    @staticmethod
    def _parse_connection(value: str) -> tuple[str, int]:
        raw = str(value or "").strip()
        if not raw:
            raise ValueError("Firefox BiDi address is unavailable")
        if "://" in raw:
            parsed = urlsplit(raw)
            host = parsed.hostname
            port = parsed.port
        elif raw.startswith("["):
            closing = raw.find("]")
            if closing < 0 or closing + 2 > len(raw) or raw[closing + 1] != ":":
                raise ValueError("Firefox BiDi address has an invalid IPv6 form")
            host = raw[1:closing]
            port = int(raw[closing + 2 :])
        else:
            host, separator, raw_port = raw.rpartition(":")
            if not separator:
                raise ValueError("Firefox BiDi address must include a port")
            port = int(raw_port)
        normalized_host = str(host or "").lower()
        if normalized_host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Firefox BiDi handoff only permits a loopback address")
        if port is None or not 1 <= int(port) <= 65535:
            raise ValueError("Firefox BiDi port must be between 1 and 65535")
        return normalized_host, int(port)

    def _current_connection(self, page: Any) -> tuple[str, int]:
        browser = self._attribute(page, "_firefox", None) or self._attribute(
            page, "_browser", None
        )
        address = self._attribute(browser, "address", None) or self._attribute(
            browser, "_address", None
        )
        if address:
            return self._parse_connection(str(address))
        if self._connection_address and self._connection_port:
            return self._connection_address, self._connection_port
        raise RuntimeError("Active Firefox does not expose a verifiable BiDi endpoint")

    def _browser_identity(self, params: dict) -> dict:
        configured = params.get("browserPath")
        if configured is not None and str(configured).strip():
            binary = Path(str(configured).strip()).expanduser()
            if not binary.is_absolute():
                raise ValueError("browserPath must be an absolute path")
            binary = binary.resolve()
        else:
            binary = self._browser_path
        if binary is None or not binary.is_file():
            raise RuntimeError(
                "Firefox binary is unavailable; pass browserPath to ruyi_export_session"
            )

        application_ini = binary.parent / "application.ini"
        if not application_ini.is_file():
            raise RuntimeError(f"Firefox application.ini not found beside {binary}")
        section = ""
        app_values: dict[str, str] = {}
        for raw_line in application_ini.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            line = raw_line.strip()
            if not line or line.startswith(("#", ";")):
                continue
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1].strip().lower()
                continue
            if section == "app" and "=" in line:
                key, value = line.split("=", 1)
                app_values[key.strip().lower()] = value.strip()

        version = app_values.get("version", "")
        build_id = app_values.get("buildid", "")
        if not version or not build_id:
            raise RuntimeError("Firefox application.ini lacks App.Version or App.BuildID")
        return {
            "name": "Firefox",
            "version": version[:80],
            "buildId": build_id[:80],
            "binarySha256": _sha256_file(binary),
        }

    @staticmethod
    def _artifact_pointer(
        *,
        case_id: str,
        handoff_id: str,
        artifact_id: str,
        relative_path: str,
        byte_count: int,
        sha256: str,
        record_count: int,
    ) -> dict:
        return {
            "schema": "evidence-pointer.v1",
            "caseId": case_id,
            "plane": "ruyi-control",
            "runId": handoff_id,
            "artifactId": artifact_id,
            "path": relative_path,
            "sha256": sha256,
            "bytes": byte_count,
            "mediaType": "application/json",
            "recordCount": record_count,
            "sensitivity": "private-raw",
            "redaction": "not-applicable",
        }

    def _cookie_state(
        self,
        page_idx: int,
        page_url: str,
        case_id: str,
        handoff_id: str,
        exported_at: str,
    ) -> tuple[dict, int]:
        result = self._get_cookies({"pageIdx": page_idx})
        if result.get("error"):
            raise RuntimeError(f"Cookie export failed: {result['error']}")
        cookies: list[dict[str, Any]] = []
        inferred_domain: str | None = None
        for index, item in enumerate(result.get("cookies", [])):
            if not isinstance(item, dict):
                raise RuntimeError("Cookie export returned a non-object item")
            raw_name = item.get("name")
            if (
                not isinstance(raw_name, str)
                or _COOKIE_NAME_PATTERN.fullmatch(raw_name) is None
            ):
                raise RuntimeError(
                    f"Cookie export item {index} has an invalid name"
                )

            raw_domain = item.get("domain")
            if raw_domain is None or raw_domain == "":
                if inferred_domain is None:
                    inferred_domain = _cookie_host_from_page_url(page_url)
                domain = inferred_domain
            elif not _is_valid_cookie_domain(raw_domain):
                raise RuntimeError(
                    f"Cookie export item {index} has an invalid domain"
                )
            else:
                # Preserve an explicit browser-provided domain byte-for-byte.
                domain = raw_domain

            cookie: dict[str, Any] = {
                "name": raw_name,
                "value": str(item.get("value") or ""),
                "domain": domain,
            }
            if item.get("path") is not None:
                cookie["path"] = str(item["path"])
            if item.get("secure") is not None:
                cookie["secure"] = bool(item["secure"])
            if item.get("httpOnly") is not None:
                cookie["httpOnly"] = bool(item["httpOnly"])
            same_site = str(item.get("sameSite") or "").strip().lower()
            if same_site in {"strict", "lax", "none"}:
                cookie["sameSite"] = same_site
            expiry = item.get("expiry")
            if (
                isinstance(expiry, (int, float))
                and not isinstance(expiry, bool)
                and math.isfinite(expiry)
            ):
                cookie["expiry"] = expiry
            cookies.append(cookie)
        return (
            {
                "schema": "browser-cookie-state.v1",
                "caseId": case_id,
                "handoffId": handoff_id,
                "exportedAt": exported_at,
                "cookies": cookies,
            },
            len(cookies),
        )

    @staticmethod
    def _normalize_storage_items(value: Any) -> dict[str, str]:
        if value is None:
            return {}
        if isinstance(value, dict):
            items = value.items()
        elif isinstance(value, list):
            normalized_items = []
            for item in value:
                if not isinstance(item, dict) or "key" not in item:
                    raise RuntimeError("Storage export returned an invalid item")
                normalized_items.append((item["key"], item.get("value")))
            items = normalized_items
        else:
            raise RuntimeError("Storage export returned an unsupported collection")
        result: dict[str, str] = {}
        for key, item_value in items:
            result[str(key)] = "" if item_value is None else str(item_value)
        return result

    def _storage_state(self, page: Any, case_id: str, handoff_id: str, exported_at: str) -> tuple[dict, int]:
        snapshot = page.run_js(
            """
            (() => {
              const __RUYI_HANDOFF_STORAGE__ = true;
              const collect = (store) => {
                const items = {};
                for (let index = 0; index < store.length; index += 1) {
                  const key = store.key(index);
                  items[key] = store.getItem(key);
                }
                return items;
              };
              return {
                origin: location.origin,
                localStorage: collect(localStorage),
                sessionStorage: collect(sessionStorage)
              };
            })()
            """
        )
        if not isinstance(snapshot, dict):
            raise RuntimeError("Storage export did not return an object")
        origin = str(snapshot.get("origin") or "")
        parsed_origin = urlsplit(origin)
        if parsed_origin.scheme not in {"http", "https"} or not parsed_origin.hostname:
            raise RuntimeError("Storage export requires an HTTP(S) page origin")
        canonical_origin = f"{parsed_origin.scheme}://{parsed_origin.hostname}"
        if parsed_origin.port is not None:
            canonical_origin += f":{parsed_origin.port}"
        local_items = self._normalize_storage_items(snapshot.get("localStorage"))
        session_items = self._normalize_storage_items(snapshot.get("sessionStorage"))
        return (
            {
                "schema": "browser-storage-state.v1",
                "caseId": case_id,
                "handoffId": handoff_id,
                "exportedAt": exported_at,
                "localStorage": [{"origin": canonical_origin, "items": local_items}],
                "sessionStorage": [{"origin": canonical_origin, "items": session_items}],
            },
            len(local_items) + len(session_items),
        )

    def _target_metadata(self, target: Any, page_idx: int, kind: str) -> dict:
        context_id = self._attribute(target, "_context_id", None)
        url = self._attribute(target, "url", "")
        is_cross_origin = False
        if kind == "frame":
            is_cross_origin = self._attribute(target, "is_cross_origin", None)

        result = {
            "kind": kind,
            "pageIdx": page_idx,
            "contextId": str(context_id) if context_id else None,
            "isCrossOrigin": is_cross_origin,
        }
        result.update(_safe_url(url))
        return result

    def _frames_for_page(self, page: Any, context_id: str | None = None) -> list[Any]:
        try:
            frames = list(page.get_all_frames() or [])
        except Exception as exc:
            requested = context_id or "<unknown>"
            raise FrameTargetError(
                f"frame_context_not_found: {requested}"
            ) from exc

        if context_id is None:
            return frames
        return [
            frame for frame in frames
            if str(self._attribute(frame, "_context_id", "")) == context_id
        ]

    def _resolve_target(self, params: dict) -> tuple[Any, dict]:
        """Resolve an explicit frame target without silently falling back."""
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        frame_context_id = params.get("frameContextId")
        if frame_context_id is None or not str(frame_context_id).strip():
            return page, self._target_metadata(page, page_idx, "page")

        requested = str(frame_context_id).strip()
        matches = self._frames_for_page(page, requested)
        if not matches:
            raise FrameTargetError(f"frame_context_not_found: {requested}")
        frame = matches[0]
        return frame, self._target_metadata(frame, page_idx, "frame")

    def _norm_selector(self, selector: str) -> str:
        """Normalize selector for ruyipage's page.ele().

        ruyipage selector prefixes: css:, xpath:, tag:, text:, @name=
        Bare strings (no prefix or leading # . / [) are treated as text search.
        We prefix with 'css:' to force CSS interpretation for common patterns.
        """
        s = selector.strip()
        if not s:
            return s
        # Already has recognized prefix
        if any(s.startswith(p) for p in ('css:', 'xpath:', 'tag:', 'text:', '@')):
            return s
        # XPath
        if s.startswith('//') or s.startswith('./'):
            return s
        # CSS patterns: #id, .class, [attr], tag, tag.class, etc.
        return f"css:{s}"

    def _resolve_action_target(self, page: Any, value: Any, label: str) -> tuple[Any, Any]:
        """Resolve a selector or viewport coordinate for human actions."""
        if isinstance(value, str):
            selector = self._norm_selector(value)
            element = page.ele(selector)
            if element is None or (NoneElement and isinstance(element, NoneElement)):
                raise ValueError(f"{label} element not found: {selector}")
            return element, selector

        if isinstance(value, dict) and "x" in value and "y" in value:
            point = {"x": int(value["x"]), "y": int(value["y"])}
            return point, point

        if isinstance(value, (list, tuple)) and len(value) == 2:
            point = {"x": int(value[0]), "y": int(value[1])}
            return point, point

        raise ValueError(
            f"{label} must be a selector string or a coordinate object with x/y"
        )

    @staticmethod
    def _normalize_human_style(style: Any) -> str:
        value = str(style or "arc").strip().lower()
        if value == "linear":
            value = "line"
        allowed = {"line", "arc", "line_then_arc", "line_overshoot_arc_back"}
        if value not in allowed:
            raise ValueError(f"Unsupported human movement style: {value}")
        return value

    def _ok(self, req_id: Any, result: Any = None) -> dict:
        return {"id": req_id, "result": result}

    def _err(self, req_id: Any, code: int, message: str, exc_info: bool = False) -> dict:
        data = traceback.format_exc() if exc_info else None
        return {"id": req_id, "error": {"code": code, "message": message, "data": data}}

    def _write_rpc_response(self, response: dict) -> None:
        """Write one JSON-RPC response without ever emitting NaN/Infinity."""
        try:
            encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            # A debugger value or an upstream object must never poison the
            # line-oriented protocol.  _serialize also normalizes non-finite
            # floats and caps recursive/container expansion.
            encoded = json.dumps(
                _serialize(response), ensure_ascii=False, allow_nan=False
            )
        with self._rpc_write_lock:
            try:
                sys.stdout.write(encoded + "\n")
                sys.stdout.flush()
            except (BrokenPipeError, OSError, ValueError):
                self._shutdown_requested = True

    def _run_async_request(self, request: dict) -> None:
        """Execute a potentially blocking request and emit its response."""
        try:
            response = self.handle(request)
            if request.get("id") is not None:
                self._write_rpc_response(response)
        except Exception as exc:
            req_id = request.get("id")
            if req_id is not None:
                self._write_rpc_response(
                    self._err(req_id, -32000, str(exc), exc_info=True)
                )
        finally:
            with self._worker_lock:
                self._workers.discard(threading.current_thread())

    def _dispatch_async(self, request: dict) -> None:
        worker = threading.Thread(
            target=self._run_async_request,
            args=(request,),
            name="ruyi-mcp-rpc-worker",
            daemon=True,
        )
        with self._worker_lock:
            self._workers.add(worker)
        worker.start()

    def _join_workers(self, timeout: float = 2.0) -> None:
        deadline = time.monotonic() + max(timeout, 0.0)
        while True:
            with self._worker_lock:
                workers = [worker for worker in self._workers if worker is not threading.current_thread()]
            if not workers:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            for worker in workers:
                worker.join(timeout=min(remaining, 0.25))

    def _configure_debug_evidence(self, params: dict) -> None:
        """Configure optional redacted debugger evidence for this browser run."""
        raw_root = params.get("debugEvidenceRoot")
        if raw_root is None:
            raw_root = os.environ.get("RUYI_MCP_DEBUG_EVIDENCE_ROOT", "").strip()
        if not raw_root:
            self._debug_evidence_root = None
            self._debug_evidence_case_id = None
            self._debug_evidence_run_id = None
            self._debug_evidence_path = None
            self._debug_evidence_count = 0
            return
        root = Path(str(raw_root)).expanduser()
        if not root.is_absolute() or str(root).startswith(("\\\\", "//")):
            raise ValueError("debugEvidenceRoot must be an absolute non-UNC path")
        root = root.resolve()
        if not root.is_dir():
            raise ValueError("debugEvidenceRoot must be an existing project directory")
        repository_root = Path(__file__).resolve().parents[1]
        if _path_is_within(root, repository_root) or _path_is_within(repository_root, root):
            raise ValueError("debugEvidenceRoot must be an external project workspace")
        case_id = str(
            params.get("debugCaseId")
            or os.environ.get("RUYI_MCP_DEBUG_CASE_ID", "")
            or root.name
        ).strip().lower()
        if not _CASE_ID_PATTERN.fullmatch(case_id):
            raise ValueError("debugCaseId must match ^[a-z0-9][a-z0-9._-]{1,79}$")
        run_id = str(params.get("debugRunId") or "").strip().lower()
        if not run_id:
            run_id = (
                f"debug_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_"
                f"{uuid.uuid4().hex[:10]}"
            )
        if not _HANDOFF_ID_PATTERN.fullmatch(run_id):
            raise ValueError("debugRunId must match ^[a-z0-9][a-z0-9_-]{0,95}$")
        evidence_dir = (root / "evidence" / "web" / "ruyi-debug" / run_id).resolve()
        if not _path_is_within(evidence_dir, root):
            raise RuntimeError("debug evidence path escaped project root")
        evidence_path = evidence_dir / "observations.jsonl"
        if evidence_path.exists():
            raise ValueError(
                f"debug evidence runId already exists: {run_id}; choose a new runId"
            )
        self._debug_evidence_root = root
        self._debug_evidence_case_id = case_id
        self._debug_evidence_run_id = run_id
        self._debug_evidence_path = evidence_path
        self._debug_evidence_count = 0

    def _debug_evidence_pointer(self) -> Optional[dict[str, Any]]:
        path = self._debug_evidence_path
        root = self._debug_evidence_root
        case_id = self._debug_evidence_case_id
        run_id = self._debug_evidence_run_id
        if path is None or root is None or not case_id or not run_id or not path.is_file():
            return None
        raw_bytes = path.read_bytes()
        return {
            "schema": "ruyi-debug-pointer.v1",
            "caseId": case_id,
            "plane": "ruyi-debug",
            "runId": run_id,
            "artifactId": "debug-observations",
            "path": path.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(raw_bytes).hexdigest(),
            "bytes": len(raw_bytes),
            "mediaType": "application/jsonl",
            "recordCount": self._debug_evidence_count,
            "sensitivity": "private-redacted",
            "redaction": "allowlist-summary",
        }

    def _record_debug_observation(self, action: str, payload: Any) -> Optional[dict[str, Any]]:
        path = self._debug_evidence_path
        if path is None:
            return None
        record = {
            "schema": "ruyi-debug-observation.v1",
            "recordedAt": _utc_timestamp(),
            "action": str(action)[:80],
            "payload": _redact_debug_value(payload),
        }
        raw = (json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
        with self._debug_evidence_lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("ab") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            self._debug_evidence_count += 1
            return self._debug_evidence_pointer()

    def _with_debug_evidence(self, action: str, result: dict[str, Any]) -> dict[str, Any]:
        pointer = self._record_debug_observation(action, result)
        if pointer is not None:
            return {**result, "evidence": pointer}
        return result

    # ------------------------------------------------------------------
    # Browser lifecycle
    # ------------------------------------------------------------------
    def _launch(self, params: dict) -> dict:
        """Launch Firefox browser with optional anti-detection configuration."""
        if not RUYIPAGE_AVAILABLE:
            raise RuntimeError("ruyipage not installed. Run: pip install ruyipage")

        self._fingerprint_ctx = None
        self._proxy_url = str(params.get("proxy") or "").strip() or None
        self._headless = bool(params.get("headless"))
        self._private_mode = bool(params.get("privateMode"))
        self._connection_address = None
        self._connection_port = None
        self._browser_path = None
        self._debugger_enabled = False
        self._debugger_server_enabled = False
        self._debugger_port = None
        with self._debugger_lock:
            self._native_breakpoints = []
        self._debug_evidence_root = None
        self._debug_evidence_case_id = None
        self._debug_evidence_run_id = None
        self._debug_evidence_path = None
        self._debug_evidence_count = 0
        self._debugger_auto_resume_after = 60
        self._configure_debug_evidence(params)

        existing_only = bool(params.get("existingOnly"))
        opts = FirefoxOptions()
        if not existing_only:
            browser_path = params.get("browserPath") or DEFAULT_FIREFOX_PATH
            if not browser_path:
                raise RuntimeError(
                    "Firefox not found. Set RUYI_FIREFOX_PATH or install a RuyiPage browser "
                    "with: python -m ruyipage install"
                )
            opts.set_browser_path(browser_path)
            self._browser_path = Path(str(browser_path)).expanduser().resolve()

        existing_address = str(params.get("address") or "127.0.0.1")
        existing_port = params.get("port")
        if existing_only:
            if existing_port is None and ":" not in existing_address:
                raise ValueError("port is required when existingOnly=true")
            if existing_port is not None:
                requested_port = int(existing_port)
                address_tail = existing_address.rsplit(":", 1)[-1]
                if address_tail.isdigit():
                    if int(address_tail) != requested_port:
                        raise ValueError("address port and port parameter do not match")
                else:
                    existing_address = f"{existing_address}:{requested_port}"
            opts.set_address(existing_address)
            opts.existing_only(True)
            # An attached browser belongs to the caller, not to this bridge.
            # Disconnecting or restarting MCP must never close that process.
            opts.close_on_exit(False)
        elif "closeOnExit" in params:
            opts.close_on_exit(bool(params.get("closeOnExit")))

        if params.get("headless"):
            opts.headless(True)
        if params.get("privateMode"):
            opts.private_mode(True)
        if params.get("proxy"):
            opts.set_proxy(params["proxy"])
        if not existing_only:
            # Never inherit Windows-admin auto system-access; attach cannot add
            # the flag after Firefox has started.
            opts.allow_system_access(False)
            if not params.get("privateMode"):
                opts.set_argument("about:blank")

        enable_debugger = bool(params.get("enableDebugger"))
        debugger_port = _normalize_debugger_port(params.get("debuggerPort"))
        auto_resume_after = _normalize_auto_resume_after(
            params.get("debuggerAutoResumeAfter", _MISSING)
        )
        if enable_debugger:
            if existing_only and debugger_port is None:
                raise ValueError(
                    "attach with enableDebugger requires debuggerPort "
                    "(the existing Firefox must already be running --start-debugger-server)"
                )
            if debugger_port is None:
                debugger_port = _allocate_loopback_port()
            opts.enable_debugger(True, port=int(debugger_port))
            self._debugger_enabled = False
            self._debugger_server_enabled = True
            self._debugger_port = int(debugger_port)
            self._debugger_auto_resume_after = auto_resume_after
        else:
            self._debugger_enabled = False
            self._debugger_server_enabled = False
            # A port supplied while the server is disabled must not be trusted
            # as evidence that this Firefox owns an RDP endpoint.  Attached
            # sessions can provide their RDP port explicitly to debug.enable.
            self._debugger_port = None
            self._debugger_auto_resume_after = 60

        profile_path, profile_mode = self._prepare_profile(params, existing_only)
        self._bidi_trace_launch = bool(params.get("traceEnabled", False))
        self._bidi_trace_active = self._bidi_trace_launch
        self._bidi_trace_output = None
        Settings.trace_enabled = self._bidi_trace_launch
        opts.enable_trace(self._bidi_trace_launch)
        try:
            if profile_path is not None:
                opts.set_profile(str(profile_path))

            fp = params.get("fingerprint")
            if fp:
                fp_kwargs = _coerce_fingerprint_kwargs(fp, profile_path)
                self._fingerprint_ctx = opts.smart_fingerprint(**fp_kwargs)

            self.opts = opts
            self.page = FirefoxPage(opts)
        except Exception:
            self.opts = None
            self.page = None
            self._fingerprint_ctx = None
            self._cleanup_managed_profile()
            self._profile_path = None
            raise
        self._attached_existing = existing_only
        self._owned_firefox_pid = None
        browser = getattr(self.page, "_firefox", None) or getattr(
            self.page, "_browser", None
        )
        if not existing_only:
            process = getattr(browser, "_process", None)
            pid = getattr(process, "pid", None)
            if isinstance(pid, int) and pid > 0:
                self._owned_firefox_pid = pid
        connection = getattr(browser, "address", None) or getattr(
            browser, "_address", None
        )
        if connection:
            try:
                self._connection_address, self._connection_port = self._parse_connection(
                    str(connection)
                )
            except ValueError:
                # Export will fail closed if the runtime does not expose a
                # canonical loopback BiDi endpoint.
                self._connection_address = None
                self._connection_port = None

        # Apply fingerprint emulation AFTER page creation
        if self._fingerprint_ctx:
            self._fingerprint_ctx.apply_emulation(self.page)

        debugger_started = False

        self.pages = {}
        self._next_page_idx = 0
        self.pages[self._next_page_idx] = self.page
        self._next_page_idx += 1
        self._capture_stats = {}
        self._intercept_modes = {}
        with self._debugger_lock:
            self._native_breakpoints = []
        self._next_breakpoint_id = 1

        # Also index other open tabs
        try:
            for i, tab in enumerate(self.page.get_tabs() or []):
                if i > 0:
                    self.pages[self._next_page_idx] = tab
                    self._next_page_idx += 1
        except Exception:
            pass

        return {
            "pageIdx": 0,
            "url": _safe_url(getattr(self.page, 'url', ''))["url"],
            "title": getattr(self.page, 'title', ''),
            "pageCount": len(self.pages),
            "attached": existing_only,
            "address": existing_address if existing_only else None,
            "profilePath": str(profile_path) if profile_path is not None else None,
            "profileMode": profile_mode,
            "closeOnExit": False if existing_only else bool(params.get("closeOnExit", True)),
            "debuggerEnabled": self._debugger_enabled,
            "debuggerPort": self._debugger_port,
            "debuggerStarted": debugger_started,
        }

    def _quit(self, params: dict) -> dict:
        attached = self._attached_existing
        owned_pid = None if attached else self._owned_firefox_pid
        owned_profile = None if attached else self._managed_profile
        if self.page:
            try:
                if attached:
                    browser = getattr(self.page, "_firefox", None)
                    detach = getattr(browser, "_detach_on_exit", None)
                    if not callable(detach):
                        raise RuntimeError("ruyiPage attach session has no detach-only API")
                    detach()
                    address = getattr(browser, "address", None) or getattr(
                        browser, "_address", None
                    )
                    if address:
                        # ruyiPage caches explicit attach objects by address.
                        # Evict both levels after detach so a later attach in
                        # the same bridge process creates a fresh BiDi driver.
                        page_cache = getattr(type(self.page), "_PAGES", None)
                        if isinstance(page_cache, dict):
                            page_cache.pop(address, None)
                        browser_cache = getattr(type(browser), "_BROWSERS", None)
                        if isinstance(browser_cache, dict):
                            lock = getattr(type(browser), "_lock", None)
                            if lock is None:
                                browser_cache.pop(address, None)
                            else:
                                with lock:
                                    browser_cache.pop(address, None)
                        if hasattr(browser, "_initialized"):
                            browser._initialized = False
                else:
                    self.page.quit()
            except Exception:
                pass
        self.page = None
        self.opts = None
        self.pages = {}
        self._breakpoints = []
        self._preload_scripts = {}
        self._fingerprint_ctx = None
        self._capture_stats = {}
        self._intercept_modes = {}
        self._attached_existing = False
        self._browser_path = None
        self._proxy_url = None
        self._headless = False
        self._private_mode = False
        self._connection_address = None
        self._connection_port = None
        self._owned_firefox_pid = None
        self._debugger_enabled = False
        self._debugger_server_enabled = False
        self._debugger_port = None
        with self._debugger_lock:
            self._native_breakpoints = []
        self._next_breakpoint_id = 1
        self._debug_evidence_root = None
        self._debug_evidence_case_id = None
        self._debug_evidence_run_id = None
        self._debug_evidence_path = None
        self._debug_evidence_count = 0
        process_cleanup = None if attached else _reap_owned_firefox(owned_pid, owned_profile)
        cleanup = self._cleanup_managed_profile()
        self._profile_path = None
        self._bidi_trace_active = False
        self._bidi_trace_launch = False
        self._bidi_trace_output = None
        if Settings is not None:
            Settings.trace_enabled = False
        result: dict[str, Any] = {}
        if cleanup is not None:
            result["profileCleanup"] = cleanup
        if process_cleanup is not None:
            result["processCleanup"] = process_cleanup
        return result

    def _status(self, params: dict) -> dict:
        if not self.page:
            return {"alive": False}
        try:
            page_idx = self._debug_page_idx(params)
            status_page = self._get_page(page_idx)
            return {
                "alive": True,
                "contextId": str(getattr(status_page, "_context_id", "")),
                "browserPid": self._owned_firefox_pid,
                "attached": self._attached_existing,
                "browserPath": str(self._browser_path) if self._browser_path else None,
                "pageCount": len(self.pages),
                "breakpointCount": sum(
                    1 for item in self._public_breakpoints()
                    if item.get("pageIdx") == page_idx
                ),
                "preloadScriptCount": len(self._preload_scripts),
                "debuggerEnabled": self._debugger_enabled,
                "debuggerServerEnabled": self._debugger_server_enabled,
                "debuggerPort": self._debugger_port,
                "debuggerStarted": False,
                "profileMode": (
                    "managed"
                    if self._managed_profile is not None
                    else "external"
                    if self._profile_path is not None
                    else "attached"
                    if self._attached_existing
                    else None
                ),
            }
        except Exception:
            return {"alive": False}

    def _set_download_behavior(self, params: dict) -> dict:
        """Configure Firefox's native BiDi download handling for this session."""
        behavior = str(params.get("behavior") or "").strip().lower()
        if behavior in {"allow", "allowed"}:
            raw_path = params.get("downloadPath")
            if not isinstance(raw_path, str) or not raw_path.strip():
                raise ValueError("downloadPath is required when behavior is allow")
            destination = Path(
                _contained_output_path(raw_path, "downloadPath", kind="directory")
            )
            destination.mkdir(parents=True, exist_ok=True)
            download_behavior = {
                "type": "allowed",
                "destinationFolder": str(destination),
            }
        elif behavior in {"deny", "denied"}:
            destination = None
            download_behavior = {"type": "denied"}
        else:
            raise ValueError("behavior must be allow or deny")

        raw_user_contexts = params.get("userContexts")
        if raw_user_contexts is None:
            user_contexts = []
        elif isinstance(raw_user_contexts, list):
            user_contexts = [str(item).strip() for item in raw_user_contexts]
        else:
            raise ValueError("userContexts must be an array of Firefox container IDs")
        if any(not item for item in user_contexts):
            raise ValueError("userContexts must not contain empty IDs")

        page = self._get_page(params.get("pageIdx", 0))
        driver = self._attribute(
            self._attribute(page, "_driver", None), "_browser_driver", None
        )
        run = self._attribute(driver, "run", None)
        if not callable(run):
            raise RuntimeError("Active ruyiPage target has no BiDi browser driver")

        payload = {"downloadBehavior": download_behavior}
        if user_contexts:
            payload["userContexts"] = user_contexts
        result = run("browser.setDownloadBehavior", payload)
        response = {
            "behavior": download_behavior["type"],
            "userContextCount": len(user_contexts),
        }
        if destination is not None:
            response["downloadPath"] = str(destination)
        if result is not None:
            response["result"] = _serialize(result)
        return response

    # ------------------------------------------------------------------
    # Page management
    # ------------------------------------------------------------------
    def _navigate(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx"))
        url = params["url"]
        timeout = params.get("timeout", 30)
        page.get(url, timeout=timeout)
        return {
            "url": _safe_url(getattr(page, 'url', url))["url"],
            "title": getattr(page, 'title', ''),
        }

    def _new_tab(self, params: dict) -> dict:
        if not self.page:
            raise RuntimeError("No browser session. Call browser.launch first.")

        url = params.get("url", "")
        timeout = params.get("timeout", 30)
        container = params.get("container", False)
        tab = None
        fingerprint_required = self._fingerprint_ctx is not None

        try:
            if container:
                tab = self.page.new_container_tab(url=None)
            else:
                tab = self.page.new_tab(url=None)
        except Exception as e:
            if container:
                raise RuntimeError(
                    "Container tab creation failed; refusing to fall back to a normal tab"
                ) from e
            # Fallback: create about:blank via JS and then resync the latest
            # tab. Target navigation stays outside the creation try/except so
            # a navigation timeout cannot create a duplicate or ghost tab.
            self.page.run_js("(() => window.open('', '_blank'))()")
            try:
                tabs = self.page.get_tabs() or []
                if not tabs:
                    raise RuntimeError("Fallback did not create a new tab")
                tab = tabs[-1]
            except Exception as fallback_error:
                raise RuntimeError("Normal tab fallback failed") from fallback_error

        fingerprint_emulation = None
        if tab is not None:
            # ruyiPage 1.2.56 scopes screen to userContext, while geo/locale/
            # timezone/headers remain browsing-context scoped. Reapply the
            # complete context before the first target navigation for both
            # normal and container tabs.
            try:
                if fingerprint_required:
                    fingerprint_emulation = self._fingerprint_ctx.apply_emulation(
                        tab,
                        set_screen_size=bool(container),
                    )
                if url:
                    tab.get(url, timeout=timeout)
            except Exception:
                try:
                    tab.close()
                except Exception:
                    pass
                raise

        idx = self._next_page_idx
        self.pages[idx] = tab
        self._next_page_idx += 1

        result = {
            "pageIdx": idx,
            "url": _safe_url(getattr(tab, 'url', url) if tab else url)["url"],
        }
        if fingerprint_emulation is not None:
            result["fingerprintEmulation"] = _serialize(fingerprint_emulation)
        return result

    def _close_tab(self, params: dict) -> dict:
        idx = self._debug_page_idx(params)
        if idx == 0:
            raise ValueError("Cannot close main tab (pageIdx=0). Use browser.quit instead.")
        if idx not in self.pages:
            raise ValueError(f"Invalid pageIdx: {idx}")

        page = self.pages.pop(idx)
        with self._debugger_lock:
            self._native_breakpoints = [
                item for item in self._native_breakpoints
                if item.get("pageIdx") != idx
            ]
        self._capture_stats.pop(self._normalize_page_idx(idx), None)
        self._intercept_modes.pop(self._normalize_page_idx(idx), None)
        try:
            page.close()
        except Exception:
            pass

        return {"closed": idx, "remaining": list(self.pages.keys())}

    def _select_tab(self, params: dict) -> dict:
        idx = params["pageIdx"]
        page = self._get_page(idx)
        # ruyipage auto-switches when using a tab object
        return {"pageIdx": idx, "url": _safe_url(getattr(page, 'url', ''))["url"]}

    def _list_tabs(self, params: dict) -> dict:
        tabs = []
        for idx, page in self.pages.items():
            try:
                tabs.append({
                    "pageIdx": idx,
                    "url": _safe_url(getattr(page, 'url', ''))["url"],
                    "title": getattr(page, 'title', ''),
                })
            except Exception:
                tabs.append({"pageIdx": idx, "error": "unreachable"})
        return {"tabs": tabs}

    def _reload(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx"))
        page.refresh()
        return {"url": _safe_url(getattr(page, 'url', ''))["url"]}

    def _screenshot(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx"))
        file_path = params.get("filePath")
        full_page = params.get("fullPage", False)

        if file_path:
            safe_path = _contained_output_path(file_path, "filePath", kind="file")
            page.screenshot(safe_path, full_page=full_page)
            return {"filePath": safe_path}
        else:
            # Return base64 screenshot
            import base64
            import tempfile
            fd, tmp = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            try:
                page.screenshot(tmp, full_page=full_page)
                with open(tmp, "rb") as f:
                    data = base64.b64encode(f.read()).decode()
                return {"base64": data, "format": "png"}
            finally:
                try:
                    os.unlink(tmp)
                except Exception:
                    pass

    def _clear_data(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        try:
            page.delete_cookies()
        except Exception:
            pass
        # Clear storage via JS
        try:
            page.run_js("""
                (() => {
                    try { localStorage.clear(); } catch(e) {}
                    try { sessionStorage.clear(); } catch(e) {}
                })()
            """)
        except Exception:
            pass
        return {"cleared": True}

    def _run_agent_js(self, target: Any, expression: str, timeout: int = 10) -> Any:
        script = (
            "(() => {\n"
            f"{_AGENT_DOM_JS}\n"
            f"return {expression};\n"
            "})()"
        )
        return target.run_js(script, timeout=timeout)

    def _page_snapshot(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        limit = int(params.get("maxNodes", _AGENT_SNAPSHOT_LIMIT))
        if limit < 1 or limit > _AGENT_SNAPSHOT_LIMIT:
            raise ValueError(f"maxNodes must be between 1 and {_AGENT_SNAPSHOT_LIMIT}")

        raw = self._run_agent_js(
            target,
            f"ruyiAgentSnapshot({limit})",
        )
        if not isinstance(raw, dict):
            raise RuntimeError("page.snapshot did not return a table")

        snapshot_id = str(raw.get("snapshotId") or "").strip()
        if not snapshot_id:
            raise RuntimeError("page.snapshot missing snapshotId")
        nodes = raw.get("nodes")
        if not isinstance(nodes, list):
            raise RuntimeError("page.snapshot missing nodes")
        indexes = [node.get("index") for node in nodes if isinstance(node, dict)]
        if len(indexes) != len(set(indexes)):
            raise RuntimeError("page.snapshot indexes are not unique")

        key = f"{id(target)}:{snapshot_id}"
        self._agent_snapshots[key] = {
            "snapshotId": snapshot_id,
            "pageId": id(target),
            "marker": {
                "url": raw.get("url"),
                "title": raw.get("title"),
                "scroll": raw.get("scroll"),
            },
            "nodeCount": len(nodes),
        }
        return {
            "snapshotId": snapshot_id,
            "url": raw.get("url"),
            "title": raw.get("title"),
            "scroll": raw.get("scroll"),
            "truncated": bool(raw.get("truncated")),
            "truncatedReasons": raw.get("truncatedReasons") or [],
            "nodeCount": len(nodes),
            "nodes": nodes,
            "target": target_metadata,
        }

    def _page_act(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        op = str(params.get("op") or "").strip().upper()
        if op not in _AGENT_ACT_OPS:
            raise ValueError(f"unsupported op: {op or '<empty>'}")

        snapshot_id = str(params.get("snapshotId") or "").strip()
        raw_index = params.get("index")
        text = params.get("text")
        wait_ms = int(params.get("waitMs", 500))

        if op in _AGENT_INDEX_OPS:
            if not snapshot_id:
                raise ValueError("snapshotId is required for this op")
            if not isinstance(raw_index, int) or raw_index < 0:
                raise ValueError("index must be a non-negative integer")
            key = f"{id(target)}:{snapshot_id}"
            if key not in self._agent_snapshots:
                return {
                    "ok": False,
                    "miss": True,
                    "reason": "stale_snapshot",
                    "retried": False,
                    "op": op,
                    "target": target_metadata,
                }

        if op == "DRAG":
            return {
                "ok": False,
                "miss": True,
                "reason": "drag_not_in_p0",
                "retried": False,
                "op": op,
                "target": target_metadata,
            }
        if op == "WAIT":
            time.sleep(max(0, min(wait_ms, 10000)) / 1000.0)
            return {"ok": True, "op": op, "waitMs": wait_ms, "target": target_metadata}
        if op == "DONE":
            return {"ok": True, "op": op, "done": True, "target": target_metadata}
        if op == "BLOCKED":
            return {
                "ok": False,
                "op": op,
                "blocked": True,
                "reason": "blocked",
                "target": target_metadata,
            }
        if op in {"SCROLL_UP", "SCROLL_DOWN"}:
            scroll = self._human_scroll(
                {
                    "pageIdx": params.get("pageIdx", 0),
                    "frameContextId": params.get("frameContextId"),
                    "direction": "up" if op == "SCROLL_UP" else "down",
                    "steps": int(params.get("steps", 4)),
                }
            )
            return {"ok": True, "op": op, "scroll": scroll, "target": target_metadata}

        probe = self._run_agent_js(
            target,
            "ruyiAgentAct("
            + json.dumps(
                {
                    "snapshotId": snapshot_id,
                    "index": raw_index,
                    "op": op,
                    "text": text,
                }
            )
            + ")",
        )
        if not isinstance(probe, dict) or not probe.get("ok"):
            reason = "gone"
            if isinstance(probe, dict):
                reason = str(probe.get("reason") or reason)
            return {
                "ok": False,
                "miss": True,
                "reason": reason,
                "retried": False,
                "op": op,
                "target": target_metadata,
            }

        if op == "SELECT":
            return {
                "ok": True,
                "op": op,
                "value": probe.get("value"),
                "index": raw_index,
                "snapshotId": snapshot_id,
                "retried": False,
                "target": target_metadata,
            }

        stamp = str(probe.get("stamp") or "")
        if not stamp:
            return {
                "ok": False,
                "miss": True,
                "reason": "gone",
                "retried": False,
                "op": op,
                "target": target_metadata,
            }

        if op == "CLICK":
            if "x" not in probe or "y" not in probe:
                return {
                    "ok": False,
                    "miss": True,
                    "reason": "gone",
                    "retried": False,
                    "op": op,
                    "target": target_metadata,
                }
            click = self._human_click(
                {
                    "pageIdx": params.get("pageIdx", 0),
                    "frameContextId": params.get("frameContextId"),
                    "target": {"x": int(probe["x"]), "y": int(probe["y"])},
                    "algorithm": params.get("algorithm", "windmouse"),
                }
            )
            if not click.get("clicked"):
                return {
                    "ok": False,
                    "miss": True,
                    "reason": "gone",
                    "retried": False,
                    "op": op,
                    "target": target_metadata,
                }
            return {
                "ok": True,
                "op": op,
                "index": raw_index,
                "snapshotId": snapshot_id,
                "retried": False,
                "click": click,
                "target": target_metadata,
            }

        if op == "TYPE_TEXT":
            if text is None:
                return {
                    "ok": False,
                    "needsText": True,
                    "op": op,
                    "index": raw_index,
                    "snapshotId": snapshot_id,
                    "retried": False,
                    "target": target_metadata,
                }
            typed = self._human_input(
                {
                    "pageIdx": params.get("pageIdx", 0),
                    "frameContextId": params.get("frameContextId"),
                    "target": f'[data-ruyi-agent="{stamp}"]',
                    "text": str(text),
                    "delayMs": params.get("delayMs", 50),
                }
            )
            if not typed.get("input"):
                return {
                    "ok": False,
                    "miss": True,
                    "reason": "gone",
                    "retried": False,
                    "op": op,
                    "target": target_metadata,
                }
            return {
                "ok": True,
                "op": op,
                "index": raw_index,
                "snapshotId": snapshot_id,
                "retried": False,
                "input": typed,
                "target": target_metadata,
            }

        raise ValueError(f"unsupported op: {op}")

    # ------------------------------------------------------------------
    # Script execution
    # ------------------------------------------------------------------
    def _evaluate(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        script = params["script"]
        timeout = params.get("timeout", 10)
        sandbox = params.get("sandbox", None)

        try:
            # Wrap as IIFE so arrow functions are called, not evaluated.
            # BiDi callFunction (as_expr=False) doesn't handle async arrow
            # functions correctly, but IIFE + expression mode works for both
            # sync and async. Node.js side always passes function declarations.
            script_iife = f"({script})()"
            result = target.run_js(script_iife, timeout=timeout, sandbox=sandbox)
            serialized = _serialize(result)
            return {"result": serialized, "target": target_metadata}
        except Exception as e:
            return {
                "result": None,
                "error": str(e),
                "stack": traceback.format_exc(),
                "target": target_metadata,
            }

    def _add_preload(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        script = params["script"]  # Arrow function declaration string
        script_obj = page.add_preload_script(script)
        script_id = str(getattr(script_obj, 'id', len(self._preload_scripts)))
        self._preload_scripts[script_id] = script
        return {"scriptId": script_id}

    def _remove_preload(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        script_id = params["scriptId"]
        if script_id in self._preload_scripts:
            del self._preload_scripts[script_id]
        try:
            page.remove_preload_script(script_id)
        except Exception:
            pass
        return {"removed": script_id}

    def _list_preloads(self, params: dict) -> dict:
        return {"preloads": [
            {"scriptId": sid, "script": script[:200] + ("..." if len(script) > 200 else "")}
            for sid, script in self._preload_scripts.items()
        ]}

    # ------------------------------------------------------------------
    # Network
    # ------------------------------------------------------------------
    def _list_requests(self, params: dict) -> dict:
        """List recent resource URLs via the page performance API. Not a JS/Python trace."""
        page = self._get_page(params.get("pageIdx", 0))
        try:
            # Try to get entries from the browser's performance API
            result = page.run_js("""
                (() => {
                    const entries = performance.getEntriesByType('resource');
                    return entries.slice(-50).map(e => ({
                        name: e.name,
                        initiatorType: e.initiatorType,
                        duration: e.duration,
                        transferSize: e.transferSize,
                    }));
                })()
            """)
            return {"requests": _serialize(result)}
        except Exception as e:
            return {"requests": [], "error": str(e)}

    def _capture_stats_for(self, page_idx: int) -> dict[str, Any]:
        return self._capture_stats.setdefault(
            page_idx,
            {
                "resultMode": "metadata",
                "observed": 0,
                "returned": 0,
                "discarded": 0,
                "bodyUnavailable": 0,
                "returnedPacketIds": set(),
            },
        )

    def _packet_metadata(self, packet: Any) -> dict:
        request = self._attribute(packet, "request", None)
        response = self._attribute(packet, "response", None)
        request_headers = self._attribute(packet, "request_headers", None)
        response_headers = self._attribute(packet, "response_headers", None)
        if request_headers is None and isinstance(request, dict):
            request_headers = request.get("headers", {})
        if response_headers is None and isinstance(response, dict):
            response_headers = response.get("headers", {})

        request_id = self._attribute(packet, "request_id", "")
        url = _safe_url(self._attribute(packet, "url", ""))
        return {
            "url": url["url"],
            "queryKeys": url["queryKeys"],
            "method": str(self._attribute(packet, "method", "") or ""),
            "status": self._attribute(packet, "status", None),
            "eventType": str(self._attribute(packet, "event_type", "") or ""),
            "timestamp": self._attribute(packet, "timestamp", None),
            "requestIdHash": _sha256_text(request_id) if request_id else None,
            "isFailed": bool(self._attribute(packet, "is_failed", False)),
            "requestHeaders": _safe_headers(request_headers),
            "responseHeaders": _safe_headers(response_headers),
            "requestBody": {"state": "not_requested"},
            "responseBody": {"state": "not_requested"},
        }

    @staticmethod
    def _body_text(value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return value if isinstance(value, str) else str(value)

    def _decode_packet_body_value(self, packet: Any, value: Any) -> Any:
        if value is None:
            return None
        decoder = self._attribute(packet, "_decode_body_value", None)
        if callable(decoder):
            try:
                return decoder(value)
            except Exception:
                return None
        return value

    def _read_capture_body(self, packet: Any, direction: str, timeout: float) -> str | None:
        """Read a CapturePacket body without the library's GET replay fallback."""
        source_name = "request" if direction == "request" else "response"
        collector_name = (
            "_request_collector" if direction == "request" else "_response_collector"
        )
        source = self._attribute(packet, source_name, None)
        direct = source.get("body") if isinstance(source, dict) else None
        decoded = self._decode_packet_body_value(packet, direct)
        if decoded is not None:
            return self._body_text(decoded)

        collector = self._attribute(packet, collector_name, None)
        reader = self._attribute(packet, "_body_from_collector", None)
        if not callable(reader):
            return None
        try:
            return self._body_text(reader(collector, direction, timeout=timeout))
        except Exception:
            return None

    @staticmethod
    def _body_read_timeout(params: dict) -> float:
        try:
            timeout = float(params.get("bodyReadTimeout", 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("bodyReadTimeout must be a finite number") from exc
        if not math.isfinite(timeout) or not 0 <= timeout <= 10:
            raise ValueError("bodyReadTimeout must be between 0 and 10 seconds")
        return timeout

    @staticmethod
    def _body_output_file(params: dict) -> str:
        output_file = params.get("outputFile")
        if not isinstance(output_file, str) or not output_file.strip():
            raise ValueError("outputFile is required when resultMode is body")
        return _contained_output_path(output_file, "outputFile", kind="file")

    @staticmethod
    def _append_jsonl(output_file: str, records: list[dict]) -> None:
        output_dir = os.path.dirname(output_file)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        with open(output_file, "a", encoding="utf-8", newline="\n") as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    @staticmethod
    def _body_for_file(value: str | None, max_body_chars: int) -> tuple[str | None, bool]:
        if value is None:
            return None, False
        truncated = bool(max_body_chars and len(value) > max_body_chars)
        return (value[:max_body_chars] if truncated else value), truncated

    def _capture_start(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        pattern = params.get("pattern", "")
        method = params.get("method", None)
        result_mode = _normalize_result_mode(params.get("resultMode"))
        collect_bodies = result_mode != "metadata"
        capture = page.capture
        cleared_previous_history = 0
        if bool(getattr(capture, "active", False)):
            # CaptureManager.start() calls stop() on an active session, and
            # upstream stop() eagerly hydrates every saved body. Clear before
            # that transition so restarting capture preserves this bridge's
            # bounded, metadata-first contract.
            cleared_previous_history = len(capture.steps)
            capture.clear()
        capture.start(pattern, method=method, collect_bodies=collect_bodies)
        self._capture_stats[page_idx] = {
            "resultMode": result_mode,
            "observed": 0,
            "returned": 0,
            "discarded": 0,
            "bodyUnavailable": 0,
            "returnedPacketIds": set(),
        }
        return {
            "capturing": True,
            "pattern": pattern,
            "resultMode": result_mode,
            "collectBodies": collect_bodies,
            "clearedPreviousPacketHistory": cleared_previous_history,
        }

    def _capture_stop(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        cleanup_timeout = float(params.get("cleanupTimeout", 5))
        if not math.isfinite(cleanup_timeout) or cleanup_timeout <= 0:
            raise ValueError("cleanupTimeout must be a positive finite number")
        cleanup_timeout = min(cleanup_timeout, 30.0)
        stop_mode = _normalize_capture_stop_mode(params.get("mode"))
        try:
            metadata_limit = int(params.get("metadataLimit", 100))
        except (TypeError, ValueError) as exc:
            raise ValueError("metadataLimit must be an integer") from exc
        if not 0 <= metadata_limit <= 1000:
            raise ValueError("metadataLimit must be between 0 and 1000")

        capture = page.capture
        history = list(capture.steps)
        history_count = len(history)
        stats = self._capture_stats_for(page_idx)
        stats["observed"] = max(int(stats["observed"]), history_count)
        returned_ids = stats["returnedPacketIds"]
        pending_packets = [packet for packet in history if id(packet) not in returned_ids]
        metadata_packets = []
        if stop_mode == "metadata":
            for packet in pending_packets[:metadata_limit]:
                metadata_packets.append(self._packet_metadata(packet))
                returned_ids.add(id(packet))
            stats["returned"] += len(metadata_packets)
        stats["discarded"] += max(0, len(pending_packets) - len(metadata_packets))

        # ruyiPage CaptureManager.stop() hydrates every packet body before it
        # releases the subscription and DataCollector. Each network.getData
        # call can consume the full global BiDi timeout, so an O(N) stop can
        # outlive the MCP bridge's fixed 120-second envelope. MCP callers have
        # already consumed packet data through capture_wait; clear the internal
        # queue/history first so stop remains a bounded cleanup operation.
        capture.clear()

        previous_bidi_timeout = None
        applied_bidi_timeout = cleanup_timeout
        if Settings is not None:
            previous_bidi_timeout = Settings.bidi_timeout
            applied_bidi_timeout = min(float(previous_bidi_timeout), cleanup_timeout)
            Settings.bidi_timeout = applied_bidi_timeout

        started = time.monotonic()
        try:
            capture.stop()
        finally:
            if Settings is not None and previous_bidi_timeout is not None:
                Settings.bidi_timeout = previous_bidi_timeout

        return {
            "capturing": bool(getattr(capture, "active", False)),
            "clearedPacketHistory": history_count,
            "mode": stop_mode,
            "metadataPackets": metadata_packets,
            "observed": stats["observed"],
            "returned": stats["returned"],
            "discarded": stats["discarded"],
            "bodyUnavailable": stats["bodyUnavailable"],
            "cleanupTimeoutSeconds": applied_bidi_timeout,
            "elapsedMs": round((time.monotonic() - started) * 1000),
        }

    def _capture_wait(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        stats = self._capture_stats_for(page_idx)
        result_mode = _normalize_result_mode(
            params.get("resultMode"), default=str(stats["resultMode"])
        )
        if result_mode != "metadata" and stats["resultMode"] == "metadata":
            raise ValueError(
                "capture body collection was disabled at start; restart capture "
                "with resultMode=schema or resultMode=body"
            )
        output_file = (
            self._body_output_file(params) if result_mode == "body" else None
        )
        body_read_timeout = self._body_read_timeout(params)
        timeout = params.get("timeout", 10)
        count = params.get("count", 5)
        max_body_chars = params.get("maxBodyChars", 0)
        if max_body_chars is None:
            max_body_chars = 0
        max_body_chars = int(max_body_chars)
        if max_body_chars < 0:
            raise ValueError("maxBodyChars must be >= 0; use 0 for complete bodies")
        capture_result = page.capture.wait(timeout=timeout, count=count)
        if isinstance(capture_result, list):
            packets = capture_result
        elif capture_result is None:
            packets = []
        else:
            packets = [capture_result]
        results = []
        body_outputs = []
        for p in packets:
            packet_metadata = self._packet_metadata(p)
            if result_mode == "metadata":
                results.append(packet_metadata)
            else:
                request_body = self._read_capture_body(
                    p, "request", body_read_timeout
                )
                response_body = self._read_capture_body(
                    p, "response", body_read_timeout
                )
                request_schema = _body_schema(
                    request_body,
                    packet_metadata["requestHeaders"].get("content-type"),
                )
                response_schema = _body_schema(
                    response_body,
                    packet_metadata["responseHeaders"].get("content-type"),
                )
                stats["bodyUnavailable"] += sum(
                    item["state"] == "unavailable"
                    for item in (request_schema, response_schema)
                )
                packet_metadata["requestBody"] = request_schema
                packet_metadata["responseBody"] = response_schema
                results.append(packet_metadata)
                if result_mode == "body":
                    request_value, request_truncated = self._body_for_file(
                        request_body, max_body_chars
                    )
                    response_value, response_truncated = self._body_for_file(
                        response_body, max_body_chars
                    )
                    body_outputs.append({
                        **packet_metadata,
                        "requestBody": request_value,
                        "responseBody": response_value,
                        "requestBodySchema": request_schema,
                        "responseBodySchema": response_schema,
                        "requestBodyTruncated": request_truncated,
                        "responseBodyTruncated": response_truncated,
                    })
            stats["observed"] += 1
            stats["returned"] += 1
            stats["returnedPacketIds"].add(id(p))

        if output_file is not None and body_outputs:
            self._append_jsonl(output_file, body_outputs)

        result = {
            "packets": results,
            "resultMode": result_mode,
            "bodyReadTimeout": body_read_timeout,
            "bodyLimitChars": max_body_chars if result_mode == "body" else None,
            "savedTo": output_file,
            "appendedPackets": len(body_outputs),
        }
        return result

    # ------------------------------------------------------------------
    # Cookies
    # ------------------------------------------------------------------
    def _bidi_trace_start(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        output_file = params.get("outputFile")
        if output_file is not None:
            output_file = _contained_output_path(output_file, "outputFile", kind="file")
        previous_enabled = bool(Settings.trace_enabled)
        try:
            Settings.trace_enabled = True
            if self.opts is not None:
                self.opts.enable_trace(True)
            tracer = page.trace
            if not previous_enabled and not self._bidi_trace_active:
                tracer.clear()
        except Exception:
            Settings.trace_enabled = previous_enabled
            if self.opts is not None:
                self.opts.enable_trace(previous_enabled)
            raise
        self._bidi_trace_active = True
        self._bidi_trace_output = output_file
        return {
            "tracing": True,
            "plane": "bidi-timeline",
            "scope": "browser",
            "fullTrace": self._bidi_trace_launch,
            "partialTrace": not self._bidi_trace_launch,
            "alreadyTracing": previous_enabled,
        }

    def _bidi_trace_stop(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        Settings.trace_enabled = False
        if self.opts is not None:
            self.opts.enable_trace(False)
        self._bidi_trace_active = False
        tracer = page.trace
        result = {"tracing": False, "plane": "bidi-timeline", "scope": "browser", "summary": str(tracer.summary())[:10000]}
        if self._bidi_trace_output:
            destination = Path(_contained_output_path(self._bidi_trace_output, "outputFile", kind="file"))
            destination.parent.mkdir(parents=True, exist_ok=True)
            payload = str(tracer.dump_json())
            destination.write_text(payload, encoding="utf-8", newline="\n")
            result["output"] = {"path": str(destination), "bytes": destination.stat().st_size, "sha256": _sha256_file(destination)}
        self._bidi_trace_output = None
        return result

    def _bidi_trace_results(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        limit = params.get("limit", 50)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("limit must be an integer between 1 and 100")
        return {
            "tracing": bool(self._bidi_trace_active and Settings.trace_enabled),
            "plane": "bidi-timeline",
            "scope": "browser",
            "entries": _serialize(page.trace.latest(limit)),
        }

    def _get_cookies(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        try:
            cookies = page.get_cookies()
            # CookieInfo objects need manual extraction
            result = []
            for c in (cookies or []):
                try:
                    result.append({
                        "name": getattr(c, "name", ""),
                        "value": getattr(c, "value", ""),
                        "domain": getattr(c, "domain", None),
                        "path": getattr(c, "path", None),
                        "secure": getattr(c, "secure", None),
                        "httpOnly": getattr(c, "http_only", None),
                        "sameSite": getattr(c, "same_site", None),
                        "expiry": getattr(c, "expiry", None),
                    })
                except Exception:
                    result.append(str(c)[:500])
            return {"cookies": result}
        except Exception as e:
            return {"cookies": [], "error": str(e)}

    def _set_cookies(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        cookies = params["cookies"]
        page.set_cookies(cookies)
        return {"set": len(cookies) if isinstance(cookies, list) else 1}

    def _delete_cookies(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        name = params.get("name")
        if name:
            page.delete_cookies(name=name)
        else:
            page.delete_cookies()
        return {"deleted": True}

    # ------------------------------------------------------------------
    # Anti-detection / fingerprint
    # ------------------------------------------------------------------
    def _set_fingerprint(self, params: dict) -> dict:
        """Apply fingerprint emulation to an already-launched page."""
        page = self._get_page(params.get("pageIdx", 0))
        viewport = params.get("viewport")
        window_size = params.get("windowSize")
        screen_size = params.get("screenSize")

        if viewport and window_size:
            raise ValueError("viewport and windowSize are mutually exclusive")

        # Apply individual emulation settings
        if params.get("geolocation"):
            geo = params["geolocation"]
            page.set_geolocation(
                latitude=geo.get("latitude", 0),
                longitude=geo.get("longitude", 0),
                accuracy=geo.get("accuracy", 100),
            )
        if params.get("timezone"):
            page.set_timezone(params["timezone"])
        if params.get("locale"):
            page.set_locale(params["locale"])
        if params.get("userAgent"):
            page.set_useragent(params["userAgent"])
        applied_size = None
        applied_screen_size = None
        warnings = []
        if viewport:
            width = int(viewport.get("width", 1920))
            height = int(viewport.get("height", 1080))
            dpr = viewport.get("devicePixelRatio")
            if width <= 0 or height <= 0:
                raise ValueError("viewport width and height must be positive")
            if dpr is not None:
                dpr = float(dpr)
                if dpr <= 0:
                    raise ValueError("viewport devicePixelRatio must be positive")
            page.set_viewport(width, height, dpr)
            applied_size = {
                "mode": "viewport",
                "width": width,
                "height": height,
                "devicePixelRatio": dpr,
            }
        elif window_size:
            width = int(window_size.get("width", 1280))
            height = int(window_size.get("height", 720))
            dpr = window_size.get("devicePixelRatio")
            if width <= 0 or height <= 0:
                raise ValueError("windowSize width and height must be positive")
            if dpr is not None:
                dpr = float(dpr)
                if dpr <= 0:
                    raise ValueError("windowSize devicePixelRatio must be positive")
                warnings.append(
                    "windowSize.devicePixelRatio is ignored by ruyiPage 1.2.56; "
                    "use viewport.devicePixelRatio for DPR"
                )
            page.set_window_size(width, height)
            applied_size = {
                "mode": "windowSize",
                "width": width,
                "height": height,
                "naturalViewport": True,
            }
        if screen_size:
            width = int(screen_size.get("width", 1920))
            height = int(screen_size.get("height", 1080))
            dpr = screen_size.get("devicePixelRatio")
            if width <= 0 or height <= 0:
                raise ValueError("screenSize width and height must be positive")
            if dpr is not None:
                dpr = float(dpr)
                if dpr <= 0:
                    raise ValueError("screenSize devicePixelRatio must be positive")
            page.emulation.set_screen_size(
                width,
                height,
                device_pixel_ratio=None,
            )
            applied_screen_size = {
                "requested": {
                    "width": width,
                    "height": height,
                    "devicePixelRatio": dpr,
                },
                "verified": False,
            }
            if dpr is not None:
                # ruyiPage 1.2.56 implements a screen DPR by issuing a second
                # browsingContext.setViewport call. That changes the viewport
                # dimensions as a side effect and violates this Bridge's
                # explicit screen/viewport separation, so the compatibility
                # field is accepted but intentionally not forwarded.
                applied_screen_size["devicePixelRatioApplied"] = False
                warnings.append(
                    "screenSize.devicePixelRatio is ignored by the ruyiPage 1.2.56 "
                    "screen operation; use viewport.devicePixelRatio for DPR"
                )
            try:
                actual_screen_size = page.run_js(
                    """
                    return {
                      width: screen.width,
                      height: screen.height,
                      devicePixelRatio: window.devicePixelRatio
                    };
                    """
                )
            except Exception:
                actual_screen_size = None
            if isinstance(actual_screen_size, dict):
                applied_screen_size["verified"] = True
                applied_screen_size["actual"] = _serialize(actual_screen_size)
                screen_size_applied = (
                    actual_screen_size.get("width") == width
                    and actual_screen_size.get("height") == height
                )
                applied_screen_size["screenSizeApplied"] = screen_size_applied
                if not screen_size_applied:
                    warnings.append(
                        "screenSize dimensions were not applied by the active Firefox runtime"
                    )
            else:
                warnings.append(
                    "screenSize was requested but the active page metrics could not be verified"
                )
        if params.get("bypassCsp"):
            page.set_bypass_csp(True)

        # Apply screen orientation
        applied_orientation = None
        if params.get("screenOrientation"):
            ori = params["screenOrientation"]
            orientation_type = ori.get("type", "portrait-primary")
            page.set_screen_orientation(
                orientation_type=orientation_type,
            )
            requested_orientation = {"type": orientation_type}
            if "angle" in ori:
                requested_orientation["angle"] = ori["angle"]
                warnings.append(
                    "screenOrientation.angle is ignored by ruyiPage 1.2.56; "
                    "only screenOrientation.type is forwarded"
                )
            applied_orientation = {
                "requested": requested_orientation,
                "forwarded": {"type": orientation_type},
                "typeForwarded": True,
                "verified": False,
                "typeApplied": False,
            }
            if "angle" in ori:
                applied_orientation["angleApplied"] = False
            try:
                actual_orientation = page.run_js(
                    """
                    return {
                      type: screen.orientation.type,
                      angle: screen.orientation.angle
                    };
                    """
                )
            except Exception:
                actual_orientation = None
            if isinstance(actual_orientation, dict):
                actual_orientation = _serialize(actual_orientation)
                applied_orientation["verified"] = True
                applied_orientation["actual"] = actual_orientation
                type_applied = actual_orientation.get("type") == orientation_type
                applied_orientation["typeApplied"] = type_applied
                if type_applied:
                    applied_orientation["applied"] = {"type": orientation_type}
                else:
                    warnings.append(
                        "screenOrientation.type was forwarded but not applied by the active Firefox runtime"
                    )
            else:
                warnings.append(
                    "screenOrientation.type was forwarded but the active page orientation could not be verified"
                )

        result = {"fingerprintApplied": True}
        if applied_size:
            result["size"] = applied_size
        if applied_screen_size:
            result["screenSize"] = applied_screen_size
        if applied_orientation:
            result["screenOrientation"] = applied_orientation
        if warnings:
            result["warnings"] = warnings
        return result

    def _set_proxy(self, params: dict) -> dict:
        """Note: proxy must be set BEFORE browser launch via browser.launch params.
        This is a no-op if browser is already running."""
        try:
            proxy_state = _safe_proxy(self._proxy_url)
        except ValueError:
            proxy_state = {"mode": "unknown", "credentials": "omitted"}
        return {
            "warning": "Proxy must be set at browser.launch time. "
                       "Use the 'proxy' parameter in browser.launch. For Cliproxy from a "
                       "domestic machine, pass a verified loopback listener of a local chained "
                       "sidecar, never a Cliproxy provider endpoint or credentials. The main Clash "
                       "mixed listener (for example http://127.0.0.1:7897) is not a Cliproxy relay "
                       "unless its dialer-proxy -> Cliproxy chain is explicitly configured and verified.",
            "proxy": proxy_state,
        }

    def _set_geolocation(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        page.set_geolocation(
            latitude=params.get("latitude", 0),
            longitude=params.get("longitude", 0),
            accuracy=params.get("accuracy", 100),
        )
        return {"geolocation": f"{params.get('latitude')},{params.get('longitude')}"}

    def _set_timezone(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        page.set_timezone(params["timezoneId"])
        return {"timezone": params["timezoneId"]}

    def _set_locale(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        page.set_locale(params["locale"])
        return {"locale": params["locale"]}

    def _set_useragent(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        page.set_useragent(params["userAgent"])
        return {"userAgent": params["userAgent"]}

    # ------------------------------------------------------------------
    # Cloudflare
    # ------------------------------------------------------------------
    def _handle_cf(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        timeout = params.get("timeout", 30)
        check_interval = params.get("checkInterval", 2)
        success = page.handle_cloudflare_challenge(
            timeout=timeout, check_interval=check_interval
        )
        return {"passed": success}

    # ------------------------------------------------------------------
    # Console
    # ------------------------------------------------------------------
    def _get_console(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        types_filter = params.get("types")
        limit = params.get("limit", 50)
        try:
            # ruyipage console is a property that collects messages
            console = getattr(page, 'console', None)
            if console is None:
                return {"messages": [], "note": "Console capture not available"}
            # Try common access patterns
            messages = []
            if hasattr(console, 'messages'):
                messages = list(console.messages)
            elif hasattr(console, 'get'):
                messages = console.get() or []

            # Filter by types if provided
            if types_filter and isinstance(types_filter, list):
                types_filter = [t.lower() for t in types_filter]
                messages = [
                    m for m in messages
                    if str(getattr(m, 'type', getattr(m, 'level', 'log'))).lower() in types_filter
                ]

            # Apply limit
            if limit and len(messages) > limit:
                messages = messages[-limit:]

            return {"messages": _serialize(messages)}
        except Exception as e:
            return {"messages": [], "error": str(e)}

    # ------------------------------------------------------------------
    # DOM interaction
    # ------------------------------------------------------------------
    def _dom_select(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        selector = self._norm_selector(params["selector"])
        timeout = params.get("timeout", 10)

        el = target.ele(selector, timeout=timeout)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {"found": False, "selector": selector, "target": target_metadata}

        # Store element reference in a way we can retrieve later
        element_id = str(id(el))
        # Attach element ID to the JS context for later retrieval
        try:
            target.run_js(f"window.__ruyi_element_{element_id} = true;")
        except Exception:
            pass

        return {
            "found": True,
            "elementId": element_id,
            "selector": selector,
            "target": target_metadata,
        }

    def _dom_get_info(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        selector = params["selector"]
        attribute = params.get("attribute")

        # Use JS for reliable DOM property access (avoids ruyipage
        # selector normalization and NoneElement issues).
        js_parts = []
        if attribute:
            js_parts.append(
                f"const attr = el.getAttribute({json.dumps(attribute)}); "
                f"return attr !== null ? attr : '';"
            )
        else:
            js_parts.append(
                "return {"
                "  text: (el.textContent || '').substring(0, 10000),"
                "  html: (el.innerHTML || '').substring(0, 50000),"
                "  value: (el.value || '').substring(0, 10000),"
                "  tag: el.tagName || '',"
                "};"
            )

        script = (
            f"() => {{"
            f"  const el = document.querySelector({json.dumps(selector)});"
            f"  if (!el) return null;"
            f"  {' '.join(js_parts)}"
            f"}}"
        )

        result = target.run_js(f"({script})()", timeout=10)
        if result is None:
            return {"found": False, "target": target_metadata}

        if attribute:
            return {
                "found": True,
                "attribute": str(result)[:10000],
                "target": target_metadata,
            }
        return {
            "found": True,
            **{k: str(v) for k, v in result.items()},
            "target": target_metadata,
        }

    def _dom_input(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        selector = self._norm_selector(params["selector"])
        text = params.get("text", "")
        clear = params.get("clear", True)

        el = target.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {
                "found": False,
                "error": f"Element not found: {selector}",
                "target": target_metadata,
            }

        el.input(text, clear=clear)
        return {"found": True, "input": text[:500], "target": target_metadata}

    def _dom_click(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        selector = self._norm_selector(params["selector"])
        el = target.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {
                "found": False,
                "error": f"Element not found: {selector}",
                "target": target_metadata,
            }
        el.click_self()
        return {"found": True, "clicked": True, "target": target_metadata}

    # ------------------------------------------------------------------
    # Human simulation
    # ------------------------------------------------------------------
    def _human_move(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        selector = self._norm_selector(params["target"])
        algorithm = params.get("algorithm", "bezier")
        style = self._normalize_human_style(params.get("style", "arc"))

        el = target.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {
                "found": False,
                "error": f"Element not found: {selector}",
                "target": target_metadata,
            }

        target.actions.human_move(el, algorithm=algorithm, style=style).perform()
        return {
            "moved": True,
            "selector": selector,
            "target": target_metadata,
            "algorithm": algorithm,
            "style": style,
        }

    def _pointer_click(
        self,
        target: Any,
        el: Any,
        algorithm: str,
        target_metadata: dict,
        selector: Any,
    ) -> dict:
        actions = target.actions
        # Firefox may keep a stale BiDi pointer source after many document
        # navigations. performActions can still return success while the page
        # receives no pointerdown/click events. Reset both the remote source
        # and ruyiPage's cached coordinates before building the next click.
        actions.release_all()
        if hasattr(actions, "_pointer_position_known"):
            actions._pointer_position_known = False
        # Keep the long human trajectory separate, then send a short atomic
        # click pulse that includes its own final pointerMove. Firefox does not
        # reliably preserve pointer coordinates across performActions calls,
        # and very long action arrays may never dispatch a trailing down/up.
        actions.human_move(el, algorithm=algorithm).perform()
        click_x = int(actions.curr_x)
        click_y = int(actions.curr_y)
        click_source_id = f"mouse-click-{random.randint(100000, 999999)}"
        driver = target._driver._browser_driver
        driver.run(
            "input.performActions",
            {
                "context": target._context_id,
                "actions": [
                    {
                        "type": "pointer",
                        "id": click_source_id,
                        "parameters": {"pointerType": "mouse"},
                        "actions": [
                            {
                                "type": "pointerMove",
                                "x": click_x,
                                "y": click_y,
                                "duration": random.randint(20, 60),
                            },
                            {"type": "pointerDown", "button": 0},
                            {"type": "pause", "duration": random.randint(40, 90)},
                            {"type": "pointerUp", "button": 0},
                        ],
                    }
                ],
            },
        )
        return {
            "clicked": True,
            "selector": selector,
            "target": target_metadata,
            "algorithm": algorithm,
            "pointerReset": True,
            "atomicPointer": True,
            "clickPoint": {"x": click_x, "y": click_y},
            "freshPointerSource": True,
        }

    def _human_click(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        algorithm = params.get("algorithm", "windmouse")
        raw_target = params.get("target")
        if isinstance(raw_target, dict) and "x" in raw_target and "y" in raw_target:
            el, selector = self._resolve_action_target(target, raw_target, "target")
            return self._pointer_click(
                target, el, algorithm, target_metadata, selector
            )

        selector = self._norm_selector(str(raw_target or ""))
        el = target.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {
                "found": False,
                "error": f"Element not found: {selector}",
                "target": target_metadata,
            }
        return self._pointer_click(target, el, algorithm, target_metadata, selector)

    def _human_scroll(self, params: dict) -> dict:
        """Perform small, one-direction native wheel steps with random pauses."""
        target, target_metadata = self._resolve_target(params)
        direction = str(params.get("direction", "down")).strip().lower()
        steps = int(params.get("steps", 4))
        min_step = int(params.get("minStep", 60))
        max_step = int(params.get("maxStep", 140))
        min_pause_ms = int(params.get("minPauseMs", 120))
        max_pause_ms = int(params.get("maxPauseMs", 500))

        if direction not in {"down", "up"}:
            raise ValueError("direction must be down or up")
        if not 1 <= steps <= 100:
            raise ValueError("steps must be between 1 and 100")
        if not 1 <= min_step <= max_step <= 2000:
            raise ValueError("minStep/maxStep must satisfy 1 <= minStep <= maxStep <= 2000")
        if not 0 <= min_pause_ms <= max_pause_ms <= 10000:
            raise ValueError(
                "minPauseMs/maxPauseMs must satisfy 0 <= minPauseMs <= maxPauseMs <= 10000"
            )

        viewport_x, viewport_y = target.rect.viewport_midpoint
        sign = 1 if direction == "down" else -1
        deltas = []
        pauses = []
        driver = target._driver._browser_driver
        for index in range(steps):
            delta = sign * random.randint(min_step, max_step)
            driver.run(
                "input.performActions",
                {
                    "context": target._context_id,
                    "actions": [
                        {
                            "type": "wheel",
                            "id": "wheel0",
                            "actions": [
                                {
                                    "type": "scroll",
                                    "x": int(viewport_x),
                                    "y": int(viewport_y),
                                    "deltaX": 0,
                                    "deltaY": delta,
                                }
                            ],
                        }
                    ],
                },
            )
            deltas.append(delta)
            if index + 1 < steps:
                pause_ms = random.randint(min_pause_ms, max_pause_ms)
                pauses.append(pause_ms)
                time.sleep(pause_ms / 1000.0)

        return {
            "scrolled": True,
            "direction": direction,
            "steps": steps,
            "deltas": deltas,
            "pausesMs": pauses,
            "totalDelta": sum(deltas),
            "nativeWheel": True,
            "target": target_metadata,
        }

    def _human_drag(self, params: dict) -> dict:
        """Perform one atomic, human-like pointer drag."""
        action_target, target_metadata = self._resolve_target(params)
        source, source_desc = self._resolve_action_target(
            action_target, params.get("source"), "source"
        )
        destination, destination_desc = self._resolve_action_target(
            action_target, params.get("target"), "target"
        )
        algorithm = str(params.get("algorithm", "bezier")).strip().lower()
        if algorithm not in {"bezier", "windmouse"}:
            raise ValueError("algorithm must be bezier or windmouse")
        style = self._normalize_human_style(params.get("style", "arc"))
        hold_ms = int(params.get("holdMs", 120))
        release_ms = int(params.get("releaseMs", 80))
        button = int(params.get("button", 0))

        if not 0 <= hold_ms <= 10000 or not 0 <= release_ms <= 10000:
            raise ValueError("holdMs and releaseMs must be between 0 and 10000")
        if button not in {0, 1, 2}:
            raise ValueError("button must be 0, 1, or 2")

        actions = action_target.actions
        try:
            chain = actions.move_to(source).hold(button=button)
            if hold_ms:
                chain.wait(hold_ms / 1000.0)
            chain.human_move(destination, algorithm=algorithm, style=style)
            if release_ms:
                chain.wait(release_ms / 1000.0)
            chain.release(button=button).perform()
        except Exception:
            try:
                actions.release_all()
            except Exception:
                pass
            raise

        return {
            "dragged": True,
            "source": source_desc,
            "destination": destination_desc,
            "target": target_metadata,
            "algorithm": algorithm,
            "style": style,
            "holdMs": hold_ms,
            "releaseMs": release_ms,
            "button": button,
        }

    def _human_input(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        selector = self._norm_selector(params["target"])
        text = params.get("text", "")
        delay_ms = params.get("delayMs", 50)

        el = target.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {
                "found": False,
                "error": f"Element not found: {selector}",
                "target": target_metadata,
            }

        # Type character by character with delay
        for char in text:
            el.input(char, clear=False)
            if delay_ms > 0:
                import time
                time.sleep(delay_ms / 1000.0)

        return {"input": True, "selector": selector, "target": target_metadata}

    # ------------------------------------------------------------------
    # Session export
    # ------------------------------------------------------------------
    def _export_session(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)

        case_id = str(params.get("caseId") or "").strip()
        if not _CASE_ID_PATTERN.fullmatch(case_id):
            raise ValueError(
                "caseId must match ^[a-z0-9][a-z0-9._-]{1,79}$"
            )
        handoff_id = str(params.get("handoffId") or "").strip()
        if not handoff_id:
            handoff_id = (
                f"handoff_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_"
                f"{uuid.uuid4().hex[:12]}"
            )
        if not _HANDOFF_ID_PATTERN.fullmatch(handoff_id):
            raise ValueError(
                "handoffId must match ^[a-z0-9][a-z0-9_-]{0,95}$"
            )

        workspace_value = str(params.get("workspaceRoot") or "").strip()
        workspace_root = Path(workspace_value).expanduser()
        if not workspace_root.is_absolute():
            raise ValueError("workspaceRoot must be an absolute project path")
        workspace_root = workspace_root.resolve()
        if not workspace_root.is_dir():
            raise ValueError("workspaceRoot must be an existing directory")
        repository_root = Path(__file__).resolve().parents[1]
        if _path_is_within(workspace_root, repository_root) or _path_is_within(
            repository_root, workspace_root
        ):
            raise ValueError(
                "workspaceRoot must be an external project workspace, not this repository"
            )

        raw_include = params.get("include", ["cookies"])
        if not isinstance(raw_include, list) or not raw_include:
            raise ValueError("include must be a non-empty array")
        include = [str(item) for item in raw_include]
        if len(set(include)) != len(include):
            raise ValueError("include must not contain duplicate state kinds")
        unsupported = sorted(set(include) - _HANDOFF_STATE_KINDS)
        if unsupported:
            raise ValueError(
                f"Unsupported handoff state kind(s): {', '.join(unsupported)}"
            )

        exported_at = _utc_timestamp()
        browser = self._browser_identity(params)
        local_head = _read_git_head(repository_root)
        proxy = _safe_proxy(self._proxy_url)
        connection_address, connection_port = self._current_connection(page)
        context_id = str(self._attribute(page, "_context_id", "") or "").strip()
        if not context_id:
            raise RuntimeError("Active page does not expose a browsing context ID")
        raw_url = str(self._attribute(page, "url", "") or "").strip()
        safe_url = _safe_url(raw_url)["url"]
        if not safe_url:
            raise RuntimeError("Active page URL is unavailable")

        raw_states: dict[str, tuple[dict, int]] = {}
        if "cookies" in include:
            raw_states["cookies"] = self._cookie_state(
                page_idx, raw_url, case_id, handoff_id, exported_at
            )
        if "storage" in include:
            raw_states["storage"] = self._storage_state(
                page, case_id, handoff_id, exported_at
            )

        relative_dir = Path("evidence") / "web" / "handoff" / handoff_id
        output_dir = (workspace_root / relative_dir).resolve()
        if not _path_is_within(output_dir, workspace_root):
            raise RuntimeError("handoff output escaped workspaceRoot")

        state_files: dict[str, dict] = {}
        artifact_names = {
            "cookies": ("cookies.json", "cookies-state"),
            "storage": ("storage.json", "storage-state"),
        }
        for state_kind in include:
            payload, record_count = raw_states[state_kind]
            filename, artifact_id = artifact_names[state_kind]
            absolute_path = output_dir / filename
            byte_count, sha256 = _write_json_atomic(absolute_path, payload)
            relative_path = (relative_dir / filename).as_posix()
            state_files[state_kind] = self._artifact_pointer(
                case_id=case_id,
                handoff_id=handoff_id,
                artifact_id=artifact_id,
                relative_path=relative_path,
                byte_count=byte_count,
                sha256=sha256,
                record_count=record_count,
            )

        connection: dict[str, Any] = {
            "mode": "attach" if self._attached_existing else "launch",
            "address": connection_address,
            "port": connection_port,
            "ownership": "external" if self._attached_existing else "control-plane",
        }
        profile_path = self._profile_path
        if (
            profile_path is not None
            and profile_path.is_absolute()
            and profile_path.exists()
            and _path_is_within(profile_path, workspace_root)
            and os.name == "nt"
        ):
            connection["profilePath"] = str(profile_path)

        capabilities = ["bidi-attach"]
        if "profilePath" in connection:
            capabilities.append("profile-clone")
        if "cookies" in state_files:
            capabilities.append("cookie-import")
        if proxy["mode"] != "direct":
            capabilities.append("proxy")
        capabilities.append("headless" if self._headless else "interactive")

        handoff: dict[str, Any] = {
            "schema": "browser-session-handoff.v1",
            "caseId": case_id,
            "handoffId": handoff_id,
            "exportedAt": exported_at,
            "source": {
                "service": CONTROL_PLANE_SERVICE,
                "publicBaseSha": PUBLIC_BASE_SHA,
                "localHeadSha": local_head,
            },
            "browser": browser,
            "connection": connection,
            "page": {"url": safe_url, "contextId": context_id},
            "stateFiles": state_files,
            "proxy": proxy,
            "capabilities": capabilities,
            "redaction": {
                "status": "allowlist-summary",
                "inlineSecrets": False,
            },
        }
        user_context_id = str(
            self._attribute(page, "_user_context_id", "") or ""
        ).strip()
        if user_context_id:
            handoff["page"]["userContextId"] = user_context_id

        # The handoff itself is an allowlisted control-plane document. Raw
        # values live only in the evidence files referenced above. Storage is
        # observation-only in v1 and is never advertised as importable.
        _write_json_atomic(output_dir / "browser-session-handoff.json", handoff)
        return handoff

    # ------------------------------------------------------------------
    # Debug (Firefox DevTools RDP via page.debugger)
    # ------------------------------------------------------------------
    def _debugger_is_started(self, page: Any) -> bool:
        return False

    def _start_page_debugger(self, page: Any) -> Any:
        raise RuntimeError("Native debugger is owned by the TypeScript RDP adapter")

    def _stop_page_debugger(self, page: Any, *, suppress_errors: bool = False) -> None:
        return

    def _stop_all_page_debuggers(self, *, suppress_errors: bool = False) -> None:
        first_error: Optional[Exception] = None
        for page in list(self.pages.values()):
            try:
                self._stop_page_debugger(page, suppress_errors=suppress_errors)
            except Exception as exc:
                if first_error is None:
                    first_error = exc
        if first_error is not None and not suppress_errors:
            raise first_error

    def _debug_page_idx(self, params: dict, default: int = 0) -> int:
        raw = params.get("pageIdx", default)
        if raw is None:
            raw = default
        if isinstance(raw, bool):
            raise ValueError("pageIdx must be a non-negative integer")
        if isinstance(raw, float) and not raw.is_integer():
            raise ValueError("pageIdx must be a non-negative integer")
        try:
            page_idx = int(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("pageIdx must be a non-negative integer") from exc
        if page_idx < 0:
            raise ValueError("pageIdx must be a non-negative integer")
        return page_idx

    def _require_debugger(self, params: dict) -> Any:
        page = self._get_page(self._debug_page_idx(params))
        if not self._debugger_is_started(page):
            if not self._debugger_server_enabled:
                raise RuntimeError(
                    "debugger RDP server was not started. Relaunch with enableDebugger=true "
                    "on ruyi_new_page (requires --start-debugger-server at Firefox launch)."
                )
            return self._start_page_debugger(page)
        return getattr(page, "debugger")

    def _debug_call(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        """Serialize debugger calls so shared RDP state cannot interleave."""
        with self._debugger_lock:
            return fn(*args, **kwargs)

    def _resolve_debug_source(
        self, dbg: Any, *, url: Any = None, source_actor: Any = None
    ) -> tuple[Any, str]:
        actor = str(source_actor or "").strip()
        source_url = str(url or "").strip()
        if actor:
            for source in self._debug_call(dbg.sources) or []:
                if str(getattr(source, "actor", "")) == actor:
                    return source, str(getattr(source, "url", "") or "")
            raise RuntimeError(f"unknown sourceActor {actor}")
        if not source_url:
            raise ValueError("url or sourceActor is required")
        return None, source_url

    def _set_native_breakpoint(
        self,
        dbg: Any,
        *,
        url: Any = None,
        source_actor: Any = None,
        line: Any,
        column: Any = None,
        condition: Any = None,
    ) -> Any:
        """Set a breakpoint, preserving an explicit source actor when needed."""
        source, source_url = self._resolve_debug_source(
            dbg, url=url, source_actor=source_actor
        )
        if source is None:
            return self._debug_call(
                dbg.set_breakpoint,
                source_url,
                int(line),
                column=None if column is None else int(column),
                condition=str(condition) if condition else None,
            )

        # ruyiPage's public set_breakpoint accepts a URL, while eval/blob and
        # duplicate inline sources require the actor as a second location key.
        connection = getattr(dbg, "connection", None)
        thread_actor = getattr(dbg, "thread_actor", None)
        if connection is None or not thread_actor:
            # Compatibility with lightweight fakes and older adapters that do
            # not expose the raw RDP connection.  URL-addressable sources can
            # still use the public API; actor-only sources fail closed below.
            if source_url:
                return self._debug_call(
                    dbg.set_breakpoint,
                    source_url,
                    int(line),
                    column=None if column is None else int(column),
                    condition=str(condition) if condition else None,
                )
            raise RuntimeError("ruyiPage debugger cannot address sourceActor directly")
        line_number = int(line)
        if line_number < 1:
            raise ValueError("line must be >= 1")
        if column is None:
            locate = getattr(dbg, "_breakpoint_positions", None)
            positions = self._debug_call(locate, source) if callable(locate) else {}
            columns = positions.get(str(line_number)) if isinstance(positions, dict) else None
            if not columns:
                raise RuntimeError(f"source line {line_number} is not breakable")
            column_number = int(sorted(columns)[0])
        else:
            column_number = int(column)
            if column_number < 0:
                raise ValueError("column must be >= 0")
        options = {"condition": str(condition)} if condition else {}
        self._debug_call(
            connection.request,
            thread_actor,
            "setBreakpoint",
            location={
                "sourceUrl": source_url,
                "sourceId": str(getattr(source, "actor", "")),
                "line": line_number,
                "column": column_number,
            },
            options=options,
        )
        if RuyiBreakpoint is None:
            return type("Breakpoint", (), {
                "url": source_url,
                "line": line_number,
                "column": column_number,
                "source_actor": str(getattr(source, "actor", "")),
                "condition": str(condition) if condition else None,
            })()
        native = RuyiBreakpoint(
            source_url,
            line_number,
            column_number,
            str(getattr(source, "actor", "")),
            str(condition) if condition else None,
        )
        private_breakpoints = getattr(dbg, "_breakpoints", None)
        if isinstance(private_breakpoints, list):
            private_breakpoints.append(native)
        return native

    def _record_breakpoint(
        self,
        native: Any,
        *,
        page_idx: int,
        mode: str,
        text: str = "",
        pattern: str = "",
    ) -> dict[str, Any]:
        with self._debugger_lock:
            breakpoint_id = str(self._next_breakpoint_id)
            self._next_breakpoint_id += 1
            info = {
                "breakpointId": breakpoint_id,
                "pageIdx": page_idx,
                "url": getattr(native, "url", "") or "",
                "sourceActor": getattr(native, "source_actor", "") or "",
                "line": getattr(native, "line", None),
                "column": getattr(native, "column", None),
                "condition": getattr(native, "condition", None),
                "mode": mode,
                "text": text,
                "pattern": pattern,
                "type": "native",
                "native": native,
            }
            self._native_breakpoints.append(info)
            return {key: value for key, value in info.items() if key != "native"}

    def _public_breakpoints(self) -> list[dict[str, Any]]:
        with self._debugger_lock:
            return [
                {key: value for key, value in item.items() if key != "native"}
                for item in self._native_breakpoints
            ]

    def _debug_enable(self, params: dict) -> dict:
        page_idx = self._debug_page_idx(params)
        page = self._get_page(page_idx)
        server_enabled_before = self._debugger_server_enabled
        requested_auto_resume = _MISSING
        if "autoResumeAfter" in params:
            requested_auto_resume = _normalize_auto_resume_after(
                params.get("autoResumeAfter")
            )
        supplied_port = None
        if "debuggerPort" in params:
            supplied_port = _normalize_debugger_port(params.get("debuggerPort"))
        if self._debugger_server_enabled and supplied_port is not None:
            if self._debugger_port not in (None, supplied_port):
                raise RuntimeError(
                    "debugger server is configured on a different port; relaunch or attach with the configured port"
                )
        elif not self._debugger_server_enabled and not self._attached_existing:
            raise RuntimeError(
                "debugger RDP server was not started. Relaunch with enableDebugger=true."
            )
        if supplied_port is not None:
            self._debugger_port = supplied_port
        if requested_auto_resume is not _MISSING:
            self._debugger_auto_resume_after = requested_auto_resume
        if not self._debugger_server_enabled:
            # An attached browser may have been started with its own RDP
            # server; it is allowed to provide that port explicitly.  An owned
            # browser without enableDebugger=true must fail closed.
            if not self._attached_existing or self._debugger_port is None:
                raise RuntimeError(
                    "debugger RDP server was not started. Relaunch with enableDebugger=true."
                )
            self._debugger_server_enabled = True
        if self._debugger_port is None:
            raise RuntimeError(
                "debugger RDP port is not configured"
            )
        self._debugger_enabled = True
        try:
            dbg = self._start_page_debugger(page)
        except Exception:
            self._debugger_enabled = False
            if not server_enabled_before:
                # An attach caller supplied a candidate RDP port, but the
                # endpoint did not accept the connection. Do not retain a
                # false capability bit for a later debugger call.
                self._debugger_server_enabled = False
            raise
        # page.debugger reads this private value when arming the watchdog;
        # update it for an already-connected session as well.
        if hasattr(dbg, "_auto_resume_after"):
            dbg._auto_resume_after = self._debugger_auto_resume_after
            if getattr(dbg, "paused", False):
                if self._debugger_auto_resume_after and hasattr(dbg, "_arm_watchdog"):
                    dbg._arm_watchdog()
                elif hasattr(dbg, "_disarm_watchdog"):
                    # ruyiPage's _arm_watchdog() returns early for None/0 and
                    # deliberately does not cancel an already armed timer.
                    # Explicitly disarm when a caller turns the watchdog off.
                    dbg._disarm_watchdog()
        sources = []
        try:
            sources = [_source_to_dict(item) for item in (self._debug_call(dbg.sources) or [])]
        except Exception as exc:
            self._stop_page_debugger(page, suppress_errors=True)
            self._debugger_enabled = False
            raise RuntimeError(f"debugger connected but source enumeration failed: {exc}") from exc
        return self._with_debug_evidence("debug.enable", {
            "started": True,
            "serverEnabled": self._debugger_server_enabled,
            "port": self._debugger_port,
            "paused": bool(getattr(dbg, "paused", False)),
            "sourceCount": len(sources),
        })

    def _debug_disable(self, params: dict) -> dict:
        # The RDP channel is a bridge-wide capability. Stop every connected
        # page so native breakpoint objects cannot survive with stale actors.
        errors: list[str] = []
        try:
            self._stop_all_page_debuggers(suppress_errors=False)
        except Exception as exc:
            errors.append(str(exc))
            self._stop_all_page_debuggers(suppress_errors=True)
        if self.page is not None and not self.pages:
            try:
                self._stop_page_debugger(self.page, suppress_errors=False)
            except Exception as exc:
                errors.append(str(exc))
        self._debugger_enabled = False
        with self._debugger_lock:
            for item in self._native_breakpoints:
                item.pop("native", None)
            self._native_breakpoints = []
        result: dict[str, Any] = {
            "started": False,
            "paused": False,
            "breakpointCount": 0,
        }
        if errors:
            result["warnings"] = errors[:5]
        return self._with_debug_evidence("debug.disable", result)

    def _debug_status(self, params: dict) -> dict:
        page_idx = self._debug_page_idx(params)
        page = self._get_page(page_idx)
        dbg = getattr(page, "debugger", None)
        started = bool(dbg is not None and getattr(dbg, "started", False))
        paused = bool(started and getattr(dbg, "paused", False))
        state = getattr(dbg, "paused_state", None) if started else None
        return self._with_debug_evidence("debug.status", {
            "enabled": self._debugger_enabled,
            "serverEnabled": self._debugger_server_enabled,
            "started": started,
            "port": self._debugger_port,
            "paused": paused,
            "pausedState": _paused_to_dict(state) if state is not None else None,
            "breakpointCount": sum(
                1 for item in self._public_breakpoints()
                if item.get("pageIdx") == page_idx
            ),
        })

    def _debug_sources(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        url_contains = str(params.get("urlContains") or params.get("filter") or "").strip() or None
        sources = self._debug_call(
            dbg.sources, url_contains=url_contains
        ) if url_contains else self._debug_call(dbg.sources)
        source_actor = str(params.get("sourceActor") or "").strip()
        if source_actor:
            sources = [
                source for source in sources or []
                if str(getattr(source, "actor", "") or "") == source_actor
            ]
        return self._with_debug_evidence(
            "debug.sources",
            {"sources": [_source_to_dict(item) for item in (sources or [])]},
        )

    def _debug_source_text(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        source_actor = str(params.get("sourceActor") or "").strip()
        source_url = str(params.get("url") or "").strip()
        if source_actor and source_url:
            raise ValueError("url and sourceActor are mutually exclusive")
        source, source_url = self._resolve_debug_source(
            dbg, url=source_url, source_actor=source_actor
        )
        text = self._debug_call(
            dbg.source_text, source if source is not None else source_url
        )
        if not isinstance(text, str):
            raise RuntimeError("debugger source_text did not return a string")
        total_length = len(text)
        offset = params.get("offset")
        max_chars_raw = params.get("maxChars", 16384)
        try:
            max_chars = int(max_chars_raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("maxChars must be an integer between 0 and 8000000") from exc
        if not 0 <= max_chars <= 8_000_000:
            raise ValueError("maxChars must be an integer between 0 and 8000000")

        if offset is not None:
            try:
                offset_value = int(offset)
            except (TypeError, ValueError) as exc:
                raise ValueError("offset must be a non-negative integer") from exc
            if offset_value < 0:
                raise ValueError("offset must be a non-negative integer")
            text = text[offset_value:]
        start_line = params.get("startLine")
        end_line = params.get("endLine")
        if offset is None and (start_line is not None or end_line is not None):
            lines = text.splitlines()
            start_value = int(start_line or 1)
            if start_value < 1:
                raise ValueError("startLine must be >= 1")
            start = start_value - 1
            end_value = int(end_line or (start_value + 199))
            if end_value < start_value:
                raise ValueError("endLine must be >= startLine")
            end = min(end_value, len(lines))
            text = "\n".join(lines[start:end])
        selected_length = len(text)
        truncated = selected_length > max_chars
        return self._with_debug_evidence("debug.source_text", {
            "ok": True,
            "url": source_url,
            "sourceActor": str(getattr(source, "actor", "") or source_actor),
            "totalLength": total_length,
            "selectedLength": selected_length,
            "truncated": truncated,
            "source": text[:max_chars] if truncated else text,
        })

    def _debug_search(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        query = str(params.get("query") or params.get("text") or "")
        if not query:
            raise ValueError("query is required")
        url_contains = str(params.get("urlContains") or params.get("urlFilter") or "").strip() or None
        case_sensitive = bool(params.get("caseSensitive"))
        needle = query if case_sensitive else query.lower()
        try:
            max_matches = int(params.get("maxMatches", 20))
        except (TypeError, ValueError) as exc:
            raise ValueError("maxMatches must be an integer between 1 and 200") from exc
        if not 1 <= max_matches <= 200:
            raise ValueError("maxMatches must be an integer between 1 and 200")
        sources = self._debug_call(
            dbg.sources, url_contains=url_contains
        ) if url_contains else self._debug_call(dbg.sources)
        matches: list[dict[str, Any]] = []
        for source in sources or []:
            try:
                body = self._debug_call(dbg.source_text, source)
            except Exception:
                continue
            if not isinstance(body, str):
                continue
            for line_no, line in enumerate(body.splitlines(), 1):
                haystack = line if case_sensitive else line.lower()
                column = haystack.find(needle)
                if column < 0:
                    continue
                matches.append(
                    {
                        "url": getattr(source, "url", "") or "",
                        "sourceActor": getattr(source, "actor", "") or "",
                        "line": line_no,
                        "column": column,
                        "preview": line[:240],
                    }
                )
                if len(matches) >= max_matches:
                    return self._with_debug_evidence(
                        "debug.search", {"matches": matches, "truncated": True}
                    )
        return self._with_debug_evidence(
            "debug.search", {"matches": matches, "truncated": False}
        )

    def _debug_set_breakpoint(self, params: dict) -> dict:
        page_idx = self._debug_page_idx(params)
        dbg = self._require_debugger({**params, "pageIdx": page_idx})
        url = str(params.get("url") or "").strip()
        source_actor = str(params.get("sourceActor") or "").strip()
        line = params.get("line")
        if url and source_actor:
            raise ValueError("url and sourceActor are mutually exclusive")
        if (not url and not source_actor) or line is None:
            raise ValueError("url or sourceActor, and line, are required")
        native = self._set_native_breakpoint(
            dbg,
            url=url,
            source_actor=source_actor,
            line=line,
            column=params.get("column"),
            condition=params.get("condition") or None,
        )
        return self._with_debug_evidence(
            "debug.set_breakpoint",
            self._record_breakpoint(native, page_idx=page_idx, mode="location"),
        )

    def _debug_set_breakpoint_on_text(self, params: dict) -> dict:
        page_idx = self._debug_page_idx(params)
        dbg = self._require_debugger({**params, "pageIdx": page_idx})
        text = str(params.get("text") or "")
        if not text:
            raise ValueError("text is required")
        url_filter = str(params.get("urlFilter") or "").strip() or None
        source_actor_filter = str(params.get("sourceActor") or "").strip() or None
        sources = self._debug_call(
            dbg.sources, url_contains=url_filter
        ) if url_filter else self._debug_call(dbg.sources)
        if source_actor_filter:
            sources = [
                source for source in sources or []
                if str(getattr(source, "actor", "") or "") == source_actor_filter
            ]
        for source in sources or []:
            try:
                body = self._debug_call(dbg.source_text, source)
            except Exception:
                continue
            if not isinstance(body, str):
                continue
            for line_no, line in enumerate(body.splitlines(), 1):
                if text not in line:
                    continue
                native = self._set_native_breakpoint(
                    dbg,
                    url=getattr(source, "url", "") or None,
                    source_actor=getattr(source, "actor", "") or None,
                    line=line_no,
                    condition=params.get("condition") or None,
                )
                return self._with_debug_evidence(
                    "debug.set_breakpoint_on_text",
                    self._record_breakpoint(
                        native,
                        page_idx=page_idx,
                        mode="text",
                        text=text,
                        pattern=url_filter or "",
                    ),
                )
        raise RuntimeError(
            f"no loaded source contained {text!r}"
            + (f" under urlFilter={url_filter!r}" if url_filter else "")
        )

    def _debug_break_on_xhr(self, params: dict) -> dict:
        """Set a native XHR breakpoint, with an explicit legacy fallback."""
        page_idx = self._debug_page_idx(params)
        dbg = self._require_debugger({**params, "pageIdx": page_idx})
        pattern = str(params.get("url") or params.get("pattern") or params.get("text") or "")
        if not pattern:
            raise ValueError("url is required")
        method = str(params.get("method") or "ANY").strip().upper() or "ANY"
        native_xhr = getattr(dbg, "set_xhr_breakpoint", None)
        if callable(native_xhr):
            applied = self._debug_call(native_xhr, pattern, method)
            if not applied:
                return self._with_debug_evidence(
                    "debug.break_on_xhr",
                    {
                        "ok": False,
                        "reason": "xhr-breakpoint-rejected",
                        "heuristic": False,
                        "verifiedRequestBreakpoint": False,
                        "pattern": pattern,
                        "method": method,
                    },
                )
            native = type(
                "XhrBreakpoint",
                (),
                {
                    "url": pattern,
                    "line": None,
                    "column": None,
                    "source_actor": "",
                    "condition": None,
                    "xhr_path": pattern,
                    "xhr_method": method,
                },
            )()
            item = self._record_breakpoint(
                native,
                page_idx=page_idx,
                mode="xhr-native",
                text=f"xhr:{pattern}",
                pattern=pattern,
            )
            return self._with_debug_evidence(
                "debug.break_on_xhr",
                {
                    "ok": True,
                    "heuristic": False,
                    "verifiedRequestBreakpoint": True,
                    "breakpoints": [item],
                    "method": method,
                },
            )
        sources = self._debug_call(dbg.sources)
        planted: list[dict[str, Any]] = []
        for source in sources or []:
            try:
                body = self._debug_call(dbg.source_text, source)
            except Exception:
                continue
            if not isinstance(body, str) or pattern not in body:
                continue
            for line_no, line in enumerate(body.splitlines(), 1):
                if pattern not in line:
                    continue
                native = self._set_native_breakpoint(
                    dbg,
                    url=getattr(source, "url", "") or None,
                    source_actor=getattr(source, "actor", "") or None,
                    line=line_no,
                )
                planted.append(
                    self._record_breakpoint(
                        native,
                        page_idx=page_idx,
                        mode="xhr",
                        text=f"xhr:{pattern}",
                        pattern=pattern,
                    )
                )
        if not planted:
            return self._with_debug_evidence(
                "debug.break_on_xhr",
                {
                    "ok": False,
                    "reason": "xhr-breakpoint-unresolved",
                    "heuristic": True,
                    "verifiedRequestBreakpoint": False,
                    "pattern": pattern,
                    "hint": "no loaded source mentioned this URL; use ruyi_debug_set_breakpoint_on_text on the issuer",
                },
            )
        return self._with_debug_evidence(
            "debug.break_on_xhr",
            {
                "ok": True,
                "heuristic": True,
                "verifiedRequestBreakpoint": False,
                "breakpoints": planted,
                "method": method,
            },
        )

    def _debug_remove_breakpoint(self, params: dict) -> dict:
        breakpoint_id = str(params.get("breakpointId") or "")
        with self._debugger_lock:
            match = next(
                (
                    item for item in self._native_breakpoints
                    if item["breakpointId"] == breakpoint_id
                ),
                None,
            )
        if match is None:
            raise RuntimeError(f"unknown breakpointId {breakpoint_id}")
        owner_page_idx = int(match.get("pageIdx", 0))
        requested_page = params.get("pageIdx")
        if requested_page is not None and self._debug_page_idx(params) != owner_page_idx:
            raise RuntimeError(
                f"breakpoint {breakpoint_id} belongs to pageIdx {owner_page_idx}"
            )
        dbg = self._require_debugger({**params, "pageIdx": owner_page_idx})
        native = match.get("native")
        if match.get("mode") == "xhr-native":
            remove_xhr = getattr(dbg, "remove_xhr_breakpoint", None)
            if not callable(remove_xhr):
                raise RuntimeError("active debugger cannot remove native XHR breakpoint")
            removed = self._debug_call(
                remove_xhr,
                getattr(native, "xhr_path", ""),
                getattr(native, "xhr_method", "ANY"),
            )
            if removed is False:
                raise RuntimeError("native XHR breakpoint removal was rejected")
        elif native is not None:
            self._debug_call(dbg.remove_breakpoint, native)
        with self._debugger_lock:
            self._native_breakpoints = [
                item for item in self._native_breakpoints
                if item["breakpointId"] != breakpoint_id
            ]
        return self._with_debug_evidence(
            "debug.remove_breakpoint", {"removed": breakpoint_id}
        )

    def _debug_list_breakpoints(self, params: dict) -> dict:
        raw_page = params.get("pageIdx")
        if raw_page is None:
            return self._with_debug_evidence(
                "debug.list_breakpoints", {"breakpoints": self._public_breakpoints()}
            )
        page_idx = self._debug_page_idx(params)
        return self._with_debug_evidence("debug.list_breakpoints", {
            "pageIdx": page_idx,
            "breakpoints": [
                item for item in self._public_breakpoints()
                if item.get("pageIdx") == page_idx
            ],
        })

    def _debug_wait_paused(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        raw_timeout = params.get("timeout", 30)
        try:
            timeout = float(raw_timeout)
        except (TypeError, ValueError) as exc:
            raise ValueError("timeout must be a finite number between 0 and 120") from exc
        if not math.isfinite(timeout) or not 0 <= timeout <= 120:
            raise ValueError("timeout must be a finite number between 0 and 120")
        state = dbg.wait_paused(timeout=timeout)
        if state is None:
            return self._with_debug_evidence(
                "debug.wait_paused", {"paused": False, "timedOut": True}
            )
        return self._with_debug_evidence(
            "debug.wait_paused",
            {"paused": True, "timedOut": False, "state": _paused_to_dict(state)},
        )

    def _debug_get_paused_info(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        state = getattr(dbg, "paused_state", None)
        if state is None:
            return self._with_debug_evidence(
                "debug.get_paused_info", {"paused": False}
            )
        frames = []
        try:
            frames = [_frame_to_dict(item) for item in (
                self._debug_call(dbg.frames, count=20) or []
            )]
        except Exception:
            if getattr(state, "frame", None) is not None:
                frames = [_frame_to_dict(state.frame)]
        return self._with_debug_evidence("debug.get_paused_info", {
            "paused": True,
            "state": _paused_to_dict(state),
            "frames": frames,
        })

    def _debug_pause(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        self._debug_call(dbg.pause)
        return self._with_debug_evidence("debug.pause", {"paused": True})

    def _debug_resume(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        self._debug_call(dbg.resume)
        return self._with_debug_evidence("debug.resume", {"paused": False})

    def _debug_step(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        step_type = str(params.get("type") or params.get("step") or "over").strip().lower()
        if step_type in {"over", "next"}:
            self._debug_call(dbg.step_over)
            resolved = "over"
        elif step_type in {"into", "in", "step"}:
            self._debug_call(dbg.step_into)
            resolved = "into"
        elif step_type in {"out", "finish"}:
            self._debug_call(dbg.step_out)
            resolved = "out"
        else:
            raise ValueError("type must be over, into, or out")
        return self._with_debug_evidence(
            "debug.step",
            {"step": resolved, "paused": bool(getattr(dbg, "paused", False))},
        )

    def _debug_frames(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        count = int(params.get("count", 50))
        if not 1 <= count <= 80:
            raise ValueError("count must be an integer between 1 and 80")
        frames = self._debug_call(dbg.frames, count=count)
        return self._with_debug_evidence(
            "debug.frames", {"frames": [_frame_to_dict(item) for item in (frames or [])]}
        )

    def _debug_scope(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        frame = params.get("frameActor") or params.get("frame")
        include_parents = bool(params.get("includeParents"))
        scope = self._debug_call(
            dbg.scope, frame=frame, include_parents=include_parents
        )
        serialized = _debugger_value(scope)
        return self._with_debug_evidence("debug.scope", {
            "scope": serialized,
            "keyCount": len(scope) if isinstance(scope, dict) else None,
        })

    def _debug_expand(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        actor = params.get("actor") or params.get("object")
        if not actor:
            raise ValueError("actor is required")
        depth = int(params.get("depth", 1))
        max_items = int(params.get("maxItems", 80))
        if not 1 <= depth <= 3:
            raise ValueError("depth must be an integer between 1 and 3")
        if not 1 <= max_items <= 200:
            raise ValueError("maxItems must be an integer between 1 and 200")
        expanded = self._debug_call(
            dbg.expand, actor, depth=depth, max_items=max_items
        )
        return self._with_debug_evidence(
            "debug.expand", {"value": _debugger_value(expanded)}
        )

    def _debug_pause_on_exceptions(self, params: dict) -> dict:
        dbg = self._require_debugger(params)
        enabled = bool(params.get("enabled", True))
        ignore_caught = bool(params.get("ignoreCaught", True))
        self._debug_call(
            dbg.pause_on_exceptions, enabled=enabled, ignore_caught=ignore_caught
        )
        return self._with_debug_evidence(
            "debug.pause_on_exceptions",
            {"enabled": enabled, "ignoreCaught": ignore_caught},
        )

    # ------------------------------------------------------------------
    # Frame
    # ------------------------------------------------------------------
    def _frame_list(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        try:
            frames = self._frames_for_page(page)
            result = []
            for f in (frames or []):
                try:
                    item = self._target_metadata(f, page_idx, "frame")
                    item["title"] = str(self._attribute(f, "title", ""))[:512]
                    result.append(item)
                except Exception:
                    result.append({"error": str(f)[:200]})
            return {"frames": result}
        except Exception as e:
            return {"frames": [], "error": str(e)}

    def _frame_select(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        context_id = params.get("contextId", "")
        selector = params.get("selector", "")
        try:
            if bool(context_id) == bool(selector):
                raise ValueError("Exactly one of contextId or selector is required")
            if context_id:
                matches = self._frames_for_page(page, str(context_id))
                frame = matches[0] if matches else None
                selected_by = "contextId"
            else:
                normalized_selector = self._norm_selector(selector)
                candidate = page.get_frame(locator=normalized_selector)
                candidate_context_id = str(
                    self._attribute(candidate, "_context_id", "")
                )
                matches = self._frames_for_page(page, candidate_context_id)
                frame = matches[0] if matches else None
                selected_by = "selector"
            if frame is None:
                return {"found": False, "selectedBy": selected_by}
            target = self._target_metadata(frame, page_idx, "frame")
            cid = target["contextId"]
            return {
                "found": True,
                "contextId": cid,
                "selectedBy": selected_by,
                "url": target["url"],
                "queryKeys": target["queryKeys"],
                "title": str(self._attribute(frame, "title", ""))[:512],
                "isCrossOrigin": target["isCrossOrigin"],
                "target": target,
            }
        except Exception as e:
            return {"found": False, "error": str(e)}

    # ------------------------------------------------------------------
    # Intercept
    # ------------------------------------------------------------------
    def _intercept_metadata(self, request: Any) -> dict:
        raw_request = self._attribute(request, "_request", None)
        raw_response = self._attribute(request, "_response_raw", None)
        request_id = self._attribute(request, "request_id", "")
        url = _safe_url(self._attribute(request, "url", ""))
        request_headers = self._attribute(request, "headers", None)
        response_headers = self._attribute(request, "response_headers", None)
        if request_headers is None and isinstance(raw_request, dict):
            request_headers = raw_request.get("headers", {})
        if response_headers is None and isinstance(raw_response, dict):
            response_headers = raw_response.get("headers", {})

        return {
            "url": url["url"],
            "queryKeys": url["queryKeys"],
            "method": str(self._attribute(request, "method", "") or ""),
            "isResponsePhase": bool(
                self._attribute(request, "is_response_phase", False)
            ),
            "responseStatus": self._attribute(request, "response_status", None),
            "requestIdHash": _sha256_text(request_id) if request_id else None,
            "requestHeaders": _safe_headers(request_headers),
            "responseHeaders": _safe_headers(response_headers),
            "requestBody": {"state": "not_requested"},
            "responseBody": {"state": "not_requested"},
        }

    def _read_collector_body(
        self, packet: Any, collector: Any, direction: str, timeout: float
    ) -> str | None:
        request_id = self._attribute(packet, "request_id", "")
        if not collector or not request_id:
            return None

        deadline = time.monotonic() + timeout
        while True:
            try:
                data = collector.get(request_id, data_type=direction)
                for name in ("base64", "bytes"):
                    decoded = self._decode_packet_body_value(
                        packet, self._attribute(data, name, None)
                    )
                    if decoded is not None:
                        return self._body_text(decoded)
                raw = self._attribute(data, "raw", None)
                if isinstance(raw, dict):
                    for key in ("data", "body", "value"):
                        decoded = self._decode_packet_body_value(packet, raw.get(key))
                        if decoded is not None:
                            return self._body_text(decoded)
            except Exception:
                pass

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            time.sleep(min(0.05, remaining))

    def _intercept_start_req(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        patterns = params.get("urlPatterns")
        result_mode = _normalize_result_mode(params.get("resultMode"))
        try:
            page.intercept.start_requests(
                None,
                url_patterns=patterns,
                collect_response=result_mode != "metadata",
            )
            self._intercept_modes[page_idx] = result_mode
            return {
                "intercepting": True,
                "phase": "request",
                "patterns": patterns,
                "resultMode": result_mode,
            }
        except Exception as e:
            return {"intercepting": False, "error": str(e)}

    def _intercept_start_resp(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        patterns = params.get("urlPatterns")
        result_mode = _normalize_result_mode(params.get("resultMode"))
        try:
            page.intercept.start_responses(
                None,
                url_patterns=patterns,
                collect_response=result_mode != "metadata",
            )
            self._intercept_modes[page_idx] = result_mode
            return {
                "intercepting": True,
                "phase": "response",
                "patterns": patterns,
                "resultMode": result_mode,
            }
        except Exception as e:
            return {"intercepting": False, "error": str(e)}

    def _continue_intercept(self, request: Any, is_response_phase: bool) -> str:
        if self._attribute(request, "handled", False):
            return "alreadyHandled"
        method_name = "continue_response" if is_response_phase else "continue_request"
        method = self._attribute(request, method_name, None)
        if not callable(method):
            raise RuntimeError(f"intercept request has no {method_name} method")
        method()
        return method_name

    def _read_intercept_body(
        self, request: Any, direction: str, timeout: float
    ) -> str | None:
        source_name = "_request" if direction == "request" else "_response_raw"
        collector_name = "_collector" if direction == "request" else "_response_collector"
        source = self._attribute(request, source_name, None)
        direct = source.get("body") if isinstance(source, dict) else None
        if direct is None and direction == "request":
            params = self._attribute(request, "_params", None)
            if isinstance(params, dict):
                direct = params.get("body")
        decoded = self._decode_packet_body_value(request, direct)
        if decoded is not None:
            return self._body_text(decoded)
        return self._read_collector_body(
            request,
            self._attribute(request, collector_name, None),
            direction,
            timeout,
        )

    def _intercept_wait(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        result_mode = _normalize_result_mode(
            params.get("resultMode"),
            default=self._intercept_modes.get(page_idx, "metadata"),
        )
        if (
            result_mode != "metadata"
            and self._intercept_modes.get(page_idx, "metadata") == "metadata"
        ):
            raise ValueError(
                "intercept body collection was disabled at start; restart interception "
                "with resultMode=schema or resultMode=body"
            )
        output_file = (
            self._body_output_file(params) if result_mode == "body" else None
        )
        body_read_timeout = self._body_read_timeout(params)
        max_body_chars = int(params.get("maxBodyChars", 0) or 0)
        if max_body_chars < 0:
            raise ValueError("maxBodyChars must be >= 0")
        timeout = params.get("timeout", 10)
        try:
            req = page.intercept.wait(timeout=timeout)
            if req is None:
                return {"timedOut": True, "resultMode": result_mode}

            result = self._intercept_metadata(req)
            result["continued"] = self._continue_intercept(
                req, result["isResponsePhase"]
            )
            if result_mode != "metadata":
                request_body = self._read_intercept_body(
                    req, "request", body_read_timeout
                )
                response_body = self._read_intercept_body(
                    req, "response", body_read_timeout
                )
                request_schema = _body_schema(
                    request_body,
                    result["requestHeaders"].get("content-type"),
                )
                response_schema = _body_schema(
                    response_body,
                    result["responseHeaders"].get("content-type"),
                )
                result["requestBody"] = request_schema
                result["responseBody"] = response_schema
                if output_file is not None:
                    request_value, request_truncated = self._body_for_file(
                        request_body, max_body_chars
                    )
                    response_value, response_truncated = self._body_for_file(
                        response_body, max_body_chars
                    )
                    self._append_jsonl(
                        output_file,
                        [{
                            **result,
                            "requestBody": request_value,
                            "responseBody": response_value,
                            "requestBodySchema": request_schema,
                            "responseBodySchema": response_schema,
                            "requestBodyTruncated": request_truncated,
                            "responseBodyTruncated": response_truncated,
                        }],
                    )
            result["resultMode"] = result_mode
            result["savedTo"] = output_file
            return result
        except Exception as e:
            return {"timedOut": True, "error": str(e)}

    def _intercept_stop(self, params: dict) -> dict:
        page_idx = self._normalize_page_idx(params.get("pageIdx", 0))
        page = self._get_page(page_idx)
        try:
            page.intercept.stop()
        except Exception:
            pass
        self._intercept_modes.pop(page_idx, None)
        return {"intercepting": False}

    # ------------------------------------------------------------------
    # WebSocket
    # ------------------------------------------------------------------
    def _ws_inject(self, params: dict) -> dict:
        """Inject WebSocket Proxy to capture messages into window.__ruyi_ws_messages."""
        page = self._get_page(params.get("pageIdx", 0))
        script = """() => {
            if (window.__ruyi_ws_injected) {
                return { injected: false, status: 'already_injected', buffered: (window.__ruyi_ws_messages || []).length };
            }
            window.__ruyi_ws_messages = window.__ruyi_ws_messages || [];
            window.__ruyi_ws_injected = true;
            const OrigWS = window.WebSocket;
            const RuyiWebSocket = function(url, protocols) {
                const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
                const entry = { url: String(url), startTime: Date.now(), sent: [], received: [] };
                window.__ruyi_ws_messages.push(entry);
                const origSend = ws.send;
                ws.send = function(data) {
                    entry.sent.push({
                        time: Date.now(),
                        data: typeof data === 'string' ? data : '[binary]',
                    });
                    return origSend.call(this, data);
                };
                ws.addEventListener('message', function(e) {
                    entry.received.push({
                        time: Date.now(),
                        data: typeof e.data === 'string' ? e.data : '[binary]',
                    });
                });
                return ws;
            };
            RuyiWebSocket.prototype = OrigWS.prototype;
            Object.defineProperty(RuyiWebSocket.prototype, 'constructor', { value: OrigWS, configurable: true });
            for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
                Object.defineProperty(RuyiWebSocket, key, { value: OrigWS[key], configurable: true });
            }
            Object.defineProperty(RuyiWebSocket, 'name', { value: 'WebSocket', configurable: true });
            Object.defineProperty(RuyiWebSocket, 'length', { value: OrigWS.length, configurable: true });
            window.WebSocket = RuyiWebSocket;
            return { injected: true };
        }"""
        try:
            result = page.run_js(f"({script})()", timeout=5)
            return {"injected": True, "status": str(result)}
        except Exception as e:
            return {"injected": False, "error": str(e)}

    def _ws_collect(self, params: dict) -> dict:
        """Read collected WebSocket messages."""
        page = self._get_page(params.get("pageIdx", 0))
        clear = params.get("clear", False)
        script = (
            "() => {"
            "  const msgs = window.__ruyi_ws_messages || [];"
            f"  if ({json.dumps(clear)}) {{ window.__ruyi_ws_messages = []; }}"
            "  return msgs;"
            "}"
        )
        try:
            result = page.run_js(f"({script})()", timeout=5)
            return {"messages": _serialize(result)}
        except Exception as e:
            return {"messages": [], "error": str(e)}

    # ------------------------------------------------------------------
    # Main dispatch
    # ------------------------------------------------------------------
    def handle(self, request: dict) -> dict:
        req_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params", {})

        # Notification (fire-and-forget)
        if req_id is None:
            handler = self._handlers.get(method)
            if handler:
                try:
                    handler(params)
                except Exception:
                    pass
            return {}  # No response for notifications

        handler = self._handlers.get(method)
        if not handler:
            return self._err(req_id, -32601, f"Unknown method: {method}")

        try:
            result = handler(params)
            return self._ok(req_id, result)
        except Exception as e:
            return self._err(req_id, -32000, str(e), exc_info=True)

    def run(self):
        """Main loop: read JSON-RPC lines from stdin, write responses to stdout."""
        # Signal readiness
        sys.stderr.write("[ruyi_bridge] Ready\n")
        sys.stderr.flush()

        try:
            for line in sys.stdin:
                if self._shutdown_requested:
                    break
                line = line.strip()
                if not line:
                    continue

                try:
                    request = json.loads(line)
                except json.JSONDecodeError as e:
                    sys.stderr.write(f"[ruyi_bridge] Invalid JSON: {e}\n")
                    sys.stderr.flush()
                    continue

                # Special: shutdown signal. Cleanup stays in the common
                # finally path so explicit shutdown, stdin EOF, and read/write
                # failures all preserve the same browser ownership contract.
                if request.get("method") == "__shutdown__":
                    self._shutdown_requested = True
                    if request.get("id") is not None:
                        self._write_rpc_response(
                            self._ok(request.get("id"), {"shutdown": True})
                        )
                    break

                if request.get("id") is not None and request.get("method") in _ASYNC_METHODS:
                    self._dispatch_async(request)
                    continue

                response = self.handle(request)

                # Don't write response for notifications
                if request.get("id") is not None:
                    self._write_rpc_response(response)
        finally:
            self._quit({})
            self._join_workers()
            sys.stderr.write("[ruyi_bridge] Shutdown complete\n")
            sys.stderr.flush()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    bridge = RuyiBridge()
    bridge.run()
