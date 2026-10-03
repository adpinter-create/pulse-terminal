"""openFDA: current drug shortages and drug recalls (enforcement reports)."""
from __future__ import annotations

import datetime as dt
import logging
import os
from collections import Counter, defaultdict
from urllib.parse import quote

from .util import Cache, Health

log = logging.getLogger("rxpulse.fda")
BASE = "https://api.fda.gov/drug"


def _q(search: str) -> str:
    # openFDA wants spaces as '+', and tolerates encoded brackets/quotes
    return quote(search, safe=':[]"').replace("%20", "+")


def _get(session, endpoint: str, search: str | None = None, **params) -> dict:
    key = os.environ.get("OPENFDA_API_KEY", "").strip()
    parts = []
    if search:
        parts.append(f"search={_q(search)}")
    for k, v in params.items():
        parts.append(f"{k}={v}")
    if key:
        parts.append(f"api_key={key}")
    url = f"{BASE}/{endpoint}.json?" + "&".join(parts)
    r = session.get(url, timeout=30)
    if r.status_code == 404:  # openFDA's way of saying "zero matches"
        return {"results": []}
    r.raise_for_status()
    return r.json()


def _parse_date(s) -> dt.date | None:
    if not s:
        return None
    s = str(s).strip()
    for fmt in ("%Y%m%d", "%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return dt.datetime.strptime(s[:10] if "-" in s else s, fmt).date()
        except ValueError:
            continue
    return None


def _as_list(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [p.strip() for p in str(v).split(";") if p.strip()]


def summarize_shortages(results: list[dict]) -> dict:
    rows = []
    for r in results:
        status = str(r.get("status", "")).strip()
        if status and status.lower() != "current":
            continue
        name = (r.get("generic_name") or r.get("proprietary_name") or "").strip()
        if not name:
            continue
        cats = _as_list(r.get("therapeutic_category")) or ["Uncategorized"]
        upd = _parse_date(r.get("update_date")) or _parse_date(r.get("initial_posting_date"))
        rows.append({"name": name.title() if name.isupper() else name, "cats": cats,
                     "company": (r.get("company_name") or "").strip(),
                     "presentation": (r.get("presentation") or "")[:140],
                     "reason": (r.get("shortage_reason") or "").strip()[:160],
                     "updated": upd.isoformat() if upd else None})
    by_drug: dict[str, dict] = {}
    for row in rows:
        d = by_drug.setdefault(row["name"].lower(), {**row, "presentations": 0})
        d["presentations"] += 1
        if row["updated"] and (not d["updated"] or row["updated"] > d["updated"]):
            d["updated"] = row["updated"]
    cat_counts = Counter()
    for d in by_drug.values():
        for c in set(d["cats"]):
            cat_counts[c] += 1
    today = dt.date.today()
    recent = sorted(by_drug.values(), key=lambda d: d["updated"] or "", reverse=True)
    updated_30 = sum(1 for d in by_drug.values()
                     if d["updated"] and (today - dt.date.fromisoformat(d["updated"])).days <= 30)
    return {"drugs": len(by_drug), "entries": len(rows), "updated_30d": updated_30,
            "by_category": cat_counts.most_common(14), "list": recent[:250]}


def summarize_recalls(results: list[dict]) -> dict:
    recent = []
    by_class = Counter()
    for r in results:
        cls = str(r.get("classification", "")).strip() or "Unclassified"
        by_class[cls] += 1
        d = _parse_date(r.get("report_date"))
        recent.append({"date": d.isoformat() if d else None, "class": cls,
                       "firm": (r.get("recalling_firm") or "").strip(),
                       "product": (r.get("product_description") or "").strip()[:220],
                       "reason": (r.get("reason_for_recall") or "").strip()[:260],
                       "status": (r.get("status") or "").strip(),
                       "states": (r.get("distribution_pattern") or "").strip()[:120],
                       "number": r.get("recall_number")})
    recent.sort(key=lambda x: x["date"] or "", reverse=True)
    return {"total": len(results), "by_class": dict(sorted(by_class.items())), "list": recent[:200]}


def weekly_counts(per_class: dict[str, list[dict]], weeks: int) -> list[dict]:
    today = dt.date.today()
    start = today - dt.timedelta(days=today.weekday()) - dt.timedelta(weeks=weeks - 1)
    buckets: dict[str, dict] = defaultdict(lambda: {"Class I": 0, "Class II": 0, "Class III": 0})
    for cls, rows in per_class.items():
        for row in rows:
            d = _parse_date(row.get("time"))
            if not d or d < start:
                continue
            wk = (d - dt.timedelta(days=d.weekday())).isoformat()
            buckets[wk][cls] += int(row.get("count", 0))
    out = []
    for i in range(weeks):
        wk = (start + dt.timedelta(weeks=i)).isoformat()
        b = buckets.get(wk, {"Class I": 0, "Class II": 0, "Class III": 0})
        out.append({"week": wk, **b})
    return out


def fetch_fda(cfg: dict, session, cache: Cache, health: Health) -> dict:
    fcfg = cfg.get("fda", {})
    today = dt.date.today()
    out: dict = {}

    # Shortages
    try:
        try:
            data = _get(session, "shortages", 'status:"Current"', limit=1000)
            results = data.get("results", [])
        except Exception:
            results = []
            for skip in (0, 1000, 2000):
                chunk = _get(session, "shortages", None, limit=1000, skip=skip).get("results", [])
                results.extend(chunk)
                if len(chunk) < 1000:
                    break
        out["shortages"] = summarize_shortages(results)
        health.ok("fda:shortages", "FDA drug shortages", detail="openFDA shortages endpoint",
                  count=out["shortages"]["drugs"], url="https://open.fda.gov/apis/drug/drugshortages/",
                  group="FDA")
    except Exception as e:
        c = (cache.load("fda") or {}).get("data", {})
        if c.get("shortages"):
            out["shortages"] = c["shortages"]
            health.stale("fda:shortages", "FDA drug shortages", detail=f"{e}; cached", group="FDA")
        else:
            health.error("fda:shortages", "FDA drug shortages", detail=str(e), group="FDA")

    # Recalls: detail for the lookback window, weekly counts per class for the trend
    try:
        lb = int(fcfg.get("recall_lookback_days", 30))
        rng = f"report_date:[{(today - dt.timedelta(days=lb)):%Y%m%d} TO {today:%Y%m%d}]"
        rec = _get(session, "enforcement", rng, limit=1000).get("results", [])
        out["recalls"] = summarize_recalls(rec)
        out["recalls"]["lookback_days"] = lb
        weeks = int(fcfg.get("recall_trend_weeks", 26))
        trng = f"report_date:[{(today - dt.timedelta(weeks=weeks + 1)):%Y%m%d} TO {today:%Y%m%d}]"
        per_class = {}
        for cls in ("Class I", "Class II", "Class III"):
            per_class[cls] = _get(session, "enforcement", f'{trng} AND classification:"{cls}"',
                                  count="report_date").get("results", [])
        out["recalls"]["weekly"] = weekly_counts(per_class, weeks)
        health.ok("fda:recalls", "FDA drug recalls", detail=f"enforcement reports, last {lb} days",
                  count=out["recalls"]["total"], url="https://open.fda.gov/apis/drug/enforcement/", group="FDA")
    except Exception as e:
        c = (cache.load("fda") or {}).get("data", {})
        if c.get("recalls"):
            out["recalls"] = c["recalls"]
            health.stale("fda:recalls", "FDA drug recalls", detail=f"{e}; cached", group="FDA")
        else:
            health.error("fda:recalls", "FDA drug recalls", detail=str(e), group="FDA")

    if out:
        prev = (cache.load("fda") or {}).get("data", {})
        cache.save("fda", {**prev, **out})
    return out
