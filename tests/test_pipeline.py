"""Offline tests. No network: every source is exercised with fixtures or fakes.
Run: python -m pytest -q"""
import datetime as dt
import json
import math
import sys
from pathlib import Path

import pandas as pd
import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from rxpulse import analytics, demo, fda, fred, markets, news, render  # noqa: E402
from rxpulse.util import Cache, Health, rnd  # noqa: E402

CFG = yaml.safe_load((ROOT / "config.yaml").read_text())
TICKERS = markets.all_tickers(CFG)
NOW = dt.datetime(2026, 9, 29, 15, 0, tzinfo=dt.timezone.utc)


class FakeResp:
    def __init__(self, text="", status=200, payload=None):
        self.text, self.status_code, self._payload = text, status, payload
        self.content = text.encode()

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, handler):
        self.handler = handler

    def get(self, url, params=None, timeout=None):
        return self.handler(url, params or {})


# ── Utilities ────────────────────────────────────────────────────────────────
def test_rnd_handles_nan_and_significant_digits():
    assert rnd(float("nan")) is None
    assert rnd(None) is None
    assert rnd(123456.789, 4) == 123457, "never rounds away whole-number digits"
    assert rnd(0.00123456, 3) == 0.00123


# ── FRED ─────────────────────────────────────────────────────────────────────
FRED_CSV = "observation_date,CPIAUCSL\n2026-06-01,320.1\n2026-07-01,.\n2026-08-01,321.4\n"


def test_fred_csv_skips_missing_values():
    s = fred.parse_fred_csv(FRED_CSV, "CPIAUCSL")
    assert list(s.values) == [320.1, 321.4]
    assert s.index[-1] == pd.Timestamp("2026-08-01")


def test_fred_falls_back_to_second_id_then_cache(tmp_path):
    cfg = {"fred": {"start": "2020-01-01", "series": [
        {"key": "cpi_rx", "ids": ["BADID", "GOODID"], "title": "Rx CPI"},
        {"key": "gone", "ids": ["NOPE"], "title": "Gone"}]}}
    cache = Cache(tmp_path)
    cache.save("fred", {"gone": {"id": "NOPE", "dates": ["2026-01-01"], "values": [1.0]}})

    def handler(url, params):
        if params.get("id") == "GOODID":
            return FakeResp("observation_date,GOODID\n2026-07-01,1\n2026-08-01,2\n")
        return FakeResp("", 500)

    h = Health()
    out = fred.fetch_fred(cfg, FakeSession(handler), cache, h)
    assert out["cpi_rx"]["id"] == "GOODID"
    assert out["gone"]["stale"] is True
    statuses = {r["key"]: r["status"] for r in h.as_list()}
    assert statuses == {"fred:cpi_rx": "ok", "fred:gone": "stale"}


# ── Markets ──────────────────────────────────────────────────────────────────
def test_stooq_parse_and_non_csv_rejection():
    csv = "Date,Open,High,Low,Close,Volume\n" + "\n".join(
        f"2026-09-{d:02d},1,1,1,{10 + d},100" for d in range(1, 11))
    raw = markets._stooq(FakeSession(lambda u, p: FakeResp(csv)), "CVS", None, dt.date(2026, 1, 1))
    assert raw["close"][-1] == 20 and raw["provider"] == "stooq"
    with pytest.raises(ValueError):
        markets._stooq(FakeSession(lambda u, p: FakeResp("No data")), "CVS", None, dt.date(2026, 1, 1))


def test_ticker_metrics_returns_and_flags():
    idx = pd.bdate_range("2025-01-01", "2026-09-28")
    closes = [100 + i * 0.1 for i in range(len(idx))]
    prices = {"CVS": {"provider": "t", "dates": [d.strftime("%Y-%m-%d") for d in idx],
                      "close": closes, "volume": [1000] * (len(idx) - 1) + [3000]}}
    rows, hist = analytics.ticker_metrics(CFG, prices, today=dt.date(2026, 9, 29))
    cvs = next(r for r in rows if r["s"] == "CVS")
    assert cvs["hi52flag"] is True and cvs["lo52flag"] is False
    assert cvs["vr"] == pytest.approx(3.0)
    assert cvs["chgp"] == pytest.approx((closes[-1] / closes[-2] - 1) * 100, rel=1e-3)
    assert next(r for r in rows if r["s"] == "UNH").get("missing") is True
    assert len(hist["series"]["CVS"]) == len(hist["dates"])


# ── News ─────────────────────────────────────────────────────────────────────
RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>Google News</title>
<item><title>FTC sues Express Scripts over insulin rebates - Reuters</title><link>https://ex.com/a</link>
<pubDate>Tue, 29 Sep 2026 13:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source>
<description>&lt;a href="x"&gt;FTC sues&lt;/a&gt;</description></item>
<item><title>FTC sues Express Scripts over insulin rebates, pricing - STAT</title><link>https://ex.com/b</link>
<pubDate>Tue, 29 Sep 2026 12:00:00 GMT</pubDate><source url="https://statnews.com">STAT</source></item>
<item><title>Old story about pharmacies - Old News</title><link>https://ex.com/c</link>
<pubDate>Tue, 01 Sep 2026 12:00:00 GMT</pubDate><source url="https://x.com">Old News</source></item>
</channel></rss>"""


def test_google_news_parse_strips_source_suffix_and_summary():
    items = news.parse_feed(RSS, "", is_google=True)
    assert items[0]["title"] == "FTC sues Express Scripts over insulin rebates"
    assert items[0]["source"] == "Reuters" and items[0]["summary"] == ""


def test_process_clusters_tags_scores_and_drops_old():
    stories = news.process(news.parse_feed(RSS, "", is_google=True), CFG, TICKERS, now=NOW)
    assert len(stories) == 1, "duplicates merge, old story drops"
    s = stories[0]
    assert s["sources"] == 2 and s["also"][0]["source"] in ("STAT", "Reuters")
    assert "pbm" in s["cats"] and "CI" in s["tickers"]
    assert "sues" in s["terms"] and s["score"] == 100


def test_alias_matching_is_whole_word():
    raw = [{"title": "Costco shoppers compare costs at local pharmacies", "url": "https://ex.com/1",
            "source": "X", "published": NOW, "summary": ""}]
    st = news.process(raw, CFG, TICKERS, now=NOW)
    assert st[0]["tickers"] == ["COST"], "matches Costco, not 'costs'"


# ── FDA ──────────────────────────────────────────────────────────────────────
def test_shortage_summary_dedupes_and_filters_status():
    res = [
        {"generic_name": "AMOXICILLIN", "status": "Current", "therapeutic_category": ["Anti-infective"],
         "update_date": "09/20/2026", "company_name": "A"},
        {"generic_name": "AMOXICILLIN", "status": "Current", "therapeutic_category": ["Anti-infective"],
         "update_date": "09/25/2026", "company_name": "B"},
        {"generic_name": "OLDDRUG", "status": "Resolved", "therapeutic_category": ["Oncology"]},
        {"generic_name": "LIDOCAINE", "status": "Current", "therapeutic_category": "Anesthesia; Pain",
         "update_date": "20260110"},
    ]
    out = fda.summarize_shortages(res)
    assert out["drugs"] == 2 and out["entries"] == 3
    amox = next(d for d in out["list"] if d["name"] == "Amoxicillin")
    assert amox["updated"] == "2026-09-25" and amox["presentations"] == 2
    assert dict(out["by_category"])["Pain"] == 1


def test_weekly_recall_counts_bucket_by_monday():
    today = dt.date.today()
    monday = today - dt.timedelta(days=today.weekday())
    rows = {"Class I": [{"time": monday.strftime("%Y%m%d"), "count": 2}],
            "Class II": [{"time": (monday + dt.timedelta(days=1)).strftime("%Y%m%d"), "count": 5}]}
    wk = fda.weekly_counts(rows, 4)
    assert wk[-1] == {"week": monday.isoformat(), "Class I": 2, "Class II": 5, "Class III": 0}
    assert len(wk) == 4


def test_openfda_404_means_zero_results():
    out = fda._get(FakeSession(lambda u, p: FakeResp("", 404)), "enforcement", "report_date:[1 TO 2]")
    assert out == {"results": []}


# ── Whole pipeline and rendering ─────────────────────────────────────────────
def _demo_payload():
    meta = {"generated_at": "2026-09-29T15:00:00Z", "build_id": "test", "demo": True, "version": "t",
            "site": CFG["site"]}
    return analytics.build_payload(CFG, demo.prices(CFG), demo.fred(CFG),
                                   news.process(demo.news_raw(), CFG, TICKERS), demo.fda(),
                                   demo.earnings(), demo.health(CFG), meta)


def test_payload_is_strict_json_and_complete():
    p = _demo_payload()
    s = json.dumps(p, allow_nan=False)  # raises on NaN/inf
    for key in ("tickers", "hist", "segperf", "movers", "macro", "costs", "news", "fda", "brief", "kpis"):
        assert p[key], key
    assert len(p["costs"]["corr"]["matrix"]) == len(p["costs"]["corr"]["keys"])
    assert all(0 <= n["score"] <= 100 for n in p["news"])
    assert "nan" not in s.lower().replace("financ", "")


def test_rendered_page_is_self_contained_and_injection_safe(tmp_path):
    p = _demo_payload()
    p["news"][0]["title"] = "</script><script>alert(1)</script>"
    render.write_site(p, tmp_path)
    html = (tmp_path / "index.html").read_text()
    assert "__DATA__" not in html and "/*__JS__*/" not in html and "/*__CSS__*/" not in html
    assert "<script>alert(1)" not in html, "data must not open or close tags"
    assert "\\u003cscript>alert(1)" in html
    assert html.count("<script") == 3  # theme pre-paint, JSON data, app
    for f in ("data/latest.json", "data/meta.json", "data/csv/watchlist.csv", "fonts/archivo.woff2",
              "embed-snippet.html", ".nojekyll"):
        assert (tmp_path / f).exists(), f
    meta = json.loads((tmp_path / "data/meta.json").read_text())
    assert meta["build_id"] == "test"


def test_desks_propagate_and_merge_across_feeds():
    raw = [{"title": "Nvidia chip export controls tighten for China", "url": "https://ex.com/t1", "source": "TechCrunch",
            "published": NOW, "summary": "", "desk": "tech"},
           {"title": "Nvidia chip export controls tighten for China, analysts say", "url": "https://ex.com/w1",
            "source": "BBC Business", "published": NOW, "summary": "", "desk": "world"}]
    st = news.process(raw, CFG, TICKERS, now=NOW)
    assert len(st) == 1 and set(st[0]["desks"]) == {"tech", "world"}
    assert "ai" in st[0]["cats"] and "trade" in st[0]["cats"] and "NVDA" in st[0]["tickers"]


def test_generic_words_no_longer_tag_pharmacy_topics():
    raw = [{"title": "Board approves AI software platform deal as tariffs rise", "url": "https://ex.com/g1",
            "source": "X", "published": NOW, "summary": ""}]
    cats = news.process(raw, CFG, TICKERS, now=NOW)[0]["cats"]
    assert not {"fda", "tech", "pricing"} & set(cats), cats
