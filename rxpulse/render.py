"""Writes the published site: one self-contained index.html (CSS, JS and a first
data snapshot inlined for an instant first paint), data/latest.json for live
polling, CSV exports for Power BI/Excel, and a copy-paste embed snippet."""
from __future__ import annotations

import csv
import json
import logging
import shutil
from pathlib import Path

log = logging.getLogger("rxpulse.render")
ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


def _dump(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _safe_inline(js_json: str) -> str:
    # "<" only ever appears inside JSON strings, so escaping it as \u003c keeps the JSON
    # valid while making it impossible for data to open or close tags in the page.
    return js_json.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def write_site(payload: dict, out_dir: Path) -> None:
    out_dir = Path(out_dir)
    data_dir = out_dir / "data"
    csv_dir = data_dir / "csv"
    csv_dir.mkdir(parents=True, exist_ok=True)

    body = _dump(payload)
    (data_dir / "latest.json").write_text(body, encoding="utf-8")
    meta = {"generated_at": payload["meta"]["generated_at"], "build_id": payload["meta"]["build_id"]}
    (data_dir / "meta.json").write_text(_dump(meta), encoding="utf-8")

    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "app.css").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")
    site = payload["meta"]["site"]
    html = (html.replace("/*__CSS__*/", css)
                .replace("/*__JS__*/", js)
                .replace("__DATA__", _safe_inline(body))
                .replace("__TITLE__", f"{site['title']} | {site['subtitle']}")
                .replace("__THEME__", site.get("theme", "auto")))
    (out_dir / "index.html").write_text(html, encoding="utf-8")
    (out_dir / ".nojekyll").write_text("")
    shutil.copytree(WEB / "fonts", out_dir / "fonts", dirs_exist_ok=True)

    write_csvs(payload, csv_dir)
    write_embed(payload, out_dir)
    log.info("site written to %s (index %.0f KB, data %.0f KB)", out_dir,
             (out_dir / "index.html").stat().st_size / 1024, len(body) / 1024)


def _csv(path: Path, header: list[str], rows) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def write_csvs(p: dict, d: Path) -> None:
    gen = p["meta"]["generated_at"]
    cols = ["s", "n", "seg", "px", "chg", "chgp", "r1w", "r1m", "r3m", "rytd", "r1y", "hi52", "lo52",
            "offhi", "vol", "avgvol", "vr", "news", "d"]
    _csv(d / "watchlist.csv", ["generated_at", "symbol", "name", "segment", "price", "change", "change_pct",
                                "ret_1w", "ret_1m", "ret_3m", "ret_ytd", "ret_1y", "high_52w", "low_52w",
                                "pct_from_high", "volume", "avg_volume_20d", "volume_ratio", "headline_count",
                                "price_date"],
         ([gen] + [t.get(c) for c in cols] for t in p["tickers"] if not t.get("missing")))
    h = p["hist"]
    _csv(d / "prices_daily.csv", ["date", "symbol", "close"],
         ((dt, s, v) for s, vals in h["series"].items() for dt, v in zip(h["dates"], vals) if v is not None))
    _csv(d / "economic_series.csv", ["date", "key", "fred_id", "title", "value"],
         ((dt, k, m["id"], m["title"], v) for k, m in p["macro"].items() for dt, v in zip(m["dates"], m["values"])))
    _csv(d / "headlines.csv", ["published", "score", "desk", "source", "title", "url", "categories", "tickers", "outlets"],
         ((n["published"], n["score"], n.get("desk", ""), n["source"], n["title"], n["url"], "|".join(n["cats"]),
           "|".join(n["tickers"]), n["sources"]) for n in p["news"]))
    rc = p["fda"].get("recalls", {})
    _csv(d / "recalls.csv", ["report_date", "class", "firm", "product", "reason", "status", "recall_number"],
         ((r["date"], r["class"], r["firm"], r["product"], r["reason"], r["status"], r.get("number"))
          for r in rc.get("list", [])))
    sh = p["fda"].get("shortages", {})
    _csv(d / "shortages.csv", ["drug", "therapeutic_categories", "company", "reason", "updated", "presentations"],
         ((r["name"], "|".join(r["cats"]), r["company"], r["reason"], r["updated"], r.get("presentations"))
          for r in sh.get("list", [])))


def write_embed(p: dict, out_dir: Path) -> None:
    url = p["meta"]["site"].get("public_url") or "https://YOUR-USERNAME.github.io/rx-pulse/"
    url = url.rstrip("/") + "/?embed=1"
    snippet = f"""<!-- Rx Pulse embed. Paste into a Code Block (Squarespace Core plan or higher),
     or any page that allows HTML + JavaScript. The iframe resizes itself to fit. -->
<div class="rxp-embed" style="width:100%;">
  <iframe id="rxp-frame" src="{url}" title="Rx Pulse pharmacy and health-tech dashboard"
          style="width:100%;height:1400px;border:0;display:block;" loading="lazy"></iframe>
</div>
<script>
  (function () {{
    var f = document.getElementById("rxp-frame");
    window.addEventListener("message", function (e) {{
      if (!e.data || e.data.type !== "rxpulse:height" || e.source !== f.contentWindow) return;
      f.style.height = Math.max(600, Math.ceil(e.data.height)) + "px";
    }});
  }})();
</script>
"""
    (out_dir / "embed-snippet.html").write_text(snippet, encoding="utf-8")


def write_snapshot(p: dict, hist_dir: Path) -> Path:
    """Compact daily record so the repo accumulates its own history over time."""
    hist_dir.mkdir(parents=True, exist_ok=True)
    day = p["meta"]["generated_at"][:10]
    snap = {
        "generated_at": p["meta"]["generated_at"],
        "tickers": {t["s"]: {k: t.get(k) for k in ("px", "chgp", "r1m", "rytd", "vr", "news")}
                    for t in p["tickers"] if not t.get("missing")},
        "macro": {k: {"last": m["last"], "last_date": m["last_date"], "yoy": m["yoy"]} for k, m in p["macro"].items()},
        "fda": {"shortage_drugs": p["fda"].get("shortages", {}).get("drugs"),
                "recalls_by_class": p["fda"].get("recalls", {}).get("by_class")},
        "top_news": [{k: n[k] for k in ("title", "url", "source", "score", "cats", "tickers")} for n in p["news"][:25]],
        "brief": p["brief"],
    }
    path = hist_dir / f"{day}.json"
    path.write_text(json.dumps(snap, indent=1, ensure_ascii=False), encoding="utf-8")
    return path
