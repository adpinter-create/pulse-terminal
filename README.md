# PulseNews

A self-updating, terminal-style markets and news dashboard built entirely on free sources. It covers global indices, Treasury yields, currencies, commodities, crypto, S&P sectors, Big Tech, freight and logistics, and the pharmacy and health-tech industry. News comes from about 25 publisher feeds and 24 topic searches across five desks (Markets, Tech, Supply chain, World and policy, Health and pharmacy), with a time-stamped headline wire and impact-ranked stories. Oil, fuel and drug-price trends come with correlation and lead-time analysis, plus FDA shortages and recalls and macro context. It refreshes every 15 minutes in market hours at no cost, and an open page updates itself without reloading.

Honest scope: it borrows the look, density and keyboard-driven navigation of a professional terminal. It does not have a terminal's licensed real-time data. Free quotes typically lag about 15 minutes, and the schedule adds up to 15 more.

## What's on the page

| Tab | What it answers |
|---|---|
| Overview | What happened today? A daily brief, 12 key numbers, a market monitor (indices, rates, FX, commodities, crypto), top stories beside a time-stamped headline wire, movers, segment performance, cost pass-through, FDA snapshot |
| Markets | How is each instrument doing? Spotlight charts for any of 90 instruments with peer and index comparison, a heatmap (sectors, Big Tech, logistics, pharmacy), a sortable watchlist, 52-week extremes, unusual volume, earnings dates |
| News | What matters most? Stories merged across outlets, filterable by desk, topic, outlet and time window, tagged by company, ranked by an explainable impact score |
| Costs and energy | How do oil and fuel flow into drug prices? Crude and fuel charts, a six-step pass-through chain, a correlation matrix with scatter plots, and lead-time tests |
| Supply and safety | What's short or recalled? FDA shortages by therapeutic area and weekly recalls by severity, both searchable |
| Macro | What's the backdrop? Inflation, rates, the yield curve, credit spreads, unemployment, freight and industrial output, pharmacy jobs |
| Sources | Is the data healthy? Status of every feed, methodology, and CSV downloads |

Keyboard: `/` search, `1`–`7` switch sections, arrow keys read chart values. Every view has a shareable link (for example `.../#markets/NVDA`).

**Command codes** (type in the search bar, press Enter): `TOP` all news, `WEI` market monitor, `MKT` markets, `IMAP` heatmap, `WL` watchlist, `ECO` macro, `CMDTY` or `OIL` costs and energy, `FDA` supply and safety, `SRC` data sources, and desk news with `FIN`, `TECH`, `SCM`, `WRLD`, `RX`. Typing a ticker or company name opens its chart.

**Themes:** Terminal (default), Dark, Light, Auto. The button in the header cycles them; each visitor's choice is remembered.

## How it works

```
GitHub Actions (every 15 min in market hours, every 3 hours otherwise)
  └─ build.py
       ├─ prices ........ yfinance → Stooq → Tiingo (first that works, per symbol)
       ├─ economic data . FRED (EIA oil and fuel, BLS producer and consumer prices, jobs, rates)
       ├─ headlines ..... Google News topic searches + publisher RSS feeds
       ├─ FDA ........... openFDA drug shortages and enforcement (recall) reports
       ├─ analytics ..... returns, segments, movers, correlations, lead times, briefing
       └─ render ........ docs/index.html + data/latest.json + CSVs
  └─ publish to GitHub Pages

Browser: loads index.html (data built in, so it paints instantly), then checks
data/meta.json every few minutes and swaps in new data when a build lands.
```

If a source fails, the page keeps its last good data and flags it on the Sources tab. A build that gets nothing from any core source refuses to publish, so a bad run never replaces a good page.

## Set up (about 15 minutes)

1. **Create a public repository** on GitHub named `pulse-terminal`, and upload every file in this folder (the web uploader's drag and drop works; keep the folder structure, including `.github/workflows`). Public repositories get unlimited free Actions minutes.
2. **Turn on Pages:** Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. **Add a free FRED key (recommended):** request one at https://fred.stlouisfed.org/docs/api/api_key.html, then Settings → Secrets and variables → Actions → New repository secret, named `FRED_API_KEY`. It works without a key, but the keyed API is more reliable. Optional secrets: `OPENFDA_API_KEY` (higher FDA limits, free at https://open.fda.gov/apis/authentication/) and `TIINGO_API_KEY` (a licensed backup for prices).
4. **Run it:** Actions tab → Refresh dashboard → Run workflow. The first run takes 3 to 5 minutes.
5. **Open it** at `https://YOUR-USERNAME.github.io/pulse-terminal/` and check the Sources tab. Anything red tells you which feed needs attention.

After that it runs on its own. A small history file is committed once a day after the market close, which builds a record over time and keeps GitHub from pausing the schedule (it disables schedules on repositories with no activity for 60 days).

## Use your own address

To serve it at `pulse.andreipinter.com`:

1. Settings → Pages → Custom domain: enter `pulse.andreipinter.com` and save.
2. At whoever manages DNS for andreipinter.com, add a **CNAME** record: host `pulse`, value `YOUR-USERNAME.github.io`.
3. Once GitHub shows the domain as verified (minutes to a few hours), tick **Enforce HTTPS**.
4. Set `public_url: "https://pulse.andreipinter.com"` in `config.yaml` so the embed snippet points at it.

A subdomain keeps the dashboard independent of where the main site lives: moving the main site off Squarespace later only means re-adding one DNS record at the new DNS host.

## Put it on your website

After a build, `embed-snippet.html` (at `https://YOUR-ADDRESS/embed-snippet.html`) holds a ready-to-paste block: an iframe that resizes itself to fit whichever tab is open.

- **Squarespace:** paste it into a Code Block. Squarespace only runs scripts and iframes in Code Blocks on certain plans (Core and above when this was written), so check yours. Without that, link to the dashboard from a button instead.
- **Any other site or static host:** paste the same snippet, or link to the page.
- **Do not** upload a copy of the built `docs/` folder to another host: a copy never refreshes. Keep the dashboard on Pages and embed or link it.

## Power BI and Excel

Every build publishes CSVs at fixed addresses. In Power BI Desktop: Get Data → Web → paste the address. Refresh works in the Power BI service with anonymous access.

| File | Contents |
|---|---|
| `data/csv/watchlist.csv` | One row per company: price, returns, 52-week range, volume ratio, headline count |
| `data/csv/prices_daily.csv` | Two years of daily closes, long format (date, symbol, close) |
| `data/csv/economic_series.csv` | All economic series, long format (date, key, FRED id, title, value) |
| `data/csv/headlines.csv` | Current stories with score, source, topics, companies |
| `data/csv/shortages.csv`, `recalls.csv` | FDA detail |
| `data/latest.json` | Everything, as the page uses it |

## Customize

Everything lives in `config.yaml`. Commit a change and the workflow rebuilds automatically.

- **Desks and feeds:** each entry under `news.feeds` and `news.google_news_queries` names its `desk`. Add any public RSS feed with a `name`, `url`, `desk` and optional `weight`. Feed addresses occasionally change; the Sources tab flags any that fail, so you know which to replace.
- **Hero tiles:** the `kpis` list sets the 12 headline numbers and their order (any ticker, a year-over-year economic series, FDA shortages, Class I recalls, or watchlist breadth).
- **Instrument groups:** segments with `kind: market` (indices, rates, FX, commodities, crypto, sectors) are excluded from movers; `monitor`, `heatmap` and `watchlist` flags choose where each group appears. Indices, futures, FX and crypto need an explicit `stooq` code for the backup price source.
- **Companies:** add a line under a segment with `symbol`, `name`, `note`, `weight` (heatmap tile size, 1 to 3) and `aliases` (names that link headlines to it, matched as whole words).
- **Economic series:** any FRED series ID works. List fallbacks in `ids` for series that get renamed.
- **Cost analysis:** `cost_chain` (the pass-through steps), `correlation_set`, `lead_lag_pairs`.
- **News:** `google_news_queries`, `feeds`, `categories` (keywords and sticker colors), `impact_terms`, `source_weights`.
- **Schedule:** edit the `cron` lines in `.github/workflows/refresh.yml` (times are UTC), then update `refresh_note` in `config.yaml` to match.

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python build.py --demo                  # synthetic data, no network: layout preview
python build.py                         # live data
python -m http.server -d docs 8000      # then open http://localhost:8000
pip install pytest && python -m pytest -q
```

## Limits and fine print

- **Prices are unofficial.** yfinance and Stooq are free, unofficial sources whose terms limit commercial use and redistribution. They suit a personal, non-commercial project. For anything more, use a licensed feed (Tiingo is already wired in as a fallback).
- **"Live" means roughly 15 to 30 minutes behind.** GitHub starts scheduled runs late when its runners are busy, and free quotes can themselves be delayed.
- **Headlines link out.** The page shows each outlet's headline and short summary with a link to the original; it does not reproduce articles.
- **Economic data lags.** Price indexes are monthly and arrive two to six weeks after the month ends. Each figure shows its as-of date.
- **Correlation is not causation.** The cost analysis measures co-movement of year-over-year changes; shared inflation cycles can drive both sides.
- **Not investment advice.**

## Files

```
config.yaml               what to track (edit this)
build.py                  entry point
rxpulse/                  markets, fred, news, fda (fetchers); analytics; render; demo; util
web/                      index.html shell, app.css, app.js, fonts (Archivo, SIL Open Font License)
tests/                    offline tests (no network needed)
.github/workflows/        the schedule and the Pages deploy
data/history/             daily snapshots (committed by the workflow)
```
