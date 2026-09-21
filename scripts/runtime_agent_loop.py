#!/usr/bin/env python3
"""Opt-in local HTML gate for page.snapshot / page.act on 151-proxy.

Serves scripts/fixtures/agent-loop.html from 127.0.0.1. Does not open
external sites. Requires RUYI_FIREFOX_PATH or --firefox.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "bridge" / "ruyi_bridge.py"
FIXTURE_PATH = REPO_ROOT / "scripts" / "fixtures" / "agent-loop.html"
HTML_BODY = FIXTURE_PATH.read_bytes()


def load_bridge_module():
    spec = importlib.util.spec_from_file_location(
        "ruyi_mcp_agent_loop_bridge", BRIDGE_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load bridge module from {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AgentFixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path in {"/", "/agent-loop.html"}:
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


def node_named(snapshot: dict, name: str) -> dict:
    for node in snapshot["nodes"]:
        if node.get("name") == name:
            return node
    raise AssertionError(f"missing node {name!r} in {snapshot['nodes']}")


def read_out(bridge) -> str:
    result = bridge.handle(
        {
            "id": 90,
            "method": "script.evaluate",
            "params": {
                "pageIdx": 0,
                "script": "() => document.getElementById('out').textContent",
            },
        }
    )
    assert "error" not in result, result
    return str(result["result"]["result"])


def run_gate(firefox_path: Path, headless: bool) -> dict:
    bridge_module = load_bridge_module()
    server = ThreadingHTTPServer(("127.0.0.1", 0), AgentFixtureHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    bridge = bridge_module.RuyiBridge()
    try:
        launched = bridge._launch(
            {
                "browserPath": str(firefox_path),
                "headless": headless,
            }
        )
        assert launched.get("launched") or launched.get("alive") or bridge.pages
        url = f"http://127.0.0.1:{server.server_address[1]}/agent-loop.html"
        nav = bridge.handle(
            {
                "id": 1,
                "method": "page.navigate",
                "params": {"pageIdx": 0, "url": url, "timeout": 20},
            }
        )
        assert "error" not in nav, nav

        observed = bridge.handle(
            {"id": 2, "method": "page.snapshot", "params": {"pageIdx": 0}}
        )
        assert "error" not in observed, observed
        snapshot = observed["result"]
        snapshot_id = snapshot["snapshotId"]
        indexes = [node["index"] for node in snapshot["nodes"]]
        assert len(indexes) == len(set(indexes)), indexes
        go = node_named(snapshot, "Go")
        name = node_named(snapshot, "Name")
        color = node_named(snapshot, "Red") if any(
            node.get("name") == "Red" for node in snapshot["nodes"]
        ) else node_named(snapshot, "color") if False else next(
            node for node in snapshot["nodes"] if node.get("tag") == "select"
        )

        clicked = bridge.handle(
            {
                "id": 3,
                "method": "page.act",
                "params": {
                    "pageIdx": 0,
                    "op": "CLICK",
                    "snapshotId": snapshot_id,
                    "index": go["index"],
                },
            }
        )
        assert clicked["result"].get("ok") is True, clicked
        assert clicked["result"].get("retried") is False, clicked
        assert read_out(bridge) == "clicked"

        typed = bridge.handle(
            {
                "id": 4,
                "method": "page.act",
                "params": {
                    "pageIdx": 0,
                    "op": "TYPE_TEXT",
                    "snapshotId": snapshot_id,
                    "index": name["index"],
                    "text": "Ada",
                    "delayMs": 0,
                },
            }
        )
        assert typed["result"].get("ok") is True, typed
        assert read_out(bridge) == "typed"

        selected = bridge.handle(
            {
                "id": 5,
                "method": "page.act",
                "params": {
                    "pageIdx": 0,
                    "op": "SELECT",
                    "snapshotId": snapshot_id,
                    "index": color["index"],
                    "text": "blue",
                },
            }
        )
        assert selected["result"].get("ok") is True, selected
        assert read_out(bridge) == "selected"

        stale = bridge.handle(
            {
                "id": 6,
                "method": "page.act",
                "params": {
                    "pageIdx": 0,
                    "op": "CLICK",
                    "snapshotId": "snap_missing",
                    "index": 0,
                },
            }
        )
        assert stale["result"].get("miss") is True, stale
        assert stale["result"].get("retried") is False, stale

        return {
            "ok": True,
            "url": url,
            "snapshotId": snapshot_id,
            "nodeCount": snapshot["nodeCount"],
            "truncated": snapshot["truncated"],
        }
    finally:
        bridge._quit({})
        server.shutdown()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--firefox",
        default=os.environ.get("RUYI_FIREFOX_PATH", ""),
        help="151-proxy firefox.exe path",
    )
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    firefox = Path(str(args.firefox).strip())
    if not firefox.is_file():
        print("runtime_agent_loop: set --firefox or RUYI_FIREFOX_PATH", file=sys.stderr)
        return 2
    result = run_gate(firefox, headless=not args.headed)
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
