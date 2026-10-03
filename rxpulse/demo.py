"""Synthetic inputs for previewing the dashboard offline (python build.py --demo).
Everything here is fake and the page says so. The real pipeline replaces all of it."""
from __future__ import annotations

import datetime as dt
import random
import zlib

import numpy as np
import pandas as pd

from .markets import all_tickers
from .util import Health

BASE = {"CVS": 70, "CI": 300, "UNH": 340, "ELV": 350, "HUM": 260, "MCK": 690, "COR": 280, "CAH": 150,
        "WMT": 98, "AMZN": 225, "KR": 66, "COST": 930, "HIMS": 48, "GDRX": 5, "OPCH": 31, "OMCL": 36,
        "BDX": 190, "VEEV": 270, "WAY": 40, "LLY": 780, "NVO": 62, "PFE": 25, "MRK": 84, "ABBV": 200,
        "JNJ": 165, "TEVA": 18, "VTRS": 10, "AMRX": 11, "SPY": 640, "XLV": 142, "XPH": 44, "IHF": 52,
        "IBB": 140, "CL=F": 66, "BZ=F": 69, "HO=F": 2.35, "NG=F": 3.1,
        "^GSPC": 6650, "^NDX": 24300, "^DJI": 46200, "^RUT": 2420, "^VIX": 16.2, "^STOXX50E": 5450, "^FTSE": 9300,
        "^N225": 44800, "^HSI": 26500, "^IRX": 3.9, "^FVX": 3.75, "^TNX": 4.15, "^TYX": 4.75, "DX-Y.NYB": 97.8,
        "EURUSD=X": 1.17, "USDJPY=X": 148.5, "GBPUSD=X": 1.34, "USDCNY=X": 7.12, "GC=F": 3750, "SI=F": 45.2, "HG=F": 4.75,
        "BTC-USD": 112000, "ETH-USD": 4100, "XLK": 285, "XLF": 53, "XLY": 238, "XLC": 115, "XLI": 152, "XLP": 79,
        "XLE": 89, "XLU": 86, "XLB": 90, "XLRE": 42, "NVDA": 182, "MSFT": 512, "AAPL": 254, "GOOGL": 245, "META": 745,
        "AVGO": 335, "TSM": 280, "AMD": 160, "TSLA": 440, "ORCL": 290, "UPS": 84, "FDX": 236, "UNP": 225, "CHRW": 128,
        "EXPD": 122, "JBHT": 142, "ODFL": 140, "XPO": 128, "MATX": 99, "ZIM": 13.5}


def _bdays(start, end):
    return pd.bdate_range(start, end)


def prices(cfg) -> dict:
    end = dt.date.today()
    idx = _bdays(end - dt.timedelta(days=732), end)
    rng = np.random.default_rng(7)
    market = rng.normal(0.0004, 0.009, len(idx))
    out = {}
    for t in all_tickers(cfg):
        s = t["symbol"]
        r = np.random.default_rng(zlib.crc32(s.encode()))
        special = any(ch in s for ch in "=^-.")
        beta = 0.3 if special else r.uniform(0.6, 1.2)
        vol = 0.004 if s.endswith("=X") or s == "DX-Y.NYB" else 0.03 if s.endswith("-USD") else 0.012 if special else r.uniform(0.009, 0.022)
        rets = beta * market + r.normal(0, vol, len(idx))
        rets[-1] += r.normal(0, vol * 1.6)
        path = np.exp(np.cumsum(rets))
        closes = BASE.get(s, 50) * path / path[-1] * (1 + r.normal(0, 0.03))
        volume = (r.lognormal(15, 0.35, len(idx))).astype(int)
        volume[-1] = int(volume[-1] * r.uniform(0.6, 2.6))
        out[s] = {"provider": "demo", "dates": [d.strftime("%Y-%m-%d") for d in idx],
                  "close": [round(float(x), 4) for x in closes], "volume": [int(v) for v in volume]}
    return out


def fred(cfg) -> dict:
    end = pd.Timestamp(dt.date.today())
    rng = np.random.default_rng(11)
    daily = _bdays("2016-01-01", end)
    lo = np.zeros(len(daily)); lo[0] = np.log(62)
    for i in range(1, len(daily)):
        lo[i] = lo[i-1] + 0.01 * (np.log(68) - lo[i-1]) + rng.normal(0, 0.018)
    oil = pd.Series(np.exp(lo), index=daily)
    brent = oil * 1.045 + rng.normal(0, 0.6, len(daily))
    gas = pd.Series(np.clip(3 * np.exp(np.cumsum(rng.normal(0, 0.03, len(daily)))), 1.6, 9), index=daily)
    weekly = pd.date_range("2016-01-04", end, freq="W-MON")
    oil_w = oil.reindex(weekly, method="ffill")
    diesel = 1.1 + 0.03 * oil_w.shift(2).bfill() + rng.normal(0, 0.05, len(weekly))
    gasoline = 0.95 + 0.028 * oil_w.shift(1).bfill() + rng.normal(0, 0.05, len(weekly))
    monthly = pd.date_range("2016-01-01", end, freq="MS")[:-1]
    oil_m = oil.resample("MS").mean().reindex(monthly).ffill()
    t = np.arange(len(monthly))

    def idx(base, drift, noise, oil_beta=0.0, lag=0):
        o = (oil_m.shift(lag).bfill() / oil_m.iloc[0] - 1).values
        return pd.Series(base * np.exp(drift * t / 12 + oil_beta * o + np.cumsum(rng.normal(0, noise, len(t)))),
                         index=monthly)

    series = {
        "wti": oil, "brent": brent, "natgas": gas, "diesel": diesel, "gasoline": gasoline,
        "ppi_freight": idx(130, 0.03, 0.004, 0.12, 2), "ppi_pharma": idx(600, 0.035, 0.003, 0.02, 6),
        "ppi_rx_retail": idx(150, 0.01, 0.006), "cpi_rx": idx(460, 0.03, 0.002, 0.005, 9),
        "cpi_medical": idx(460, 0.032, 0.0015), "cpi_all": idx(236, 0.03, 0.0012, 0.03, 1),
        "retail_hpc": idx(28000, 0.04, 0.006), "emp_pharmacy": idx(740, -0.004, 0.002),
        "ust10": pd.Series(np.clip(2 + np.cumsum(rng.normal(0.001, 0.04, len(daily))), 0.5, 5.2), index=daily),
        "unrate": idx(4.1, 0.01, 0.02), "t10y2y": pd.Series(np.clip(0.4 + np.cumsum(rng.normal(0, 0.02, len(daily))), -1.1, 1.2), index=daily),
        "hy_spread": pd.Series(np.clip(3.6 + np.cumsum(rng.normal(0, 0.03, len(daily))), 2.6, 6), index=daily),
        "freight_tsi": idx(138, 0.005, 0.006), "indpro": idx(102, 0.008, 0.003),
        "fedfunds": pd.Series(np.clip(np.round(1 + np.cumsum(rng.normal(0.0005, 0.02, len(daily))) * 4) / 4,
                                      0.08, 5.33), index=daily),
    }
    return {k: {"id": f"DEMO:{k}", "dates": [d.strftime("%Y-%m-%d") for d in s.dropna().index],
                "values": [float(v) for v in s.dropna().values]} for k, s in series.items()}


HEADLINES = [
    ("What PBM reform proposals would change for Express Scripts, Caremark and Optum Rx", 0),
    ("PBM reform proposals explained: what changes for Express Scripts and Caremark", 1),
    ("How Medicare drug price negotiation timelines work, step by step", 0),
    ("What to watch in drug distribution: McKesson, Cencora and Cardinal Health", 2),
    ("GLP-1 demand and pharmacy workflow: Eli Lilly and Novo Nordisk in focus", 0),
    ("GLP-1 demand in the pharmacy: Eli Lilly and Novo Nordisk in focus", 3),
    ("Independent pharmacy economics explained: reimbursement, DIR fees and margins", 1),
    ("Pharmacy automation primer: dispensing robots, Omnicell and BD Pyxis", 2),
    ("Understanding Class I, II and III drug recalls", 3),
    ("How FDA compiles and updates the drug shortage list", 0),
    ("How 340B contract pharmacy disputes work", 1),
    ("DSCSA serialization basics for pharmacies and wholesalers", 2),
    ("Telepharmacy and pharmacist prescribing: a state-by-state overview", 3),
    ("Star Ratings and medication adherence measures in Part D, explained", 0),
    ("Walmart, Kroger and Costco pharmacy footprints compared", 1),
    ("Generic drug pricing dynamics: Teva, Viatris and Amneal", 2),
    ("Healthcare private equity deal activity: a primer on buyouts and take-privates", 3),
    ("How diesel costs travel through drug distribution", 0),
    ("Digital pharmacy models: Amazon Pharmacy, GoodRx and Hims & Hers", 1),
    ("Specialty pharmacy and biosimilars: an overview", 2),
    ("Cybersecurity in pharmacy systems: what e-prescribing outages teach", 3),
    ("UnitedHealth, Cigna and CVS Health: vertical integration explained", 0),
    ("Tariffs and active pharmaceutical ingredient sourcing: the basics", 1),
    ("Compounded semaglutide and the FDA shortage list: how the rules work", 2),
    ("Medicaid pharmacy reimbursement models compared", 3),
    ("AI in pharmacy operations: where automation fits in verification", 0),
    ("Humana and Elevance pharmacy businesses: CenterWell and CarelonRx", 1),
    ("Pharmacy closures and pharmacy deserts: how researchers measure access", 2),
    ("Biotech and pharma ETFs: what XPH and IBB hold", 3),
    ("Veeva, Waystar and the health software stack", 0),
]


DESK_HEADLINES = [
    ("How the Federal Reserve's dot plot works, and what markets read into it", "markets"),
    ("Reading a yield curve: what the 10-year minus 2-year spread signals", "markets"),
    ("Earnings season primer: guidance, margins and what analysts watch", "markets"),
    ("What the VIX measures and why traders call it the fear gauge", "markets"),
    ("How AI chip demand flows from Nvidia to TSMC and memory makers", "tech"),
    ("Data center power: why utilities now matter to AI", "tech"),
    ("Explainer: how antitrust cases against Big Tech platforms work", "tech"),
    ("Ransomware basics: how attacks spread and what companies disclose", "tech"),
    ("How container shipping rates are set, from spot to contract", "supply"),
    ("Trucking cycles explained: capacity, spot rates and contract rates", "supply"),
    ("What happens to supply chains when a canal or strait is disrupted", "supply"),
    ("Tariffs 101: who pays, and how importers respond", "supply"),
    ("How export controls on chips are designed and enforced", "world"),
    ("Explainer: how central banks outside the US set policy", "world"),
]


def news_raw() -> list[dict]:
    now = dt.datetime.now(dt.timezone.utc)
    rnd = random.Random(5)
    out = []
    for i, (title, src) in enumerate(HEADLINES):
        out.append({"title": title, "url": f"https://example.com/sample-story-{i + 1}",
                    "source": f"Sample feed {'ABCD'[src]}",
                    "published": now - dt.timedelta(hours=rnd.uniform(0.3, 66)),
                    "summary": "Sample summary text. Live runs show the publisher's own summary here, "
                               "trimmed to a couple of sentences, with a link to the full story."
                               if i % 3 == 0 else "", "via": "Sample", "desk": "health"})
    for j, (title, desk) in enumerate(DESK_HEADLINES):
        out.append({"title": title, "url": f"https://example.com/sample-desk-{j + 1}", "source": f"Sample feed {'ABCD'[j % 4]}",
                    "published": now - dt.timedelta(hours=rnd.uniform(0.2, 40)), "summary": "", "via": "Sample", "desk": desk})
    return out


CATS = ["Anti-infective", "Oncology", "Cardiovascular", "Anesthesia", "Endocrinology", "Neurology",
        "Pain management", "Psychiatry", "Pediatric", "Hematology", "Gastroenterology", "Renal"]


def fda() -> dict:
    rnd = random.Random(9)
    today = dt.date.today()
    lst = []
    for i in range(96):
        cat = rnd.choices(CATS, weights=[9, 8, 7, 7, 5, 5, 5, 4, 3, 3, 2, 2])[0]
        lst.append({"name": f"Sample drug {i + 1:02d}", "cats": [cat], "company": f"Sample Labs {rnd.randint(1, 30)}",
                    "presentation": "Sample presentation, 10 mL vial", "reason": rnd.choice(
                        ["Demand increase", "Manufacturing delay", "Discontinuation", "Raw material", ""]),
                    "updated": (today - dt.timedelta(days=rnd.randint(0, 200))).isoformat(), "presentations":
                        rnd.randint(1, 6)})
    lst.sort(key=lambda d: d["updated"], reverse=True)
    counts = {}
    for d in lst:
        counts[d["cats"][0]] = counts.get(d["cats"][0], 0) + 1
    weekly = []
    start = today - dt.timedelta(days=today.weekday()) - dt.timedelta(weeks=25)
    for w in range(26):
        weekly.append({"week": (start + dt.timedelta(weeks=w)).isoformat(), "Class I": rnd.choice([0, 0, 1, 1, 2, 4]),
                       "Class II": rnd.randint(6, 30), "Class III": rnd.randint(0, 8)})
    recalls = []
    for i in range(64):
        cls = rnd.choices(["Class I", "Class II", "Class III"], weights=[1, 6, 2])[0]
        recalls.append({"date": (today - dt.timedelta(days=rnd.randint(0, 29))).isoformat(), "class": cls,
                        "firm": f"Sample Pharma Co. {rnd.randint(1, 25)}",
                        "product": f"Sample product {i + 1}, tablets, 30-count bottle",
                        "reason": rnd.choice(["CGMP deviations", "Failed dissolution specifications",
                                              "Presence of particulate matter", "Labeling error", "Lack of sterility assurance"]),
                        "status": "Ongoing", "states": "Nationwide", "number": f"D-{1000 + i}-2026"})
    recalls.sort(key=lambda r: r["date"], reverse=True)
    by_class = {}
    for r in recalls:
        by_class[r["class"]] = by_class.get(r["class"], 0) + 1
    return {"shortages": {"drugs": len(lst), "entries": sum(d["presentations"] for d in lst),
                          "updated_30d": sum(1 for d in lst if (today - dt.date.fromisoformat(d["updated"])).days <= 30),
                          "by_category": sorted(counts.items(), key=lambda kv: -kv[1]), "list": lst},
            "recalls": {"total": len(recalls), "by_class": dict(sorted(by_class.items())), "list": recalls,
                        "lookback_days": 30, "weekly": weekly}}


def earnings() -> list[dict]:
    today = dt.date.today()
    rows = [("CVS", "CVS Health", 12), ("UNH", "UnitedHealth", 16), ("MCK", "McKesson", 30),
            ("CI", "Cigna Group", 32), ("LLY", "Eli Lilly", 31), ("TEVA", "Teva", 38), ("OMCL", "Omnicell", 36)]
    return sorted([{"symbol": s, "name": n, "date": (today + dt.timedelta(days=d)).isoformat(),
                    "eps_est": None, "rev_est": None} for s, n, d in rows], key=lambda r: r["date"])


def health(cfg) -> Health:
    h = Health()
    h.set("demo", "Sample data mode", "stale", detail="Synthetic data for layout preview. Run without --demo for live data.",
          group="Build")
    return h
