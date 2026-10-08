"""Run every suite in the project, in the order they get useful.

    python tools/check_all.py

1. backend pytest      - the sync protocol and conflict rules
2. frontend vitest     - the client engine, against a fake server
3. frontend build      - typecheck, bundle, stamp the service worker
4. tools/smoke_test.py - a real uvicorn process over HTTP
5. tools/browser_check - a real Chromium: service worker, offline cold start,
                         conflict resolution (skipped if Playwright is absent)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
VENV_PYTHON_POSIX = ROOT / ".venv" / "bin" / "python"

NPM = shutil.which("npm") or ("npm.cmd" if os.name == "nt" else "npm")


def python_exe() -> str:
    for candidate in (VENV_PYTHON, VENV_PYTHON_POSIX):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def run(label: str, command: list[str], cwd: Path) -> bool:
    print(f"\n{'=' * 68}\n{label}\n{'=' * 68}")
    result = subprocess.run(command, cwd=str(cwd))
    ok = result.returncode == 0
    print(f"--> {'PASS' if ok else 'FAIL'}: {label}")
    return ok


def main() -> int:
    python = python_exe()
    results: list[tuple[str, bool]] = []

    results.append(
        ("backend tests", run("backend tests (pytest)", [python, "-m", "pytest"], BACKEND))
    )
    results.append(
        ("client tests", run("client tests (vitest)", [NPM, "test", "--silent"], FRONTEND))
    )
    results.append(("frontend build", run("frontend build", [NPM, "run", "build"], FRONTEND)))
    results.append(
        (
            "http smoke test",
            run("http smoke test", [python, str(ROOT / "tools" / "smoke_test.py")], ROOT),
        )
    )

    playwright_present = (FRONTEND / "node_modules" / "playwright" / "index.mjs").is_file()
    if playwright_present:
        results.append(
            (
                "browser check",
                run("browser check", ["node", str(ROOT / "tools" / "browser_check.mjs")], ROOT),
            )
        )
    else:
        print("\nskipping the browser check - Playwright is not installed")
        print("  cd frontend && npm install && npx playwright install chromium")

    print(f"\n{'=' * 68}\nsummary\n{'=' * 68}")
    for label, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")

    failures = [label for label, ok in results if not ok]
    if failures:
        print(f"\n{len(failures)} suite(s) failed")
        return 1
    print("\neverything passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
