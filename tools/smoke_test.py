"""End-to-end smoke test against a real uvicorn process.

The unit tests cover the sync protocol and the client engine. This covers the
things only a real server can show: that the built PWA is actually served, that
the service worker and manifest come back with headers a browser will accept,
and that a push/pull round trip works over HTTP rather than through a test
client shim.

    python tools/smoke_test.py

Starts the server on a free port, runs the checks, and shuts it down. Exits
non-zero on the first failure.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
DIST = ROOT / "frontend" / "dist"

PASS = 0
FAIL = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ok    {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}{(' - ' + detail) if detail else ''}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def get(url: str) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def post(url: str, payload: dict) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        method="POST",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def wait_for_health(base: str, process: subprocess.Popen, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        try:
            status, _headers, _body = get(f"{base}/api/health")
            if status == 200:
                return True
        except Exception:
            time.sleep(0.25)
    return False


def main() -> int:
    if not (DIST / "index.html").is_file():
        print("frontend/dist is missing - run: cd frontend && npm run build")
        return 2

    python = (
        ROOT / ".venv" / "Scripts" / "python.exe"
        if (ROOT / ".venv" / "Scripts" / "python.exe").is_file()
        else Path(sys.executable)
    )

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    tmp = Path(tempfile.mkdtemp(prefix="tally-smoke-"))

    env = {
        **os.environ,
        "TALLY_DATABASE_URL": f"sqlite+pysqlite:///{(tmp / 'smoke.db').as_posix()}",
        # Requests without a token run as this user; sign-in itself is covered
        # by backend/tests/test_accounts.py.
        "TALLY_DEV_USER": "smoke-test",
        "TALLY_DEMO": "1",
    }

    process = subprocess.Popen(
        [str(python), "-m", "uvicorn", "app.main:app", "--port", str(port), "--log-level", "warning"],
        cwd=str(BACKEND),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    try:
        if not wait_for_health(base, process):
            output = process.stdout.read().decode(errors="replace") if process.stdout else ""
            print("server did not come up:\n" + output)
            return 2

        print("\napp shell")
        status, headers, body = get(f"{base}/")
        check("GET / returns the built index.html", status == 200 and b"<div id=\"root\">" in body)
        check(
            "index.html is served as HTML",
            headers.get("content-type", "").startswith("text/html"),
            headers.get("content-type", ""),
        )
        check(
            "index.html is revalidated, not cached hard",
            "no-cache" in headers.get("cache-control", ""),
            headers.get("cache-control", ""),
        )

        status, _headers, body = get(f"{base}/some/deep/link")
        check("unknown paths fall back to the app shell", status == 200 and b"<div id=\"root\">" in body)

        print("\nservice worker")
        status, headers, body = get(f"{base}/sw.js")
        text = body.decode()
        check("GET /sw.js returns the worker", status == 200)
        check(
            "served with Service-Worker-Allowed: /",
            headers.get("service-worker-allowed") == "/",
            headers.get("service-worker-allowed", "missing"),
        )
        check(
            "served no-store so a stale worker cannot pin users",
            "no-store" in headers.get("cache-control", ""),
            headers.get("cache-control", ""),
        )
        check(
            "served as JavaScript",
            "javascript" in headers.get("content-type", ""),
            headers.get("content-type", ""),
        )
        check("build placeholders were replaced", "__SW_VERSION__" not in text and "__PRECACHE_MANIFEST__" not in text)
        check("precache manifest includes the shell", '"/index.html"' in text)
        check("precache manifest includes the hashed bundle", "/assets/index-" in text)
        check("the API is excluded from caching", "startsWith('/api/')" in text)

        print("\nmanifest and icons")
        status, headers, body = get(f"{base}/manifest.webmanifest")
        manifest = json.loads(body)
        check("GET /manifest.webmanifest returns JSON", status == 200)
        check(
            "correct manifest content type",
            headers.get("content-type", "").startswith("application/manifest+json"),
            headers.get("content-type", ""),
        )
        check("display is standalone", manifest.get("display") == "standalone")
        check("start_url is set", manifest.get("start_url") == "/")
        sizes = {icon["sizes"] for icon in manifest["icons"]}
        purposes = {icon.get("purpose") for icon in manifest["icons"]}
        check("has 192 and 512 icons", {"192x192", "512x512"} <= sizes, str(sizes))
        check("has a maskable icon", "maskable" in purposes, str(purposes))

        for icon in manifest["icons"]:
            status, headers, body = get(f"{base}{icon['src']}")
            check(
                f"{icon['src']} is a real PNG",
                status == 200 and body[:8] == b"\x89PNG\r\n\x1a\n",
                f"status {status}",
            )

        print("\nstatic assets")
        asset = next(
            line.split('"')[1]
            for line in text.splitlines()
            if '"/assets/' in line and line.strip().endswith('.js",')
        )
        status, headers, _body = get(f"{base}{asset}")
        check("hashed bundle is served", status == 200)
        check(
            "hashed assets are cached immutably",
            "immutable" in headers.get("cache-control", ""),
            headers.get("cache-control", ""),
        )

        print("\nsync API over HTTP")
        status, _headers, _body = get(f"{base}/api/nope")
        check("unknown API routes 404 instead of returning HTML", status == 404)

        status, body = post(
            f"{base}/api/sync/push",
            {
                "device_id": "smoke-phone",
                "ops": [
                    {
                        "op_id": "smoke-1",
                        "entry_id": "smoke-entry",
                        "kind": "create",
                        "base_rev": 0,
                        "fields": {"amount_cents": 1234, "merchant": "Smoke Cafe"},
                    }
                ],
            },
        )
        check("push accepts a create", status == 200 and body["results"][0]["status"] == "applied")

        status, _headers, raw = get(f"{base}/api/sync/pull?since=0")
        pulled = json.loads(raw)
        check("pull returns the entry", status == 200 and len(pulled["changes"]) == 1)
        check("pull hands back a cursor", pulled["cursor"] > 0)

        # A second device edits the same field, then the first pushes a stale op.
        status, body = post(
            f"{base}/api/demo/other-device-edit",
            {"entry_id": "smoke-entry", "fields": {"amount_cents": 9999}},
        )
        check("the other device's edit applies", status == 200)

        status, body = post(
            f"{base}/api/sync/push",
            {
                "device_id": "smoke-phone",
                "ops": [
                    {
                        "op_id": "smoke-2",
                        "entry_id": "smoke-entry",
                        "kind": "update",
                        "base_rev": 1,
                        "fields": {"amount_cents": 5555},
                    }
                ],
            },
        )
        result = body["results"][0]
        check("a same-field stale write conflicts", result["status"] == "conflict", result["status"])
        check(
            "the conflict names the overlapping field",
            result["conflict"]["overlapping_fields"] == ["amount_cents"],
        )
        check(
            "nothing was overwritten",
            result["entry"]["fields"]["amount_cents"] == 9999,
        )

        # A disjoint stale write merges instead.
        status, body = post(
            f"{base}/api/sync/push",
            {
                "device_id": "smoke-phone",
                "ops": [
                    {
                        "op_id": "smoke-3",
                        "entry_id": "smoke-entry",
                        "kind": "update",
                        "base_rev": 1,
                        "fields": {"note": "from the other side of a tunnel"},
                    }
                ],
            },
        )
        result = body["results"][0]
        check("a disjoint stale write auto-merges", result["status"] == "merged", result["status"])
        check(
            "both edits survived the merge",
            result["entry"]["fields"]["amount_cents"] == 9999
            and result["entry"]["fields"]["note"] == "from the other side of a tunnel",
        )

        print(f"\n{PASS} passed, {FAIL} failed")
        return 1 if FAIL else 0

    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    sys.exit(main())
