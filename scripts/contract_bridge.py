#!/usr/bin/env python3
"""Offline contracts for the ruyiPage dependency and Python bridge.

The checks intentionally avoid launching Firefox.  They exercise the exact
installed ruyiPage version, its runtime proxy-auth file generation, and the
bridge handlers with small fake browser objects.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import hashlib
import inspect
import io
import json
import random
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
import ruyipage
from ruyipage import FirefoxOptions
from ruyipage._base import browser as browser_module
from ruyipage._base.browser import Firefox
from ruyipage._bidi import network as bidi_network
from ruyipage._fingerprint import builder as fingerprint_builder
from ruyipage._pages.firefox_base import FirefoxBase
from ruyipage._units.actions import Actions
from ruyipage.errors import BrowserConnectError


EXPECTED_RUYIPAGE_VERSION = "1.2.56"
REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "bridge" / "ruyi_bridge.py"
REQUIREMENTS_PATH = REPO_ROOT / "requirements.txt"
HANDOFF_SCHEMA_PATH = REPO_ROOT / "contracts" / "browser-session-handoff.v1.schema.json"
POINTER_SCHEMA_PATH = REPO_ROOT / "contracts" / "evidence-pointer.v1.schema.json"
HANDOFF_FIXTURE_PATH = REPO_ROOT / "contracts" / "fixtures" / "browser-session-handoff.valid.json"
LIVE_COOKIE_FIXTURE_PATH = REPO_ROOT / "scripts" / "fixtures" / "cookies-domainless.live-shape.json"
HANDOFF_SCHEMA_SHA256 = "9a759a8a5a9af92ae6958a06975bbd58a0d20f67aeb87543100548f36b9ea240"
POINTER_SCHEMA_SHA256 = "986b8965c5b41d41f7bed3d8294de2551165e739f81d1822bb6e529d081c1dbd"


def load_bridge_module():
    spec = importlib.util.spec_from_file_location("ruyi_mcp_contract_bridge", BRIDGE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load bridge module from {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BRIDGE_MODULE = load_bridge_module()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


HANDOFF_SCHEMA = load_json(HANDOFF_SCHEMA_PATH)
POINTER_SCHEMA = load_json(POINTER_SCHEMA_PATH)
CONTRACT_REGISTRY = Registry().with_resources(
    [
        (HANDOFF_SCHEMA["$id"], Resource.from_contents(HANDOFF_SCHEMA)),
        (POINTER_SCHEMA["$id"], Resource.from_contents(POINTER_SCHEMA)),
    ]
)
HANDOFF_VALIDATOR = Draft202012Validator(
    HANDOFF_SCHEMA,
    registry=CONTRACT_REGISTRY,
    format_checker=FormatChecker(),
)


class FakeLaunchOptions:
    """Small launch-options fake that records values passed by the bridge."""

    instances: list["FakeLaunchOptions"] = []

    def __init__(self):
        self.browser_path = None
        self.proxy = None
        self.address = None
        self.existing = False
        self.close_on_exit_value = True
        self.profile = None
        self.fingerprint_kwargs = None
        FakeLaunchOptions.instances.append(self)

    def set_browser_path(self, path):
        self.browser_path = path
        return self

    def set_proxy(self, proxy):
        self.proxy = proxy
        return self

    def set_address(self, address):
        self.address = address
        return self

    def existing_only(self, enabled=True):
        self.existing = bool(enabled)
        return self

    def close_on_exit(self, enabled=True):
        self.close_on_exit_value = bool(enabled)
        return self

    def set_profile(self, profile):
        self.profile = profile
        return self

    def smart_fingerprint(self, **kwargs):
        self.fingerprint_kwargs = kwargs
        return None


class FakeLaunchPage:
    url = "about:blank"
    title = ""

    def __init__(self, options):
        self.options = options
        self.quit_calls = 0

    def get_tabs(self):
        return []

    def quit(self):
        self.quit_calls += 1


class FailingLaunchPage:
    def __init__(self, _options):
        raise RuntimeError("synthetic Firefox startup failure")


class FakeAttachBrowser:
    _BROWSERS = {}
    _lock = threading.Lock()

    def __init__(self):
        self.detach_calls = 0
        self.address = "127.0.0.1:26700"
        self._initialized = True
        self._BROWSERS[self.address] = self

    def _detach_on_exit(self):
        self.detach_calls += 1


class FakeAttachPage(FakeLaunchPage):
    _PAGES = {}

    def __init__(self, options):
        super().__init__(options)
        self._firefox = FakeAttachBrowser()
        self._PAGES[self._firefox.address] = self


class FakeOrientationPage:
    def __init__(self, *, apply_orientation=True):
        self.calls: list[tuple[str]] = []
        self.apply_orientation = apply_orientation
        self.orientation_type = "landscape-primary"

    def set_screen_orientation(self, *, orientation_type):
        self.calls.append((orientation_type,))
        if self.apply_orientation:
            self.orientation_type = orientation_type

    def run_js(self, _expression):
        return {"type": self.orientation_type, "angle": 0}


class FakeFirefoxProcess:
    def __init__(self, pid):
        self.pid = pid
        self.events: list[object] = []

    def poll(self):
        return None

    def kill(self):
        self.events.append("kill")

    def terminate(self):
        self.events.append("terminate")

    def wait(self, timeout=None):
        self.events.append(("wait", timeout))


def make_upstream_browser_for_quit(options, process):
    browser = object.__new__(Firefox)
    browser._quit_lock = threading.RLock()
    browser._driver = None
    browser._owns_session = False
    browser._process = process
    browser._options = options
    browser._auto_profile = None
    browser._address = options.address
    browser._initialized = True
    return browser


class FakeFingerprintPage:
    def __init__(self):
        self.calls: list[tuple] = []
        self.emulation = self
        self.actual_screen = {
            "width": 1366,
            "height": 768,
            "devicePixelRatio": 1.0,
        }

    def set_viewport(self, width, height, device_pixel_ratio=None):
        self.calls.append(("set_viewport", width, height, device_pixel_ratio))

    def set_window_size(self, width, height, device_pixel_ratio=None):
        self.calls.append(("set_window_size", width, height, device_pixel_ratio))

    def set_screen_size(self, width, height, device_pixel_ratio=None):
        self.calls.append(("set_screen_size", width, height, device_pixel_ratio))

    def run_js(self, script):
        return dict(self.actual_screen)


class FakeCaptureManager:
    def __init__(self, result, history=None, stop_error=None):
        self.result = result
        self.wait_calls: list[tuple[float, int]] = []
        self.start_calls: list[tuple[object, object, bool]] = []
        self._history = list(history or [])
        self.stop_error = stop_error
        self.clear_calls = 0
        self.stop_calls: list[tuple[int, float]] = []
        self.active = True

    @property
    def steps(self):
        return self._history[:]

    def wait(self, *, timeout, count):
        self.wait_calls.append((timeout, count))
        return self.result

    def start(self, targets, *, method=None, collect_bodies=True):
        self.start_calls.append((targets, method, bool(collect_bodies)))
        self.active = True
        return self

    def clear(self):
        self.clear_calls += 1
        self._history = []
        return self

    def stop(self):
        self.stop_calls.append(
            (len(self._history), BRIDGE_MODULE.Settings.bidi_timeout)
        )
        if self.stop_error is not None:
            raise self.stop_error
        self.active = False
        return self


class FakeCapturePage:
    def __init__(self, result, history=None, stop_error=None):
        self.capture = FakeCaptureManager(
            result,
            history=history,
            stop_error=stop_error,
        )


class FakeCapturePacket:
    """Capture packet whose public body properties must never be read by Bridge."""

    def __init__(
        self,
        *,
        url="https://fixture.invalid/api?token=secret&kind=fixture",
        method="POST",
        status=200,
        request_body='{"credential":"secret","page":1}',
        response_body='{"ok":true,"token":"secret"}',
        request_id="fixture-request-id",
    ):
        self.url = url
        self.method = method
        self.status = status
        self.request_id = request_id
        self.event_type = "responseCompleted"
        self.timestamp = 123.45
        self.is_failed = False
        self.request = {
            "request": request_id,
            "headers": [
                {"name": "Content-Type", "value": {"value": "application/json"}},
                {"name": "Authorization", "value": {"value": "Bearer secret"}},
            ],
        }
        self.response = {
            "status": status,
            "headers": [
                {"name": "Content-Type", "value": {"value": "application/json"}},
                {"name": "Set-Cookie", "value": {"value": "session=secret"}},
            ],
        }
        self.request_headers = {"content-type": "application/json", "authorization": "Bearer secret"}
        self.response_headers = {"content-type": "application/json", "set-cookie": "session=secret"}
        self._request_collector = object()
        self._response_collector = object()
        self._bodies = {"request": request_body, "response": response_body}
        self.body_reads: list[tuple[str, float]] = []

    @property
    def request_body(self):
        raise AssertionError("Bridge must not read CapturePacket.request_body")

    @property
    def response_body(self):
        raise AssertionError("Bridge must not read CapturePacket.response_body")

    def _decode_body_value(self, value):
        return value

    def _body_from_collector(self, _collector, direction, timeout=0):
        self.body_reads.append((direction, timeout))
        return self._bodies[direction]


class FakeInterceptRequest:
    def __init__(self, *, response_phase=False):
        self._request = {
            "request": "intercept-request-id",
            "url": "https://fixture.invalid/intercept?token=secret",
            "method": "POST",
            "headers": [
                {"name": "Content-Type", "value": {"value": "application/json"}},
                {"name": "Cookie", "value": {"value": "session=secret"}},
            ],
            "body": '{"requestSecret":"secret"}',
        }
        self._response_raw = {
            "status": 201,
            "headers": [
                {"name": "Content-Type", "value": {"value": "application/json"}},
                {"name": "Set-Cookie", "value": {"value": "session=secret"}},
            ],
            "body": '{"responseSecret":"secret"}',
        }
        self._response_phase = response_phase
        self.continued: list[str] = []

    @property
    def request_id(self):
        return self._request["request"]

    @property
    def url(self):
        return self._request["url"]

    @property
    def method(self):
        return self._request["method"]

    @property
    def headers(self):
        return {"content-type": "application/json", "cookie": "session=secret"}

    @property
    def is_response_phase(self):
        return self._response_phase

    @property
    def response_status(self):
        return self._response_raw["status"] if self._response_phase else None

    @property
    def response_headers(self):
        return {"content-type": "application/json", "set-cookie": "session=secret"}

    @property
    def handled(self):
        return bool(self.continued)

    @property
    def body(self):
        raise AssertionError("Bridge must not read InterceptedRequest.body")

    @property
    def response_body(self):
        raise AssertionError("Bridge must not read InterceptedRequest.response_body")

    def _decode_body_value(self, value):
        return value

    def continue_request(self):
        self.continued.append("continue_request")

    def continue_response(self):
        self.continued.append("continue_response")


class FakeInterceptManager:
    def __init__(self, request):
        self.request = request
        self.start_requests_calls: list[tuple[object, bool]] = []
        self.start_responses_calls: list[tuple[object, bool]] = []
        self.stop_calls = 0

    def start_requests(self, _handler, *, url_patterns=None, collect_response=False):
        self.start_requests_calls.append((url_patterns, bool(collect_response)))

    def start_responses(self, _handler, *, url_patterns=None, collect_response=False):
        self.start_responses_calls.append((url_patterns, bool(collect_response)))

    def wait(self, *, timeout):
        return self.request

    def stop(self):
        self.stop_calls += 1


class FakeInterceptPage:
    def __init__(self, request):
        self.intercept = FakeInterceptManager(request)


class FakeRuntimeWindow:
    def __init__(self):
        self.calls: list[tuple[int, int]] = []

    def _set_size_only(self, width, height):
        self.calls.append((width, height))


class FakeFingerprintContext:
    def __init__(self, events=None):
        self.calls: list[object] = []
        self.events = events

    def apply_emulation(self, page, *, set_screen_size=True):
        self.calls.append((page, set_screen_size))
        if self.events is not None:
            self.events.append(("emulate", page, set_screen_size))
        return {
            "screen": bool(set_screen_size),
            "geolocation": True,
            "locale": True,
            "timezone": True,
            "headers": True,
        }


class FakeContainerTab:
    def __init__(self, events):
        self.events = events
        self.url = "about:blank"
        self.closed = False

    def get(self, url, timeout=30):
        self.events.append(("navigate", url, timeout))
        self.url = url

    def close(self):
        self.closed = True


class FakeContainerPage:
    url = "about:blank"

    def __init__(self, events=None):
        self.events = events if events is not None else []
        self.container_calls: list[str | None] = []
        self.normal_calls: list[str | None] = []
        self.tab = FakeContainerTab(self.events)

    def new_container_tab(self, url=None):
        self.container_calls.append(url)
        self.events.append(("create-container", url))
        return self.tab

    def new_tab(self, url=None):
        self.normal_calls.append(url)
        self.events.append(("create-normal", url))
        return self.tab


class FakeFailingContainerPage:
    url = "about:blank"

    def __init__(self):
        self.fallback_calls = 0

    def new_container_tab(self, url=None):
        raise RuntimeError("fixture container failure")

    def run_js(self, script):
        self.fallback_calls += 1
        raise AssertionError("container creation must not use normal-tab fallback")


class FakeNavigationFailureTab(FakeContainerTab):
    def get(self, url, timeout=30):
        self.events.append(("navigate", url, timeout))
        raise RuntimeError("fixture navigation failure")


class FakeNavigationFailurePage:
    url = "about:blank"

    def __init__(self):
        self.events = []
        self.tab = FakeNavigationFailureTab(self.events)

    def new_tab(self, url=None):
        self.events.append(("create-normal", url))
        return self.tab


class FakeFrame:
    def __init__(
        self,
        context_id="frame-selector-context",
        marker="B",
        *,
        is_cross_origin=False,
    ):
        self._context_id = context_id
        self.url = f"https://frame.fixture.invalid/{marker}?secret=value"
        self.title = f"fixture frame {marker}"
        self.is_cross_origin = is_cross_origin
        self.marker = marker
        self.run_js_calls: list[tuple[str, object, object]] = []

    def run_js(self, script, timeout=None, sandbox=None):
        self.run_js_calls.append((script, timeout, sandbox))
        return self.marker


class FakeFramePage:
    def __init__(self):
        self.calls: list[dict] = []
        self._context_id = "top-context"
        self.url = "https://top.fixture.invalid/?secret=value"
        self.title = "top fixture"
        self.frames = [
            FakeFrame("frame-a", "A"),
            FakeFrame("frame-selector-context", "B"),
        ]
        self.run_js_calls: list[tuple[str, object, object]] = []

    def get_frame(self, **kwargs):
        self.calls.append(kwargs)
        return self.frames[1]

    def get_all_frames(self):
        return list(self.frames)

    def run_js(self, script, timeout=None, sandbox=None):
        self.run_js_calls.append((script, timeout, sandbox))
        return "TOP"


class FakeHumanActions:
    def __init__(self):
        self.calls: list[tuple] = []
        self._pointer_position_known = True
        self._action_stages: list[dict] = []
        self.curr_x = 0
        self.curr_y = 0

    def move_to(self, target):
        self.calls.append(("move_to", target))
        return self

    def hold(self, on_ele=None, button=0):
        self.calls.append(("hold", on_ele, button))
        return self

    def wait(self, seconds):
        self.calls.append(("wait", seconds))
        return self

    def human_move(self, target, style=None, algorithm=None):
        self.calls.append(("human_move", target, style, algorithm))
        self.curr_x = 688
        self.curr_y = 857
        return self

    def human_click(self, target, algorithm=None):
        self.calls.append(("human_click", target, algorithm))
        self._action_stages = [
            {"source": "pointer", "actions": [{"type": "pointerMove", "x": 10, "y": 20}]},
            {"source": "wait", "duration": 75},
            {
                "source": "pointer",
                "actions": [
                    {"type": "pointerDown", "button": 0},
                    {"type": "pause", "duration": 50},
                    {"type": "pointerUp", "button": 0},
                ],
            },
        ]
        return self

    def release(self, on_ele=None, button=0):
        self.calls.append(("release", on_ele, button))
        return self

    def perform(self):
        self.calls.append(("perform",))
        return self

    def release_all(self):
        self.calls.append(("release_all",))
        return self


class FakeHumanPage:
    _context_id = "human-context"

    def __init__(self):
        self.actions = FakeHumanActions()
        self.browser_driver = FakeWheelDriver()
        self._driver = SimpleNamespace(_browser_driver=self.browser_driver)
        self.elements = {
            "css:#source": object(),
            "css:#target": object(),
        }

    def ele(self, selector):
        return self.elements.get(selector)


class FakeFrameActionPage:
    _context_id = "top-human-context"
    url = "https://top.fixture.invalid/"

    def __init__(self, frame):
        self.frame = frame
        self.top_action_calls: list[object] = []

    def get_all_frames(self):
        return [self.frame]


class FakeWheelDriver:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def run(self, method, payload):
        self.calls.append((method, payload))


class FakeWheelPage:
    _context_id = "wheel-context"

    def __init__(self):
        self.rect = SimpleNamespace(viewport_midpoint=(640.5, 477.25))
        self.browser_driver = FakeWheelDriver()
        self._driver = SimpleNamespace(_browser_driver=self.browser_driver)


class FakeSessionCookie:
    def __init__(self):
        self.name = "session"
        self.value = "cookie-secret-value"
        self.domain = "fixture.invalid"
        self.path = "/"
        self.secure = True
        self.http_only = True
        self.same_site = "Lax"
        self.expiry = 2_000_000_000


class FakeSessionPage:
    url = "https://fixture.invalid/app?token=navigation-secret"
    title = "Fixture"
    _context_id = "context-session-export"
    _user_context_id = "user-context-session-export"

    def __init__(self):
        self._firefox = SimpleNamespace(address="127.0.0.1:26700")
        self.storage_export_calls = 0

    def get_cookies(self):
        return [FakeSessionCookie()]

    def run_js(self, script):
        if "__RUYI_HANDOFF_STORAGE__" not in script:
            raise AssertionError("unexpected session export script")
        self.storage_export_calls += 1
        return {
            "origin": "https://fixture.invalid",
            "localStorage": {"access_token": "local-storage-secret"},
            "sessionStorage": {"nonce": "session-storage-secret"},
        }


class RuyiBridgeContractTests(unittest.TestCase):
    def setUp(self):
        FakeLaunchOptions.instances.clear()
        FakeAttachPage._PAGES.clear()
        FakeAttachBrowser._BROWSERS.clear()
        Firefox._BROWSERS.clear()
        Firefox._RESERVED_PORTS.clear()
        self.settings = BRIDGE_MODULE.Settings

    def tearDown(self):
        Firefox._BROWSERS.clear()
        Firefox._RESERVED_PORTS.clear()

    def _prepare_session_export(self, temporary_root: Path):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeSessionPage()
        bridge.page = page
        bridge.pages[0] = page
        bridge._headless = True
        bridge._proxy_url = "http://proxy-user:proxy-secret@proxy.invalid:8080"

        workspace_root = temporary_root / "project"
        workspace_root.mkdir()
        profile_path = workspace_root / "profiles" / "source"
        profile_path.mkdir(parents=True)
        bridge._profile_path = profile_path.resolve()

        browser_root = temporary_root / "firefox"
        browser_root.mkdir()
        browser_binary = browser_root / (
            "firefox.exe" if BRIDGE_MODULE.os.name == "nt" else "firefox"
        )
        browser_binary.write_bytes(b"synthetic-firefox-binary")
        (browser_root / "application.ini").write_text(
            "[App]\nVersion=151.0a1\nBuildID=20260718144531\n",
            encoding="utf-8",
            newline="\n",
        )
        bridge._browser_path = browser_binary.resolve()
        return bridge, page, workspace_root

    def test_exact_ruyipage_version_is_installed_and_pinned(self):
        requirements = REQUIREMENTS_PATH.read_text(encoding="utf-8").splitlines()
        pins = [line.strip() for line in requirements if line.strip().lower().startswith("ruyipage==")]

        self.assertEqual(pins, [f"ruyiPage=={EXPECTED_RUYIPAGE_VERSION}"])
        self.assertEqual(importlib.metadata.version("ruyiPage"), EXPECTED_RUYIPAGE_VERSION)
        self.assertEqual(ruyipage.__version__, EXPECTED_RUYIPAGE_VERSION)

    def test_bridge_imports_ruyipage_and_registers_core_handlers(self):
        self.assertTrue(BRIDGE_MODULE.RUYIPAGE_AVAILABLE)
        self.assertIsNotNone(BRIDGE_MODULE.FirefoxPage)
        self.assertIsNotNone(BRIDGE_MODULE.FirefoxOptions)

        bridge = BRIDGE_MODULE.RuyiBridge()
        expected_handlers = {
            "browser.launch",
            "browser.quit",
            "browser.status",
            "fingerprint.set",
            "human.scroll",
            "human.drag",
            "session.export",
        }
        self.assertTrue(expected_handlers.issubset(bridge._handlers))
        self.assertTrue(
            {"trace.start", "trace.stop", "trace.results"}.isdisjoint(bridge._handlers)
        )
        self.assertEqual(
            bridge.handle({"id": 1, "method": "browser.status", "params": {}}),
            {"id": 1, "result": {"alive": False}},
        )

    def test_bundled_handoff_contract_matches_canonical_snapshot(self):
        schema_digest = hashlib.sha256(HANDOFF_SCHEMA_PATH.read_bytes()).hexdigest()
        pointer_digest = hashlib.sha256(POINTER_SCHEMA_PATH.read_bytes()).hexdigest()
        self.assertEqual(schema_digest, HANDOFF_SCHEMA_SHA256)
        self.assertEqual(pointer_digest, POINTER_SCHEMA_SHA256)
        HANDOFF_VALIDATOR.validate(load_json(HANDOFF_FIXTURE_PATH))

    def test_export_session_defaults_to_cookie_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            bridge, page, workspace_root = self._prepare_session_export(Path(tmp))
            response = bridge.handle(
                {
                    "id": 2,
                    "method": "session.export",
                    "params": {
                        "pageIdx": 0,
                        "caseId": "synthetic-web-case",
                        "handoffId": "handoff_cookie_default_001",
                        "workspaceRoot": str(workspace_root),
                    },
                }
            )

            self.assertNotIn("error", response)
            handoff = response["result"]
            HANDOFF_VALIDATOR.validate(handoff)
            self.assertEqual(set(handoff["stateFiles"]), {"cookies"})
            self.assertIn("cookie-import", handoff["capabilities"])
            self.assertNotIn("storage-import", handoff["capabilities"])
            self.assertEqual(page.storage_export_calls, 0)
            self.assertFalse(
                (
                    workspace_root
                    / "evidence"
                    / "web"
                    / "handoff"
                    / "handoff_cookie_default_001"
                    / "storage.json"
                ).exists()
            )

    def test_domainless_live_cookie_shape_infers_current_http_host(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        live_shape = load_json(LIVE_COOKIE_FIXTURE_PATH)
        bridge._get_cookies = Mock(return_value=live_shape)

        state, count = bridge._cookie_state(
            0,
            "https://pmos.nx.sgcc.com.cn:10443/#/login",
            "synthetic-web-case",
            "handoff_domainless_001",
            "2026-08-01T00:00:00Z",
        )

        self.assertEqual(count, 2)
        self.assertEqual(
            [cookie["domain"] for cookie in state["cookies"]],
            ["pmos.nx.sgcc.com.cn", "pmos.nx.sgcc.com.cn"],
        )
        self.assertEqual(
            [cookie["name"] for cookie in state["cookies"]],
            ["session_token", "challenge_sig"],
        )

    def test_cookie_state_fails_closed_on_ambiguous_origin_or_invalid_identity(self):
        bridge = BRIDGE_MODULE.RuyiBridge()

        for page_url in ("about:blank", "file:///private/page.html", ""):
            with self.subTest(page_url=page_url):
                bridge._get_cookies = Mock(
                    return_value={
                        "cookies": [
                            {"name": "sid", "value": "synthetic", "domain": ""}
                        ]
                    }
                )
                with self.assertRaisesRegex(RuntimeError, "valid HTTP\\(S\\) page URL"):
                    bridge._cookie_state(
                        0,
                        page_url,
                        "synthetic-web-case",
                        "handoff_invalid_origin",
                        "2026-08-01T00:00:00Z",
                    )

        invalid_items = (
            {"name": "bad;name", "value": "synthetic", "domain": "fixture.invalid"},
            {"name": "sid", "value": "synthetic", "domain": "fixture.invalid/path"},
            {"name": "sid", "value": "synthetic", "domain": "999.999.999.999"},
        )
        for item in invalid_items:
            with self.subTest(item_keys=sorted(item)):
                bridge._get_cookies = Mock(return_value={"cookies": [item]})
                with self.assertRaisesRegex(RuntimeError, "invalid (name|domain)"):
                    bridge._cookie_state(
                        0,
                        "https://fixture.invalid/app",
                        "synthetic-web-case",
                        "handoff_invalid_cookie",
                        "2026-08-01T00:00:00Z",
                    )

        explicit_domain = ".Example.INVALID"
        bridge._get_cookies = Mock(
            return_value={
                "cookies": [
                    {"name": "sid", "value": "synthetic", "domain": explicit_domain}
                ]
            }
        )
        state, _ = bridge._cookie_state(
            0,
            "about:blank",
            "synthetic-web-case",
            "handoff_explicit_domain",
            "2026-08-01T00:00:00Z",
        )
        self.assertEqual(state["cookies"][0]["domain"], explicit_domain)

    def test_export_session_writes_raw_state_only_to_evidence_pointers(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp)
            bridge, page, workspace_root = self._prepare_session_export(temporary_root)

            response = bridge.handle(
                {
                    "id": 2,
                    "method": "session.export",
                    "params": {
                        "pageIdx": 0,
                        "caseId": "synthetic-web-case",
                        "handoffId": "handoff_contract_001",
                        "workspaceRoot": str(workspace_root),
                        "include": ["cookies", "storage"],
                    },
                }
            )

            self.assertNotIn("error", response)
            handoff = response["result"]
            HANDOFF_VALIDATOR.validate(handoff)
            serialized_handoff = json.dumps(handoff, ensure_ascii=False)
            for secret in (
                "cookie-secret-value",
                "local-storage-secret",
                "session-storage-secret",
                "navigation-secret",
                "proxy-user",
                "proxy-secret",
            ):
                self.assertNotIn(secret, serialized_handoff)

            self.assertEqual(handoff["schema"], "browser-session-handoff.v1")
            self.assertEqual(handoff["source"]["publicBaseSha"], BRIDGE_MODULE.PUBLIC_BASE_SHA)
            self.assertRegex(handoff["source"]["localHeadSha"], r"^[a-f0-9]{7,40}$")
            self.assertEqual(handoff["page"]["url"], "https://fixture.invalid/app")
            self.assertEqual(
                handoff["proxy"],
                {
                    "mode": "http",
                    "endpoint": "proxy.invalid:8080",
                    "credentials": "omitted",
                },
            )
            self.assertEqual(
                handoff["browser"]["binarySha256"],
                hashlib.sha256(b"synthetic-firefox-binary").hexdigest(),
            )
            self.assertEqual(page.storage_export_calls, 1)
            self.assertNotIn("storage-import", handoff["capabilities"])

            state_payloads = {}
            for state_kind, pointer in handoff["stateFiles"].items():
                state_path = workspace_root / Path(pointer["path"])
                raw = state_path.read_bytes()
                self.assertEqual(len(raw), pointer["bytes"])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), pointer["sha256"])
                state_payloads[state_kind] = json.loads(raw.decode("utf-8"))

            self.assertEqual(
                state_payloads["cookies"]["cookies"][0]["value"],
                "cookie-secret-value",
            )
            self.assertEqual(
                state_payloads["cookies"]["cookies"][0]["sameSite"],
                "lax",
            )
            self.assertEqual(
                state_payloads["cookies"]["cookies"][0]["expiry"],
                2_000_000_000,
            )
            self.assertEqual(
                state_payloads["storage"]["localStorage"][0]["items"]["access_token"],
                "local-storage-secret",
            )
            self.assertEqual(
                state_payloads["storage"]["sessionStorage"][0]["items"]["nonce"],
                "session-storage-secret",
            )

            handoff_path = (
                workspace_root
                / "evidence"
                / "web"
                / "handoff"
                / "handoff_contract_001"
                / "browser-session-handoff.json"
            )
            self.assertEqual(load_json(handoff_path), handoff)

    def test_safe_url_removes_credentials_query_values_and_opaque_payloads(self):
        self.assertEqual(
            BRIDGE_MODULE._safe_url(
                "https://user:secret@fixture.invalid/api?token=secret&kind=sample"
            ),
            {
                "url": "https://fixture.invalid/api",
                "queryKeys": ["kind", "token"],
            },
        )
        self.assertEqual(
            BRIDGE_MODULE._safe_url("data:text/html,<script>secret</script>"),
            {"url": "data:", "queryKeys": []},
        )
        self.assertEqual(
            BRIDGE_MODULE._safe_url("file:///D:/private/secret.html"),
            {"url": "file:", "queryKeys": []},
        )

    def test_bridge_passes_credentialed_proxy_urls_to_ruyipage_unchanged(self):
        proxy_urls = (
            "http://user%40tenant:pa%24%24@proxy.example.com:1000",
            "socks5://user%2Bname:pa%24%24@proxy.example.com:1080",
        )

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.dict(
                    BRIDGE_MODULE.os.environ,
                    {"RUYI_MCP_PROFILE_ROOT": str(Path(tmp) / "profiles")},
                    clear=False,
                ),
                patch.object(BRIDGE_MODULE, "FirefoxOptions", FakeLaunchOptions),
                patch.object(BRIDGE_MODULE, "FirefoxPage", FakeLaunchPage),
                patch.object(BRIDGE_MODULE, "DEFAULT_FIREFOX_PATH", None),
            ):
                for request_id, proxy_url in enumerate(proxy_urls, start=10):
                    with self.subTest(proxy_url=proxy_url):
                        bridge = BRIDGE_MODULE.RuyiBridge()
                        response = bridge.handle(
                            {
                                "id": request_id,
                                "method": "browser.launch",
                                "params": {
                                    "browserPath": "/contract/fake-firefox",
                                    "proxy": proxy_url,
                                },
                            }
                        )
                        self.assertNotIn("error", response)
                        self.assertEqual(FakeLaunchOptions.instances[-1].proxy, proxy_url)
                        bridge.handle(
                            {"id": request_id + 100, "method": "browser.quit", "params": {}}
                        )

    def test_bridge_owns_default_profile_and_passes_it_to_smart_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile_root = Path(tmp) / "profiles"
            with (
                patch.dict(
                    BRIDGE_MODULE.os.environ,
                    {"RUYI_MCP_PROFILE_ROOT": str(profile_root)},
                    clear=False,
                ),
                patch.object(BRIDGE_MODULE, "FirefoxOptions", FakeLaunchOptions),
                patch.object(BRIDGE_MODULE, "FirefoxPage", FakeLaunchPage),
            ):
                bridge = BRIDGE_MODULE.RuyiBridge()
                launch = bridge.handle(
                    {
                        "id": 11,
                        "method": "browser.launch",
                        "params": {
                            "browserPath": "/contract/fake-firefox",
                            "fingerprint": {"requireCountry": "US"},
                        },
                    }
                )
                self.assertNotIn("error", launch)
                profile = Path(launch["result"]["profilePath"])
                self.assertEqual(profile.parent, profile_root.resolve())
                self.assertTrue(profile.is_dir())
                self.assertEqual(launch["result"]["profileMode"], "managed")
                self.assertEqual(FakeLaunchOptions.instances[-1].profile, str(profile))
                self.assertEqual(
                    FakeLaunchOptions.instances[-1].fingerprint_kwargs["userdir"],
                    str(profile),
                )

                quit_response = bridge.handle(
                    {"id": 12, "method": "browser.quit", "params": {}}
                )

            self.assertNotIn("error", quit_response)
            self.assertEqual(
                quit_response["result"]["profileCleanup"],
                {"attempted": True, "removed": True},
            )
            self.assertFalse(profile.exists())

    def test_bridge_rejects_relative_profile_path(self):
        with (
            patch.object(BRIDGE_MODULE, "FirefoxOptions", FakeLaunchOptions),
            patch.object(BRIDGE_MODULE, "FirefoxPage", FakeLaunchPage),
        ):
            bridge = BRIDGE_MODULE.RuyiBridge()
            response = bridge.handle(
                {
                    "id": 12,
                    "method": "browser.launch",
                    "params": {
                        "browserPath": "/contract/fake-firefox",
                        "profilePath": "relative-profile",
                    },
                }
            )

        self.assertIn("error", response)
        self.assertIn("profilePath must be an absolute path", response["error"]["message"])

    def test_bridge_cleans_owned_profile_when_browser_startup_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile_root = Path(tmp) / "profiles"
            with (
                patch.dict(
                    BRIDGE_MODULE.os.environ,
                    {"RUYI_MCP_PROFILE_ROOT": str(profile_root)},
                    clear=False,
                ),
                patch.object(BRIDGE_MODULE, "FirefoxOptions", FakeLaunchOptions),
                patch.object(BRIDGE_MODULE, "FirefoxPage", FailingLaunchPage),
            ):
                bridge = BRIDGE_MODULE.RuyiBridge()
                response = bridge.handle(
                    {
                        "id": 121,
                        "method": "browser.launch",
                        "params": {"browserPath": "/contract/fake-firefox"},
                    }
                )

            self.assertIn("error", response)
            self.assertEqual(list(profile_root.iterdir()), [])
            self.assertIsNone(bridge._managed_profile)
            self.assertIsNone(bridge._profile_path)

    def test_bridge_preserves_explicit_external_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "external-profile"
            with (
                patch.object(BRIDGE_MODULE, "FirefoxOptions", FakeLaunchOptions),
                patch.object(BRIDGE_MODULE, "FirefoxPage", FakeLaunchPage),
            ):
                bridge = BRIDGE_MODULE.RuyiBridge()
                launch = bridge.handle(
                    {
                        "id": 13,
                        "method": "browser.launch",
                        "params": {
                            "browserPath": "/contract/fake-firefox",
                            "profilePath": str(profile),
                        },
                    }
                )
                self.assertNotIn("error", launch)
                self.assertEqual(launch["result"]["profileMode"], "external")
                self.assertEqual(FakeLaunchOptions.instances[-1].profile, str(profile.resolve()))
                profile.mkdir()
                quit_response = bridge.handle(
                    {"id": 14, "method": "browser.quit", "params": {}}
                )

            self.assertNotIn("error", quit_response)
            self.assertEqual(quit_response["result"], {})
            self.assertTrue(profile.exists())

    def test_bridge_attaches_existing_browser_without_owning_its_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "profile"
            with (
                patch.object(BRIDGE_MODULE, "FirefoxOptions", FakeLaunchOptions),
                patch.object(BRIDGE_MODULE, "FirefoxPage", FakeLaunchPage),
            ):
                bridge = BRIDGE_MODULE.RuyiBridge()
                response = bridge.handle(
                    {
                        "id": 20,
                        "method": "browser.launch",
                        "params": {
                            "existingOnly": True,
                            "address": "127.0.0.1",
                            "port": 26700,
                            "profilePath": str(profile),
                        },
                    }
                )

            self.assertNotIn("error", response)
            options = FakeLaunchOptions.instances[-1]
            self.assertEqual(options.address, "127.0.0.1:26700")
            self.assertIsNone(options.browser_path)
            self.assertTrue(options.existing)
            self.assertFalse(options.close_on_exit_value)
            self.assertEqual(options.profile, str(profile.resolve()))
            self.assertTrue(response["result"]["attached"])
            self.assertEqual(response["result"]["profileMode"], "external")
            self.assertFalse(response["result"]["closeOnExit"])

    def test_quit_detaches_attached_browser_without_browser_close(self):
        with (
            patch.object(BRIDGE_MODULE, "FirefoxOptions", FakeLaunchOptions),
            patch.object(BRIDGE_MODULE, "FirefoxPage", FakeAttachPage),
        ):
            bridge = BRIDGE_MODULE.RuyiBridge()
            launch = bridge.handle(
                {
                    "id": 13,
                    "method": "browser.launch",
                    "params": {
                        "browserPath": "/contract/fake-firefox",
                        "existingOnly": True,
                        "address": "127.0.0.1",
                        "port": 26700,
                    },
                }
            )
            page = bridge.page
            quit_response = bridge.handle(
                {"id": 14, "method": "browser.quit", "params": {}}
            )

        self.assertNotIn("error", launch)
        self.assertNotIn("error", quit_response)
        self.assertEqual(page._firefox.detach_calls, 1)
        self.assertEqual(page.quit_calls, 0)
        self.assertFalse(page._firefox._initialized)
        self.assertNotIn(page._firefox.address, FakeAttachPage._PAGES)
        self.assertNotIn(page._firefox.address, FakeAttachBrowser._BROWSERS)

    def test_ruyipage_1256_failed_owned_startup_cleans_process_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "profile"
            processes = [FakeFirefoxProcess(1001), FakeFirefoxProcess(1002)]
            instances = []
            taskkill_calls = []

            def launch(browser):
                profile.mkdir(exist_ok=True)
                browser._auto_profile = str(profile)
                browser._reserve_port(9222)
                browser._process = processes.pop(0)
                Firefox._BROWSERS["stale"] = browser
                instances.append(browser)

            with (
                patch.object(browser_module.sys, "platform", "win32"),
                patch.object(
                    Firefox,
                    "_ensure_launch_port_available",
                    lambda browser: None,
                ),
                patch.object(Firefox, "_launch_browser", launch),
                patch.object(Firefox, "_wait_for_connection", lambda browser: False),
                patch.object(
                    browser_module.subprocess,
                    "run",
                    side_effect=lambda command, **kwargs: taskkill_calls.append(command),
                ),
            ):
                options = FirefoxOptions().set_address("127.0.0.1:9222")
                with self.assertRaises(BrowserConnectError):
                    Firefox(options)

            self.assertEqual(
                {tuple(command) for command in taskkill_calls},
                {
                    ("taskkill", "/F", "/T", "/PID", "1001"),
                    ("taskkill", "/F", "/T", "/PID", "1002"),
                },
            )
            self.assertIsNone(instances[-1]._process)
            self.assertIsNone(instances[-1]._auto_profile)
            self.assertFalse(profile.exists())
            self.assertNotIn(9222, Firefox._RESERVED_PORTS)
            self.assertFalse(Firefox._BROWSERS)

    def test_ruyipage_1256_failed_existing_only_startup_preserves_process(self):
        external_process = FakeFirefoxProcess(2001)
        instances = []
        taskkill_calls = []

        def try_connect(browser):
            browser._process = external_process
            instances.append(browser)
            return False

        with (
            patch.object(browser_module.sys, "platform", "win32"),
            patch.object(Firefox, "_try_connect", try_connect),
            patch.object(
                browser_module.subprocess,
                "run",
                side_effect=lambda command, **kwargs: taskkill_calls.append(command),
            ),
        ):
            options = (
                FirefoxOptions()
                .set_address("127.0.0.1:9223")
                .existing_only(True)
            )
            with self.assertRaises(BrowserConnectError):
                Firefox(options)

        self.assertEqual(external_process.events, [])
        self.assertEqual(taskkill_calls, [])
        self.assertIsNone(instances[-1]._process)
        self.assertFalse(Firefox._BROWSERS)

    def test_ruyipage_1256_force_quit_terminates_owned_process_tree(self):
        process = FakeFirefoxProcess(3001)
        taskkill_calls = []
        browser = make_upstream_browser_for_quit(FirefoxOptions(), process)

        with (
            patch.object(browser_module.sys, "platform", "win32"),
            patch.object(
                browser_module.subprocess,
                "run",
                side_effect=lambda command, **kwargs: taskkill_calls.append(command),
            ),
        ):
            browser.quit(force=True)

        self.assertEqual(
            taskkill_calls,
            [["taskkill", "/F", "/T", "/PID", "3001"]],
        )
        self.assertEqual(process.events, [("wait", 5)])
        self.assertIsNone(browser._process)

    def test_ruyipage_1256_existing_only_quit_detaches_external_process(self):
        process = FakeFirefoxProcess(4001)
        options = FirefoxOptions().existing_only(True)
        browser = make_upstream_browser_for_quit(options, process)
        driver_events = []
        browser._driver = SimpleNamespace(
            mark_closing=lambda: driver_events.append("mark_closing"),
            stop=lambda: driver_events.append("stop"),
        )

        with (
            patch.object(browser_module.sys, "platform", "win32"),
            patch.object(browser, "_teardown_proxy_auth") as teardown_proxy_auth,
            patch.object(browser_module.subprocess, "run") as subprocess_run,
        ):
            browser.quit(force=True)

        self.assertEqual(driver_events, ["mark_closing", "stop"])
        teardown_proxy_auth.assert_called_once_with()
        subprocess_run.assert_not_called()
        self.assertEqual(process.events, [])
        self.assertIsNone(browser._process)
        self.assertIsNone(browser._driver)

    def test_ruyipage_generates_http_and_socks_runtime_auth_files(self):
        cases = (
            (
                "http://user%40tenant:pa%24%24@proxy.example.com:1000",
                "httpauth",
                {"username": "user@tenant", "password": "pa$$"},
            ),
            (
                "socks5://user%2Bname:pa%24%24@proxy.example.com:1080",
                "socksauth",
                {"username": "user+name", "password": "pa$$"},
            ),
        )

        for proxy_url, prefix, credentials in cases:
            with self.subTest(proxy_url=proxy_url), tempfile.TemporaryDirectory() as tmp:
                profile = Path(tmp) / "profile"
                options = FirefoxOptions().set_profile(str(profile)).set_proxy(proxy_url)
                options.prepare_runtime_files()

                runtime_fpfile = Path(options.fpfile)
                self.assertEqual(runtime_fpfile.parent, profile)
                self.assertTrue(runtime_fpfile.is_file())
                runtime_text = runtime_fpfile.read_text(encoding="utf-8")
                self.assertIn(f"{prefix}.username:{credentials['username']}", runtime_text)
                self.assertIn(f"{prefix}.password:{credentials['password']}", runtime_text)
                other_prefix = "socksauth" if prefix == "httpauth" else "httpauth"
                self.assertNotIn(f"{other_prefix}.username", runtime_text)
                self.assertEqual(options._get_proxy_auth_credentials(), credentials)

                options.write_prefs_to_profile()
                user_js = (profile / "user.js").read_text(encoding="utf-8")
                self.assertIn('user_pref("network.proxy.type", 1);', user_js)
                self.assertIn('proxy.example.com', user_js)
                self.assertNotIn("user%", user_js)
                self.assertNotIn("pa%24%24", user_js)

    def test_ruyipage_smart_fingerprint_uses_explicit_userdir(self):
        geo = fingerprint_builder.GeoInfo(
            ip="198.51.100.42",
            country_code="US",
            country="United States",
            region="CA",
            city="Los Angeles",
            timezone="America/Los_Angeles",
            latitude=34.0522,
            longitude=-118.2437,
            source="contract-fixture",
        )
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "managed-profile"
            options = FirefoxOptions()
            with (
                patch.object(fingerprint_builder, "fetch_geo_info", return_value=geo),
                patch.object(fingerprint_builder, "fetch_public_ipv6", return_value=None),
            ):
                context = options.smart_fingerprint(
                    userdir=str(profile),
                    require_country="US",
                )

            self.assertEqual(Path(context.userdir), profile.resolve())
            self.assertEqual(Path(options.profile_path), profile.resolve())
            self.assertEqual(Path(context.fpfile_path).parent, profile.resolve())
            self.assertTrue((profile / "fpfile.txt").is_file())

    def test_ruyipage_1256_window_fingerprint_and_action_contracts(self):
        smart_signature = inspect.signature(fingerprint_builder.apply_smart_fingerprint)
        self.assertFalse(smart_signature.parameters["set_window_size_on_opts"].default)
        emulation_signature = inspect.signature(
            fingerprint_builder.FingerprintContext.apply_emulation
        )
        self.assertTrue(emulation_signature.parameters["set_screen_size"].default)
        self.assertFalse(hasattr(fingerprint_builder, "_safe_startup_window_size"))

        fpfile_source = inspect.getsource(fingerprint_builder.write_fpfile)
        self.assertNotIn('a("width:"', fpfile_source)
        self.assertNotIn('a("height:"', fpfile_source)

        options = FirefoxOptions().set_window_size(1366, 768)
        self.assertEqual(options.startup_window_size, (1366, 768))
        self.assertTrue(hasattr(ruyipage.FirefoxPage, "set_window_size"))

        runtime_page = FirefoxBase.__new__(FirefoxBase)
        FirefoxBase.__init__(runtime_page)
        runtime_window = FakeRuntimeWindow()
        runtime_page._window = runtime_window
        runtime_page.set_window_size(960, 640, device_pixel_ratio=1.25)
        self.assertEqual(runtime_window.calls, [(960, 640)])

        actions = Actions(SimpleNamespace())
        random.seed(70)
        path = actions._build_windmouse_path((100, 100), (500, 300))
        self.assertLess(len(path), 120)
        self.assertEqual(path[-1], (500.0, 300.0))

        stages = [
            {"source": "pointer", "actions": [{"type": "pointerDown", "button": 0}]},
            {"source": "wait", "actions": [], "duration": 100},
            {"source": "pointer", "actions": [{"type": "pointerMove", "x": 200, "y": 100}]},
            {"source": "pointer", "actions": [{"type": "pointerUp", "button": 0}]},
        ]
        merged = actions._coalesce_pointer_drag_stages(stages)
        self.assertEqual(len(merged), 1)
        self.assertEqual(
            [item["type"] for item in merged[0]["actions"]],
            ["pointerDown", "pause", "pointerMove", "pointerUp"],
        )

    def test_window_and_screen_size_handlers_are_explicit_and_separate(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeFingerprintPage()
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 18,
                "method": "fingerprint.set",
                "params": {
                    "pageIdx": 0,
                    "windowSize": {
                        "width": 1280,
                        "height": 720,
                        "devicePixelRatio": 1.25,
                    },
                    "screenSize": {
                        "width": 1366,
                        "height": 768,
                        "devicePixelRatio": 1.25,
                    },
                },
            }
        )

        self.assertNotIn("error", response)
        self.assertEqual(
            page.calls,
            [
                ("set_window_size", 1280, 720, None),
                ("set_screen_size", 1366, 768, None),
            ],
        )
        self.assertEqual(response["result"]["size"]["mode"], "windowSize")
        self.assertTrue(response["result"]["size"]["naturalViewport"])
        self.assertEqual(
            response["result"]["screenSize"]["requested"],
            {"width": 1366, "height": 768, "devicePixelRatio": 1.25},
        )
        self.assertTrue(response["result"]["screenSize"]["verified"])
        self.assertTrue(response["result"]["screenSize"]["screenSizeApplied"])
        self.assertEqual(
            response["result"]["screenSize"]["actual"],
            page.actual_screen,
        )
        self.assertFalse(response["result"]["screenSize"]["devicePixelRatioApplied"])
        self.assertIn(
            "windowSize.devicePixelRatio is ignored",
            response["result"]["warnings"][0],
        )
        self.assertIn(
            "screenSize.devicePixelRatio is ignored",
            response["result"]["warnings"][1],
        )

        viewport_bridge = BRIDGE_MODULE.RuyiBridge()
        viewport_page = FakeFingerprintPage()
        viewport_bridge.pages[0] = viewport_page
        viewport_response = viewport_bridge.handle(
            {
                "id": 181,
                "method": "fingerprint.set",
                "params": {
                    "pageIdx": 0,
                    "viewport": {
                        "width": 800,
                        "height": 600,
                        "devicePixelRatio": 1.25,
                    },
                },
            }
        )
        self.assertNotIn("error", viewport_response)
        self.assertEqual(
            viewport_page.calls,
            [("set_viewport", 800, 600, 1.25)],
        )
        self.assertEqual(
            viewport_response["result"]["size"],
            {
                "mode": "viewport",
                "width": 800,
                "height": 600,
                "devicePixelRatio": 1.25,
            },
        )

        invalid = bridge.handle(
            {
                "id": 19,
                "method": "fingerprint.set",
                "params": {
                    "pageIdx": 0,
                    "viewport": {"width": 800, "height": 600},
                    "windowSize": {"width": 1280, "height": 720},
                },
            }
        )
        self.assertIn("error", invalid)

    def test_ruyipage_1256_data_collector_uses_current_bidi_payload(self):
        class RecordingDriver:
            def __init__(self):
                self.calls = []

            def run(self, method, params=None, **kwargs):
                self.calls.append((method, params, kwargs))
                return {"collector": "fixture-collector"}

        driver = RecordingDriver()
        result = bidi_network.add_data_collector(
            driver,
            events=["network.responseCompleted"],
            contexts="context-1",
            max_encoded_data_size=131072,
            data_types=["response"],
            collector_type="blob",
        )

        self.assertEqual(result, {"collector": "fixture-collector"})
        self.assertEqual(len(driver.calls), 1)
        method, payload, kwargs = driver.calls[0]
        self.assertEqual(method, "network.addDataCollector")
        self.assertEqual(kwargs, {})
        self.assertEqual(
            payload,
            {
                "dataTypes": ["response"],
                "maxEncodedDataSize": 131072,
                "collectorType": "blob",
                "contexts": ["context-1"],
            },
        )
        self.assertNotIn("events", payload)

    def test_capture_wait_normalizes_count_one_packet_to_list(self):
        packet = FakeCapturePacket()
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeCapturePage(packet)
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 22,
                "method": "network.capture_wait",
                "params": {"pageIdx": 0, "timeout": 3, "count": 1},
            }
        )

        self.assertNotIn("error", response)
        self.assertEqual(page.capture.wait_calls, [(3, 1)])
        result_packet = response["result"]["packets"][0]
        self.assertEqual(result_packet["url"], "https://fixture.invalid/api")
        self.assertEqual(result_packet["queryKeys"], ["kind", "token"])
        self.assertEqual(result_packet["status"], 200)
        self.assertEqual(result_packet["method"], "POST")
        self.assertEqual(result_packet["requestHeaders"], {"content-type": "application/json"})
        self.assertEqual(result_packet["responseHeaders"], {"content-type": "application/json"})
        self.assertEqual(result_packet["requestBody"], {"state": "not_requested"})
        self.assertEqual(result_packet["responseBody"], {"state": "not_requested"})
        self.assertEqual(packet.body_reads, [])
        self.assertNotIn("secret", json.dumps(response))
        self.assertEqual(response["result"]["resultMode"], "metadata")
        self.assertIsNone(response["result"]["bodyLimitChars"])

    def test_capture_start_selects_collector_mode_and_schema_never_returns_body_values(self):
        packet = FakeCapturePacket()
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeCapturePage(packet)
        bridge.pages[0] = page

        default_started = bridge.handle(
            {
                "id": 219,
                "method": "network.capture_start",
                "params": {"pageIdx": 0},
            }
        )
        self.assertNotIn("error", default_started)
        self.assertEqual(default_started["result"]["resultMode"], "metadata")
        blocked_upgrade = bridge.handle(
            {
                "id": 2191,
                "method": "network.capture_wait",
                "params": {"pageIdx": 0, "resultMode": "schema"},
            }
        )
        self.assertIn("error", blocked_upgrade)
        self.assertIn("disabled at start", blocked_upgrade["error"]["message"])

        started = bridge.handle(
            {
                "id": 220,
                "method": "network.capture_start",
                "params": {"pageIdx": 0, "pattern": "/api", "resultMode": "schema"},
            }
        )
        self.assertNotIn("error", started)
        self.assertEqual(
            page.capture.start_calls,
            [("", None, False), ("/api", None, True)],
        )
        self.assertEqual(started["result"]["resultMode"], "schema")

        schema = bridge.handle(
            {
                "id": 221,
                "method": "network.capture_wait",
                "params": {
                    "pageIdx": 0,
                    "timeout": 1,
                    "count": 1,
                },
            }
        )
        self.assertNotIn("error", schema)
        schema_packet = schema["result"]["packets"][0]
        self.assertEqual(schema_packet["requestBody"]["format"], "json-object")
        self.assertEqual(schema_packet["requestBody"]["topLevelKeys"], ["credential", "page"])
        self.assertEqual(schema_packet["responseBody"]["topLevelKeys"], ["ok", "token"])
        self.assertEqual(len(packet.body_reads), 2)
        self.assertNotIn("secret", json.dumps(schema))

    def test_capture_body_mode_writes_jsonl_without_returning_body_values(self):
        packet = FakeCapturePacket(
            request_body="x" * 64,
            response_body="y" * 64,
        )
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeCapturePage(packet)
        bridge.pages[0] = page

        bridge.handle(
            {
                "id": 221,
                "method": "network.capture_start",
                "params": {"pageIdx": 0, "resultMode": "body"},
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            output_file = str(Path(tmp) / "capture.jsonl")
            response = bridge.handle(
                {
                    "id": 222,
                    "method": "network.capture_wait",
                    "params": {
                        "pageIdx": 0,
                        "timeout": 1,
                        "count": 1,
                        "resultMode": "body",
                        "outputFile": output_file,
                        "maxBodyChars": 8,
                    },
                }
            )
            self.assertNotIn("error", response)
            self.assertEqual(response["result"]["resultMode"], "body")
            self.assertEqual(response["result"]["appendedPackets"], 1)
            self.assertNotIn("x" * 64, json.dumps(response))
            saved = [json.loads(line) for line in Path(output_file).read_text(encoding="utf-8").splitlines()]

        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["requestBody"], "x" * 8)
        self.assertEqual(saved[0]["responseBody"], "y" * 8)
        self.assertTrue(saved[0]["requestBodyTruncated"])
        self.assertTrue(saved[0]["responseBodyTruncated"])

    def test_capture_restart_clears_active_history_before_upstream_stop_can_hydrate(self):
        old_packet = FakeCapturePacket()
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeCapturePage(None, history=[old_packet])
        bridge.pages[0] = page

        restarted = bridge.handle(
            {
                "id": 223,
                "method": "network.capture_start",
                "params": {"pageIdx": 0},
            }
        )

        self.assertNotIn("error", restarted)
        self.assertEqual(restarted["result"]["clearedPreviousPacketHistory"], 1)
        self.assertEqual(page.capture.clear_calls, 1)
        self.assertEqual(old_packet.body_reads, [])

    def test_capture_wait_preserves_empty_and_multi_packet_results(self):
        cases = (
            ("empty", None, 1, []),
            (
                "multi",
                [
                    SimpleNamespace(url="https://fixture.invalid/1", status=200),
                    SimpleNamespace(url="https://fixture.invalid/2", status=204),
                ],
                2,
                ["https://fixture.invalid/1", "https://fixture.invalid/2"],
            ),
        )

        for label, capture_result, count, expected_urls in cases:
            with self.subTest(label=label):
                bridge = BRIDGE_MODULE.RuyiBridge()
                page = FakeCapturePage(capture_result)
                bridge.pages[0] = page
                response = bridge.handle(
                    {
                        "id": 23,
                        "method": "network.capture_wait",
                        "params": {"pageIdx": 0, "timeout": 2, "count": count},
                    }
                )

                self.assertNotIn("error", response)
                self.assertEqual(page.capture.wait_calls, [(2, count)])
                self.assertEqual(
                    [item["url"] for item in response["result"]["packets"]],
                    expected_urls,
                )

    def test_capture_stop_clears_history_and_bounds_bidi_cleanup(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeCapturePage(None, history=[object(), object(), object()])
        bridge.pages[0] = page
        original_bidi_timeout = self.settings.bidi_timeout

        response = bridge.handle(
            {
                "id": 24,
                "method": "network.capture_stop",
                "params": {"pageIdx": 0, "cleanupTimeout": 2.5},
            }
        )

        self.assertNotIn("error", response)
        self.assertEqual(page.capture.clear_calls, 1)
        self.assertEqual(page.capture.stop_calls, [(0, 2.5)])
        self.assertFalse(page.capture.active)
        self.assertEqual(self.settings.bidi_timeout, original_bidi_timeout)
        self.assertEqual(response["result"]["capturing"], False)
        self.assertEqual(response["result"]["clearedPacketHistory"], 3)
        self.assertEqual(response["result"]["mode"], "discard")
        self.assertEqual(response["result"]["observed"], 3)
        self.assertEqual(response["result"]["returned"], 0)
        self.assertEqual(response["result"]["discarded"], 3)
        self.assertEqual(response["result"]["bodyUnavailable"], 0)
        self.assertEqual(response["result"]["cleanupTimeoutSeconds"], 2.5)
        self.assertGreaterEqual(response["result"]["elapsedMs"], 0)

        invalid = bridge.handle(
            {
                "id": 25,
                "method": "network.capture_stop",
                "params": {"pageIdx": 0, "cleanupTimeout": 0},
            }
        )
        self.assertIn("error", invalid)

    def test_capture_stop_metadata_returns_only_unconsumed_safe_summaries(self):
        first = FakeCapturePacket(request_id="first")
        second = FakeCapturePacket(request_id="second")
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeCapturePage(first, history=[first, second])
        page.capture.active = False
        bridge.pages[0] = page

        bridge.handle(
            {
                "id": 240,
                "method": "network.capture_start",
                "params": {"pageIdx": 0},
            }
        )
        waited = bridge.handle(
            {
                "id": 241,
                "method": "network.capture_wait",
                "params": {"pageIdx": 0, "timeout": 1, "count": 1},
            }
        )
        self.assertNotIn("error", waited)

        stopped = bridge.handle(
            {
                "id": 242,
                "method": "network.capture_stop",
                "params": {"pageIdx": 0, "mode": "metadata", "metadataLimit": 10},
            }
        )
        self.assertNotIn("error", stopped)
        result = stopped["result"]
        self.assertEqual(result["observed"], 2)
        self.assertEqual(result["returned"], 2)
        self.assertEqual(result["discarded"], 0)
        self.assertEqual(len(result["metadataPackets"]), 1)
        self.assertEqual(result["metadataPackets"][0]["requestBody"], {"state": "not_requested"})
        self.assertEqual(second.body_reads, [])
        self.assertNotIn("secret", json.dumps(stopped))

    def test_capture_stop_restores_global_timeout_when_cleanup_raises(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeCapturePage(
            None,
            history=[object()],
            stop_error=RuntimeError("fixture cleanup failure"),
        )
        bridge.pages[0] = page
        original_bidi_timeout = self.settings.bidi_timeout

        response = bridge.handle(
            {
                "id": 26,
                "method": "network.capture_stop",
                "params": {"pageIdx": 0, "cleanupTimeout": 1.5},
            }
        )

        self.assertIn("error", response)
        self.assertEqual(page.capture.clear_calls, 1)
        self.assertEqual(page.capture.stop_calls, [(0, 1.5)])
        self.assertEqual(self.settings.bidi_timeout, original_bidi_timeout)

    def test_intercept_defaults_to_safe_metadata_and_continues_the_request(self):
        request = FakeInterceptRequest()
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeInterceptPage(request)
        bridge.pages[0] = page

        started = bridge.handle(
            {
                "id": 270,
                "method": "intercept.start_req",
                "params": {"pageIdx": 0},
            }
        )
        self.assertNotIn("error", started)
        self.assertEqual(page.intercept.start_requests_calls, [(None, False)])

        waited = bridge.handle(
            {
                "id": 271,
                "method": "intercept.wait",
                "params": {"pageIdx": 0, "timeout": 1},
            }
        )
        self.assertNotIn("error", waited)
        result = waited["result"]
        self.assertEqual(result["resultMode"], "metadata")
        self.assertEqual(result["continued"], "continue_request")
        self.assertEqual(request.continued, ["continue_request"])
        self.assertEqual(result["url"], "https://fixture.invalid/intercept")
        self.assertEqual(result["queryKeys"], ["token"])
        self.assertEqual(result["requestBody"], {"state": "not_requested"})
        self.assertEqual(result["requestHeaders"], {"content-type": "application/json"})
        self.assertNotIn("secret", json.dumps(waited))

    def test_intercept_body_mode_writes_jsonl_without_returning_body_values(self):
        request = FakeInterceptRequest(response_phase=True)
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeInterceptPage(request)
        bridge.pages[0] = page
        bridge.handle(
            {
                "id": 272,
                "method": "intercept.start_resp",
                "params": {"pageIdx": 0, "resultMode": "body"},
            }
        )
        self.assertEqual(page.intercept.start_responses_calls, [(None, True)])

        with tempfile.TemporaryDirectory() as tmp:
            output_file = str(Path(tmp) / "intercept.jsonl")
            waited = bridge.handle(
                {
                    "id": 273,
                    "method": "intercept.wait",
                    "params": {
                        "pageIdx": 0,
                        "outputFile": output_file,
                        "maxBodyChars": 16,
                    },
                }
            )
            self.assertNotIn("error", waited)
            saved = [json.loads(line) for line in Path(output_file).read_text(encoding="utf-8").splitlines()]

        self.assertEqual(waited["result"]["resultMode"], "body")
        self.assertEqual(waited["result"]["continued"], "continue_response")
        self.assertNotIn("secret", json.dumps(waited))
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0]["requestBody"].startswith('{"requestSecret'))
        self.assertTrue(saved[0]["responseBody"].startswith('{"responseSecret'))

    def test_new_tabs_reapply_fingerprint_before_first_navigation(self):
        for container in (False, True):
            with self.subTest(container=container):
                events = []
                bridge = BRIDGE_MODULE.RuyiBridge()
                page = FakeContainerPage(events)
                fingerprint = FakeFingerprintContext(events)
                bridge.page = page
                bridge.pages[0] = page
                bridge._next_page_idx = 1
                bridge._fingerprint_ctx = fingerprint

                target_url = "https://fixture.invalid/target"
                response = bridge.handle(
                    {
                        "id": 20,
                        "method": "page.new",
                        "params": {
                            "url": target_url,
                            "timeout": 17,
                            "container": container,
                        },
                    }
                )

                self.assertNotIn("error", response)
                create_event = "create-container" if container else "create-normal"
                self.assertEqual(
                    events,
                    [
                        (create_event, None),
                        ("emulate", page.tab, container),
                        ("navigate", target_url, 17),
                    ],
                )
                self.assertEqual(fingerprint.calls, [(page.tab, container)])
                self.assertEqual(
                    response["result"]["fingerprintEmulation"]["screen"],
                    container,
                )

    def test_container_creation_failure_never_downgrades_to_normal_tab(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeFailingContainerPage()
        bridge.page = page
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 201,
                "method": "page.new",
                "params": {
                    "url": "https://fixture.invalid/container",
                    "container": True,
                },
            }
        )

        self.assertIn("error", response)
        self.assertIn("refusing to fall back", response["error"]["message"])
        self.assertEqual(page.fallback_calls, 0)

    def test_navigation_failure_closes_tab_without_registering_it(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeNavigationFailurePage()
        bridge.page = page
        bridge.pages[0] = page
        bridge._next_page_idx = 1

        response = bridge.handle(
            {
                "id": 202,
                "method": "page.new",
                "params": {
                    "url": "https://fixture.invalid/fail",
                    "container": False,
                },
            }
        )

        self.assertIn("error", response)
        self.assertEqual(
            page.events,
            [
                ("create-normal", None),
                ("navigate", "https://fixture.invalid/fail", 30),
            ],
        )
        self.assertTrue(page.tab.closed)
        self.assertEqual(bridge.pages, {0: page})
        self.assertEqual(bridge._next_page_idx, 1)

    def test_frame_selector_uses_ruyipage_1256_content_window_mapping(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeFramePage()
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 21,
                "method": "frame.select",
                "params": {"pageIdx": 0, "selector": "#second"},
            }
        )

        self.assertNotIn("error", response)
        self.assertEqual(page.calls, [{"locator": "css:#second"}])
        self.assertEqual(response["result"]["selectedBy"], "selector")
        self.assertEqual(response["result"]["contextId"], "frame-selector-context")
        self.assertEqual(response["result"]["url"], "https://frame.fixture.invalid/B")
        self.assertEqual(response["result"]["queryKeys"], ["secret"])
        self.assertEqual(response["result"]["target"]["kind"], "frame")

    def test_frame_context_targets_evaluate_and_invalid_ids_never_fall_back(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeFramePage()
        other_page = FakeFramePage()
        other_page.frames[0]._context_id = "other-tab-frame"
        bridge.pages[0] = page
        bridge.pages[1] = other_page

        selected = bridge.handle(
            {
                "id": 203,
                "method": "frame.select",
                "params": {"pageIdx": 0, "contextId": "frame-selector-context"},
            }
        )
        self.assertNotIn("error", selected)

        targeted = bridge.handle(
            {
                "id": 204,
                "method": "script.evaluate",
                "params": {
                    "pageIdx": 0,
                    "frameContextId": "frame-selector-context",
                    "script": "() => document.querySelector('#value').textContent",
                },
            }
        )
        self.assertNotIn("error", targeted)
        self.assertEqual(targeted["result"]["result"], "B")
        self.assertEqual(targeted["result"]["target"]["contextId"], "frame-selector-context")
        self.assertEqual(page.run_js_calls, [])
        self.assertEqual(len(page.frames[1].run_js_calls), 1)

        for request_id, frame_context_id in enumerate(
            ("missing-frame", "other-tab-frame"),
            start=205,
        ):
            with self.subTest(frame_context_id=frame_context_id):
                invalid = bridge.handle(
                    {
                        "id": request_id,
                        "method": "script.evaluate",
                        "params": {
                            "pageIdx": 0,
                            "frameContextId": frame_context_id,
                            "script": "() => 'should-not-run'",
                        },
                    }
                )
                self.assertIn("error", invalid)
                self.assertIn("frame_context_not_found", invalid["error"]["message"])
                self.assertEqual(page.run_js_calls, [])

    def test_human_action_uses_the_explicit_frame_bidi_context(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        frame = FakeHumanPage()
        frame._context_id = "child-human-context"
        page = FakeFrameActionPage(frame)
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 210,
                "method": "human.click",
                "params": {
                    "pageIdx": 0,
                    "frameContextId": "child-human-context",
                    "target": "#target",
                    "algorithm": "windmouse",
                },
            }
        )

        self.assertNotIn("error", response)
        self.assertEqual(response["result"]["target"]["kind"], "frame")
        self.assertEqual(len(frame.browser_driver.calls), 1)
        self.assertEqual(
            frame.browser_driver.calls[0][1]["context"],
            "child-human-context",
        )

    def test_human_click_resets_remote_and_cached_pointer_before_perform(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeHumanPage()
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 211,
                "method": "human.click",
                "params": {
                    "pageIdx": 0,
                    "target": "#target",
                    "algorithm": "windmouse",
                },
            }
        )

        self.assertNotIn("error", response)
        self.assertTrue(response["result"]["clicked"])
        self.assertTrue(response["result"]["pointerReset"])
        self.assertTrue(response["result"]["atomicPointer"])
        self.assertFalse(page.actions._pointer_position_known)
        self.assertEqual(
            page.actions.calls,
            [
                ("release_all",),
                ("human_move", page.elements["css:#target"], None, "windmouse"),
                ("perform",),
            ],
        )
        self.assertEqual(len(page.browser_driver.calls), 1)
        method, payload = page.browser_driver.calls[0]
        self.assertEqual(method, "input.performActions")
        self.assertEqual(payload["context"], "human-context")
        click_actions = payload["actions"][0]["actions"]
        self.assertEqual(click_actions[0]["type"], "pointerMove")
        self.assertEqual((click_actions[0]["x"], click_actions[0]["y"]), (688, 857))
        self.assertEqual(
            [action["type"] for action in click_actions],
            ["pointerMove", "pointerDown", "pause", "pointerUp"],
        )

    def test_human_scroll_emits_small_native_wheel_steps_in_one_direction(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeWheelPage()
        bridge.pages[0] = page

        with (
            patch.object(BRIDGE_MODULE.random, "randint", side_effect=[70, 150, 90, 250, 110]),
            patch.object(BRIDGE_MODULE.time, "sleep") as sleep,
        ):
            response = bridge.handle(
                {
                    "id": 212,
                    "method": "human.scroll",
                    "params": {
                        "pageIdx": 0,
                        "direction": "down",
                        "steps": 3,
                        "minStep": 60,
                        "maxStep": 140,
                        "minPauseMs": 120,
                        "maxPauseMs": 500,
                    },
                }
            )

        self.assertNotIn("error", response)
        self.assertEqual(response["result"]["deltas"], [70, 90, 110])
        self.assertEqual(response["result"]["pausesMs"], [150, 250])
        self.assertEqual(response["result"]["totalDelta"], 270)
        self.assertTrue(response["result"]["nativeWheel"])
        sleep.assert_has_calls([unittest.mock.call(0.15), unittest.mock.call(0.25)])
        self.assertEqual(len(page.browser_driver.calls), 3)
        for index, (method, payload) in enumerate(page.browser_driver.calls):
            self.assertEqual(method, "input.performActions")
            self.assertEqual(payload["context"], "wheel-context")
            source = payload["actions"][0]
            self.assertEqual((source["type"], source["id"]), ("wheel", "wheel0"))
            action = source["actions"][0]
            self.assertEqual(action["type"], "scroll")
            self.assertEqual((action["x"], action["y"]), (640, 477))
            self.assertEqual(action["deltaX"], 0)
            self.assertEqual(action["deltaY"], [70, 90, 110][index])

    def test_human_scroll_supports_up_and_rejects_invalid_ranges(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeWheelPage()
        bridge.pages[0] = page

        with patch.object(BRIDGE_MODULE.random, "randint", return_value=80):
            upward = bridge.handle(
                {
                    "id": 213,
                    "method": "human.scroll",
                    "params": {
                        "pageIdx": 0,
                        "direction": "up",
                        "steps": 1,
                        "minStep": 60,
                        "maxStep": 140,
                    },
                }
            )
        self.assertEqual(upward["result"]["deltas"], [-80])

        invalid_cases = (
            {"direction": "sideways"},
            {"steps": 0},
            {"minStep": 141, "maxStep": 140},
            {"minPauseMs": 501, "maxPauseMs": 500},
        )
        for offset, params in enumerate(invalid_cases):
            with self.subTest(params=params):
                response = bridge.handle(
                    {
                        "id": 214 + offset,
                        "method": "human.scroll",
                        "params": {"pageIdx": 0, **params},
                    }
                )
                self.assertIn("error", response)

    def test_human_drag_builds_atomic_waited_chain(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeHumanPage()
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 21,
                "method": "human.drag",
                "params": {
                    "pageIdx": 0,
                    "source": "#source",
                    "target": "#target",
                    "algorithm": "windmouse",
                    "style": "linear",
                    "holdMs": 120,
                    "releaseMs": 80,
                },
            }
        )

        self.assertNotIn("error", response)
        self.assertTrue(response["result"]["dragged"])
        self.assertEqual(response["result"]["style"], "line")
        self.assertEqual(
            page.actions.calls,
            [
                ("move_to", page.elements["css:#source"]),
                ("hold", None, 0),
                ("wait", 0.12),
                ("human_move", page.elements["css:#target"], "line", "windmouse"),
                ("wait", 0.08),
                ("release", None, 0),
                ("perform",),
            ],
        )

    def test_orientation_handler_ignores_unsupported_angle(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeOrientationPage()
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 20,
                "method": "fingerprint.set",
                "params": {
                    "pageIdx": 0,
                    "screenOrientation": {
                        "type": "landscape-primary",
                        "angle": 90,
                    },
                },
            }
        )

        self.assertNotIn("error", response)
        self.assertEqual(page.calls, [("landscape-primary",)])
        self.assertEqual(
            response["result"]["screenOrientation"],
            {
                "requested": {"type": "landscape-primary", "angle": 90},
                "forwarded": {"type": "landscape-primary"},
                "typeForwarded": True,
                "verified": True,
                "actual": {"type": "landscape-primary", "angle": 0},
                "applied": {"type": "landscape-primary"},
                "typeApplied": True,
                "angleApplied": False,
            },
        )
        self.assertIn(
            "screenOrientation.angle is ignored",
            response["result"]["warnings"][0],
        )

    def test_orientation_handler_does_not_claim_unsupported_type(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        page = FakeOrientationPage(apply_orientation=False)
        bridge.pages[0] = page

        response = bridge.handle(
            {
                "id": 21,
                "method": "fingerprint.set",
                "params": {
                    "pageIdx": 0,
                    "screenOrientation": {"type": "portrait-primary"},
                },
            }
        )

        self.assertNotIn("error", response)
        self.assertEqual(page.calls, [("portrait-primary",)])
        self.assertEqual(
            response["result"]["screenOrientation"],
            {
                "requested": {"type": "portrait-primary"},
                "forwarded": {"type": "portrait-primary"},
                "typeForwarded": True,
                "verified": True,
                "typeApplied": False,
                "actual": {"type": "landscape-primary", "angle": 0},
            },
        )
        self.assertIn(
            "screenOrientation.type was forwarded but not applied",
            response["result"]["warnings"][0],
        )

    def test_bridge_run_stdin_eof_uses_common_cleanup_path(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        bridge._quit = Mock(return_value={})
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            patch.object(BRIDGE_MODULE.sys, "stdin", io.StringIO("")),
            patch.object(BRIDGE_MODULE.sys, "stdout", stdout),
            patch.object(BRIDGE_MODULE.sys, "stderr", stderr),
        ):
            bridge.run()

        bridge._quit.assert_called_once_with({})
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("[ruyi_bridge] Ready", stderr.getvalue())
        self.assertIn("[ruyi_bridge] Shutdown complete", stderr.getvalue())

    def test_bridge_run_explicit_shutdown_uses_common_cleanup_once(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        bridge._quit = Mock(return_value={})
        stdin = io.StringIO(
            json.dumps({"id": 99, "method": "__shutdown__", "params": {}}) + "\n"
        )
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            patch.object(BRIDGE_MODULE.sys, "stdin", stdin),
            patch.object(BRIDGE_MODULE.sys, "stdout", stdout),
            patch.object(BRIDGE_MODULE.sys, "stderr", stderr),
        ):
            bridge.run()

        bridge._quit.assert_called_once_with({})
        response = json.loads(stdout.getvalue())
        self.assertEqual(response, {"id": 99, "result": {"shutdown": True}})
        self.assertIn("[ruyi_bridge] Shutdown complete", stderr.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
