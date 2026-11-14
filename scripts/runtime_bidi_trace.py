from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path


def run_gate(firefox: Path, headless: bool = True) -> dict:
    bridge_path = Path(__file__).resolve().parents[1] / "bridge" / "ruyi_bridge.py"
    spec = importlib.util.spec_from_file_location("bidi_trace_gate_bridge", bridge_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    bridge = module.RuyiBridge()
    with tempfile.TemporaryDirectory(prefix="ruyi-bidi-trace-") as directory:
        output = Path(directory) / "timeline.json"
        try:
            launch = bridge._launch({"browserPath": str(firefox), "headless": headless, "traceEnabled": True, "enableDebugger": True})
            assert launch["debuggerStarted"] is False
            bridge._navigate({"pageIdx": 0, "url": "data:text/html,<title>Trace fixture</title>"})
            first = bridge._bidi_trace_results({"limit": 100})
            assert first["entries"]
            started = bridge._bidi_trace_start({"outputFile": str(output)})
            assert started["fullTrace"] is True
            tab = bridge._new_tab({"url": "data:text/html,<title>Second fixture</title>"})
            bridge._evaluate({"pageIdx": tab["pageIdx"], "script": "() => 40 + 2"})
            shared = bridge._bidi_trace_results({"pageIdx": tab["pageIdx"], "limit": 100})
            assert len(shared["entries"]) > len(first["entries"])
            stopped = bridge._bidi_trace_stop({"pageIdx": 0})
            assert "data" not in stopped
            assert stopped["output"]["bytes"] > 0
            json.loads(output.read_text(encoding="utf-8"))
            count = len(bridge._bidi_trace_results({"limit": 100})["entries"])
            bridge._evaluate({"pageIdx": 0, "script": "() => 7"})
            assert len(bridge._bidi_trace_results({"limit": 100})["entries"]) == count
            return {"ok": True, "scope": "browser", "launchEntries": len(first["entries"]), "sharedEntries": len(shared["entries"]), "outputBytes": stopped["output"]["bytes"], "freezeAfterStop": True, "rdpListenerOnly": True}
        finally:
            bridge._quit({})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_gate(Path(args.firefox).resolve(strict=True))
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).resolve().write_text(text, encoding="utf-8", newline="\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
