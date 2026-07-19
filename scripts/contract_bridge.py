#!/usr/bin/env python3
"""Offline contracts for the ruyiPage dependency and Python bridge.

The checks intentionally avoid launching Firefox.  They exercise the exact
installed ruyiPage version, its runtime proxy-auth file generation, and the
bridge handlers with small fake browser objects.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import inspect
import json
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ruyipage
from ruyipage import FirefoxOptions
from ruyipage._fingerprint import builder as fingerprint_builder
from ruyipage._pages.firefox_base import FirefoxBase
from ruyipage._units.actions import Actions


EXPECTED_RUYIPAGE_VERSION = "1.2.54"
REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "bridge" / "ruyi_bridge.py"
REQUIREMENTS_PATH = REPO_ROOT / "requirements.txt"


def load_bridge_module():
    spec = importlib.util.spec_from_file_location("ruyi_mcp_contract_bridge", BRIDGE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load bridge module from {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BRIDGE_MODULE = load_bridge_module()


class FakeLaunchOptions:
    """Small launch-options fake that records values passed by the bridge."""

    instances: list["FakeLaunchOptions"] = []

    def __init__(self):
        self.browser_path = None
        self.proxy = None
        self.trace_enabled = False
        FakeLaunchOptions.instances.append(self)

    def set_browser_path(self, path):
        self.browser_path = path
        return self

    def set_proxy(self, proxy):
        self.proxy = proxy
        return self

    def enable_trace(self, enabled=True):
        self.trace_enabled = bool(enabled)
        return self


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


class FakeOrientationPage:
    def __init__(self):
        self.calls: list[tuple[str, int]] = []

    def set_screen_orientation(self, *, orientation_type, angle=0):
        self.calls.append((orientation_type, angle))


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
    def __init__(self, result):
        self.result = result
        self.wait_calls: list[tuple[float, int]] = []

    def wait(self, *, timeout, count):
        self.wait_calls.append((timeout, count))
        return self.result


class FakeCapturePage:
    def __init__(self, result):
        self.capture = FakeCaptureManager(result)


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
    _context_id = "frame-selector-context"
    url = "about:srcdoc"
    title = "fixture frame"
    is_cross_origin = False


class FakeFramePage:
    def __init__(self):
        self.calls: list[dict] = []

    def get_frame(self, **kwargs):
        self.calls.append(kwargs)
        return FakeFrame()


class FakeHumanActions:
    def __init__(self):
        self.calls: list[tuple] = []

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
    def __init__(self):
        self.actions = FakeHumanActions()
        self.elements = {
            "css:#source": object(),
            "css:#target": object(),
        }

    def ele(self, selector):
        return self.elements.get(selector)


class FakeTracer:
    def __init__(self, settings, entries=None):
        self.settings = settings
        self.entries = list(entries or [])
        self.clear_calls = 0
        self.dump_calls = 0
        self.dump_trace_enabled: list[bool] = []

    def clear(self):
        self.clear_calls += 1
        self.entries.clear()

    def latest(self, limit=50):
        return self.entries[-limit:]

    def summary(self):
        return {"entryCount": len(self.entries)}

    def dump_json(self):
        self.dump_calls += 1
        self.dump_trace_enabled.append(bool(self.settings.trace_enabled))
        serializable = [entry.to_dict() if hasattr(entry, "to_dict") else entry for entry in self.entries]
        return json.dumps(serializable, ensure_ascii=False)


class FakeTraceEntry:
    def __init__(self, event):
        self.event = event

    def to_dict(self):
        return {"event": self.event}


class FakeTraceOptions:
    def __init__(self, enabled=False):
        self.trace_enabled = bool(enabled)
        self.enable_trace_calls: list[bool] = []

    def enable_trace(self, enabled=True):
        self.trace_enabled = bool(enabled)
        self.enable_trace_calls.append(self.trace_enabled)
        return self


class FakeTracePage:
    def __init__(self, tracer, settings=None, options=None):
        self._tracer = tracer
        self.settings = settings
        self.options = options
        self.trace_accesses = 0
        self.quit_calls = 0
        self.quit_trace_states: list[tuple[bool | None, bool | None]] = []

    @property
    def trace(self):
        self.trace_accesses += 1
        return self._tracer

    def quit(self):
        self.quit_calls += 1
        settings_state = None if self.settings is None else bool(self.settings.trace_enabled)
        options_state = None if self.options is None else bool(self.options.trace_enabled)
        self.quit_trace_states.append((settings_state, options_state))


class RuyiBridgeContractTests(unittest.TestCase):
    def setUp(self):
        FakeLaunchOptions.instances.clear()
        self.settings = BRIDGE_MODULE.Settings
        self.original_trace_enabled = self.settings.trace_enabled
        self.settings.trace_enabled = False

    def tearDown(self):
        self.settings.trace_enabled = self.original_trace_enabled

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
            "human.drag",
            "trace.start",
            "trace.stop",
            "trace.results",
        }
        self.assertTrue(expected_handlers.issubset(bridge._handlers))
        self.assertEqual(
            bridge.handle({"id": 1, "method": "browser.status", "params": {}}),
            {"id": 1, "result": {"alive": False}},
        )

    def test_bridge_passes_credentialed_proxy_urls_to_ruyipage_unchanged(self):
        proxy_urls = (
            "http://user%40tenant:pa%24%24@proxy.example.com:1000",
            "socks5://user%2Bname:pa%24%24@proxy.example.com:1080",
        )

        with (
            patch.object(BRIDGE_MODULE, "FirefoxOptions", FakeLaunchOptions),
            patch.object(BRIDGE_MODULE, "FirefoxPage", FakeLaunchPage),
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

    def test_ruyipage_1254_window_fingerprint_and_action_contracts(self):
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
                ("set_screen_size", 1366, 768, 1.25),
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
        self.assertIn("ignored", response["result"]["warnings"][0])
        self.assertIn("not applied", response["result"]["warnings"][1])

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

    def test_capture_wait_normalizes_count_one_packet_to_list(self):
        packet = SimpleNamespace(
            url="https://fixture.invalid/api",
            status=200,
            method="POST",
            request_body='{"fixture":true}',
            response_body='{"ok":true}',
        )
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
        self.assertEqual(
            response["result"]["packets"],
            [
                {
                    "url": "https://fixture.invalid/api",
                    "status": 200,
                    "method": "POST",
                    "requestBody": '{"fixture":true}',
                    "responseBody": '{"ok":true}',
                }
            ],
        )

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

    def test_frame_selector_uses_ruyipage_1254_content_window_mapping(self):
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

    def test_orientation_handler_uses_orientation_type_keyword(self):
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
        self.assertEqual(page.calls, [("landscape-primary", 90)])

    def test_runtime_trace_start_clears_old_buffer_and_stop_preserves_dump(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        tracer = FakeTracer(self.settings, entries=[{"event": "stale"}])
        options = FakeTraceOptions()
        page = FakeTracePage(tracer)
        bridge.pages[0] = page
        bridge.opts = options
        bridge._trace_enabled_at_launch = False

        with tempfile.TemporaryDirectory() as tmp:
            output_file = Path(tmp) / "trace.json"
            start = bridge.handle(
                {
                    "id": 30,
                    "method": "trace.start",
                    "params": {"pageIdx": 0, "outputFile": str(output_file)},
                }
            )
            self.assertNotIn("error", start)
            self.assertEqual(
                {key: start["result"][key] for key in ("tracing", "fullTrace", "partialTrace")},
                {"tracing": True, "fullTrace": False, "partialTrace": True},
            )
            self.assertFalse(start["result"]["alreadyTracing"])
            self.assertTrue(self.settings.trace_enabled)
            self.assertTrue(options.trace_enabled)
            self.assertGreaterEqual(page.trace_accesses, 1)
            self.assertEqual(tracer.clear_calls, 1)
            self.assertEqual(tracer.entries, [])

            runtime_entry = FakeTraceEntry("runtime")
            tracer.entries.append(runtime_entry)
            repeated_start = bridge.handle(
                {
                    "id": 31,
                    "method": "trace.start",
                    "params": {"pageIdx": 0, "outputFile": str(output_file)},
                }
            )
            self.assertNotIn("error", repeated_start)
            self.assertTrue(repeated_start["result"]["alreadyTracing"])
            self.assertEqual(tracer.clear_calls, 1)
            self.assertEqual(tracer.entries, [runtime_entry])

            active_results = bridge.handle(
                {
                    "id": 32,
                    "method": "trace.results",
                    "params": {"pageIdx": 0, "limit": 10},
                }
            )
            self.assertEqual(active_results["result"]["tracing"], True)
            self.assertEqual(active_results["result"]["entries"], [{"event": "runtime"}])

            stop = bridge.handle(
                {"id": 33, "method": "trace.stop", "params": {"pageIdx": 0}}
            )
            self.assertNotIn("error", stop)
            self.assertFalse(stop["result"]["tracing"])
            self.assertFalse(self.settings.trace_enabled)
            self.assertFalse(options.trace_enabled)
            self.assertEqual(tracer.dump_trace_enabled, [True])
            self.assertEqual(tracer.clear_calls, 1)
            self.assertEqual(tracer.entries, [runtime_entry])
            self.assertEqual(
                json.loads(output_file.read_text(encoding="utf-8")),
                [{"event": "runtime"}],
            )

            stopped_results = bridge.handle(
                {
                    "id": 34,
                    "method": "trace.results",
                    "params": {"pageIdx": 0, "limit": 10},
                }
            )
            self.assertEqual(stopped_results["result"]["tracing"], False)
            self.assertEqual(stopped_results["result"]["entries"], [{"event": "runtime"}])

            restarted = bridge.handle(
                {"id": 35, "method": "trace.start", "params": {"pageIdx": 0}}
            )
            self.assertNotIn("error", restarted)
            self.assertFalse(restarted["result"]["alreadyTracing"])
            self.assertTrue(self.settings.trace_enabled)
            self.assertTrue(options.trace_enabled)
            self.assertEqual(tracer.clear_calls, 2)
            self.assertEqual(tracer.entries, [])

    def test_launch_trace_start_keeps_initial_navigation_evidence(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        tracer = FakeTracer(self.settings, entries=[{"event": "initial-navigation"}])
        options = FakeTraceOptions(enabled=True)
        page = FakeTracePage(tracer)
        bridge.pages[0] = page
        bridge.opts = options
        bridge._trace_enabled_at_launch = True
        self.settings.trace_enabled = True

        start = bridge.handle(
            {"id": 40, "method": "trace.start", "params": {"pageIdx": 0}}
        )

        self.assertNotIn("error", start)
        self.assertEqual(
            {key: start["result"][key] for key in ("tracing", "fullTrace", "partialTrace")},
            {"tracing": True, "fullTrace": True, "partialTrace": False},
        )
        self.assertTrue(start["result"]["alreadyTracing"])
        self.assertTrue(self.settings.trace_enabled)
        self.assertTrue(options.trace_enabled)
        self.assertEqual(tracer.clear_calls, 0)
        self.assertEqual(tracer.entries, [{"event": "initial-navigation"}])

    def test_trace_start_failure_restores_settings_and_options(self):
        class BrokenTracePage:
            @property
            def trace(self):
                raise RuntimeError("trace unavailable")

        bridge = BRIDGE_MODULE.RuyiBridge()
        options = FakeTraceOptions(enabled=False)
        bridge.pages[0] = BrokenTracePage()
        bridge.opts = options
        self.settings.trace_enabled = True

        response = bridge.handle(
            {"id": 45, "method": "trace.start", "params": {"pageIdx": 0}}
        )

        self.assertIn("error", response)
        self.assertTrue(self.settings.trace_enabled)
        self.assertFalse(options.trace_enabled)
        self.assertEqual(options.enable_trace_calls, [True, False])
        self.assertFalse(bridge._trace_active)

    def test_trace_option_enable_failure_restores_settings(self):
        class BrokenTraceOptions(FakeTraceOptions):
            def enable_trace(self, enabled=True):
                enabled = bool(enabled)
                self.enable_trace_calls.append(enabled)
                if enabled:
                    raise RuntimeError("trace option unavailable")
                self.trace_enabled = False
                return self

        tracer = FakeTracer(self.settings)
        page = FakeTracePage(tracer)
        options = BrokenTraceOptions(enabled=False)
        bridge = BRIDGE_MODULE.RuyiBridge()
        bridge.pages[0] = page
        bridge.opts = options
        self.settings.trace_enabled = False

        response = bridge.handle(
            {"id": 46, "method": "trace.start", "params": {"pageIdx": 0}}
        )

        self.assertIn("error", response)
        self.assertFalse(self.settings.trace_enabled)
        self.assertFalse(options.trace_enabled)
        self.assertEqual(options.enable_trace_calls, [True, False])
        self.assertEqual(page.trace_accesses, 0)
        self.assertFalse(bridge._trace_active)

    def test_browser_quit_disables_global_trace_recording(self):
        bridge = BRIDGE_MODULE.RuyiBridge()
        tracer = FakeTracer(self.settings)
        options = FakeTraceOptions(enabled=True)
        page = FakeTracePage(tracer, settings=self.settings, options=options)
        bridge.page = page
        bridge.pages[0] = page
        bridge.opts = options
        self.settings.trace_enabled = True

        response = bridge.handle({"id": 50, "method": "browser.quit", "params": {}})

        self.assertNotIn("error", response)
        self.assertFalse(self.settings.trace_enabled)
        self.assertFalse(options.trace_enabled)
        self.assertEqual(page.quit_calls, 1)
        self.assertEqual(page.quit_trace_states, [(False, False)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
