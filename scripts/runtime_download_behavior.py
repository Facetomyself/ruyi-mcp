#!/usr/bin/env python3
"""Opt-in real Firefox gate for native BiDi download directory handling."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "bridge" / "ruyi_bridge.py"
DOWNLOAD_BODY = b"ruyi-mcp native Firefox download smoke\n"


def load_bridge_module():
    spec = importlib.util.spec_from_file_location(
        "ruyi_mcp_download_runtime_bridge", BRIDGE_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load bridge module from {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DownloadFixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            body = (
                b"<!doctype html><meta charset='utf-8'>"
                b"<a id='download' href='/attachment'>download</a>"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
        elif self.path == "/attachment":
            body = DOWNLOAD_BODY
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Disposition", "attachment; filename=ruyi-download.txt")
        else:
            body = b""
            self.send_response(404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


def wait_for_download(directory: Path, timeout_seconds: float) -> Path:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        files = [path for path in directory.iterdir() if path.is_file()]
        partial = [path for path in files if path.suffix in {".part", ".tmp"}]
        complete = [path for path in files if path not in partial]
        if len(complete) == 1 and not partial:
            return complete[0]
        time.sleep(0.1)
    raise RuntimeError("Download did not finish in the configured directory")


def run_gate(firefox_path: Path, headless: bool, timeout_seconds: float) -> dict:
    bridge_module = load_bridge_module()
    server = ThreadingHTTPServer(("127.0.0.1", 0), DownloadFixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    bridge = bridge_module.RuyiBridge()
    with tempfile.TemporaryDirectory(prefix="ruyi_mcp_download_") as tmp:
        download_dir = Path(tmp) / "downloads"
        try:
            bridge._launch({"browserPath": str(firefox_path), "headless": headless})
            behavior = bridge._set_download_behavior(
                {"pageIdx": 0, "behavior": "allow", "downloadPath": str(download_dir)}
            )
            assert behavior["behavior"] == "allowed", behavior
            assert Path(behavior["downloadPath"]) == download_dir.resolve(), behavior

            page = bridge.pages[0]
            page.get(f"http://127.0.0.1:{server.server_address[1]}/")
            page.ele("css:#download").click_self()
            downloaded = wait_for_download(download_dir, timeout_seconds)
            content = downloaded.read_bytes()
            assert content == DOWNLOAD_BODY, {
                "path": str(downloaded),
                "bytes": len(content),
            }
            return {
                "firefox": str(firefox_path),
                "headless": headless,
                "behavior": behavior["behavior"],
                "filename": downloaded.name,
                "bytes": len(content),
                "contentVerified": True,
            }
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
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--timeout", type=float, default=15.0)
    args = parser.parse_args()

    if sys.flags.optimize:
        raise SystemExit("Runtime gate requires assertions; do not run Python with -O")
    if not args.firefox:
        raise SystemExit("Set RUYI_FIREFOX_PATH or pass --firefox")
    if not 1 <= args.timeout <= 60:
        raise SystemExit("--timeout must be between 1 and 60 seconds")

    firefox_path = Path(args.firefox).expanduser().resolve()
    if not firefox_path.is_file():
        raise SystemExit(f"Firefox executable not found: {firefox_path}")

    print(
        json.dumps(
            run_gate(firefox_path, headless=not args.headed, timeout_seconds=args.timeout),
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
