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
import ipaddress
import math
import random
import time
import tempfile
import hashlib
import re
import uuid
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
    RUYIPAGE_AVAILABLE = True
except ImportError:
    RUYIPAGE_AVAILABLE = False
    FirefoxPage = None  # type: ignore
    FirefoxOptions = None  # type: ignore
    Settings = None  # type: ignore
    NoneElement = None  # type: ignore


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
    if isinstance(obj, (int, float)):
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


_RESULT_MODES = frozenset({"metadata", "schema", "body"})
_CAPTURE_STOP_MODES = frozenset({"discard", "metadata"})
_HANDOFF_STATE_KINDS = frozenset({"cookies", "storage"})
_CASE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")
_HANDOFF_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,95}$")
_GIT_SHA_PATTERN = re.compile(r"^[a-f0-9]{7,40}$")
_COOKIE_NAME_PATTERN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,4096}$")
_COOKIE_DOMAIN_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
PUBLIC_BASE_SHA = "788d7af28dd9ec4e91d79470cd30030aac3f8aba"
CONTROL_PLANE_SERVICE = "ruyi-mcp-reverse-env"
_HEADER_ALLOWLIST = frozenset({
    "content-type",
    "content-length",
    "content-encoding",
    "cache-control",
    "etag",
    "last-modified",
})


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
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
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

        self._handlers = {
            # Browser lifecycle
            "browser.launch":        self._launch,
            "browser.quit":          self._quit,
            "browser.status":        self._status,
            # Page management
            "page.navigate":         self._navigate,
            "page.new":              self._new_tab,
            "page.close":            self._close_tab,
            "page.select":           self._select_tab,
            "page.list":             self._list_tabs,
            "page.reload":           self._reload,
            "page.screenshot":       self._screenshot,
            "page.clear_data":       self._clear_data,
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
            # Debug (soft breakpoints)
            "debug.set_breakpoint":  self._set_breakpoint,
            "debug.remove_breakpoint": self._remove_breakpoint,
            "debug.list_breakpoints":  self._list_breakpoints,
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

        profile_path, profile_mode = self._prepare_profile(params, existing_only)
        try:
            if profile_path is not None:
                opts.set_profile(str(profile_path))

            # Fingerprint — smart_fingerprint needs proxy info
            fp = params.get("fingerprint")
            if fp:
                fp_kwargs = {}
                if fp.get("proxyHost"):
                    fp_kwargs["proxy_host"] = fp["proxyHost"]
                if fp.get("proxyPort"):
                    fp_kwargs["proxy_port"] = int(fp["proxyPort"])
                if fp.get("proxyUser"):
                    fp_kwargs["proxy_user"] = fp["proxyUser"]
                if fp.get("proxyPwd"):
                    fp_kwargs["proxy_pwd"] = fp["proxyPwd"]
                if fp.get("requireCountry"):
                    fp_kwargs["require_country"] = fp["requireCountry"]
                if fp.get("manualGeo"):
                    fp_kwargs["manual_geo"] = fp["manualGeo"]
                # ruyiPage otherwise creates userdir_<timestamp>_<random> below
                # os.getcwd(). Keep fingerprint files and profile data under the
                # same controlled directory selected above.
                if profile_path is not None:
                    fp_kwargs["userdir"] = str(profile_path)
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
        browser = getattr(self.page, "_firefox", None) or getattr(
            self.page, "_browser", None
        )
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

        self.pages = {}
        self._next_page_idx = 0
        self.pages[self._next_page_idx] = self.page
        self._next_page_idx += 1
        self._capture_stats = {}
        self._intercept_modes = {}

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
            "url": getattr(self.page, 'url', ''),
            "title": getattr(self.page, 'title', ''),
            "pageCount": len(self.pages),
            "attached": existing_only,
            "address": existing_address if existing_only else None,
            "profilePath": str(profile_path) if profile_path is not None else None,
            "profileMode": profile_mode,
            "closeOnExit": False if existing_only else bool(params.get("closeOnExit", True)),
        }

    def _quit(self, params: dict) -> dict:
        if self.page:
            try:
                if self._attached_existing:
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
        cleanup = self._cleanup_managed_profile()
        self._profile_path = None
        return {"profileCleanup": cleanup} if cleanup is not None else {}

    def _status(self, params: dict) -> dict:
        if not self.page:
            return {"alive": False}
        try:
            return {
                "alive": True,
                "url": getattr(self.page, 'url', ''),
                "title": getattr(self.page, 'title', ''),
                "pageCount": len(self.pages),
                "breakpointCount": len(self._breakpoints),
                "preloadScriptCount": len(self._preload_scripts),
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

    # ------------------------------------------------------------------
    # Page management
    # ------------------------------------------------------------------
    def _navigate(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx"))
        url = params["url"]
        timeout = params.get("timeout", 30)
        page.get(url, timeout=timeout)
        return {
            "url": getattr(page, 'url', url),
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
            "url": getattr(tab, 'url', url) if tab else url,
        }
        if fingerprint_emulation is not None:
            result["fingerprintEmulation"] = _serialize(fingerprint_emulation)
        return result

    def _close_tab(self, params: dict) -> dict:
        idx = params.get("pageIdx", 0)
        if idx == 0:
            raise ValueError("Cannot close main tab (pageIdx=0). Use browser.quit instead.")
        if idx not in self.pages:
            raise ValueError(f"Invalid pageIdx: {idx}")

        page = self.pages.pop(idx)
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
        return {"pageIdx": idx, "url": getattr(page, 'url', '')}

    def _list_tabs(self, params: dict) -> dict:
        tabs = []
        for idx, page in self.pages.items():
            try:
                tabs.append({
                    "pageIdx": idx,
                    "url": getattr(page, 'url', ''),
                    "title": getattr(page, 'title', ''),
                })
            except Exception:
                tabs.append({"pageIdx": idx, "error": "unreachable"})
        return {"tabs": tabs}

    def _reload(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx"))
        page.refresh()
        return {"url": getattr(page, 'url', '')}

    def _screenshot(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx"))
        file_path = params.get("filePath")
        full_page = params.get("fullPage", False)

        if file_path:
            page.screenshot(file_path, full_page=full_page)
            return {"filePath": file_path}
        else:
            # Return base64 screenshot
            import base64
            import tempfile
            tmp = tempfile.mktemp(suffix=".png")
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
        """Get recent network requests. Without capture, approximate via trace or JS."""
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
        if not os.path.isabs(output_file):
            raise ValueError("outputFile must be an absolute path")
        return os.path.abspath(output_file)

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
        return {
            "warning": "Proxy must be set at browser.launch time. "
                       "Use the 'proxy' parameter in browser.launch.",
            "proxy": params.get("proxyUrl", "not set"),
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

    def _human_click(self, params: dict) -> dict:
        target, target_metadata = self._resolve_target(params)
        selector = self._norm_selector(params["target"])
        algorithm = params.get("algorithm", "windmouse")

        el = target.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {
                "found": False,
                "error": f"Element not found: {selector}",
                "target": target_metadata,
            }

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
    # Debug (soft breakpoints via preload scripts)
    # ------------------------------------------------------------------
    def _set_breakpoint(self, params: dict) -> dict:
        """Set a soft breakpoint by injecting a Proxy/wrapper around target code."""
        page = self._get_page(params.get("pageIdx", 0))
        mode = params.get("mode", "text")
        text = params.get("text", "")
        pattern = params.get("pattern", text)
        url_filter = params.get("urlFilter", "")
        condition = params.get("condition", "")

        # For XHR/fetch breakpoints, inject a preload wrapper explicitly.
        # Do not infer this mode from the text contents: URL patterns like
        # "/api/login" must still install the network wrappers.
        if mode == "xhr":
            pattern_js = json.dumps(pattern)
            script = """() => {
                const _origFetch = window.fetch;
                window.fetch = function(...args) {
                    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                    if (url.includes(__RUYI_PATTERN__)) {
                        debugger;
                    }
                    return _origFetch.apply(this, args);
                };
                const _origXHR = window.XMLHttpRequest.prototype.open;
                window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                    this.__ruyi_method = method;
                    this._ruyi_url = url;
                    if (String(url).includes(__RUYI_PATTERN__)) {
                        debugger;
                    }
                    return _origXHR.call(this, method, url, ...rest);
                };
            }""".replace("__RUYI_PATTERN__", pattern_js)
        else:
            # Generic text search — inject a MutationObserver-like scanner
            marker = json.dumps(text[:200])
            script = """() => {
                window.__ruyi_bp_target = __RUYI_MARKER__;
            }""".replace("__RUYI_MARKER__", marker)

        bp_id = page.add_preload_script(script)
        bp_id_str = str(getattr(bp_id, 'id', len(self._breakpoints)))

        bp_info = {
            "breakpointId": bp_id_str,
            "text": text,
            "mode": mode,
            "pattern": pattern,
            "urlFilter": url_filter,
            "condition": condition,
            "type": "soft",
        }
        self._breakpoints.append(bp_info)

        return bp_info

    def _remove_breakpoint(self, params: dict) -> dict:
        bp_id = params.get("breakpointId", "")
        page = self._get_page(params.get("pageIdx", 0))

        self._breakpoints = [b for b in self._breakpoints if b["breakpointId"] != bp_id]
        try:
            page.remove_preload_script(bp_id)
        except Exception:
            pass

        return {"removed": bp_id}

    def _list_breakpoints(self, params: dict) -> dict:
        return {"breakpoints": self._breakpoints}

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
                    if request.get("id") is not None:
                        response = self._ok(request.get("id"), {"shutdown": True})
                        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                        sys.stdout.flush()
                    break

                response = self.handle(request)

                # Don't write response for notifications
                if request.get("id") is not None:
                    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                    sys.stdout.flush()
        finally:
            self._quit({})
            sys.stderr.write("[ruyi_bridge] Shutdown complete\n")
            sys.stderr.flush()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    bridge = RuyiBridge()
    bridge.run()
