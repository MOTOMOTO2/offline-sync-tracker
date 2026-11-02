"""Vercel's entry point: the FastAPI app from backend/, served under /api.

Vercel runs any ASGI ``app`` it finds in api/; vercel.json sends every /api/*
request here. The built PWA itself is served by Vercel's CDN, from the same
origin, which is what lets the service worker control it.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.main import app  # noqa: E402,F401
