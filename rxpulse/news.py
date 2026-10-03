"""Headlines from topic searches and trade publishers, deduplicated into stories,
tagged by category and company, and ranked by an explainable impact score."""
from __future__ import annotations

import calendar
import datetime as dt
import hashlib
import html
import logging
import math
import re
from urllib.parse import quote_plus

import feedparser

from .util import Cache, Health, iso, utcnow

log = logging.getLogger("rxpulse.news")

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
TOKEN_RE = re.compile(r"[a-z0-9]+")
STOP = set("a an the of to in on for and or with at by from as is are be its it this that new says after amid over into up "
           "out vs via more how why what will could may us".split())


def clean_text(s: str | None, limit: int = 320) -> str:
    if not s:
        return ""
    s = html.unescape(TAG_RE.sub(" ", s))
    s = WS_RE.sub(" ", s).strip()
    if len(s) > limit:
        s = s[:limit].rsplit(" ", 1)[0].rstrip(",.;:") + "…"
    return s


def _kw_regex(words: list[str]) -> re.Pattern | None:
    words = [w for w in words if w]
    if not words:
        return None
    alts = sorted((re.escape(w) for w in words), key=len, reverse=True)
    return re.compile(r"(?<![A-Za-z0-9])(?:" + "|".join(alts) + r")(?![A-Za-z0-9])", re.IGNORECASE)


def _entry_time(e) -> dt.datetime | None:
    for attr in ("published_parsed", "updated_parsed"):
        t = getattr(e, attr, None) or (e.get(attr) if isinstance(e, dict) else None)
        if t:
            return dt.datetime.fromtimestamp(calendar.timegm(t), tz=dt.timezone.utc)
    return None


def parse_feed(content: bytes | str, default_source: str, is_google: bool = False) -> list[dict]:
    fp = feedparser.parse(content)
    items = []
    feed_title = clean_text(getattr(fp.feed, "title", "") or default_source, 80)
    for e in fp.entries:
        title = clean_text(e.get("title"), 300)
        link = e.get("link")
        if not title or not link:
            continue
        source = default_source
        src = e.get("source")
        if src and getattr(src, "title", None):
            source = clean_text(src.title, 80)
        elif src and isinstance(src, dict) and src.get("title"):
            source = clean_text(src["title"], 80)
        elif not default_source:
            source = feed_title
        if is_google:
            suffix = f" - {source}"
            if title.endswith(suffix):
                title = title[: -len(suffix)].strip()
            summary = ""  # Google News summaries just repeat headlines
        else:
            summary = clean_text(e.get("summary") or e.get("description"), 320)
            if summary.lower().startswith(title.lower()[:40]):
                summary = ""
        items.append({"title": title, "url": link, "source": source,
                      "published": _entry_time(e), "summary": summary})
    return items


def _tokens(title: str) -> set[str]:
    return {t for t in TOKEN_RE.findall(title.lower()) if t not in STOP and len(t) > 2}


def cluster(items: list[dict], threshold: float = 0.55) -> list[dict]:
    """Group near-duplicate headlines from different outlets into one story."""
    items = sorted(items, key=lambda x: x["_w"], reverse=True)
    stories: list[dict] = []
    for it in items:
        tk = _tokens(it["title"])
        if not tk:
            continue
        home = None
        for st in stories:
            inter = len(tk & st["_tk"])
            if inter == 0:
                continue
            j = inter / len(tk | st["_tk"])
            if j >= threshold or (inter >= 5 and inter / min(len(tk), len(st["_tk"])) >= 0.8):
                home = st
                break
        if home is None:
            stories.append({**it, "_tk": tk, "also": [], "_desks": {it.get("desk")} - {None}})
        else:
            if it.get("desk"):
                home["_desks"].add(it["desk"])
            if it["source"] != home["source"] and all(a["source"] != it["source"] for a in home["also"]):
                home["also"].append({"source": it["source"], "url": it["url"], "title": it["title"]})
            if it["published"] and home["published"] and it["published"] < home["published"]:
                home["first_seen"] = iso(it["published"])
    return stories


def fetch_news(cfg: dict, session, cache: Cache, health: Health, tickers: list[dict]) -> list[dict]:
    ncfg = cfg["news"]
    raw: list[dict] = []
    window = ncfg.get("google_news_window", "3d")

    # Google News topic searches
    g_ok = 0
    g_total = len(ncfg.get("google_news_queries", []))
    default_desk = ncfg.get("default_desk", "health")
    for entry in ncfg.get("google_news_queries", []):
        q = entry["q"] if isinstance(entry, dict) else str(entry)
        desk = entry.get("desk", default_desk) if isinstance(entry, dict) else default_desk
        url = (f"https://news.google.com/rss/search?q={quote_plus(q + ' when:' + window)}"
               f"&hl=en-US&gl=US&ceid=US:en")
        try:
            r = session.get(url, timeout=20)
            r.raise_for_status()
            got = parse_feed(r.content, "", is_google=True)
            for it in got:
                it["query"] = q
                it["via"] = "Google News"
                it["desk"] = desk
            raw.extend(got)
            g_ok += 1
        except Exception as e:
            log.info("google news %r failed: %s", q, e)
    if g_total:
        status = "ok" if g_ok == g_total else ("error" if g_ok == 0 else "stale")
        health.set("news:google", "Google News topic searches", status,
                   detail=f"{g_ok}/{g_total} searches returned", count=g_ok,
                   url="https://news.google.com", group="News")

    # Direct publisher feeds
    feed_weights = {}
    for f in ncfg.get("feeds", []):
        feed_weights[f["name"]] = f.get("weight", 1.0)
        try:
            r = session.get(f["url"], timeout=20)
            r.raise_for_status()
            got = parse_feed(r.content, f["name"])
            if not got:
                raise ValueError("feed parsed but had no entries")
            for it in got:
                it["via"] = f["name"]
                it["desk"] = f.get("desk", ncfg.get("default_desk", "health"))
            raw.extend(got)
            health.ok(f"feed:{f['name']}", f["name"], detail="RSS", count=len(got), url=f["url"], group="News")
        except Exception as e:
            health.error(f"feed:{f['name']}", f["name"], detail=str(e), url=f["url"], group="News")

    if not raw:
        cached = cache.load("news")
        if cached:
            health.stale("news", "Headline pipeline", detail="all news sources failed; showing cache",
                         count=len(cached["data"]), as_of=cached["fetched_at"], group="News")
            return cached["data"]
        health.error("news", "Headline pipeline", detail="no headlines from any source", group="News")
        return []

    stories = process(raw, cfg, tickers, feed_weights)
    cache.save("news", stories)
    health.ok("news", "Headline pipeline", detail=f"{len(raw)} headlines into {len(stories)} stories",
              count=len(stories), group="News")
    return stories


def process(raw: list[dict], cfg: dict, tickers: list[dict], feed_weights: dict | None = None,
            now: dt.datetime | None = None) -> list[dict]:
    ncfg = cfg["news"]
    now = now or utcnow()
    lookback = dt.timedelta(hours=ncfg.get("lookback_hours", 72))
    src_w = {**ncfg.get("source_weights", {}), **(feed_weights or {})}
    cats = [(c["id"], _kw_regex(c["keywords"])) for c in ncfg["categories"]]
    impact_re = _kw_regex(ncfg.get("impact_terms", []))
    tick_res = [(t["symbol"], _kw_regex(t.get("aliases", []))) for t in tickers if t.get("aliases")]

    fresh = []
    for it in raw:
        p = it.get("published")
        if isinstance(p, str):
            p = dt.datetime.fromisoformat(p.replace("Z", "+00:00"))
        if p is None:
            p = now
        if p > now + dt.timedelta(hours=1):
            p = now
        if now - p > lookback:
            continue
        it = {**it, "published": p}
        it["_w"] = src_w.get(it["source"], src_w.get(it.get("via", ""), 1.0))
        fresh.append(it)

    stories = cluster(fresh)
    out = []
    for st in stories:
        text = f"{st['title']} {st.get('summary', '')}"
        st_cats = [cid for cid, rx in cats if rx and rx.search(text)]
        st_ticks = [sym for sym, rx in tick_res if rx and rx.search(text)]
        terms = sorted({m.group(0).lower() for m in impact_re.finditer(st["title"])}) if impact_re else []
        age_h = max(0.0, (now - st["published"]).total_seconds() / 3600)
        n_src = 1 + len(st["also"])
        base = (1.0 + 0.45 * min(n_src - 1, 5) + 0.2 * min(len(st_cats), 3)
                + 0.5 * min(len(terms), 2) + 0.35 * min(len(st_ticks), 3))
        recency = 0.3 + 0.7 * math.exp(-age_h / 30.0)
        raw_score = base * st["_w"] * recency
        uid = hashlib.sha1(st["url"].encode()).hexdigest()[:12]
        out.append({
            "id": uid, "title": st["title"], "url": st["url"], "source": st["source"],
            "published": iso(st["published"]), "summary": st.get("summary", ""),
            "cats": st_cats or ["general"], "tickers": st_ticks, "terms": terms,
            "desk": st.get("desk") or "health", "desks": sorted(st["_desks"] or {st.get("desk") or "health"}),
            "sources": n_src, "also": st["also"][:6], "raw_score": raw_score,
        })
    if out:
        top = max(o["raw_score"] for o in out)
        for o in out:
            o["score"] = int(round(100 * o.pop("raw_score") / top))
    out.sort(key=lambda o: (o["score"], o["published"]), reverse=True)
    return out[: ncfg.get("max_items", 220)]
