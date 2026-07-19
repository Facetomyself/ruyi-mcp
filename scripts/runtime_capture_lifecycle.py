#!/usr/bin/env python3
"""Opt-in real Firefox gate for bounded capture start/wait/stop cycles."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "bridge" / "ruyi_bridge.py"
HTML_BODY = (
    '<!doctype html><meta charset="utf-8">'
    '<title>ruyi capture lifecycle</title><body>'
    + ("x" * (128 * 1024))
    + "</body>"
).encode("utf-8")


def load_bridge_module():
    spec = importlib.util.spec_from_file_location(
        "ruyi_mcp_capture_runtime_bridge", BRIDGE_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load bridge module from {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CaptureFixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/capture/redirect":
            location = "/capture/page"
            if parsed.query:
                location += f"?{parsed.query}"
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if parsed.path == "/capture/page":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(HTML_BODY)))
            self.end_headers()
            self.wfile.write(HTML_BODY)
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, _format, *_args):
        return


def run_gate(firefox_path: Path, cycles: int, cleanup_timeout: float, headless: bool):
    bridge_module = load_bridge_module()
    server = ThreadingHTTPServer(("127.0.0.1", 0), CaptureFixtureHandler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    bridge = bridge_module.RuyiBridge()
    page = None
    metrics = []
    try:
        bridge._launch(
            {
                "browserPath": str(firefox_path),
                "headless": headless,
            }
        )
        page = bridge.pages[0]
        page.network.set_cache_behavior("bypass")
        port = server.server_address[1]
        pattern = f"127.0.0.1:{port}/capture/"

        for cycle in range(cycles):
            target = f"http://127.0.0.1:{port}/capture/redirect?cycle={cycle}"
            cycle_started = time.monotonic()
            bridge._capture_start(
                {
                    "pageIdx": 0,
                    "pattern": pattern,
                    "method": "GET",
                }
            )
            bridge._navigate({"pageIdx": 0, "url": target, "timeout": 20})
            capture_result = bridge._capture_wait(
                {"pageIdx": 0, "timeout": 10, "count": 2}
            )
            packets = capture_result["packets"]
            assert len(packets) == 2, packets
            assert [packet["status"] for packet in packets] == [302, 200], packets
            assert "ruyi capture lifecycle" in (packets[1]["responseBody"] or "")

            stop_result = bridge._capture_stop(
                {
                    "pageIdx": 0,
                    "cleanupTimeout": cleanup_timeout,
                }
            )
            assert stop_result["capturing"] is False, stop_result
            assert stop_result["clearedPacketHistory"] >= 2, stop_result
            assert stop_result["cleanupTimeoutSeconds"] <= cleanup_timeout, stop_result
            assert stop_result["elapsedMs"] <= (cleanup_timeout * 2000) + 2000, stop_result
            assert page.capture.active is False

            metrics.append(
                {
                    "cycle": cycle,
                    "packets": len(packets),
                    "statusChain": [packet["status"] for packet in packets],
                    "stopElapsedMs": stop_result["elapsedMs"],
                    "cycleElapsedMs": round((time.monotonic() - cycle_started) * 1000),
                }
            )

        return {
            "firefox": str(firefox_path),
            "headless": headless,
            "cycles": cycles,
            "cleanupTimeoutSeconds": cleanup_timeout,
            "maxStopElapsedMs": max(item["stopElapsedMs"] for item in metrics),
            "maxCycleElapsedMs": max(item["cycleElapsedMs"] for item in metrics),
            "allStatusChains": [item["statusChain"] for item in metrics],
        }
    finally:
        try:
            if page is not None and page.capture.active:
                bridge._capture_stop(
                    {"pageIdx": 0, "cleanupTimeout": cleanup_timeout}
                )
        finally:
            try:
                bridge._quit({})
            finally:
                server.shutdown()
                server.server_close()
                server_thread.join(timeout=2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--firefox",
        default=os.environ.get("RUYI_FIREFOX_PATH"),
        help="Path to a ruyiPage-compatible Firefox executable",
    )
    parser.add_argument("--cycles", type=int, default=20)
    parser.add_argument("--cleanup-timeout", type=float, default=2.0)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    if sys.flags.optimize:
        raise SystemExit("Runtime gate requires assertions; do not run Python with -O")
    if not args.firefox:
        raise SystemExit("Set RUYI_FIREFOX_PATH or pass --firefox")
    if args.cycles < 1:
        raise SystemExit("--cycles must be >= 1")
    if not 0 < args.cleanup_timeout <= 30:
        raise SystemExit("--cleanup-timeout must be in (0, 30]")

    firefox_path = Path(args.firefox).expanduser().resolve()
    if not firefox_path.is_file():
        raise SystemExit(f"Firefox executable not found: {firefox_path}")

    result = run_gate(
        firefox_path,
        cycles=args.cycles,
        cleanup_timeout=args.cleanup_timeout,
        headless=not args.headed,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
