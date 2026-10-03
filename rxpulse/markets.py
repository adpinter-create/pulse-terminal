"""Daily price history for the watchlist.

Provider chain per symbol: yfinance (batch) -> Stooq CSV -> Tiingo (if keyed).
Any symbol that fails everywhere falls back to its cached history, flagged stale.
"""
from __future__ import annotations

import datetime as dt
import io
import logging
import re
import os
import time

import pandas as pd

from .util import Cache, Health, iso, utcnow

log = logging.getLogger("rxpulse.markets")

PERIOD_DAYS = {"1y": 366, "2y": 732, "3y": 1100, "5y": 1830}


def all_tickers(cfg: dict) -> list[dict]:
    out = []
    for seg in cfg["markets"]["segments"]:
        for t in seg["tickers"]:
            kind = seg.get("kind", "equity")
            out.append({**t, "segment": seg["id"], "segment_name": seg["name"], "kind": kind,
                        "is_benchmark": bool(seg.get("benchmark")) or kind == "market"})
    return out


def _frame_to_raw(df: pd.DataFrame, provider: str) -> dict | None:
    if df is None or df.empty or "Close" not in df.columns:
        return None
    df = df.copy()
    df.index = pd.to_datetime(df.index).tz_localize(None) if getattr(df.index, "tz", None) else pd.to_datetime(df.index)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df.dropna(subset=["Close"])
    df = df[df["Close"] > 0]
    if len(df) < 5:
        return None
    vol = df["Volume"] if "Volume" in df.columns else pd.Series(index=df.index, dtype=float)
    return {
        "provider": provider,
        "dates": [d.strftime("%Y-%m-%d") for d in df.index],
        "close": [round(float(v), 4) for v in df["Close"]],
        "volume": [None if pd.isna(v) else int(v) for v in vol.reindex(df.index)],
    }


def _yfinance_batch(symbols: list[str], period: str) -> dict[str, dict]:
    import yfinance as yf  # imported lazily so demo mode never needs it

    got: dict[str, dict] = {}
    try:
        df = yf.download(symbols, period=period, interval="1d", group_by="ticker",
                         auto_adjust=True, progress=False, threads=True)
    except Exception as e:  # network, rate limit, schema change
        log.warning("yfinance batch failed: %s", e)
        return got
    if df is None or df.empty:
        return got
    if isinstance(df.columns, pd.MultiIndex):
        lvl0 = set(df.columns.get_level_values(0))
        for s in symbols:
            try:
                sub = df[s] if s in lvl0 else df.xs(s, axis=1, level=1)
            except KeyError:
                continue
            raw = _frame_to_raw(sub, "yfinance")
            if raw:
                got[s] = raw
    elif len(symbols) == 1:
        raw = _frame_to_raw(df, "yfinance")
        if raw:
            got[symbols[0]] = raw
    return got


def _stooq(session, symbol: str, stooq_sym: str | None, start: dt.date) -> dict | None:
    if not stooq_sym and re.search(r"[\^=\-.]", symbol):
        return None  # indices, futures, FX and crypto need an explicit Stooq code in config
    code = (stooq_sym or f"{symbol.lower()}.us")
    url = (f"https://stooq.com/q/d/l/?s={code}&i=d"
           f"&d1={start:%Y%m%d}&d2={dt.date.today():%Y%m%d}")
    r = session.get(url, timeout=20)
    r.raise_for_status()
    text = r.text.strip()
    if not text.lower().startswith("date"):
        raise ValueError(f"stooq returned non-CSV for {code}: {text[:60]!r}")
    df = pd.read_csv(io.StringIO(text), parse_dates=["Date"], index_col="Date")
    return _frame_to_raw(df, "stooq")


def _tiingo(session, symbol: str, key: str, start: dt.date) -> dict | None:
    url = f"https://api.tiingo.com/tiingo/daily/{symbol.lower()}/prices"
    r = session.get(url, params={"startDate": start.isoformat(), "token": key}, timeout=20)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return None
    df = pd.DataFrame(rows)
    df["Date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
    df = df.set_index("Date").rename(columns={"adjClose": "Close", "adjVolume": "Volume"})
    return _frame_to_raw(df[["Close", "Volume"]], "tiingo")


def fetch_prices(cfg: dict, session, cache: Cache, health: Health) -> dict[str, dict]:
    tickers = all_tickers(cfg)
    symbols = [t["symbol"] for t in tickers]
    by_sym = {t["symbol"]: t for t in tickers}
    period = cfg["markets"].get("history_period", "2y")
    start = dt.date.today() - dt.timedelta(days=PERIOD_DAYS.get(period, 732))
    providers = cfg["markets"].get("providers", ["yfinance", "stooq"])
    tiingo_key = os.environ.get("TIINGO_API_KEY", "").strip()

    got: dict[str, dict] = {}
    if "yfinance" in providers:
        got.update(_yfinance_batch(symbols, period))
        log.info("yfinance: %d/%d symbols", len(got), len(symbols))

    for s in symbols:
        if s in got:
            continue
        for p in providers:
            if p == "yfinance":
                continue
            try:
                if p == "stooq":
                    raw = _stooq(session, s, by_sym[s].get("stooq"), start)
                elif p == "tiingo" and tiingo_key and "=" not in s:
                    raw = _tiingo(session, s, tiingo_key, start)
                else:
                    continue
                if raw:
                    got[s] = raw
                    log.info("%s via %s", s, p)
                    break
            except Exception as e:
                log.info("%s via %s failed: %s", s, p, e)
            time.sleep(0.4)

    cached = (cache.load("prices") or {}).get("data", {})
    stale = []
    for s in symbols:
        if s not in got and s in cached:
            got[s] = {**cached[s], "stale": True}
            stale.append(s)
    missing = [s for s in symbols if s not in got]

    fresh = {s: v for s, v in got.items() if not v.get("stale")}
    if fresh:
        merged = {**cached, **fresh}
        cache.save("prices", merged)

    providers_used = sorted({v["provider"] for v in fresh.values()})
    detail = f"{len(fresh)} fresh via {', '.join(providers_used) or 'none'}"
    if stale:
        detail += f"; {len(stale)} from cache ({', '.join(stale[:8])})"
    if missing:
        detail += f"; unavailable: {', '.join(missing)}"
    status = "ok" if not stale and not missing else ("error" if not fresh else "stale")
    health.set("prices", "Market prices", status, detail=detail, count=len(got),
               url="https://finance.yahoo.com", group="Markets")
    return got


def fetch_earnings(cfg: dict, cache: Cache, health: Health) -> list[dict]:
    """Next earnings date per company. Changes slowly, so refreshed once a day."""
    if not cfg["markets"].get("earnings_calendar", True):
        return []
    age = cache.age_hours("earnings")
    cached = cache.load("earnings")
    if cached and age is not None and age < 20:
        health.ok("earnings", "Earnings calendar", detail="cached (refreshed daily)",
                  count=len(cached["data"]), as_of=cached["fetched_at"], group="Markets")
        return cached["data"]
    try:
        import yfinance as yf
    except ImportError:
        return (cached or {}).get("data", [])

    out = []
    today = dt.date.today()
    for t in all_tickers(cfg):
        if t["is_benchmark"]:
            continue
        try:
            cal = yf.Ticker(t["symbol"]).calendar
            dates = cal.get("Earnings Date") if isinstance(cal, dict) else None
            if not dates:
                continue
            upcoming = sorted(d for d in dates if isinstance(d, dt.date) and d >= today)
            if upcoming:
                out.append({"symbol": t["symbol"], "name": t["name"], "date": upcoming[0].isoformat(),
                            "eps_est": cal.get("Earnings Average"), "rev_est": cal.get("Revenue Average")})
        except Exception as e:
            log.info("earnings %s failed: %s", t["symbol"], e)
        time.sleep(0.3)
    out.sort(key=lambda r: r["date"])
    if out:
        cache.save("earnings", out)
        health.ok("earnings", "Earnings calendar", detail="Yahoo Finance calendar", count=len(out),
                  url="https://finance.yahoo.com/calendar/earnings", group="Markets")
        return out
    if cached:
        health.stale("earnings", "Earnings calendar", detail="refresh failed; showing cache",
                     count=len(cached["data"]), as_of=cached["fetched_at"], group="Markets")
        return cached["data"]
    health.error("earnings", "Earnings calendar", detail="no data returned", group="Markets")
    return []
