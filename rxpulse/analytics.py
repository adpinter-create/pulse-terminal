"""Turns raw fetch results into the payload the front end renders."""
from __future__ import annotations

import datetime as dt
import math
from statistics import mean

import numpy as np
import pandas as pd

from .markets import all_tickers
from .util import pct, rnd

SESSIONS = {"r1w": 5, "r1m": 21, "r3m": 63, "r1y": 252}


# ── Markets ──────────────────────────────────────────────────────────────────
def ticker_metrics(cfg: dict, prices: dict[str, dict], today: dt.date | None = None) -> tuple[list[dict], dict]:
    today = today or dt.date.today()
    out = []
    all_dates: set[str] = set()
    series: dict[str, pd.Series] = {}
    for t in all_tickers(cfg):
        s = t["symbol"]
        raw = prices.get(s)
        row = {"s": s, "n": t["name"], "note": t.get("note", ""), "seg": t["segment"],
               "bench": t["is_benchmark"], "w": t.get("weight", 1), "unit": t.get("unit"),
               "short": t.get("short"), "kind": t.get("kind", "equity")}
        if not raw or len(raw.get("close", [])) < 2:
            row["missing"] = True
            out.append(row)
            continue
        c = raw["close"]
        d = raw["dates"]
        v = raw.get("volume") or [None] * len(c)
        series[s] = pd.Series(c, index=pd.to_datetime(d))
        all_dates.update(d)
        last = c[-1]
        row.update({"px": rnd(last, 6), "prev": rnd(c[-2], 6), "chg": rnd(last - c[-2], 4),
                    "chgp": rnd(pct(last, c[-2]), 4), "d": d[-1], "provider": raw.get("provider"),
                    "stale": bool(raw.get("stale"))})
        for k, n in SESSIONS.items():
            row[k] = rnd(pct(last, c[-1 - n]), 4) if len(c) > n else None
        last_year = int(d[-1][:4]) - 1
        prior = [cc for dd, cc in zip(d, c) if int(dd[:4]) <= last_year]
        row["rytd"] = rnd(pct(last, prior[-1]), 4) if prior else None
        window = c[-252:]
        hi, lo = max(window), min(window)
        row.update({"hi52": rnd(hi, 6), "lo52": rnd(lo, 6), "offhi": rnd(pct(last, hi), 4),
                    "hi52flag": bool(last >= hi * 0.998 and len(c) > 120),
                    "lo52flag": bool(last <= lo * 1.002 and len(c) > 120)})
        vols = [x for x in v[-21:-1] if x]
        if v[-1] and vols:
            row.update({"vol": v[-1], "avgvol": int(mean(vols)), "vr": rnd(v[-1] / mean(vols), 3)})
        if (today - dt.date.fromisoformat(d[-1])).days > 5:
            row["stale"] = True
        row["spark"] = [rnd(x, 5) for x in c[-40:]]
        out.append(row)

    dates = sorted(all_dates)
    hist = {"dates": dates, "series": {}}
    idx = pd.to_datetime(dates)
    for s, ser in series.items():
        ser = ser[~ser.index.duplicated(keep="last")].reindex(idx)
        hist["series"][s] = [None if pd.isna(x) else rnd(x, 5) for x in ser.values]
    return out, hist


def segment_perf(cfg: dict, tickers: list[dict]) -> list[dict]:
    rows = []
    for seg in cfg["markets"]["segments"]:
        if seg.get("benchmark") or seg.get("kind") == "market":
            continue
        members = [t for t in tickers if t["seg"] == seg["id"] and not t.get("missing")]

        def avg(k):
            vals = [t[k] for t in members if t.get(k) is not None]
            return rnd(mean(vals), 4) if vals else None

        rows.append({"id": seg["id"], "name": seg["name"], "n": len(members),
                     "d1": avg("chgp"), "w1": avg("r1w"), "m1": avg("r1m"), "ytd": avg("rytd"),
                     "up": sum(1 for t in members if (t.get("chgp") or 0) > 0),
                     "down": sum(1 for t in members if (t.get("chgp") or 0) < 0)})
    return rows


def movers(tickers: list[dict]) -> dict:
    eq = [t for t in tickers if not t["bench"] and t.get("chgp") is not None]
    up = sorted([t for t in eq if t["chgp"] > 0], key=lambda t: -t["chgp"])[:6]
    dn = sorted([t for t in eq if t["chgp"] < 0], key=lambda t: t["chgp"])[:6]
    vol = sorted([t for t in eq if (t.get("vr") or 0) >= 1.6], key=lambda t: -t["vr"])[:6]
    return {"up": [t["s"] for t in up], "down": [t["s"] for t in dn], "volume": [t["s"] for t in vol],
            "highs": [t["s"] for t in eq if t.get("hi52flag")],
            "lows": [t["s"] for t in eq if t.get("lo52flag")],
            "adv": sum(1 for t in eq if t["chgp"] > 0), "dec": sum(1 for t in eq if t["chgp"] < 0),
            "unch": sum(1 for t in eq if t["chgp"] == 0)}


# ── Economic series ──────────────────────────────────────────────────────────
def _series(raw: dict) -> pd.Series:
    return pd.Series(raw["values"], index=pd.to_datetime(raw["dates"])).sort_index()


def _freq(s: pd.Series) -> str:
    if len(s) < 3:
        return "unknown"
    gaps = np.diff(s.index.values).astype("timedelta64[D]").astype(float)
    gap = float(np.median(gaps))
    return "daily" if gap <= 2 else "weekly" if gap <= 9 else "monthly" if gap <= 40 else "quarterly"


def macro_block(cfg: dict, fred: dict[str, dict]) -> dict:
    out = {}
    spec_by_key = {s["key"]: s for s in cfg["fred"]["series"]}
    for k, raw in fred.items():
        spec = spec_by_key.get(k, {})
        s = _series(raw)
        if s.empty:
            continue
        f = _freq(s)
        last_d = s.index[-1]
        prior = s[: last_d - pd.Timedelta(days=360)]
        yoy = pct(s.iloc[-1], prior.iloc[-1]) if len(prior) else None
        prev_yoy = pct(s.iloc[-2], s.iloc[-14]) if f == "monthly" and len(s) > 14 else None
        keep_from = last_d - pd.Timedelta(days=365 * (5 if f == "daily" else 8))
        ks = s[s.index >= keep_from]
        spark_n = {"daily": 60, "weekly": 26, "monthly": 24}.get(f, 24)
        out[k] = {"id": raw.get("id"), "title": spec.get("title", k), "short": spec.get("short", spec.get("title", k)),
                  "units": spec.get("units", ""),
                  "fmt": spec.get("fmt", "num"), "freq": f, "stale": bool(raw.get("stale")),
                  "last": rnd(s.iloc[-1], 6), "last_date": last_d.strftime("%Y-%m-%d"),
                  "prev": rnd(s.iloc[-2], 6) if len(s) > 1 else None,
                  "chgp": rnd(pct(s.iloc[-1], s.iloc[-2]), 4) if len(s) > 1 else None,
                  "yoy": rnd(yoy, 4), "prev_yoy": rnd(prev_yoy, 4),
                  "chg_1y": rnd(s.iloc[-1] - prior.iloc[-1], 4) if len(prior) else None,
                  "dates": [d.strftime("%Y-%m-%d") for d in ks.index],
                  "values": [rnd(v, 6) for v in ks.values],
                  "spark": [rnd(v, 5) for v in s.values[-spark_n:]]}
    return out


def monthly_yoy(fred: dict[str, dict], keys: list[str]) -> pd.DataFrame:
    cols = {}
    for k in keys:
        if k in fred and fred[k].get("values"):
            m = _series(fred[k]).resample("MS").mean()
            cols[k] = m.pct_change(12, fill_method=None) * 100
    return pd.DataFrame(cols).dropna(how="all")


def _corr(a: pd.Series, b: pd.Series) -> tuple[float | None, int]:
    pair = pd.concat([a, b], axis=1).dropna()
    n = len(pair)
    if n < 18 or pair.iloc[:, 0].std() == 0 or pair.iloc[:, 1].std() == 0:
        return None, n
    r = pair.iloc[:, 0].corr(pair.iloc[:, 1])
    return (None if math.isnan(r) else rnd(r, 3)), n


def cost_block(cfg: dict, fred: dict[str, dict], macro: dict) -> dict:
    keys = [k for k in cfg.get("correlation_set", []) if k in fred]
    chain = []
    for k in cfg.get("cost_chain", []):
        if k in macro:
            m = macro[k]
            chain.append({"key": k, "title": m["title"], "short": m["short"], "last": m["last"], "last_date": m["last_date"],
                          "yoy": m["yoy"], "units": m["units"], "fmt": m["fmt"], "freq": m["freq"]})

    yoy = monthly_yoy(fred, sorted(set(keys) | set(cfg.get("cost_chain", []))
                                   | {"cpi_all", "cpi_medical"}))
    window = int(cfg.get("correlation_window_months", 60))
    recent = yoy.tail(window)
    matrix, nmat = [], []
    for a in keys:
        row, nrow = [], []
        for b in keys:
            if a in recent and b in recent:
                r, n = _corr(recent[a], recent[b])
            else:
                r, n = None, 0
            row.append(r)
            nrow.append(n)
        matrix.append(row)
        nmat.append(nrow)

    leadlag = []
    for a, b in cfg.get("lead_lag_pairs", []):
        if a not in yoy or b not in yoy:
            continue
        lags = []
        for k in range(13):
            pair = pd.concat([yoy[a].shift(k), yoy[b]], axis=1).dropna().tail(window)
            r, _ = _corr(pair.iloc[:, 0], pair.iloc[:, 1]) if len(pair) else (None, 0)
            lags.append(r)
        valid = [(i, r) for i, r in enumerate(lags) if r is not None]
        if not valid:
            continue
        bi, br = max(valid, key=lambda x: x[1])
        leadlag.append({"a": a, "b": b, "lags": lags, "best_lag": bi, "best_r": br, "r0": lags[0]})

    tail = yoy.tail(96)
    yoy_out = {"dates": [d.strftime("%Y-%m-%d") for d in tail.index]}
    for k in tail.columns:
        yoy_out[k] = [rnd(v, 4) for v in tail[k].values]

    return {"chain": chain, "yoy": yoy_out, "leadlag": leadlag,
            "corr": {"keys": keys, "titles": [macro[k]["title"] if k in macro else k for k in keys],
                     "matrix": matrix, "n": nmat, "window": window}}


# ── News linkage ─────────────────────────────────────────────────────────────
def link_news(news: list[dict], tickers: list[dict]) -> list[dict]:
    moves = {t["s"]: t.get("chgp") for t in tickers}
    for it in news:
        big = [s for s in it.get("tickers", []) if moves.get(s) is not None and abs(moves[s]) >= 2]
        it["movers"] = big
        if big:
            it["score"] = min(100, it["score"] + 12)
    news.sort(key=lambda o: (o["score"], o["published"]), reverse=True)
    counts: dict[str, int] = {}
    for it in news:
        for s in it.get("tickers", []):
            counts[s] = counts.get(s, 0) + 1
    for t in tickers:
        t["news"] = counts.get(t["s"], 0)
    return news


# ── Briefing ("Sig") and KPIs ───────────────────────────────────────────────
def _fp(x, d=1):
    if x is None:
        return "n/a"
    if abs(x) < 0.5 * 10 ** -d:
        x = 0.0
    return f"{x:+.{d}f}%".replace("+0.0%", "0.0%").replace("+0%", "0%")


def briefing(cfg, tickers, segs, mv, macro, fda) -> list[str]:
    by = {t["s"]: t for t in tickers}
    out = []
    idx = [(lbl, by[s]) for s, lbl in (("^GSPC", "S&P 500"), ("^NDX", "Nasdaq 100"), ("^DJI", "Dow"))
           if s in by and by[s].get("chgp") is not None]
    if idx:
        out.append("US stocks: " + ", ".join(f"{lbl} {_fp(t['chgp'], 2)}" for lbl, t in idx) + ".")
    tnx, vix = by.get("^TNX"), by.get("^VIX")
    parts = []
    if tnx and tnx.get("px") is not None and tnx.get("chg") is not None:
        bp = tnx["chg"] * 100
        parts.append(f"10-year Treasury yield {tnx['px']:.2f}% ({'+' if bp > 0 else ''}{bp:.0f} bp)")
    if vix and vix.get("px") is not None:
        parts.append(f"VIX {vix['px']:.1f}")
    for s, lbl in (("GC=F", "gold"), ("BTC-USD", "bitcoin")):
        t = by.get(s)
        if t and t.get("chgp") is not None:
            parts.append(f"{lbl} {_fp(t['chgp'], 1)}")
    if parts:
        out.append(parts[0][0].upper() + "; ".join(parts)[1:] + ".")
    xlv = by.get(cfg["markets"].get("sector_etf", "XLV"))
    spy = by.get("^GSPC") or by.get(cfg["markets"].get("benchmark", "SPY"))
    if xlv and spy and xlv.get("chgp") is not None and spy.get("chgp") is not None:
        gap = xlv["chgp"] - spy["chgp"]
        verb = "outpaced" if gap > 0.05 else "trailed" if gap < -0.05 else "kept pace with"
        out.append(f"Health care {verb} the market: the sector moved {_fp(xlv['chgp'], 2)} "
                   f"against {_fp(spy['chgp'], 2)} for the S&P 500.")
    ranked = [s for s in segs if s.get("d1") is not None]
    if len(ranked) >= 2:
        best = max(ranked, key=lambda s: s["d1"])
        worst = min(ranked, key=lambda s: s["d1"])
        out.append(f"{best['name']} led the watchlist at {_fp(best['d1'], 2)}; "
                   f"{worst['name']} lagged at {_fp(worst['d1'], 2)}.")
    cand = [by[s] for s in mv["up"][:1] + mv["down"][:1] if s in by]
    if cand:
        lead = max(cand, key=lambda t: abs(t["chgp"]))
        n = lead.get("news", 0)
        tail = f", with {n} related headline{'s' if n != 1 else ''}" if n else ""
        out.append(f"Biggest single move: {lead['n']} at {_fp(lead['chgp'], 1)}{tail}.")
    wti, fw = by.get("CL=F"), macro.get("wti")
    if wti and wti.get("px"):
        yoy = f" and {_fp(fw['yoy'], 0)} from a year ago" if fw and fw.get("yoy") is not None else ""
        out.append(f"WTI crude is ${wti['px']:.2f}, {_fp(wti['chgp'], 1)} on the day{yoy}.")
    elif fw:
        out.append(f"WTI crude is ${fw['last']:.2f}, {_fp(fw['yoy'], 0)} from a year ago.")
    rx, ppi = macro.get("cpi_rx"), macro.get("ppi_rx_retail")
    if rx and rx.get("yoy") is not None:
        s = f"Prescription drug and medical goods prices are running {_fp(rx['yoy'])} year over year"
        if ppi and ppi.get("yoy") is not None:
            s += f", while pharmacy dispensing margins sit at {_fp(ppi['yoy'])}"
        out.append(s + ".")
    sh, rc = fda.get("shortages"), fda.get("recalls")
    parts = []
    if sh:
        parts.append(f"{sh['drugs']} drugs in active shortage")
    if rc:
        c1 = rc["by_class"].get("Class I", 0)
        parts.append(f"{c1} Class I recall{'s' if c1 != 1 else ''} in the last {rc.get('lookback_days', 30)} days")
    if parts:
        out.append("FDA reports " + " and ".join(parts) + ".")
    return out


def kpis(cfg, tickers, mv, macro, fda) -> list[dict]:
    if cfg.get("kpis"):
        return kpis_from_config(cfg, tickers, mv, macro, fda)
    return kpis_legacy(cfg, tickers, mv, macro, fda)


def kpis_from_config(cfg, tickers, mv, macro, fda) -> list[dict]:
    by = {t["s"]: t for t in tickers}
    out = []
    for k in cfg["kpis"]:
        typ = k.get("type")
        if typ == "ticker":
            t = by.get(k["symbol"])
            if not t or t.get("px") is None:
                continue
            unit = t.get("unit")
            row = {"id": t["s"], "label": k.get("label", t["n"]), "sub": t.get("short") or t["s"], "value": t["px"],
                   "fmt": {"%": "yield", "idx": "idx", "fx": "fx"}.get(unit, "usd"), "chg": t["chgp"],
                   "chg_label": "today", "tone": k.get("tone", "market"), "spark": t.get("spark"),
                   "tab": "markets", "ticker": t["s"]}
            if unit == "%" and t.get("chg") is not None:
                row.update({"chg": rnd(t["chg"] * 100, 3), "chg_fmt": "bp"})
            out.append(row)
        elif typ == "macro_yoy" and macro.get(k["key"], {}).get("yoy") is not None:
            m = macro[k["key"]]
            d = (m["yoy"] - m["prev_yoy"]) if m.get("prev_yoy") is not None else None
            out.append({"id": k["key"], "label": k.get("label", m["title"]), "sub": "year over year", "value": m["yoy"],
                        "fmt": "pctchg", "chg": rnd(d, 3), "chg_label": "vs prior month", "chg_fmt": "pts",
                        "tone": k.get("tone", "cost"), "spark": m["spark"], "tab": "costs", "asof": m["last_date"]})
        elif typ == "fda_shortages" and fda.get("shortages"):
            sh = fda["shortages"]
            out.append({"id": "shortages", "label": k.get("label", "Drugs in shortage"), "sub": "FDA, current",
                        "value": sh["drugs"], "fmt": "int", "note": f"{sh['updated_30d']} updated in 30 days",
                        "tone": "count", "tab": "supply"})
        elif typ == "fda_class1" and fda.get("recalls"):
            rc = fda["recalls"]
            out.append({"id": "recalls", "label": k.get("label", "Class I recalls"), "sub": f"last {rc.get('lookback_days', 30)} days",
                        "value": rc["by_class"].get("Class I", 0), "fmt": "int", "note": f"{rc['total']} drug recalls in total",
                        "tone": "count", "tab": "supply",
                        "bars": [w["Class I"] + w["Class II"] + w["Class III"] for w in rc.get("weekly", [])][-12:]})
        elif typ == "breadth":
            total = mv["adv"] + mv["dec"] + mv["unch"]
            if total:
                out.append({"id": "breadth", "label": k.get("label", "Watchlist breadth"), "sub": f"{total} companies",
                            "value": mv["adv"], "value2": mv["dec"], "fmt": "breadth", "tone": "market", "tab": "markets"})
    return out


def kpis_legacy(cfg, tickers, mv, macro, fda) -> list[dict]:
    by = {t["s"]: t for t in tickers}
    out = []
    xlv = by.get(cfg["markets"].get("sector_etf", "XLV"))
    if xlv and xlv.get("px"):
        out.append({"id": "xlv", "label": "Health care sector", "sub": "XLV", "value": xlv["px"], "fmt": "usd",
                    "chg": xlv["chgp"], "chg_label": "today", "tone": "market", "spark": xlv.get("spark"),
                    "tab": "markets", "ticker": xlv["s"]})
    total = mv["adv"] + mv["dec"] + mv["unch"]
    if total:
        out.append({"id": "breadth", "label": "Watchlist breadth", "sub": f"{total} companies",
                    "value": mv["adv"], "value2": mv["dec"], "fmt": "breadth", "tone": "market", "tab": "markets"})
    wti = by.get("CL=F")
    if wti and wti.get("px"):
        out.append({"id": "wti", "label": "WTI crude", "sub": "front month, $/bbl", "value": wti["px"],
                    "fmt": "usd", "chg": wti["chgp"], "chg_label": "today", "tone": "cost",
                    "spark": wti.get("spark"), "tab": "costs"})
    elif "wti" in macro:
        m = macro["wti"]
        out.append({"id": "wti", "label": "WTI crude", "sub": "spot, $/bbl", "value": m["last"], "fmt": "usd",
                    "chg": m["chgp"], "chg_label": "prior day", "tone": "cost", "spark": m["spark"], "tab": "costs"})
    if "diesel" in macro:
        m = macro["diesel"]
        out.append({"id": "diesel", "label": "Diesel, retail", "sub": "US average, $/gal", "value": m["last"],
                    "fmt": "usd3", "chg": m["chgp"], "chg_label": "week", "tone": "cost", "spark": m["spark"],
                    "tab": "costs", "asof": m["last_date"]})
    for key, label, tn in (("cpi_rx", "Rx drug prices", "cost"), ("ppi_rx_retail", "Pharmacy margins", "market")):
        m = macro.get(key)
        if m and m.get("yoy") is not None:
            d = (m["yoy"] - m["prev_yoy"]) if m.get("prev_yoy") is not None else None
            out.append({"id": key, "label": label, "sub": "year over year", "value": m["yoy"], "fmt": "pctchg",
                        "chg": rnd(d, 3), "chg_label": "vs prior month", "chg_fmt": "pts", "tone": tn,
                        "spark": m["spark"], "tab": "costs", "asof": m["last_date"]})
    sh = fda.get("shortages")
    if sh:
        out.append({"id": "shortages", "label": "Drugs in shortage", "sub": "FDA, current", "value": sh["drugs"],
                    "fmt": "int", "note": f"{sh['updated_30d']} updated in 30 days", "tone": "count",
                    "tab": "supply"})
    rc = fda.get("recalls")
    if rc:
        out.append({"id": "recalls", "label": "Class I recalls", "sub": f"last {rc.get('lookback_days', 30)} days",
                    "value": rc["by_class"].get("Class I", 0), "fmt": "int",
                    "note": f"{rc['total']} drug recalls in total", "tone": "count", "tab": "supply",
                    "bars": [w["Class I"] + w["Class II"] + w["Class III"] for w in rc.get("weekly", [])][-12:]})
    return out


def build_payload(cfg, prices, fred, news, fda, earnings, health, meta) -> dict:
    tickers, hist = ticker_metrics(cfg, prices)
    segs = segment_perf(cfg, tickers)
    mv = movers(tickers)
    macro = macro_block(cfg, fred)
    costs = cost_block(cfg, fred, macro)
    news = link_news(news, tickers)
    horizon = (dt.date.today() + dt.timedelta(days=45)).isoformat()
    earnings = [e for e in earnings if e["date"] <= horizon]
    return {
        "meta": meta,
        "health": health.as_list(),
        "segments": [{"id": s["id"], "name": s["name"], "bench": bool(s.get("benchmark")) or s.get("kind") == "market",
                      "kind": s.get("kind", "equity"), "monitor": bool(s.get("monitor")),
                      "heatmap": s.get("heatmap", True), "watchlist": s.get("watchlist", True), "desk": s.get("desk")}
                     for s in cfg["markets"]["segments"]],
        "desks": cfg["news"].get("desks", []),
        "tickers": tickers, "hist": hist, "segperf": segs, "movers": mv, "earnings": earnings,
        "macro": macro, "costs": costs, "news": news,
        "newscats": [{"id": c["id"], "name": c["name"], "color": c["color"]} for c in cfg["news"]["categories"]]
                    + [{"id": "general", "name": "Industry", "color": "#E3E8EC"}],
        "fda": fda,
        "brief": briefing(cfg, tickers, segs, mv, macro, fda),
        "kpis": kpis(cfg, tickers, mv, macro, fda),
    }
