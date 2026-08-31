#!/usr/bin/env python3
"""Direct Firefox 151 gate for ruyiPage 1.2.68 page.debugger.

The production MCP path is covered separately by runtime_mcp_debugger.mjs;
this script remains useful for isolating the upstream RDP adapter.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ruyipage import FirefoxOptions, FirefoxPage

HTML = b"""<!doctype html>
<html><head><meta charset="utf-8"><title>dbg</title></head>
<body>
<script src="/app.js"></script>
</body></html>
"""
JS = b"""
function targetFn(x) {
  var y = x + 1;
  return y * 2;
}
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/app.js":
            body, ctype = JS, "application/javascript; charset=utf-8"
        elif self.path in ("/", "/index.html"):
            body, ctype = HTML, "text/html; charset=utf-8"
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


def allocate_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


def run_gate(firefox_path: Path, headless: bool) -> dict:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    rdp_port = allocate_port()
    result: dict = {
        "ok": False,
        "firefox": str(firefox_path),
        "origin": origin,
        "rdpPort": rdp_port,
    }
    tmp = tempfile.TemporaryDirectory(prefix="ruyi_dbg_runtime_", ignore_cleanup_errors=True)
    try:
        opts = FirefoxOptions()
        opts.set_browser_path(str(firefox_path))
        opts.set_profile(str(Path(tmp.name) / "profile"))
        opts.allow_system_access(False)
        opts.set_argument("about:blank")
        opts.enable_debugger(port=rdp_port)
        opts.close_on_exit(True)
        if headless:
            opts.headless(True)
        page = FirefoxPage(opts)
        try:
            page.get(origin + "/")
            page.wait(0.4)
            dbg = page.debugger
            dbg.start(timeout=20, auto_resume_after=20)
            sources = dbg.sources(url_contains="app.js")
            assert sources, "app.js source missing"
            url = sources[0].url
            text = dbg.source_text(url)
            assert "var y = x + 1" in text, text
            line = next(
                i + 1 for i, row in enumerate(text.splitlines()) if "var y = x + 1" in row
            )
            bp = dbg.set_breakpoint(url, line)

            trigger_error: list[BaseException] = []

            def fire():
                try:
                    time.sleep(0.2)
                    result["value"] = page.run_js("targetFn(41)")
                except Exception as exc:  # surface worker failures in the gate
                    trigger_error.append(exc)

            worker = threading.Thread(target=fire, daemon=True)
            worker.start()
            state = dbg.wait_paused(timeout=15)
            assert state is not None, "wait_paused timeout"
            assert state.why == "breakpoint", state.why
            assert state.line == line, state.line
            scope = dbg.scope()
            assert scope.get("x") == 41, scope
            frames = dbg.frames(count=8)
            assert frames and frames[0].display_name == "targetFn", frames
            dbg.step_over()
            after = dbg.wait_paused(timeout=10)
            assert after is not None, "step_over did not pause"
            dbg.resume()
            worker.join(timeout=5)
            assert not worker.is_alive(), "trigger worker did not finish after resume"
            assert not trigger_error, trigger_error[0]
            assert result.get("value") == 84, result
            result.update(
                {
                    "ok": True,
                    "breakpoint": {"url": bp.url, "line": bp.line, "column": bp.column},
                    "paused": {"why": state.why, "line": state.line},
                    "scopeX": scope.get("x"),
                    "triggerResult": result.get("value"),
                    "stepOverLine": after.line,
                }
            )
            return result
        finally:
            try:
                if page.debugger.started:
                    page.debugger.stop()
            except Exception:
                pass
            try:
                page.quit()
            except Exception:
                pass
    finally:
        server.shutdown()
        tmp.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser()
    reverse_env_root = Path(__file__).resolve().parents[3]
    default_firefox = reverse_env_root / "tools" / "ruyipage" / "runtimes" / "151-proxy" / "firefox" / "firefox.exe"
    parser.add_argument(
        "--firefox",
        default=os.environ.get(
            "RUYI_FIREFOX_PATH",
            str(default_firefox),
        ),
    )
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    firefox = Path(args.firefox)
    if not firefox.exists():
        print(json.dumps({"ok": False, "error": "firefox missing", "path": str(firefox)}))
        return 2
    result = run_gate(firefox, args.headless)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
