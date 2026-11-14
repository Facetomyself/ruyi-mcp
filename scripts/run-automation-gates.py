from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    firefox = Path(args.firefox).resolve(strict=True)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    scripts = Path(__file__).resolve().parent
    gates = [
        ("automation", "runtime_ruyipage_1256.py", {}),
        ("capture", "runtime_capture_lifecycle.py", {"cycles": 20, "cleanup_timeout": 2.0}),
        ("attach", "runtime_attach_lifecycle.py", {}),
        ("download", "runtime_download_behavior.py", {"timeout_seconds": 15.0}),
        ("agent", "runtime_agent_loop.py", {}),
    ]
    results = []
    for name, filename, keywords in gates:
        spec = importlib.util.spec_from_file_location(f"ruyi_gate_{name}", scripts / filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        started = time.monotonic()
        try:
            payload = module.run_gate(firefox, headless=True, **keywords)
            result = {"gate": name, "ok": True, "elapsedSeconds": round(time.monotonic() - started, 3), "result": payload}
        except Exception as exc:
            result = {"gate": name, "ok": False, "elapsedSeconds": round(time.monotonic() - started, 3), "error": f"{type(exc).__name__}: {exc}"}
        (output / f"{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        results.append(result)
        print(json.dumps({key: value for key, value in result.items() if key != "result"}, ensure_ascii=False), flush=True)
    summary = {"firefox": str(firefox), "passed": sum(result["ok"] for result in results), "total": len(results)}
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8", newline="\n")
    return 0 if all(result["ok"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
