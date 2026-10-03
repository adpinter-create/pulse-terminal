#!/usr/bin/env python3
"""Rx Pulse build.

    python build.py                 # fetch live data, write the site to ./docs
    python build.py --demo          # synthetic data, no network (layout preview)
    python build.py --snapshot      # also write data/history/YYYY-MM-DD.json

Fail-safe by design: each source falls back to its last good cached copy, and the
site is only written after the whole payload builds, so a bad run never publishes
a broken page.
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

from rxpulse import analytics, render
from rxpulse.markets import all_tickers
from rxpulse.util import Cache, Health, iso, utcnow

ROOT = Path(__file__).resolve().parent
VERSION = "1.0.0"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--out", default=str(ROOT / "docs"))
    ap.add_argument("--cache", default=str(ROOT / "data" / "cache"))
    ap.add_argument("--demo", action="store_true", help="synthetic data, no network")
    ap.add_argument("--snapshot", action="store_true", help="write a daily history snapshot")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")
    log = logging.getLogger("rxpulse")
    cfg = yaml.safe_load(Path(args.config).read_text())
    tickers = all_tickers(cfg)

    if args.demo:
        from rxpulse import demo, news as news_mod
        prices, fred = demo.prices(cfg), demo.fred(cfg)
        news = news_mod.process(demo.news_raw(), cfg, tickers)
        fda, earnings, health = demo.fda(), demo.earnings(), demo.health(cfg)
    else:
        from rxpulse import fda as fda_mod, fred as fred_mod, markets, news as news_mod
        from rxpulse.util import http_session
        session = http_session()
        cache = Cache(Path(args.cache))
        health = Health()
        log.info("prices…")
        prices = markets.fetch_prices(cfg, session, cache, health)
        log.info("economic series…")
        fred = fred_mod.fetch_fred(cfg, session, cache, health)
        log.info("headlines…")
        news = news_mod.fetch_news(cfg, session, cache, health, tickers)
        log.info("FDA…")
        fda = fda_mod.fetch_fda(cfg, session, cache, health)
        log.info("earnings calendar…")
        earnings = markets.fetch_earnings(cfg, cache, health)

    if not prices and not fred and not news:
        log.error("every core source failed and no cache exists; not publishing")
        return 1

    now = utcnow()
    tz = ZoneInfo(cfg["site"].get("timezone", "America/Chicago"))
    meta = {"generated_at": iso(now), "build_id": now.astimezone(tz).strftime("%y%m%d-%H%M"),
            "demo": bool(args.demo), "version": VERSION,
            "site": {k: cfg["site"].get(k) for k in ("title", "subtitle", "author", "timezone", "theme",
                                                   "poll_minutes", "public_url", "refresh_note")}}
    payload = analytics.build_payload(cfg, prices, fred, news, fda, earnings, health, meta)
    render.write_site(payload, Path(args.out))
    if args.snapshot:
        p = render.write_snapshot(payload, ROOT / "data" / "history")
        log.info("snapshot %s", p)

    bad = [h for h in payload["health"] if h["status"] == "error"]
    for h in bad:
        log.warning("source error: %s: %s", h["label"], h["detail"])
    log.info("done: %d tickers, %d stories, %d economic series, %d source issues",
             sum(1 for t in payload["tickers"] if not t.get("missing")), len(payload["news"]),
             len(payload["macro"]), len(bad))
    return 0


if __name__ == "__main__":
    sys.exit(main())
