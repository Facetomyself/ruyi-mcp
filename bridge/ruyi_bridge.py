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
from pathlib import Path
from typing import Any, Optional

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
        candidates.append(
            Path(__file__).resolve().parents[3]
            / "tools"
            / "ruyitrace"
            / "firefox"
            / "firefox.exe"
        )
        browser_root = Path.home() / "AppData" / "Local" / "ruyipage" / "browsers"
        if browser_root.is_dir():
            candidates.extend(sorted(browser_root.glob("firefox-*/firefox/firefox.exe"), reverse=True))

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    return shutil.which("firefox") or shutil.which("firefox.exe") or ""


DEFAULT_FIREFOX_PATH = _discover_firefox_path()


# ---------------------------------------------------------------------------
# RuyiBridge
# ---------------------------------------------------------------------------
class RuyiBridge:
    """JSON-RPC bridge wrapping ruyipage browser and BiDi trace capabilities."""

    def __init__(self):
        self.page: Optional[FirefoxPage] = None
        self.opts: Optional[FirefoxOptions] = None
        self.pages: dict[int, Any] = {}          # pageIdx → FirefoxPage/Tab
        self._next_page_idx: int = 0
        self._breakpoints: list[dict] = []        # soft breakpoint registry
        self._trace_output: Optional[str] = None
        self._trace_enabled_at_launch: bool = False
        self._trace_active: bool = False
        self._preload_scripts: dict[str, str] = {}  # scriptId → script text
        self._fingerprint_ctx: Any = None

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
            "human.input":           self._human_input,
            # Session export
            "session.export":        self._export_session,
            # Debug (soft breakpoints)
            "debug.set_breakpoint":  self._set_breakpoint,
            "debug.remove_breakpoint": self._remove_breakpoint,
            "debug.list_breakpoints":  self._list_breakpoints,
            # Trace
            "trace.start":           self._trace_start,
            "trace.stop":            self._trace_stop,
            "trace.results":         self._trace_results,
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

        # Frame storage (contextId → FirefoxFrame)
        self._frame_obj: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _get_page(self, page_idx: Any = 0) -> Any:
        idx = page_idx if page_idx is not None else 0
        if isinstance(idx, str):
            idx = int(idx)
        if idx not in self.pages:
            raise ValueError(f"Invalid pageIdx: {idx}. Available: {list(self.pages.keys())}")
        return self.pages[idx]

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
        self._trace_output = None
        self._trace_enabled_at_launch = bool(params.get("traceEnabled"))
        self._trace_active = False
        if Settings is not None:
            Settings.trace_enabled = False

        opts = FirefoxOptions()
        browser_path = params.get("browserPath") or DEFAULT_FIREFOX_PATH
        if not browser_path:
            raise RuntimeError(
                "Firefox not found. Set RUYI_FIREFOX_PATH or install a RuyiPage browser "
                "with: python -m ruyipage install"
            )
        opts.set_browser_path(browser_path)

        if params.get("headless"):
            opts.headless(True)
        if params.get("privateMode"):
            opts.private_mode(True)
        if params.get("proxy"):
            opts.set_proxy(params["proxy"])

        # Profile
        if params.get("profilePath"):
            opts.set_profile(params["profilePath"])

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
            self._fingerprint_ctx = opts.smart_fingerprint(**fp_kwargs)

        # Trace
        if self._trace_enabled_at_launch:
            opts.enable_trace(True)

        self.opts = opts
        self.page = FirefoxPage(opts)
        if Settings is not None:
            Settings.trace_enabled = self._trace_enabled_at_launch
        self._trace_active = self._trace_enabled_at_launch

        # Apply fingerprint emulation AFTER page creation
        if self._fingerprint_ctx:
            self._fingerprint_ctx.apply_emulation(self.page)

        self.pages = {}
        self._next_page_idx = 0
        self.pages[self._next_page_idx] = self.page
        self._next_page_idx += 1

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
        }

    def _quit(self, params: dict) -> dict:
        if Settings is not None:
            Settings.trace_enabled = False
        if self.opts is not None and hasattr(self.opts, "enable_trace"):
            self.opts.enable_trace(False)
        self._trace_active = False
        if self.page:
            try:
                self.page.quit()
            except Exception:
                pass
        self.page = None
        self.opts = None
        self.pages = {}
        self._breakpoints = []
        self._trace_enabled_at_launch = False
        self._trace_active = False
        self._trace_output = None
        self._preload_scripts = {}
        self._fingerprint_ctx = None
        self._frame_obj = {}
        return {}

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
                "tracing": self._trace_active,
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
            # ruyiPage 1.2.54 scopes screen to userContext, while geo/locale/
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
        page = self._get_page(params.get("pageIdx"))
        script = params["script"]
        timeout = params.get("timeout", 10)
        sandbox = params.get("sandbox", None)

        try:
            # Wrap as IIFE so arrow functions are called, not evaluated.
            # BiDi callFunction (as_expr=False) doesn't handle async arrow
            # functions correctly, but IIFE + expression mode works for both
            # sync and async. Node.js side always passes function declarations.
            script_iife = f"({script})()"
            result = page.run_js(script_iife, timeout=timeout, sandbox=sandbox)
            serialized = _serialize(result)
            return {"result": serialized}
        except Exception as e:
            return {"result": None, "error": str(e), "stack": traceback.format_exc()}

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

    def _capture_start(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        pattern = params.get("pattern", "")
        method = params.get("method", None)
        page.capture.start(pattern, method=method)
        return {"capturing": True, "pattern": pattern}

    def _capture_stop(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        page.capture.stop()
        return {"capturing": False}

    def _capture_wait(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        timeout = params.get("timeout", 10)
        count = params.get("count", 5)
        capture_result = page.capture.wait(timeout=timeout, count=count)
        if isinstance(capture_result, list):
            packets = capture_result
        elif capture_result is None:
            packets = []
        else:
            packets = [capture_result]
        results = []
        for p in packets:
            try:
                results.append({
                    "url": getattr(p, 'url', str(p)),
                    "status": getattr(p, 'status', None),
                    "method": getattr(p, 'method', None),
                    "requestBody": str(getattr(p, 'request_body', ''))[:5000],
                    "responseBody": str(getattr(p, 'response_body', ''))[:5000],
                })
            except Exception:
                results.append({"raw": str(p)[:5000]})
        return {"packets": results}

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
                    "windowSize.devicePixelRatio is ignored by ruyiPage 1.2.54; "
                    "use viewport.devicePixelRatio for DPR; screenSize DPR is runtime-dependent"
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
                device_pixel_ratio=dpr,
            )
            applied_screen_size = {
                "requested": {
                    "width": width,
                    "height": height,
                    "devicePixelRatio": dpr,
                },
                "verified": False,
            }
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
                requested_dpr = applied_screen_size["requested"].get("devicePixelRatio")
                actual_dpr = actual_screen_size.get("devicePixelRatio")
                if requested_dpr is not None and actual_dpr is not None:
                    dpr_applied = abs(float(requested_dpr) - float(actual_dpr)) < 1e-9
                    applied_screen_size["devicePixelRatioApplied"] = dpr_applied
                    if not dpr_applied:
                        warnings.append(
                            "screenSize.devicePixelRatio was not applied by the active Firefox runtime"
                        )
            else:
                warnings.append(
                    "screenSize was requested but the active page metrics could not be verified"
                )
        if params.get("bypassCsp"):
            page.set_bypass_csp(True)

        # Apply screen orientation
        if params.get("screenOrientation"):
            ori = params["screenOrientation"]
            page.set_screen_orientation(
                orientation_type=ori.get("type", "portrait-primary"),
                angle=ori.get("angle", 0),
            )

        result = {"fingerprintApplied": True}
        if applied_size:
            result["size"] = applied_size
        if applied_screen_size:
            result["screenSize"] = applied_screen_size
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
        page = self._get_page(params.get("pageIdx", 0))
        selector = self._norm_selector(params["selector"])
        timeout = params.get("timeout", 10)

        el = page.ele(selector, timeout=timeout)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {"found": False, "selector": selector}

        # Store element reference in a way we can retrieve later
        element_id = str(id(el))
        # Attach element ID to the JS context for later retrieval
        try:
            page.run_js(f"window.__ruyi_element_{element_id} = true;")
        except Exception:
            pass

        return {
            "found": True,
            "elementId": element_id,
            "selector": selector,
        }

    def _dom_get_info(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
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

        result = page.run_js(f"({script})()", timeout=10)
        if result is None:
            return {"found": False}

        if attribute:
            return {"found": True, "attribute": str(result)[:10000]}
        return {"found": True, **{k: str(v) for k, v in result.items()}}

    def _dom_input(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        selector = self._norm_selector(params["selector"])
        text = params.get("text", "")
        clear = params.get("clear", True)

        el = page.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {"found": False, "error": f"Element not found: {selector}"}

        el.input(text, clear=clear)
        return {"found": True, "input": text[:500]}

    def _dom_click(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        selector = self._norm_selector(params["selector"])
        el = page.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {"found": False, "error": f"Element not found: {selector}"}
        el.click_self()
        return {"found": True, "clicked": True}

    # ------------------------------------------------------------------
    # Human simulation
    # ------------------------------------------------------------------
    def _human_move(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        selector = self._norm_selector(params["target"])
        algorithm = params.get("algorithm", "bezier")
        style = self._normalize_human_style(params.get("style", "arc"))

        el = page.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {"found": False, "error": f"Element not found: {selector}"}

        page.actions.human_move(el, algorithm=algorithm, style=style).perform()
        return {
            "moved": True,
            "target": selector,
            "algorithm": algorithm,
            "style": style,
        }

    def _human_click(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        selector = self._norm_selector(params["target"])
        algorithm = params.get("algorithm", "windmouse")

        el = page.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {"found": False, "error": f"Element not found: {selector}"}

        page.actions.human_click(el, algorithm=algorithm).perform()
        return {"clicked": True, "target": selector, "algorithm": algorithm}

    def _human_drag(self, params: dict) -> dict:
        """Perform one atomic, human-like pointer drag."""
        page = self._get_page(params.get("pageIdx", 0))
        source, source_desc = self._resolve_action_target(page, params.get("source"), "source")
        target, target_desc = self._resolve_action_target(page, params.get("target"), "target")
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

        actions = page.actions
        try:
            chain = actions.move_to(source).hold(button=button)
            if hold_ms:
                chain.wait(hold_ms / 1000.0)
            chain.human_move(target, algorithm=algorithm, style=style)
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
            "target": target_desc,
            "algorithm": algorithm,
            "style": style,
            "holdMs": hold_ms,
            "releaseMs": release_ms,
            "button": button,
        }

    def _human_input(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        selector = self._norm_selector(params["target"])
        text = params.get("text", "")
        delay_ms = params.get("delayMs", 50)

        el = page.ele(selector)
        if el is None or (NoneElement and isinstance(el, NoneElement)):
            return {"found": False, "error": f"Element not found: {selector}"}

        # Type character by character with delay
        for char in text:
            el.input(char, clear=False)
            if delay_ms > 0:
                import time
                time.sleep(delay_ms / 1000.0)

        return {"input": True, "target": selector}

    # ------------------------------------------------------------------
    # Session export
    # ------------------------------------------------------------------
    def _export_session(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        output_file = params.get("outputFile")
        include = params.get("include", ["cookies", "localStorage", "sessionStorage"])

        session = {}

        if "cookies" in include:
            try:
                session["cookies"] = _serialize(page.get_cookies())
            except Exception as e:
                session["cookiesError"] = str(e)

        if "localStorage" in include:
            try:
                ls = page.run_js("""
                    (() => {
                        const items = {};
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            items[key] = localStorage.getItem(key);
                        }
                        return items;
                    })()
                """)
                session["localStorage"] = _serialize(ls)
            except Exception as e:
                session["localStorageError"] = str(e)

        if "sessionStorage" in include:
            try:
                ss = page.run_js("""
                    (() => {
                        const items = {};
                        for (let i = 0; i < sessionStorage.length; i++) {
                            const key = sessionStorage.key(i);
                            items[key] = sessionStorage.getItem(key);
                        }
                        return items;
                    })()
                """)
                session["sessionStorage"] = _serialize(ss)
            except Exception as e:
                session["sessionStorageError"] = str(e)

        if "userAgent" in include:
            try:
                session["userAgent"] = str(page.run_js("(() => navigator.userAgent)()"))
            except Exception:
                pass

        if "url" in include:
            try:
                session["url"] = getattr(page, 'url', '')
            except Exception:
                pass

        # Write to file if path provided
        if output_file:
            output_dir = os.path.dirname(os.path.abspath(output_file))
            if output_dir:
                os.makedirs(output_dir, exist_ok=True)
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(session, f, ensure_ascii=False, indent=2)

        return {
            "session": session if not output_file else {"savedTo": output_file},
            "outputFile": output_file,
        }

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
    # Trace (ruyitrace integration)
    # ------------------------------------------------------------------
    def _trace_start(self, params: dict) -> dict:
        """Start a fresh ruyipage BiDi trace segment."""
        page = self._get_page(params.get("pageIdx", 0))
        if Settings is None:
            raise RuntimeError("ruyipage Settings API is unavailable")

        settings_was_enabled = bool(Settings.trace_enabled)
        options_was_enabled = bool(
            getattr(self.opts, "trace_enabled", settings_was_enabled)
        )
        was_tracing = bool(settings_was_enabled or self._trace_active)
        try:
            Settings.trace_enabled = True
            if self.opts is not None and hasattr(self.opts, "enable_trace"):
                self.opts.enable_trace(True)
            tracer = page.trace
        except Exception:
            Settings.trace_enabled = settings_was_enabled
            if self.opts is not None and hasattr(self.opts, "enable_trace"):
                try:
                    self.opts.enable_trace(options_was_enabled)
                except Exception:
                    pass
            raise
        if not self._trace_enabled_at_launch and not was_tracing and hasattr(tracer, "clear"):
            tracer.clear()
        self._trace_active = True

        output_file = params.get("outputFile")
        self._trace_output = output_file

        result = {
            "tracing": True,
            "fullTrace": self._trace_enabled_at_launch,
            "partialTrace": not self._trace_enabled_at_launch,
            "startedAtRuntime": not self._trace_enabled_at_launch,
            "alreadyTracing": was_tracing,
            "outputFile": output_file,
        }
        if not self._trace_enabled_at_launch:
            result["warning"] = (
                "Runtime trace started successfully, but browser launch events are not included. "
                "Use traceEnabled:true in ruyi_new_page when launch coverage is required."
            )
        return result

    def _trace_stop(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))

        result = {"tracing": False}
        tracer = None
        try:
            tracer = page.trace
            summary = tracer.summary() if hasattr(tracer, 'summary') else ""
            result["summary"] = str(summary)[:10000]
        except Exception as e:
            result["summaryError"] = str(e)

        try:
            json_data = page.trace.dump_json() if hasattr(page.trace, 'dump_json') else "{}"
            if self._trace_output:
                output_dir = os.path.dirname(os.path.abspath(self._trace_output))
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                with open(self._trace_output, "w", encoding="utf-8") as f:
                    f.write(str(json_data))
                result["savedTo"] = self._trace_output
            result["data"] = str(json_data)[:100000]
        except Exception as e:
            result["dumpError"] = str(e)

        if Settings is not None:
            Settings.trace_enabled = False
        if self.opts is not None and hasattr(self.opts, "enable_trace"):
            self.opts.enable_trace(False)
        self._trace_active = False
        self._trace_output = None
        return result

    def _trace_results(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        limit = params.get("limit", 50)

        try:
            tracer = page.trace
            if hasattr(tracer, 'latest'):
                latest = tracer.latest(limit)
                return {
                    "tracing": bool(
                        self._trace_active
                        and Settings is not None
                        and Settings.trace_enabled
                    ),
                    "entries": _serialize(latest),
                }
            summary = tracer.summary() if hasattr(tracer, 'summary') else "Trace available"
            return {
                "tracing": bool(
                    self._trace_active
                    and Settings is not None
                    and Settings.trace_enabled
                ),
                "summary": str(summary)[:10000],
            }
        except Exception as e:
            return {"tracing": self._trace_active, "error": str(e)}

    # ------------------------------------------------------------------
    # Frame
    # ------------------------------------------------------------------
    def _frame_list(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        try:
            frames = page.get_all_frames()
            result = []
            for f in (frames or []):
                try:
                    result.append({
                        "contextId": getattr(f, "_context_id", ""),
                        "url": getattr(f, "url", ""),
                        "title": getattr(f, "title", ""),
                        "isCrossOrigin": getattr(f, "is_cross_origin", None),
                    })
                except Exception:
                    result.append({"error": str(f)[:200]})
            return {"frames": result}
        except Exception as e:
            return {"frames": [], "error": str(e)}

    def _frame_select(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        context_id = params.get("contextId", "")
        selector = params.get("selector", "")
        try:
            if bool(context_id) == bool(selector):
                raise ValueError("Exactly one of contextId or selector is required")
            if context_id:
                frame = page.get_frame(context_id=context_id)
                selected_by = "contextId"
            else:
                normalized_selector = self._norm_selector(selector)
                frame = page.get_frame(locator=normalized_selector)
                selected_by = "selector"
            if frame is None:
                return {"found": False, "selectedBy": selected_by}
            cid = getattr(frame, "_context_id", "")
            self._frame_obj[cid] = frame
            return {
                "found": True,
                "contextId": cid,
                "selectedBy": selected_by,
                "url": getattr(frame, "url", ""),
                "title": getattr(frame, "title", ""),
                "isCrossOrigin": getattr(frame, "is_cross_origin", None),
            }
        except Exception as e:
            return {"found": False, "error": str(e)}

    # ------------------------------------------------------------------
    # Intercept
    # ------------------------------------------------------------------
    def _intercept_start_req(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        patterns = params.get("urlPatterns")
        try:
            page.intercept.start_requests(None, url_patterns=patterns)
            return {"intercepting": True, "phase": "request", "patterns": patterns}
        except Exception as e:
            return {"intercepting": False, "error": str(e)}

    def _intercept_start_resp(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        patterns = params.get("urlPatterns")
        try:
            page.intercept.start_responses(None, url_patterns=patterns)
            return {"intercepting": True, "phase": "response", "patterns": patterns}
        except Exception as e:
            return {"intercepting": False, "error": str(e)}

    def _intercept_wait(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        timeout = params.get("timeout", 10)
        try:
            req = page.intercept.wait(timeout=timeout)
            if req is None:
                return {"timedOut": True}
            # Extract InterceptedRequest properties
            result = {
                "url": getattr(req, "url", ""),
                "method": getattr(req, "method", ""),
                "isResponsePhase": getattr(req, "is_response_phase", False),
                "requestHeaders": _serialize(getattr(req, "headers", {})),
                "requestBody": str(getattr(req, "body", ""))[:10000],
            }
            if result["isResponsePhase"]:
                result["responseStatus"] = getattr(req, "response_status", None)
                result["responseHeaders"] = _serialize(getattr(req, "response_headers", {}))
                result["responseBody"] = str(getattr(req, "response_body", ""))[:50000]
            return result
        except Exception as e:
            return {"timedOut": True, "error": str(e)}

    def _intercept_stop(self, params: dict) -> dict:
        page = self._get_page(params.get("pageIdx", 0))
        try:
            page.intercept.stop()
        except Exception:
            pass
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

            # Special: shutdown signal
            if request.get("method") == "__shutdown__":
                if request.get("id") is not None:
                    response = self._ok(request.get("id"), {"shutdown": True})
                    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                    sys.stdout.flush()
                self._quit({})
                break

            response = self.handle(request)

            # Don't write response for notifications
            if request.get("id") is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()

        sys.stderr.write("[ruyi_bridge] Shutdown complete\n")
        sys.stderr.flush()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    bridge = RuyiBridge()
    bridge.run()
