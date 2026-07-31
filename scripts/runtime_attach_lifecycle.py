#!/usr/bin/env python3
"""Opt-in attach/detach ownership gate for a ruyiPage-compatible Firefox."""

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
    spec = importlib.util.spec_from_file_location(
        "ruyi_mcp_attach_runtime_bridge", BRIDGE_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load bridge module from {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evict_owner_cache(page) -> None:
    """Release the launch connection without losing ownership of its process."""
    browser = page._firefox
    address = browser.address
    browser._detach_on_exit()
    browser_cache = getattr(type(browser), "_BROWSERS", None)
    if isinstance(browser_cache, dict):
        lock = getattr(type(browser), "_lock", None)
        if lock is None:
            browser_cache.pop(address, None)
        else:
            with lock:
                browser_cache.pop(address, None)


def attach_once(bridge_module, address: str, marker: str) -> dict:
    host, port_text = address.rsplit(":", 1)
    bridge = bridge_module.RuyiBridge()
    launch_result = bridge._launch(
        {
            "existingOnly": True,
            "address": host,
            "port": int(port_text),
        }
    )
    try:
        observed = bridge.page.run_js("return window.__ruyiAttachMarker")
        assert observed == marker, {"expected": marker, "observed": observed}
        assert launch_result["attached"] is True, launch_result
        assert launch_result["closeOnExit"] is False, launch_result
        return {
            "launch": launch_result,
            "marker": observed,
            "statusBeforeDetach": bridge._status({}),
        }
    finally:
        bridge._quit({})


def run_gate(firefox_path: Path, headless: bool) -> dict:
    bridge_module = load_bridge_module()
    marker = "ruyi-mcp-attach-survival-1.2.56"
    marker_html = (
        "<!doctype html><html><body><script>"
        f"window.__ruyiAttachMarker={json.dumps(marker)};"
        "</script></body></html>"
    )

    with tempfile.TemporaryDirectory(prefix="ruyi_mcp_attach_1256_") as tmp:
        profile = Path(tmp) / "profile"
        options = (
            FirefoxOptions()
            .set_browser_path(str(firefox_path))
            .set_profile(str(profile))
            .set_window_size(960, 640)
            .close_on_exit(False)
        )
        if headless:
            options.headless(True)

        owner_page = None
        owner_browser = None
        try:
            owner_page = FirefoxPage(options)
            owner_page.get(
                "data:text/html;charset=utf-8," + quote(marker_html)
            )
            owner_page.wait(0.2)
            owner_browser = owner_page._firefox
            owner_process = owner_browser._process
            if owner_process is None or owner_process.poll() is not None:
                raise RuntimeError("Owner Firefox process is not alive before attach")

            address = owner_browser.address
            pid = owner_process.pid
            evict_owner_cache(owner_page)

            first = attach_once(bridge_module, address, marker)
            assert owner_process.poll() is None, "First detach terminated caller-owned Firefox"
            second = attach_once(bridge_module, address, marker)
            assert owner_process.poll() is None, "Second detach terminated caller-owned Firefox"

            return {
                "firefox": str(firefox_path),
                "headless": headless,
                "address": address,
                "ownerPid": pid,
                "firstAttach": first,
                "secondAttach": second,
                "survivedBothDetaches": True,
            }
        finally:
            if owner_browser is not None:
                try:
                    owner_browser.quit(timeout=5, force=True)
                except Exception:
                    terminate = getattr(owner_browser, "_terminate_owned_process_tree", None)
                    if callable(terminate):
                        terminate(timeout=5)
            elif owner_page is not None:
                try:
                    owner_page.quit(force=True)
                except Exception:
                    pass
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
