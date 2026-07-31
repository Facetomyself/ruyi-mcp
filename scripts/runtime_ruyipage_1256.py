#!/usr/bin/env python3
"""Opt-in offline Firefox 151 runtime gate for the ruyiPage 1.2.56 contract."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import quote

from ruyipage import FirefoxOptions, FirefoxPage


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "bridge" / "ruyi_bridge.py"


def load_bridge_module():
    spec = importlib.util.spec_from_file_location("ruyi_mcp_runtime_bridge", BRIDGE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load bridge module from {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def page_metrics(page):
    return page.run_js(
        """
        return {
          outer: {width: window.outerWidth, height: window.outerHeight},
          inner: {width: window.innerWidth, height: window.innerHeight},
          screen: {width: screen.width, height: screen.height},
          dpr: window.devicePixelRatio
        };
        """
    )


class RuntimeFingerprintContext:
    """Small deterministic context used to verify pre-navigation replay."""

    def __init__(self, width=1500, height=950):
        self.width = width
        self.height = height
        self.calls = 0

    def apply_emulation(self, page, *, set_screen_size=True):
        self.calls += 1
        if set_screen_size:
            page.emulation.set_screen_size(
                self.width,
                self.height,
            )
        return {
            "screen": bool(set_screen_size),
            "geolocation": False,
            "locale": False,
            "timezone": False,
            "headers": False,
        }


def run_gate(firefox_path: Path, headless: bool) -> dict:
    bridge_module = load_bridge_module()
    with tempfile.TemporaryDirectory(prefix="ruyi_mcp_1256_") as tmp:
        profile = Path(tmp) / "profile"
        options = (
            FirefoxOptions()
            .set_browser_path(str(firefox_path))
            .set_profile(str(profile))
            .set_window_size(960, 640)
        )
        if headless:
            options.headless(True)

        page = None
        try:
            page = FirefoxPage(options)
            page.get("about:blank")
            bridge = bridge_module.RuyiBridge()
            bridge.page = page
            bridge.pages[0] = page
            bridge._next_page_idx = 1

            window_result = bridge._set_fingerprint(
                {
                    "pageIdx": 0,
                    "windowSize": {
                        "width": 960,
                        "height": 640,
                        "devicePixelRatio": 1.25,
                    },
                }
            )
            page.wait(0.3)
            natural = page_metrics(page)
            assert natural["outer"] == {"width": 960, "height": 640}, natural
            assert 0 < natural["inner"]["width"] <= natural["outer"]["width"], natural
            assert 0 < natural["inner"]["height"] <= natural["outer"]["height"], natural
            assert natural["inner"] != natural["outer"], natural
            assert window_result["size"]["naturalViewport"] is True
            assert "ignored" in window_result["warnings"][0]

            screen_result = bridge._set_fingerprint(
                {
                    "pageIdx": 0,
                    "screenSize": {
                        "width": 1440,
                        "height": 900,
                        "devicePixelRatio": 1.25,
                    },
                }
            )
            page.wait(0.2)
            explicit_screen = page_metrics(page)
            assert explicit_screen["screen"] == {"width": 1440, "height": 900}, explicit_screen
            assert explicit_screen["outer"] == natural["outer"], explicit_screen
            assert explicit_screen["inner"] == natural["inner"], explicit_screen
            assert screen_result["screenSize"]["actual"]["width"] == 1440
            assert screen_result["screenSize"]["actual"]["height"] == 900
            assert screen_result["screenSize"]["devicePixelRatioApplied"] is False
            assert any(
                "screenSize.devicePixelRatio is ignored" in warning
                for warning in screen_result["warnings"]
            ), screen_result

            orientation_result = bridge._set_fingerprint(
                {
                    "pageIdx": 0,
                    "screenOrientation": {
                        "type": "portrait-primary",
                        "angle": 90,
                    },
                }
            )
            orientation_contract = orientation_result["screenOrientation"]
            assert orientation_contract["typeForwarded"] is True
            assert orientation_contract["verified"] is True
            assert orientation_contract["typeApplied"] is True
            assert orientation_contract["angleApplied"] is False
            assert orientation_contract["actual"]["type"] == "portrait-primary"
            assert orientation_contract["actual"]["angle"] != 90
            assert any(
                "screenOrientation.angle is ignored" in warning
                for warning in orientation_result["warnings"]
            ), orientation_result

            fingerprint = RuntimeFingerprintContext()
            bridge._fingerprint_ctx = fingerprint
            first_navigation_html = """
            <!doctype html><html><body><script>
              window.__firstNavigationMetrics = {
                screen: {width: screen.width, height: screen.height},
                dpr: window.devicePixelRatio
              };
            </script></body></html>
            """
            first_navigation_url = (
                "data:text/html;charset=utf-8," + quote(first_navigation_html)
            )
            normal_result = bridge._new_tab(
                {"url": first_navigation_url, "container": False}
            )
            normal_tab = bridge.pages[normal_result["pageIdx"]]
            normal_tab.wait(0.2)
            normal_screen = page_metrics(normal_tab)
            normal_first_navigation = normal_tab.run_js(
                "return window.__firstNavigationMetrics"
            )
            assert normal_screen["screen"] == {"width": 1440, "height": 900}, normal_screen
            assert normal_first_navigation["screen"] == {"width": 1440, "height": 900}, normal_first_navigation
            assert fingerprint.calls == 1
            assert normal_result["fingerprintEmulation"]["screen"] is False
            viewport_result = bridge._set_fingerprint(
                {
                    "pageIdx": normal_result["pageIdx"],
                    "viewport": {
                        "width": 800,
                        "height": 500,
                        "devicePixelRatio": 1.25,
                    },
                }
            )
            normal_tab.wait(0.2)
            explicit_viewport = page_metrics(normal_tab)
            assert explicit_viewport["inner"] == {"width": 800, "height": 500}, explicit_viewport
            assert explicit_viewport["dpr"] == 1.25, explicit_viewport
            assert explicit_viewport["outer"] == normal_screen["outer"], explicit_viewport
            assert explicit_viewport["screen"] == {"width": 1440, "height": 900}, explicit_viewport
            assert viewport_result["size"]["devicePixelRatio"] == 1.25

            frame_html = """
            <!doctype html><html><body>
              <iframe id="first" srcdoc="<p id='value'>A</p>"></iframe>
              <iframe id="second" srcdoc="<p id='value'>B</p>"></iframe>
            </body></html>
            """
            page.get("data:text/html;charset=utf-8," + quote(frame_html))
            page.wait(0.2)
            frame_result = bridge._frame_select(
                {"pageIdx": 0, "selector": "#second"}
            )
            assert frame_result["found"] is True, frame_result
            assert frame_result["selectedBy"] == "selector", frame_result
            frame = bridge._frame_obj[frame_result["contextId"]]
            frame_value = frame.ele("css:#value").text
            assert frame_value == "B", frame_value

            drag_html = """
            <!doctype html><html><head><style>
              #track { position: relative; width: 420px; height: 60px; margin: 80px; background: #ddd; }
              #handle { position: absolute; left: 0; top: 5px; width: 50px; height: 50px; background: #369; }
              #target { position: absolute; left: 330px; top: 5px; width: 50px; height: 50px; background: #693; }
            </style></head><body><div id="track"><div id="handle"></div><div id="target"></div></div>
            <script>
              const state = {events: [], captures: [], left: 0};
              const handle = document.querySelector('#handle');
              let startX = 0;
              let dragging = false;
              function record(event) {
                state.events.push({type: event.type, buttons: event.buttons, x: event.clientX});
              }
              handle.addEventListener('gotpointercapture', () => state.captures.push('got'));
              handle.addEventListener('lostpointercapture', () => state.captures.push('lost'));
              handle.addEventListener('pointerdown', event => {
                record(event); dragging = true; startX = event.clientX;
                handle.setPointerCapture(event.pointerId);
              });
              handle.addEventListener('pointermove', event => {
                record(event);
                if (!dragging || event.buttons !== 1) return;
                state.left = Math.max(0, Math.min(330, event.clientX - startX));
                handle.style.left = state.left + 'px';
              });
              handle.addEventListener('pointerup', event => {
                record(event); dragging = false; handle.releasePointerCapture(event.pointerId);
              });
              window.__ruyiDragState = state;
            </script></body></html>
            """
            page.get("data:text/html;charset=utf-8," + quote(drag_html))
            drag_result = bridge._human_drag(
                {
                    "pageIdx": 0,
                    "source": "#handle",
                    "target": "#target",
                    "style": "line",
                    "algorithm": "bezier",
                    "holdMs": 120,
                    "releaseMs": 80,
                }
            )
            page.wait(0.2)
            drag_state = page.run_js("return window.__ruyiDragState")
            down_index = next(
                index for index, event in enumerate(drag_state["events"])
                if event["type"] == "pointerdown"
            )
            up_index = next(
                index for index, event in enumerate(drag_state["events"])
                if event["type"] == "pointerup"
            )
            pressed_moves = [
                event for event in drag_state["events"][down_index + 1:up_index]
                if event["type"] == "pointermove"
            ]
            assert pressed_moves, drag_state
            assert all(event["buttons"] == 1 for event in pressed_moves), drag_state
            assert drag_state["left"] >= 280, drag_state
            assert drag_state["captures"] == ["got", "lost"], drag_state
            assert drag_result["dragged"] is True, drag_result

            interaction_html = """
            <!doctype html><html><head><style>
              body { margin: 0; min-height: 3200px; }
              #click-target { position: absolute; left: 120px; top: 120px; width: 180px; height: 60px; }
            </style></head><body><button id="click-target">click me</button>
            <script>
              window.__ruyiClickCount = 0;
              window.__ruyiWheelEvents = [];
              document.querySelector('#click-target').addEventListener('click', () => {
                window.__ruyiClickCount += 1;
              });
              window.addEventListener('wheel', event => {
                window.__ruyiWheelEvents.push({
                  deltaY: event.deltaY,
                  trusted: event.isTrusted,
                  target: event.target && event.target.tagName,
                  defaultPrevented: event.defaultPrevented
                });
              }, {passive: true});
            </script></body></html>
            """
            interaction_page_idx = normal_result["pageIdx"]
            interaction_page = normal_tab
            interaction_page.get(
                "data:text/html;charset=utf-8," + quote(interaction_html)
            )
            click_result = bridge._human_click(
                {
                    "pageIdx": interaction_page_idx,
                    "target": "#click-target",
                    "algorithm": "bezier",
                }
            )
            interaction_page.wait(0.2)
            click_count = interaction_page.run_js("return window.__ruyiClickCount")
            assert click_count == 1, {"clickCount": click_count, "result": click_result}
            assert click_result["pointerReset"] is True, click_result
            assert click_result["atomicPointer"] is True, click_result

            scroll_result = bridge._human_scroll(
                {
                    "pageIdx": interaction_page_idx,
                    "direction": "down",
                    "steps": 3,
                    "minStep": 90,
                    "maxStep": 90,
                    "minPauseMs": 100,
                    "maxPauseMs": 100,
                }
            )
            interaction_page.wait(0.2)
            scroll_state = interaction_page.run_js(
                "return {scrollY: window.scrollY, events: window.__ruyiWheelEvents, "
                "scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight}"
            )
            scroll_y = scroll_state["scrollY"]
            assert scroll_y > 0, {"state": scroll_state, "result": scroll_result}
            assert scroll_result["deltas"] == [90, 90, 90], scroll_result
            assert scroll_result["nativeWheel"] is True, scroll_result

            container_result = bridge._new_tab(
                {"url": first_navigation_url, "container": True}
            )
            container_tab = bridge.pages[container_result["pageIdx"]]
            container_tab.wait(0.2)
            container_screen = page_metrics(container_tab)
            container_first_navigation = container_tab.run_js(
                "return window.__firstNavigationMetrics"
            )
            assert container_screen["screen"] == {"width": 1500, "height": 950}, container_screen
            assert container_first_navigation["screen"] == {"width": 1500, "height": 950}, container_first_navigation
            assert fingerprint.calls == 2
            assert container_result["fingerprintEmulation"]["screen"] is True

            return {
                "firefox": str(firefox_path),
                "headless": headless,
                "naturalWindow": natural,
                "windowResult": window_result,
                "explicitScreen": explicit_screen,
                "screenResult": screen_result,
                "orientationResult": orientation_result,
                "normalTabScreen": normal_screen,
                "normalFirstNavigation": normal_first_navigation,
                "explicitViewport": explicit_viewport,
                "viewportResult": viewport_result,
                "containerTabScreen": container_screen,
                "containerFirstNavigation": container_first_navigation,
                "frameValue": frame_value,
                "frameResult": frame_result,
                "dragResult": drag_result,
                "pressedPointerMoves": len(pressed_moves),
                "clickResult": click_result,
                "clickCount": click_count,
                "scrollResult": scroll_result,
                "scrollState": scroll_state,
            }
        finally:
            if page is not None:
                page.quit()
            time.sleep(1.0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--firefox",
        default=os.environ.get("RUYI_FIREFOX_PATH"),
        help="Path to a ruyiPage-compatible Firefox executable",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run with a visible Firefox window instead of headless mode",
    )
    args = parser.parse_args()

    if sys.flags.optimize:
        raise SystemExit("Runtime gate requires assertions; do not run Python with -O")
    if not args.firefox:
        raise SystemExit("Set RUYI_FIREFOX_PATH or pass --firefox")

    firefox_path = Path(args.firefox).expanduser().resolve()
    if not firefox_path.is_file():
        raise SystemExit(f"Firefox executable not found: {firefox_path}")

    result = run_gate(firefox_path, headless=not args.headed)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
