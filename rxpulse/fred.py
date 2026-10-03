"""Federal Reserve Economic Data (FRED): oil, fuel, producer and consumer prices,
pharmacy margins, employment, rates. Works without a key (public CSV endpoint);
FRED_API_KEY switches to the official JSON API."""
from __future__ import annotations

import io
import logging
import os

import pandas as pd

from .util import Cache, Health

log = logging.getLogger("rxpulse.fred")


def parse_fred_csv(text: str, sid: str) -> pd.Series:
    df = pd.read_csv(io.StringIO(text))
    date_col = next((c for c in df.columns if c.lower() in ("observation_date", "date")), df.columns[0])
    val_col = sid if sid in df.columns else df.columns[-1]
    s = pd.Series(pd.to_numeric(df[val_col], errors="coerce").values,
                  index=pd.to_datetime(df[date_col]), name=sid).dropna()
    if s.empty:
        raise ValueError(f"{sid}: no numeric observations")
    return s.sort_index()


def _fetch_one(session, sid: str, start: str, key: str | None) -> pd.Series:
    if key:
        r = session.get("https://api.stlouisfed.org/fred/series/observations",
                        params={"series_id": sid, "api_key": key, "file_type": "json",
                                "observation_start": start}, timeout=25)
        r.raise_for_status()
        obs = r.json().get("observations", [])
        s = pd.Series({pd.Timestamp(o["date"]): pd.to_numeric(o["value"], errors="coerce") for o in obs},
                      name=sid).dropna()
        if s.empty:
            raise ValueError(f"{sid}: empty")
        return s.sort_index()
    r = session.get("https://fred.stlouisfed.org/graph/fredgraph.csv",
                    params={"id": sid, "cosd": start}, timeout=25)
    r.raise_for_status()
    return parse_fred_csv(r.text, sid)


def fetch_fred(cfg: dict, session, cache: Cache, health: Health) -> dict[str, dict]:
    key = os.environ.get("FRED_API_KEY", "").strip() or None
    start = cfg["fred"].get("start", "2016-01-01")
    cached = (cache.load("fred") or {}).get("data", {})
    out: dict[str, dict] = {}
    for spec in cfg["fred"]["series"]:
        k = spec["key"]
        last_err = ""
        for sid in spec["ids"]:
            try:
                s = _fetch_one(session, sid, start, key)
                out[k] = {"id": sid, "dates": [d.strftime("%Y-%m-%d") for d in s.index],
                          "values": [float(v) for v in s.values]}
                health.ok(f"fred:{k}", spec["title"], detail=f"FRED {sid}", count=len(s),
                          url=f"https://fred.stlouisfed.org/series/{sid}", group="Economic data")
                break
            except Exception as e:
                last_err = f"{sid}: {e}"
                log.info("FRED %s failed: %s", sid, e)
        if k not in out:
            if k in cached:
                out[k] = {**cached[k], "stale": True}
                health.stale(f"fred:{k}", spec["title"], detail=f"refresh failed ({last_err}); cached",
                             url=f"https://fred.stlouisfed.org/series/{cached[k].get('id', '')}",
                             group="Economic data")
            else:
                health.error(f"fred:{k}", spec["title"], detail=last_err or "unavailable",
                             group="Economic data")
    fresh = {k: v for k, v in out.items() if not v.get("stale")}
    if fresh:
        cache.save("fred", {**cached, **fresh})
    return out
