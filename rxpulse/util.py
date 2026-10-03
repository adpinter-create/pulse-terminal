"""Shared plumbing: HTTP with retries, a JSON cache for last-known-good data,
and a health ledger that records how every source behaved on this run."""
from __future__ import annotations

import datetime as dt
import json
import logging
import math
from pathlib import Path
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger("rxpulse")

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36 RxPulse/1.0")


def http_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(total=3, connect=3, read=2, backoff_factor=1.5,
                  status_forcelist=[429, 500, 502, 503, 504],
                  allowed_methods=["GET"], respect_retry_after_header=True)
    adapter = HTTPAdapter(max_retries=retry, pool_maxsize=16)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    s.headers.update({"User-Agent": UA, "Accept": "*/*"})
    return s


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(d: dt.datetime | dt.date | None) -> str | None:
    if d is None:
        return None
    if isinstance(d, dt.datetime):
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return d.isoformat()


def parse_iso(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def rnd(x: Any, digits: int = 4) -> float | None:
    """Round to significant digits; NaN/inf/None become None (valid JSON)."""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    if x == 0:
        return 0.0
    mag = int(math.floor(math.log10(abs(x))))
    return round(x, max(0, digits - 1 - mag))


def pct(new: Any, old: Any) -> float | None:
    try:
        new, old = float(new), float(old)
    except (TypeError, ValueError):
        return None
    if old == 0 or math.isnan(new) or math.isnan(old):
        return None
    return (new / old - 1.0) * 100.0


class Cache:
    """Last-known-good payloads. If a source fails, the dashboard keeps showing
    its previous data (flagged stale) instead of going blank."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        return self.root / f"{name}.json"

    def load(self, name: str) -> dict | None:
        p = self._path(name)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            log.warning("cache %s unreadable; ignoring", name)
            return None

    def save(self, name: str, data: Any) -> None:
        payload = {"fetched_at": iso(utcnow()), "data": data}
        self._path(name).write_text(json.dumps(payload, separators=(",", ":"), default=str))

    def age_hours(self, name: str) -> float | None:
        c = self.load(name)
        if not c:
            return None
        t = parse_iso(c.get("fetched_at"))
        return None if t is None else (utcnow() - t).total_seconds() / 3600.0


class Health:
    """Per-source status shown on the Sources tab and in the header badge."""

    def __init__(self):
        self.rows: dict[str, dict] = {}

    def set(self, key: str, label: str, status: str, detail: str = "",
            count: int | None = None, as_of: str | None = None, url: str | None = None,
            group: str = "") -> None:
        self.rows[key] = {"key": key, "label": label, "status": status, "detail": detail[:300],
                          "count": count, "as_of": as_of or iso(utcnow()), "url": url, "group": group}

    def ok(self, key, label, **kw):
        self.set(key, label, "ok", **kw)

    def stale(self, key, label, **kw):
        self.set(key, label, "stale", **kw)

    def error(self, key, label, **kw):
        self.set(key, label, "error", **kw)

    def as_list(self) -> list[dict]:
        order = {"error": 0, "stale": 1, "partial": 2, "ok": 3}
        return sorted(self.rows.values(), key=lambda r: (r["group"], order.get(r["status"], 9), r["label"]))
