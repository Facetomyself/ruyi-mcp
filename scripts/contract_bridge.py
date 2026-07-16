#!/usr/bin/env python3
"""Offline contracts for the ruyiPage dependency and Python bridge.

The checks intentionally avoid launching Firefox.  They exercise the exact
installed ruyiPage version, its runtime proxy-auth file generation, and the
bridge handlers with small fake browser objects.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ruyipage
from ruyipage import FirefoxOptions
from ruyipage._fingerprint.builder import _safe_startup_window_size
from ruyipage._units.actions import Actions


EXPECTED_RUYIPAGE_VERSION = "1.2.50"
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

    def set_viewport(self, width, height):
        self.calls.append(("set_viewport", width, height))

    def set_window_size(self, width, height, device_pixel_ratio=None):
        self.calls.append(("set_window_size", width, height, device_pixel_ratio))


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

    def test_ruyipage_1250_window_and_action_regressions(self):
        self.assertEqual(_safe_startup_window_size(1366, 768), (1286, 688))

        options = FirefoxOptions().set_window_size(1366, 768)
        self.assertEqual(options.startup_window_size, (1366, 768))
        self.assertTrue(hasattr(ruyipage.FirefoxPage, "set_window_size"))

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

    def test_window_size_handler_uses_synchronized_api_and_rejects_viewport_mix(self):
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
                },
            }
        )

        self.assertNotIn("error", response)
        self.assertEqual(page.calls, [("set_window_size", 1280, 720, 1.25)])
        self.assertEqual(response["result"]["size"]["mode"], "windowSize")

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
