/* Rx Pulse front end. No dependencies. Renders from the JSON snapshot inlined in
   the page, then polls data/meta.json and swaps in fresh data when a new build lands. */
(() => {
  "use strict";

  // ── Environment ─────────────────────────────────────────────────────────────
  let D = JSON.parse(document.getElementById("rxp-data").textContent);
  const SITE = D.meta.site || {};
  const TZ = SITE.timezone || "America/Chicago";
  const params = new URLSearchParams(location.search);
  const EMBED = params.has("embed");
  if (EMBED) document.documentElement.classList.add("is-embed");
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const app = document.getElementById("app");
  const $ = (s, r = app) => r.querySelector(s);
  const $$ = (s, r = app) => [...r.querySelectorAll(s)];

  const store = {
    get(k, d) { try { const v = localStorage.getItem("rxp:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("rxp:" + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const TABS = [
    { id: "overview", name: "Overview" }, { id: "markets", name: "Markets" }, { id: "news", name: "News" },
    { id: "costs", name: "Costs and energy" }, { id: "supply", name: "Supply and safety" },
    { id: "macro", name: "Macro" }, { id: "sources", name: "Sources" },
  ];

  const S = {
    tab: "overview", spot: null, range: "6M", cmp: new Set(), mover: "up", heat: "chgp",
    wlSort: { k: "seg", dir: 1 }, wlSeg: "all", wlQ: "",
    nf: { desk: "all", cats: new Set(), src: "all", linked: false, q: "", sort: "score", hours: 72, limit: 40 },
    energy: { keys: new Set(["wti", "brent"]), range: "1Y", rebase: false },
    yoyKeys: new Set(["cpi_rx", "ppi_pharma", "ppi_rx_retail", "cpi_all"]),
    corr: null, ll: 0, sup: { cat: null, q: "", cls: "all", rq: "" },
    stars: new Set(store.get("stars", [])),
  };

  let TK, NEWS_BY_T, CAT;
  function index() {
    TK = new Map(D.tickers.map(t => [t.s, t]));
    CAT = new Map(D.newscats.map(c => [c.id, c]));
    NEWS_BY_T = new Map();
    for (const n of D.news) for (const s of n.tickers || []) {
      if (!NEWS_BY_T.has(s)) NEWS_BY_T.set(s, []);
      NEWS_BY_T.get(s).push(n);
    }
  }
  index();

  // ── Formatting ──────────────────────────────────────────────────────────────
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const href = u => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
  const NF = [0, 1, 2, 3, 4].map(d => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const MINUS = "\u2212";
  const ok = v => v != null && isFinite(v);
  const num = (v, d = 2) => (ok(v) ? (v < 0 ? MINUS : "") + NF[d].format(Math.abs(v)) : "–");
  function sgn(v, d = 2, suf = "%") {
    if (!ok(v)) return "–";
    const r = Math.abs(v) < 0.5 * 10 ** -d ? 0 : v;
    return (r > 0 ? "+" : r < 0 ? MINUS : "") + NF[d].format(Math.abs(r)) + suf;
  }
  function fmt(v, f) {
    if (!ok(v)) return "–";
    const a = Math.abs(v), neg = v < 0 ? MINUS : "";
    switch (f) {
      case "usd": return neg + "$" + NF[a < 1 ? 3 : 2].format(a);
      case "usd3": return neg + "$" + NF[3].format(a);
      case "pct": return num(v, 2) + "%";
      case "pctchg": return sgn(v, 1);
      case "idx": return num(v, 1);
      case "musd": return a >= 1000 ? neg + "$" + NF[1].format(a / 1000) + "B" : neg + "$" + NF[0].format(a) + "M";
      case "k": return num(v, 1) + "K";
      case "yield": return num(v, 3) + "%";
      case "fx": return num(v, a >= 20 ? 2 : 4);
      case "int": return num(v, 0);
      default: return num(v, 2);
    }
  }
  function pxDigits(t, v = t.px) {
    switch (t.unit) {
      case "$/gal": return 4;
      case "$/MMBtu": case "$/lb": case "%": return 3;
      case "fx": return ok(v) && Math.abs(v) >= 20 ? 2 : 4;
      default: return 2;
    }
  }
  const isYield = t => t.unit === "%";
  /* Change text for any instrument: basis points for yields, percent otherwise */
  const chgText = (t, d = 2) => (isYield(t) ? (ok(t.chg) ? sgn(t.chg * 100, 0, "") + " bp" : "–") : sgn(t.chgp, d));
  const chgTone = t => tone(isYield(t) ? t.chg : t.chgp, t.s === "^VIX" ? "inverse" : "market");
  const fmtPx = (t, v = t.px) => (ok(v) ? NF[pxDigits(t, v)].format(v) + (isYield(t) ? "%" : "") : "–");
  const tone = (v, kind = "market") => (!ok(v) || Math.abs(v) < 0.005 ? "flat" : kind === "cost" ? (v > 0 ? "cost-up" : "cost-down") : kind === "inverse" ? (v > 0 ? "down" : "up") : v > 0 ? "up" : "down");
  const arrow = v => (!ok(v) || Math.abs(v) < 0.005 ? "" : v > 0 ? "▲" : "▼");
  const label = t => t.short || t.s;

  const dtf = o => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...o });
  const F = {
    dayTime: dtf({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    long: dtf({ weekday: "long", month: "long", day: "numeric" }),
    hm: dtf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    full: dtf({ weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
  };
  const U = o => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o });
  const FU = { day: U({ month: "short", day: "numeric" }), dayY: U({ month: "short", day: "numeric", year: "numeric" }),
    mon: U({ month: "short" }), monY: U({ month: "short", year: "numeric" }) };
  const tzAbbr = () => { try { return dtf({ timeZoneName: "short" }).formatToParts(new Date()).find(p => p.type === "timeZoneName").value; } catch (e) { return ""; } };
  const dms = s => Date.parse(s.length === 10 ? s + "T00:00:00Z" : s);
  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) { const h = Math.round(s / 3600); return h + (h === 1 ? " hr ago" : " hrs ago"); }
    const d = Math.round(s / 86400); return d + (d === 1 ? " day ago" : " days ago");
  }
  const asOf = (d, freq) => (freq === "monthly" ? FU.monY : FU.dayY).format(dms(d));

  // ── Chart engine ────────────────────────────────────────────────────────────
  const RO = new ResizeObserver(entries => {
    for (const e of entries) {
      const c = e.target.__c;
      if (c && e.contentRect.width > 0 && Math.abs(e.contentRect.width - c.w) > 2) c.draw();
    }
  });
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const palette = () => [cssv("--amber"), cssv("--teal"), cssv("--ink-2"), "#7b61c4", cssv("--down"), "#3f7fc4", "#7a9a2e"];

  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function ticks(a, b, n) {
    const st = niceStep((b - a) / Math.max(1, n)), out = [];
    for (let v = Math.ceil(a / st) * st; v <= b + st * 1e-9; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v);
    out.step = st;
    return out;
  }
  function tickFmt(v, f, step) {
    const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
    if (f === "usd" || f === "usd3") return (v < 0 ? MINUS : "") + "$" + NF[d].format(Math.abs(v));
    if (f === "pct") return num(v, d) + "%";
    if (f === "pctchg") return sgn(v, d);
    if (f === "musd") return "$" + NF[1].format(v / 1000) + "B";
    return num(v, d);
  }
  function timeTicks(t0, t1, n) {
    const day = 864e5, span = (t1 - t0) / day, out = [], d = new Date(t0);
    if (span <= 62) {
      const step = Math.max(1, Math.ceil(span / n));
      for (let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); t <= t1; t += step * day) out.push([t, FU.day.format(t)]);
    } else if (span <= 3 * 366) {
      const months = span / 30.4, step = [1, 2, 3, 4, 6, 12].find(s => months / s <= n) || 12;
      let m = d.getUTCMonth() + 1;
      while (m % step) m++;
      for (;;) {
        const yy = d.getUTCFullYear() + Math.floor(m / 12), mm = m % 12, t = Date.UTC(yy, mm, 1);
        if (t > t1) break;
        out.push([t, mm === 0 ? String(yy) : FU.mon.format(t)]);
        m += step;
      }
    } else {
      const step = Math.max(1, Math.ceil(span / 365.25 / n));
      for (let y = d.getUTCFullYear() + 1; ; y += step) { const t = Date.UTC(y, 0, 1); if (t > t1) break; out.push([t, String(y)]); }
    }
    return out;
  }
  function nearest(arr, t) {
    let lo = 0, hi = arr.length - 1;
    if (hi < 0) return -1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid; else hi = mid; }
    return Math.abs(arr[lo] - t) <= Math.abs(arr[hi] - t) ? lo : hi;
  }
  function nearestValid(s, t) {
    const i = nearest(s.t, t);
    if (i < 0) return -1;
    for (let k = 0; k < s.t.length; k++) {
      if (i - k >= 0 && s.v[i - k] != null) return i - k;
      if (i + k < s.t.length && s.v[i + k] != null) return i + k;
    }
    return -1;
  }

  /* series: [{name, t:[ms], v:[num|null], color?, fmt?, width?, dash?}] */
  function lineChart(host, o) {
    host.classList.add("chart");
    const c = { w: 0, draw };
    host.__c = c;
    RO.observe(host);
    draw();
    return c;

    function draw() {
      const W = Math.round(host.clientWidth);
      if (!W) return;
      c.w = W;
      const H = o.height || 240;
      const M = { l: 4, r: o.noAxis ? 4 : 50, t: 12, b: 24 };
      let ser = o.series.filter(s => s && s.t && s.t.length && s.v.some(x => x != null));
      if (o.rebase) ser = ser.map(s => {
        const b = s.v.find(x => x != null);
        return { ...s, v: s.v.map(x => (x == null || !b ? null : (x / b) * 100)) };
      });
      let t0 = Infinity, t1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const s of ser) for (let i = 0; i < s.t.length; i++) {
        const v = s.v[i];
        if (v == null) continue;
        if (s.t[i] < t0) t0 = s.t[i];
        if (s.t[i] > t1) t1 = s.t[i];
        if (v < y0) y0 = v;
        if (v > y1) y1 = v;
      }
      if (!isFinite(y0) || t1 <= t0) { host.innerHTML = `<p class="empty">No data in this range.</p>`; return; }
      if (o.zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
      const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.05 || 1;
      y0 -= pad; y1 += pad;
      const iw = W - M.l - M.r, ih = H - M.t - M.b;
      const X = t => M.l + ((t - t0) / (t1 - t0)) * iw;
      const Y = v => M.t + (1 - (v - y0) / (y1 - y0)) * ih;
      const yf = o.rebase ? "idx" : o.fmt || ser[0].fmt || "num";
      const yt = ticks(y0, y1, Math.max(3, Math.round(ih / 48)));
      let g = "";
      for (const v of yt) {
        g += `<line class="gl" x1="${M.l}" x2="${M.l + iw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
        if (!o.noAxis) g += `<text class="ax" x="${W - M.r + 8}" y="${(Y(v) + 4).toFixed(1)}">${tickFmt(v, yf, yt.step)}</text>`;
      }
      const base = o.rebase ? 100 : o.zero ? 0 : null;
      if (base != null && y0 < base && y1 > base) g += `<line class="zl" x1="${M.l}" x2="${M.l + iw}" y1="${Y(base).toFixed(1)}" y2="${Y(base).toFixed(1)}"/>`;
      for (const [t, lab] of timeTicks(t0, t1, Math.max(3, Math.floor(iw / 80)))) {
        const x = X(t);
        if (x < M.l + 14 || x > M.l + iw - 14) continue;
        g += `<text class="ax" x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
      }
      const pal = palette();
      ser.forEach((s, k) => { s.col = s.color || pal[k % pal.length]; });
      let paths = "";
      ser.forEach((s, k) => {
        let d = "", first = null, last = null;
        for (let i = 0; i < s.t.length; i++) {
          if (s.v[i] == null) continue;
          const x = X(s.t[i]).toFixed(1), y = Y(s.v[i]).toFixed(1);
          d += (d ? "L" : "M") + x + " " + y;
          if (!first) first = [x, y];
          last = [x, y];
        }
        if (o.area && k === 0 && first) paths += `<path d="${d}L${last[0]} ${M.t + ih}L${first[0]} ${M.t + ih}Z" fill="${s.col}" opacity=".1"/>`;
        paths += `<path d="${d}" fill="none" stroke="${s.col}" stroke-width="${s.width || 1.8}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
      });
      const legend = o.legend && ser.length > 1 ? `<div class="legend" style="margin-top:6px">${ser.map(s => `<span><i class="sw" style="background:${s.col};height:3px;vertical-align:3px"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
      host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" tabindex="0" aria-label="${esc(o.label || "Chart")}. Arrow keys read values.">${g}${paths}<g class="hov" style="display:none"><line class="xh" y1="${M.t}" y2="${M.t + ih}"/>${ser.map(s => `<circle r="3.5" fill="${s.col}" stroke="${cssv("--stock")}" stroke-width="1.5"/>`).join("")}</g></svg>${legend}<div class="ctip" hidden></div>`;

      const svg = host.querySelector("svg"), hov = svg.querySelector(".hov"), xh = hov.firstElementChild;
      const dots = [...hov.querySelectorAll("circle")], tip = host.querySelector(".ctip");
      const primary = ser.reduce((a, b) => (b.t.length > a.t.length ? b : a));
      const dfmt = o.monthly ? FU.monY : FU.dayY;
      let cur = -1;
      const show = i => {
        if (i < 0) { hov.style.display = "none"; tip.hidden = true; cur = -1; return; }
        cur = i;
        const t = primary.t[i], x = X(t);
        hov.style.display = "";
        xh.setAttribute("x1", x); xh.setAttribute("x2", x);
        let rows = "";
        ser.forEach((s, k) => {
          const j = nearestValid(s, t);
          if (j < 0 || Math.abs(s.t[j] - t) > 40 * 864e5) { dots[k].style.display = "none"; return; }
          dots[k].style.display = "";
          dots[k].setAttribute("cx", X(s.t[j])); dots[k].setAttribute("cy", Y(s.v[j]));
          const f = o.rebase ? "idx" : s.fmt || yf;
          rows += `<div><i style="background:${s.col}"></i>${esc(s.name)}<strong>${f === "pctchg" ? sgn(s.v[j], 1) : fmt(s.v[j], f)}</strong></div>`;
        });
        tip.innerHTML = `<b>${dfmt.format(t)}</b>${rows}`;
        tip.hidden = false;
        const tw = tip.offsetWidth;
        let left = x + 14;
        if (left + tw > W) left = x - tw - 14;
        tip.style.left = Math.max(0, left) + "px";
        tip.style.top = M.t + "px";
      };
      svg.addEventListener("pointermove", e => {
        const r = svg.getBoundingClientRect();
        const x = ((e.clientX - r.left) * W) / r.width;
        if (x < M.l || x > M.l + iw) return show(-1);
        show(nearestValid(primary, t0 + ((x - M.l) / iw) * (t1 - t0)));
      });
      svg.addEventListener("pointerleave", () => show(-1));
      svg.addEventListener("blur", () => show(-1));
      svg.addEventListener("keydown", e => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        let i = cur < 0 ? primary.t.length : cur;
        do { i += e.key === "ArrowRight" ? 1 : -1; } while (i >= 0 && i < primary.t.length && primary.v[i] == null);
        if (i >= 0 && i < primary.t.length) show(i);
      });
    }
  }

  function spark(vals, { w = 84, h = 24, fluid = false, kind = "market" } = {}) {
    const v = (vals || []).filter(x => x != null);
    if (v.length < 2) return "";
    if (fluid) {
      let mn = Math.min(...v), mx = Math.max(...v);
      if (mx === mn) { mx += 1; mn -= 1; }
      const pts = v.map((x, i) => `${((i / (v.length - 1)) * 100).toFixed(2)},${((1 - (x - mn) / (mx - mn)) * (h - 4) + 2).toFixed(2)}`).join(" ");
      return `<svg class="spark ${tone(v[v.length - 1] - v[0], kind)}" viewBox="0 0 100 ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
    }
    let mn = Math.min(...v), mx = Math.max(...v);
    if (mx === mn) { mx += 1; mn -= 1; }
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * (w - 4) + 2).toFixed(1)},${((1 - (x - mn) / (mx - mn)) * (h - 6) + 3).toFixed(1)}`);
    const [lx, ly] = pts[pts.length - 1].split(",");
    return `<svg class="spark ${tone(v[v.length - 1] - v[0])}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx}" cy="${ly}" r="2.2" fill="currentColor"/></svg>`;
  }

  /* Generic SVG drawn to container width, redrawn on resize */
  function svgBox(host, height, paint) {
    host.classList.add("chart");
    const c = { w: 0, draw() { const W = Math.round(host.clientWidth); if (!W) return; c.w = W; host.innerHTML = paint(W, height); } };
    host.__c = c;
    RO.observe(host);
    c.draw();
  }

  function mix(rgbA, rgbB, t) { return rgbA.map((a, i) => Math.round(a + (rgbB[i] - a) * t)); }
  function divColor(v, lim, pos = [12, 122, 76], negc = [184, 50, 42]) {
    const neu = cssv("--heat-neu").split(",").map(Number);
    if (!ok(v)) return { bg: `rgb(${neu})`, fg: "var(--ink-3)" };
    const t = Math.max(-1, Math.min(1, v / lim));
    const a = Math.pow(Math.abs(t), 0.75);
    return { bg: `rgb(${mix(neu, t >= 0 ? pos : negc, a)})`, fg: a > 0.55 ? "#fff" : "var(--ink)" };
  }

  // Global tooltip for bar charts
  function gtip(e, html) {
    const g = $("#gtip");
    if (!html) { g.hidden = true; return; }
    g.innerHTML = html;
    g.hidden = false;
    const w = g.offsetWidth;
    g.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 14) + "px";
    g.style.top = e.clientY + 14 + "px";
  }

  // ── Shell ───────────────────────────────────────────────────────────────────
  function shell() {
    app.innerHTML = `
      <div class="tape" id="tape" role="region" aria-label="Watchlist prices"></div>
      <div class="wrap">
        <header class="head">
          <a class="brand" href="#overview" data-act="tab" data-tab="overview"><span class="brand-mark"><span class="rx" aria-hidden="true">R<i>x</i></span></span><span class="brand-txt"><strong>${esc(SITE.title)}</strong><span class="brand-sub">${esc(SITE.subtitle)}</span></span></a>
          <div class="search" role="search">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 11l3.6 3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            <input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Search, or type a command: TOP, WEI, ECO, TECH, SCM" aria-label="Search markets and headlines, or type a command" aria-controls="q-results" aria-expanded="false">
            <kbd aria-hidden="true">/</kbd>
            <div class="q-results" id="q-results" hidden></div>
          </div>
          <div class="status" id="status"></div>
        </header>
        <div id="banner"></div>
        <section class="hero" aria-label="Daily brief and key indicators"><article class="label" id="label"></article><div class="kpis" id="kpis"></div></section>
      </div>
      <div class="tabs-bar"><div class="wrap"><nav class="tabs" role="tablist" id="tabs" aria-label="Dashboard sections">${TABS.map(t => `<button class="tab" role="tab" id="t-${t.id}" aria-controls="p-${t.id}" aria-selected="false" tabindex="-1" data-act="tab" data-tab="${t.id}">${t.name}<span class="n" id="tn-${t.id}"></span></button>`).join("")}</nav></div></div>
      <main class="wrap">${TABS.map(t => `<section class="panel" id="p-${t.id}" role="tabpanel" aria-labelledby="t-${t.id}" tabindex="-1" hidden></section>`).join("")}</main>
      <footer class="wrap"><div class="foot" id="foot"></div></footer>
      <div class="gtip" id="gtip" hidden></div>
      <div class="sr" aria-live="polite" id="live"></div>`;
  }

  function healthSummary() {
    const h = D.health || [];
    const good = h.filter(x => x.status === "ok").length;
    const bad = h.some(x => x.status === "error"), stale = h.some(x => x.status === "stale");
    return { good, total: h.length, cls: bad ? "bad" : stale ? "warn" : "ok" };
  }
  function marketStatus() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const m = +p.hour * 60 + +p.minute;
    if (p.weekday === "Sat" || p.weekday === "Sun") return { k: "closed", t: "Market closed" };
    if (m >= 570 && m < 960) return { k: "open", t: "Market open" };
    if (m >= 240 && m < 570) return { k: "pre", t: "Pre-market" };
    if (m >= 960 && m < 1200) return { k: "post", t: "After hours" };
    return { k: "closed", t: "Market closed" };
  }
  const themeLabel = () => ({ auto: "Auto", light: "Light", dark: "Dark", terminal: "Terminal" }[document.documentElement.dataset.theme] || "Auto");

  function renderStatus() {
    const ms = marketStatus(), h = healthSummary();
    const age = (Date.now() - Date.parse(D.meta.generated_at)) / 60000;
    const fresh = age < 120 ? "ok" : age < 60 * 20 ? "warn" : "bad";
    $("#status").innerHTML = `
      <span class="chip hide-s" title="US stock market hours (Eastern). Market holidays are not reflected."><span class="dot ${ms.k === "open" ? "ok" + (REDUCED ? "" : " live") : ms.k === "closed" ? "" : "warn"}"></span>${ms.t}</span>
      <span class="chip" title="Data built ${esc(F.full.format(new Date(D.meta.generated_at)))}"><span class="dot ${fresh}"></span>Updated&nbsp;<time data-ago="${D.meta.generated_at}">${ago(D.meta.generated_at)}</time></span>
      <button class="chip hide-s" data-act="tab" data-tab="sources" title="Source health"><span class="dot ${h.cls}"></span>${h.good} of ${h.total} sources</button>
      <button class="chip" data-act="theme" aria-label="Color theme: ${themeLabel()}. Click to change."><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/></svg>${themeLabel()}</button>`;
  }

  function renderBanner() {
    const age = (Date.now() - Date.parse(D.meta.generated_at)) / 36e5;
    let html = "";
    if (D.meta.demo) html = `<div class="banner" role="note"><strong>Preview with synthetic sample data.</strong> Prices, headlines, economic series and FDA entries on this page are illustrative only. The first scheduled run replaces all of it with live data.</div>`;
    else if (age > 30) html = `<div class="banner" role="alert"><strong>Data is ${Math.round(age)} hours old.</strong> The scheduled refresh may be failing. The Sources tab shows which feeds are affected.</div>`;
    $("#banner").innerHTML = html;
  }

  function renderTape() {
    const star = [...S.stars].map(s => TK.get(s)).filter(Boolean);
    const rest = D.tickers.filter(t => !t.missing && !S.stars.has(t.s));
    const list = star.concat(rest).filter(t => !t.missing && ok(t.px));
    const item = (t, dup) => `<button class="tp" data-act="spot" data-s="${esc(t.s)}"${dup ? ' tabindex="-1"' : ""}><b>${esc(label(t))}</b><span data-px="${esc(t.s)}">${fmtPx(t)}</span><span class="${chgTone(t)}">${arrow(isYield(t) ? t.chg : t.chgp)} ${chgText(t)}</span></button>`;
    $("#tape").innerHTML = `<div class="tape-track" style="--dur:${Math.max(40, list.length * 2.6)}s">${list.map(t => item(t)).join("")}<span class="dup" aria-hidden="true" style="display:inline-flex">${list.map(t => item(t, true)).join("")}</span></div>`;
  }

  function renderLabel() {
    const g = new Date(D.meta.generated_at), h = healthSummary();
    $("#label").innerHTML = `
      <div class="lb-top">
        <div class="lb-pharm"><span class="lb-mark"><span class="rx" aria-hidden="true">R<i>x</i></span></span><div><strong>${esc(SITE.title)} daily brief</strong><span class="lb-sub">${esc(SITE.subtitle)}</span></div></div>
        <dl class="lb-meta"><div><dt>Rx#</dt><dd>${esc(D.meta.build_id)}</dd></div><div><dt>Filled</dt><dd>${esc(F.dayTime.format(g))} ${esc(tzAbbr())}</dd></div></dl>
      </div>
      <h1 class="lb-drug">${esc(F.long.format(g))}</h1>
      <div class="lb-sig"><span class="lb-sig-k">Sig:</span><ul>${D.brief.map(s => `<li>${esc(s)}</li>`).join("")}</ul></div>
      <dl class="lb-foot">
        <div><dt>Qty</dt><dd>${D.news.length} stories</dd></div>
        <div><dt>Refills</dt><dd>${esc(SITE.refresh_note || "Scheduled")}</dd></div>
        <div><dt>Sources</dt><dd>${h.good} of ${h.total} healthy</dd></div>
        <div><dt>Compiled by</dt><dd>${esc(SITE.author || "")}</dd></div>
      </dl>
      <div class="aux">Not investment advice. Quotes may be delayed.</div>`;
  }

  function kpiValue(k) {
    if (k.fmt === "breadth") return `${k.value}<small> up</small> ${k.value2}<small> down</small>`;
    if (k.fmt === "pctchg") return sgn(k.value, 1);
    return fmt(k.value, k.fmt);
  }
  function renderKpis() {
    $("#kpis").innerHTML = D.kpis.map(k => {
      let extra = "";
      if (k.fmt === "breadth") {
        const tot = (k.value + k.value2) || 1;
        extra = `<span class="breadth" aria-hidden="true"><i style="width:${(k.value / tot) * 100}%"></i><i style="width:${(k.value2 / tot) * 100}%"></i></span>`;
      }
      const ch = ok(k.chg) ? `<span class="pill ${tone(k.chg, k.tone)}">${arrow(k.chg)} ${k.chg_fmt === "pts" ? sgn(k.chg, 2, "") + " pts" : k.chg_fmt === "bp" ? sgn(k.chg, 0, "") + " bp" : sgn(k.chg)}</span><span class="muted">${esc(k.chg_label || "")}</span>` : k.note ? `<span class="muted">${esc(k.note)}</span>` : "";
      const vis = k.spark ? spark(k.spark, { h: 30, fluid: true, kind: k.tone === "cost" || k.tone === "inverse" ? k.tone : "market" }) : k.bars ? `<span class="minibars" aria-hidden="true">${k.bars.map(b => `<i style="height:${Math.max(2, (b / Math.max(...k.bars, 1)) * 28)}px"></i>`).join("")}</span>` : "";
      const asof = k.asof ? `, ${asOf(k.asof, k.fmt === "pctchg" ? "monthly" : "weekly")}` : "";
      return `<button class="kpi" data-act="goto" data-tab="${k.tab}"${k.ticker ? ` data-s="${esc(k.ticker)}"` : ""}>
        <span class="kpi-l">${esc(k.label)}</span><span class="kpi-s">${esc((k.sub || "") + asof)}</span>
        <span class="kpi-vis">${vis}</span><span class="kpi-v">${kpiValue(k)}</span>${extra}<span class="kpi-c">${ch}</span></button>`;
    }).join("");
  }

  function renderTabCounts() {
    $("#tn-news").textContent = D.news.length;
    const bad = (D.health || []).filter(h => h.status !== "ok").length;
    $("#tn-sources").textContent = bad ? `${bad} issue${bad > 1 ? "s" : ""}` : "";
  }

  function renderFoot() {
    $("#foot").innerHTML = `
      <span>Data: Yahoo Finance and Stooq (prices, typically delayed), FRED (BLS, EIA, Federal Reserve), openFDA, Google News and ${(D.health || []).filter(h => h.group === "News").length || "publisher"} news feeds. Not investment advice.</span>
      <span>Build ${esc(D.meta.build_id)}, version ${esc(D.meta.version || "")}. Keys: <b>/</b> search or command (TOP, WEI, ECO, TECH, SCM, RX), <b>1</b>–<b>7</b> sections. Compiled by ${esc(SITE.author || "")}.</span>`;
  }

  // ── Shared pieces ───────────────────────────────────────────────────────────
  function sticker(id) {
    const c = CAT.get(id) || { name: id, color: "#e3e8ec" };
    return `<span class="stk" style="--c:${esc(c.color)}">${esc(c.name)}</span>`;
  }
  function tkBadge(s) {
    const t = TK.get(s);
    if (!t) return "";
    return `<button class="tkb" data-act="spot" data-s="${esc(s)}" title="${esc(t.n)}">${esc(label(t))}<span class="${tone(t.chgp)}">${sgn(t.chgp, 1)}</span></button>`;
  }
  function storyRow(n, { full = false } = {}) {
    const also = n.sources > 1 ? `<span>+${n.sources - 1} outlet${n.sources > 2 ? "s" : ""}</span>` : "";
    return `<li class="story">
      <div class="story-top">${n.cats.map(sticker).join("")}<span class="impact" title="Impact score ${n.score} of 100: outlet count, source weight, recency, topic and market linkage"><i style="--v:${n.score}"></i>${n.score}</span></div>
      <a class="story-t" href="${href(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
      <div class="story-m">${n.desk ? `<span class="wd" title="${esc(deskName(n.desk))}">${esc(DESK_ABBR[n.desk] || "")}</span>` : ""}<span class="src">${esc(n.source)}</span><time data-ago="${esc(n.published)}" title="${esc(F.full.format(new Date(n.published)))}">${ago(n.published)}</time>${also}${(n.tickers || []).slice(0, 5).map(tkBadge).join("")}</div>
      ${full && n.summary ? `<p class="story-s">${esc(n.summary)}</p>` : ""}
      ${full && n.also && n.also.length ? `<details class="story-also"><summary>Also covered by ${n.also.length}</summary><ul>${n.also.map(a => `<li><a href="${href(a.url)}" target="_blank" rel="noopener">${esc(a.source)}</a>: ${esc(a.title)}</li>`).join("")}</ul></details>` : ""}
    </li>`;
  }
  const segBtns = (items, cur, act, aria) => `<div class="seg" role="group" aria-label="${esc(aria)}">${items.map(([k, l]) => `<button data-act="${act}" data-k="${esc(k)}" aria-pressed="${k === cur}">${esc(l)}</button>`).join("")}</div>`;
  const card = (title, body, { sub = "", tools = "", cls = "", id = "" } = {}) => /* id lands on the section */
    `<section class="card ${cls}"${id ? ` id="${id}"` : ""}><header class="card-h"><h2>${title}</h2>${sub ? `<span class="sub">${sub}</span>` : ""}${tools}</header>${body}</section>`;

  function earningsList(n) {
    const rows = (D.earnings || []).slice(0, n);
    if (!rows.length) return `<p class="empty">No confirmed earnings dates in the next 45 days.</p>`;
    const today = Date.parse(D.meta.generated_at);
    return `<ul class="earn">${rows.map(e => {
      const days = Math.max(0, Math.round((dms(e.date) - today) / 864e5));
      return `<li><span class="d">${FU.day.format(dms(e.date))}</span><button data-act="spot" data-s="${esc(e.symbol)}"><b>${esc(e.symbol)}</b></button><span>${esc(e.name)}</span><span class="muted">${days === 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days"}</span></li>`;
    }).join("")}</ul>`;
  }

  // ── Overview ────────────────────────────────────────────────────────────────
  function renderOverview(el) {
    const sh = D.fda.shortages, rc = D.fda.recalls;
    const c = rc ? rc.by_class : {};
    const tot = rc ? Math.max(1, rc.total) : 1;
    el.innerHTML = `
      ${card("Market monitor", monitor(), { sub: "select any row for its chart", id: "mon" })}
      <div class="grid g-ov-a">
        ${card("Top stories", `<ol class="stories">${D.news.slice(0, 8).map(n => storyRow(n)).join("") || `<li class="empty">No stories in the last 72 hours.</li>`}</ol>`, { sub: "ranked by impact", tools: `<button class="link" data-act="tab" data-tab="news">All ${D.news.length} stories</button>` })}
        ${card("Headline wire", wire(16), { sub: "newest first, all desks", tools: `<button class="link" data-act="tab" data-tab="news">All news</button>` })}
      </div>
      <div class="grid g-ov-b">
        ${card("Market movers", `<div id="ov-movers"></div>`, { tools: segBtns([["up", "Gainers"], ["down", "Decliners"], ["volume", "Volume"]], S.mover, "mover", "Mover type") })}
        ${card("Segments today", segBars() + `<p class="note">Equal-weighted average of each group's daily move. Select a segment to filter the watchlist.</p>`)}
        ${card("Cost pass-through", `<ol class="chain">${D.costs.chain.map(k => `<li><span class="t">${esc(k.short || k.title)}<small>year over year, ${esc(asOf(k.last_date, k.freq))}</small></span><span class="pill ${tone(k.yoy, "cost")}">${sgn(k.yoy, 1)}</span></li>`).join("")}</ol><button class="link" data-act="tab" data-tab="costs">Correlations and lead times</button>`, { sub: "crude to the counter" })}
        ${card("Supply and safety", `
          <div class="grid g-2" style="gap:10px">
            <div><div class="big-n">${sh ? sh.drugs : "–"}</div><div class="muted">drugs in shortage</div></div>
            <div><div class="big-n">${rc ? rc.total : "–"}</div><div class="muted">recalls, ${rc ? rc.lookback_days : 30} days</div></div>
          </div>
          ${rc ? `<div class="stack" role="img" aria-label="Recalls by class"><i class="c1" style="width:${((c["Class I"] || 0) / tot) * 100}%"></i><i class="c2" style="width:${((c["Class II"] || 0) / tot) * 100}%"></i><i class="c3" style="width:${((c["Class III"] || 0) / tot) * 100}%"></i></div>
          <div class="legend"><span><i class="sw c1"></i>Class I ${c["Class I"] || 0}</span><span><i class="sw c2"></i>Class II ${c["Class II"] || 0}</span><span><i class="sw c3"></i>Class III ${c["Class III"] || 0}</span></div>` : ""}
          <p style="margin-top:10px"><button class="link" data-act="tab" data-tab="supply">Shortage and recall detail</button></p>`)}
      </div>`;
    renderMovers();
    $("#ov-movers").insertAdjacentHTML("afterend", `<p class="note">Lines show the last 40 trading days.</p>`);
  }
  const DESK_ABBR = { markets: "MKT", tech: "TECH", supply: "SCM", world: "WRLD", health: "HLTH" };
  const deskName = id => ((D.desks || []).find(d => d.id === id) || { name: id }).name;
  function histAgo(sym, n) {
    const v = (D.hist.series[sym] || []).filter(x => x != null);
    return v.length > n ? v[v.length - 1 - n] : null;
  }
  function ytdBase(sym) {
    const H = D.hist, v = H.series[sym] || [], y = H.dates.length ? H.dates[H.dates.length - 1].slice(0, 4) : "";
    for (let i = H.dates.length - 1; i >= 0; i--) if (H.dates[i] < y && v[i] != null) return v[i];
    return null;
  }
  function periodCell(t, base) {
    if (!ok(base) || !ok(t.px)) return `<td class="flat">–</td>`;
    if (isYield(t)) { const bp = (t.px - base) * 100; return `<td class="${tone(bp)}">${sgn(bp, 0, "")}</td>`; }
    const p = (t.px / base - 1) * 100;
    return `<td class="${tone(p, t.s === "^VIX" ? "inverse" : "market")}">${sgn(p, 1)}</td>`;
  }
  function monitor() {
    const segs = D.segments.filter(s => s.monitor);
    if (!segs.length) return `<p class="empty">No market monitor groups are configured.</p>`;
    return `<div class="mon">${segs.map(sg => {
      const ts = D.tickers.filter(t => t.seg === sg.id && !t.missing);
      if (!ts.length) return "";
      return `<div class="tbl-wrap"><table class="mon-t"><thead><tr><th class="l">${esc(sg.name)}</th><th>Last</th><th>Chg</th><th>1M</th><th>YTD</th></tr></thead><tbody>${ts.map(t => `<tr class="row" data-act="spot" data-s="${esc(t.s)}" tabindex="0" aria-label="${esc(t.n)}, open chart"><td class="l"><b>${esc(label(t))}</b><span class="muted mon-n">${esc(t.n)}</span>${t.stale ? ' <span class="flag">stale</span>' : ""}</td><td data-px="${esc(t.s)}">${fmtPx(t)}</td><td class="${chgTone(t)}">${chgText(t)}</td>${periodCell(t, histAgo(t.s, 21))}${periodCell(t, ytdBase(t.s))}</tr>`).join("")}</tbody></table></div>`;
    }).join("")}</div><p class="note">Yields change in basis points (1 bp = 0.01 percentage point). For the VIX, green means falling volatility. Quotes from free sources, typically delayed about 15 minutes.</p>`;
  }
  function wire(n) {
    const list = D.news.slice().sort((a, b) => Date.parse(b.published) - Date.parse(a.published)).slice(0, n);
    if (!list.length) return `<p class="empty">No headlines in the current window.</p>`;
    return `<ol class="wire">${list.map(x => `<li><time title="${esc(F.full.format(new Date(x.published)))}">${esc(F.hm.format(new Date(x.published)))}</time><span class="wd" title="${esc(deskName(x.desk))}">${esc(DESK_ABBR[x.desk] || "")}</span><a href="${href(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><span class="src">${esc(x.source)}, <span data-ago="${esc(x.published)}">${ago(x.published)}</span></span></li>`).join("")}</ol>`;
  }
  function segBars() {
    const rows = D.segperf.filter(s => ok(s.d1));
    const refs = ["XLV", "SPY"].map(s => TK.get(s)).filter(t => t && ok(t.chgp)).map(t => ({ name: t.n, d1: t.chgp, ref: true }));
    const all = rows.concat(refs);
    const max = Math.max(0.5, ...all.map(r => Math.abs(r.d1)));
    return all.map(r => {
      const w = (Math.abs(r.d1) / max) * 50;
      const pos = r.d1 >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
      const inner = `<span>${esc(r.name)}</span><span class="t"><i class="${r.d1 >= 0 ? "up" : "down"}" style="${pos}"></i></span><span class="v ${tone(r.d1)}">${sgn(r.d1)}</span>`;
      return r.ref ? `<div class="dbar ref">${inner}</div>` : `<button class="dbar" style="width:100%" data-act="seg-go" data-k="${esc(r.id)}">${inner}</button>`;
    }).join("");
  }
  function renderMovers() {
    const el = $("#ov-movers");
    if (!el) return;
    $$("[data-act=mover]").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === S.mover));
    const list = (D.movers[S.mover] || []).map(s => TK.get(s)).filter(Boolean);
    if (!list.length) {
      el.innerHTML = `<p class="empty">${S.mover === "volume" ? "No watchlist company is trading above 1.6 times its 20-day average volume." : "No movers in this direction today."}</p>`;
      return;
    }
    el.innerHTML = list.map(t => {
      const n = (NEWS_BY_T.get(t.s) || [])[0];
      return `<div class="mv"><button class="mv-main" data-act="spot" data-s="${esc(t.s)}">
          <b>${esc(label(t))}</b><span class="nm">${esc(t.n)}${S.mover === "volume" && ok(t.vr) ? `<small>${num(t.vr, 1)}× usual volume</small>` : ""}</span>
          <span class="ch ${tone(t.chgp)}">${sgn(t.chgp)}</span>${spark(t.spark)}</button>
        ${n ? `<div class="hl"><a href="${href(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a> <span class="muted">${esc(n.source)}</span></div>` : ""}</div>`;
    }).join("");
  }

  // ── Markets ─────────────────────────────────────────────────────────────────
  function renderMarkets(el) {
    const segs = D.segments.filter(s => s.watchlist !== false);
    el.innerHTML = `
      <section class="card" id="spot"></section>
      ${card("Heatmap", `<div id="heat"></div><div class="scale" id="heat-scale"></div>`, { sub: "tile size reflects weight in the sector; select a tile for detail", tools: segBtns([["chgp", "Day"], ["r1w", "1W"], ["r1m", "1M"], ["rytd", "YTD"]], S.heat, "heat", "Heatmap period") })}
      ${card("Watchlist", `<div class="ctl-row"><div class="chips" role="group" aria-label="Segment filter"><button class="fchip" data-act="wlseg" data-k="all" aria-pressed="${S.wlSeg === "all"}">All</button>${segs.map(s => `<button class="fchip" data-act="wlseg" data-k="${esc(s.id)}" aria-pressed="${S.wlSeg === s.id}">${esc(s.name)}</button>`).join("")}</div><input class="input" id="wl-q" type="search" placeholder="Filter by name or note" aria-label="Filter watchlist" value="${esc(S.wlQ)}"><button class="fchip" data-act="wlgroup" aria-pressed="${S.wlSort.k === "seg"}">Group by segment</button></div><div class="tbl-wrap" id="wl"></div>`, { id: "watchlist" })}
      <div class="grid g-3">
        ${card("52-week extremes", extremes())}
        ${card("Unusual volume", volList(), { sub: "vs 20-day average" })}
        ${card("Earnings ahead", earningsList(8))}
      </div>`;
    $("#wl-q").addEventListener("input", debounce(e => { S.wlQ = e.target.value.trim(); renderWatchlist(); }, 120));
    renderSpot(); renderHeat(); renderWatchlist();
  }
  function extremes() {
    const hi = D.movers.highs.map(s => TK.get(s)).filter(Boolean), lo = D.movers.lows.map(s => TK.get(s)).filter(Boolean);
    const row = t => `<li><button data-act="spot" data-s="${esc(t.s)}" style="display:flex;width:100%;justify-content:space-between;padding:5px 0"><span><b>${esc(label(t))}</b> <span class="muted">${esc(t.n)}</span></span><span class="${tone(t.chgp)}">${sgn(t.chgp)}</span></button></li>`;
    if (!hi.length && !lo.length) return `<p class="empty">No watchlist company is at a 52-week high or low.</p>`;
    return `${hi.length ? `<h3>At 52-week highs</h3><ul>${hi.map(row).join("")}</ul>` : ""}${lo.length ? `<h3 style="margin-top:10px">At 52-week lows</h3><ul>${lo.map(row).join("")}</ul>` : ""}`;
  }
  function volList() {
    const v = D.movers.volume.map(s => TK.get(s)).filter(Boolean);
    if (!v.length) return `<p class="empty">Nothing trading above 1.6 times normal volume.</p>`;
    return `<ul>${v.map(t => `<li><button data-act="spot" data-s="${esc(t.s)}" style="display:grid;grid-template-columns:60px 1fr auto auto;gap:8px;width:100%;padding:5px 0"><b>${esc(label(t))}</b><span class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.n)}</span><b>${num(t.vr, 1)}×</b><span class="${tone(t.chgp)}">${sgn(t.chgp)}</span></button></li>`).join("")}</ul>`;
  }

  function rangeStart(key, last) {
    const d = new Date(dms(last));
    const months = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24, "3Y": 36, "5Y": 60 }[key];
    if (key === "YTD") return `${d.getUTCFullYear()}-01-01`;
    d.setUTCMonth(d.getUTCMonth() - (months || 6));
    return d.toISOString().slice(0, 10);
  }
  function histSeries(sym, start) {
    const H = D.hist, v = H.series[sym];
    if (!v) return null;
    let i0 = H.dates.findIndex(d => d >= start);
    if (i0 < 0) i0 = 0;
    return { t: H.dates.slice(i0).map(dms), v: v.slice(i0) };
  }

  function renderSpot() {
    const el = $("#spot");
    if (!el) return;
    const fallback = D.movers.up[0] || D.movers.down[0] || "XLV";
    if (!S.spot || !TK.get(S.spot) || TK.get(S.spot).missing) S.spot = fallback;
    const t = TK.get(S.spot);
    if (!t || t.missing) { el.innerHTML = `<p class="empty">No price data available.</p>`; return; }
    const seg = D.segments.find(s => s.id === t.seg);
    const peers = D.tickers.filter(x => x.seg === t.seg && x.s !== t.s && !x.missing);
    const cmpOpts = [["SPY", "S&P 500"], ["XLV", "Health care"]].filter(([s]) => s !== t.s && TK.get(s) && !TK.get(s).missing)
      .concat(peers.map(p => [p.s, label(p)]));
    const pos = t.hi52 > t.lo52 ? ((t.px - t.lo52) / (t.hi52 - t.lo52)) * 100 : 50;
    const news = (NEWS_BY_T.get(t.s) || []).slice(0, 5);
    const star = S.stars.has(t.s);
    const earn = (D.earnings || []).find(e => e.symbol === t.s);
    el.innerHTML = `
      <div class="spot-h">
        <div>
          <div class="muted" style="font-size:12.5px;font-weight:600">Spotlight: ${esc(seg ? seg.name : "")}</div>
          <h2 class="spot-t">${esc(t.n)} <span class="muted" style="font-size:.6em;font-stretch:90%">${esc(t.s)}</span> <button class="star" data-act="star" data-s="${esc(t.s)}" aria-pressed="${star}" aria-label="${star ? "Remove from" : "Add to"} starred">${star ? "★" : "☆"}</button></h2>
          <div class="spot-sub">${esc(t.note || "")}${t.stale ? ` <span class="flag">Last price from ${esc(t.d)}</span>` : ""}</div>
        </div>
        <div class="spot-px"><span class="p" data-px="${esc(t.s)}">${t.unit ? "" : "$"}${fmtPx(t)}</span><span class="pill ${chgTone(t)}">${arrow(isYield(t) ? t.chg : t.chgp)} ${isYield(t) ? chgText(t) : `${sgn(t.chg, pxDigits(t), "")} (${sgn(t.chgp)})`}</span></div>
      </div>
      <div class="spot-body">
        <div>
          <div class="ctl-row">${segBtns(["1M", "3M", "6M", "YTD", "1Y", "2Y"].map(k => [k, k]), S.range, "range", "Chart range")}
            <div class="series-chips chips" role="group" aria-label="Compare with">${cmpOpts.slice(0, 9).map(([s, l], i) => `<button data-act="cmp" data-s="${esc(s)}" aria-pressed="${S.cmp.has(s)}" style="--c:${palette()[(i + 1) % 7]}"><i></i>${esc(l)}</button>`).join("")}</div></div>
          <div id="spot-chart"></div>
          <p class="note" id="spot-note"></p>
        </div>
        <div>
          <dl class="stats">
            ${[["1 week", t.r1w], ["1 month", t.r1m], ["3 months", t.r3m], ["Year to date", t.rytd], ["1 year", t.r1y], ["Off 52-week high", t.offhi]].map(([l, v]) => `<div class="stat"><dt>${l}</dt><dd class="${tone(v)}">${sgn(v, 1)}</dd></div>`).join("")}
            <div class="stat wide"><dt>52-week range</dt><dd><div class="rng"><i style="left:${pos}%"></i></div><div class="rng-l"><span>${fmtPx(t, t.lo52)}</span><span>${fmtPx(t, t.hi52)}</span></div></dd></div>
            <div class="stat"><dt>Volume vs 20-day</dt><dd>${ok(t.vr) ? num(t.vr, 2) + "×" : "–"}</dd></div>
            <div class="stat"><dt>Next earnings</dt><dd>${earn ? FU.day.format(dms(earn.date)) : "–"}</dd></div>
          </dl>
          <h3>In the news</h3>
          ${news.length ? `<ol class="stories">${news.map(n => `<li class="story"><a class="story-t" style="font-size:14px" href="${href(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><div class="story-m"><span class="src">${esc(n.source)}</span><time data-ago="${esc(n.published)}">${ago(n.published)}</time></div></li>`).join("")}</ol>` : `<p class="empty" style="padding-top:4px">No headlines mention ${esc(t.n)} in the last 72 hours.</p>`}
        </div>
      </div>`;
    drawSpotChart();
  }
  function drawSpotChart() {
    const t = TK.get(S.spot), host = $("#spot-chart");
    if (!t || !host) return;
    const start = rangeStart(S.range, D.hist.dates[D.hist.dates.length - 1]);
    const main = histSeries(t.s, start);
    const cmps = [...S.cmp].filter(s => s !== t.s && TK.get(s)).map(s => ({ name: label(TK.get(s)), ...histSeries(s, start) })).filter(x => x.t);
    const pal = palette();
    const chips = $$("#spot [data-act=cmp]");
    const colorOf = s => { const b = chips.find(c => c.dataset.s === s); return b ? b.style.getPropertyValue("--c") : pal[2]; };
    const series = [{ name: label(t), ...main, color: pal[0], width: 2.2, fmt: t.unit ? "num" : "usd" }]
      .concat([...S.cmp].filter(s => s !== t.s && TK.get(s)).map((s, i) => ({ ...cmps[i], color: colorOf(s), width: 1.5 })));
    const rebase = cmps.length > 0;
    lineChart(host, { series, height: 300, area: !rebase, rebase, fmt: t.unit ? "num" : "usd", label: `${t.n} price, ${S.range}` });
    $("#spot-note").textContent = rebase ? "Comparison mode: every line is rebased to 100 at the start of the range, so the chart shows relative performance." : "Daily closes, adjusted for splits and dividends where the provider supplies them.";
  }

  function renderHeat() {
    const el = $("#heat");
    if (!el) return;
    $$("[data-act=heat]").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === S.heat));
    const lim = { chgp: 3, r1w: 6, r1m: 12, rytd: 30 }[S.heat];
    const segs = D.segments.filter(s => s.heatmap !== false);
    el.innerHTML = segs.map(sg => {
      const ts = D.tickers.filter(t => t.seg === sg.id && !t.missing);
      if (!ts.length) return "";
      return `<div class="heat-seg"><span>${esc(sg.name)}</span><div class="heat-row">${ts.map(t => {
        const v = t[S.heat], c = divColor(v, lim);
        return `<button class="tile" data-act="spot" data-s="${esc(t.s)}" style="--g:${t.w || 1};background:${c.bg};color:${c.fg}" title="${esc(t.n)}: ${sgn(v)}"><b>${esc(label(t))}</b><span>${sgn(v, 1)}</span></button>`;
      }).join("")}</div></div>`;
    }).join("");
    const lo = divColor(-lim, lim).bg, mid = divColor(0, lim).bg, hi = divColor(lim, lim).bg;
    $("#heat-scale").innerHTML = `<span>${sgn(-lim, 0)} or worse</span><i style="background:linear-gradient(to right, ${lo}, ${mid}, ${hi})"></i><span>${sgn(lim, 0)} or better</span>`;
  }

  const WL_COLS = [
    ["s", "Company", "l"], ["px", "Last"], ["chgp", "Day"], ["r1w", "1W"], ["r1m", "1M"], ["rytd", "YTD"], ["r1y", "1Y"],
    ["offhi", "52-week range"], ["vr", "Volume vs avg"], ["news", "Headlines"], [null, "40-day trend"],
  ];
  function wlRow(t) {
    const star = S.stars.has(t.s);
    const pos = t.hi52 > t.lo52 ? ((t.px - t.lo52) / (t.hi52 - t.lo52)) * 100 : 50;
    return `<tr class="row" data-act="spot" data-s="${esc(t.s)}" tabindex="0" aria-label="${esc(t.n)}, open spotlight">
      <td class="nm l"><button class="star" data-act="star" data-s="${esc(t.s)}" aria-pressed="${star}" aria-label="${star ? "Unstar" : "Star"} ${esc(t.n)}">${star ? "★" : "☆"}</button> <b>${esc(label(t))}</b><span>${esc(t.n)}</span>${t.stale ? ` <span class="flag" title="Latest price is from ${esc(t.d)}">stale</span>` : ""}</td>
      <td data-px="${esc(t.s)}">${fmtPx(t)}</td>
      ${["chgp", "r1w", "r1m", "rytd", "r1y"].map(k => `<td class="${tone(t[k])}">${sgn(t[k], k === "chgp" ? 2 : 1)}</td>`).join("")}
      <td title="52-week low ${fmtPx(t, t.lo52)}, high ${fmtPx(t, t.hi52)}; ${sgn(t.offhi, 1)} from the high"><span class="rng"><i style="left:${pos}%"></i></span></td>
      <td>${ok(t.vr) ? num(t.vr, 2) + "×" : "–"}</td>
      <td>${t.news || ""}</td>
      <td>${spark(t.spark)}</td></tr>`;
  }
  function renderWatchlist() {
    const el = $("#wl");
    if (!el) return;
    $$("[data-act=wlseg]").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === S.wlSeg));
    $$("[data-act=wlgroup]").forEach(b => b.setAttribute("aria-pressed", S.wlSort.k === "seg"));
    const wlSegs = new Set(D.segments.filter(s => s.watchlist !== false).map(s => s.id));
    let rows = D.tickers.filter(t => !t.missing && wlSegs.has(t.seg));
    if (S.wlSeg !== "all") rows = rows.filter(t => t.seg === S.wlSeg);
    if (S.wlQ) {
      const q = S.wlQ.toLowerCase();
      rows = rows.filter(t => (t.s + " " + t.n + " " + (t.note || "")).toLowerCase().includes(q));
    }
    const { k, dir } = S.wlSort;
    let body = "";
    if (k === "seg") {
      const starred = rows.filter(t => S.stars.has(t.s));
      if (starred.length) body += `<tr class="grp"><td colspan="11">Starred</td></tr>` + starred.map(wlRow).join("");
      for (const sg of D.segments) {
        const g = rows.filter(t => t.seg === sg.id && !S.stars.has(t.s));
        if (g.length) body += `<tr class="grp"><td colspan="11">${esc(sg.name)}</td></tr>` + g.map(wlRow).join("");
      }
    } else {
      rows.sort((a, b) => {
        const x = a[k], y = b[k];
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
      });
      body = rows.map(wlRow).join("");
    }
    const head = WL_COLS.map(([key, l, cls]) => {
      const sorted = key && k === key ? (dir > 0 ? "ascending" : "descending") : null;
      return `<th class="${cls || ""}"${sorted ? ` aria-sort="${sorted}"` : ""}>${key ? `<button data-act="wlsort" data-k="${key}">${l}</button>` : l}</th>`;
    }).join("");
    el.innerHTML = rows.length ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` : `<p class="empty">No companies match that filter.</p>`;
  }

  // ── News ────────────────────────────────────────────────────────────────────
  function renderNews(el) {
    const srcCounts = {};
    D.news.forEach(n => { srcCounts[n.source] = (srcCounts[n.source] || 0) + 1; });
    const sources = Object.entries(srcCounts).sort((a, b) => b[1] - a[1]);
    el.innerHTML = `<div class="news-layout">
      <aside class="card rail" aria-label="News filters">
        <div class="rail-g"><h3>Desk</h3><div id="n-desks"></div></div>
        <div class="rail-g"><h3>Topics</h3><div id="n-cats"></div></div>
        <div class="rail-g"><h3>Window</h3>${segBtns([["24", "24 hrs"], ["48", "48 hrs"], ["72", "72 hrs"]], String(S.nf.hours), "nwin", "Time window")}</div>
        <div class="rail-g"><h3>Outlet</h3><select class="input" id="n-src" style="width:100%" aria-label="Filter by outlet"><option value="all">All outlets (${sources.length})</option>${sources.map(([s, c]) => `<option value="${esc(s)}"${S.nf.src === s ? " selected" : ""}>${esc(s)} (${c})</option>`).join("")}</select></div>
        <div class="rail-g"><label class="check"><input type="checkbox" id="n-linked"${S.nf.linked ? " checked" : ""}> Only stories naming a watchlist company</label></div>
        <div class="rail-g"><button class="link" data-act="nreset">Clear all filters</button></div>
      </aside>
      <section class="card">
        <div class="news-tools"><input class="input" id="n-q" type="search" placeholder="Search headlines and summaries" aria-label="Search headlines" value="${esc(S.nf.q)}">${segBtns([["score", "Most impact"], ["time", "Newest"]], S.nf.sort, "nsort", "Sort order")}<span class="muted" id="n-count" aria-live="polite"></span></div>
        <ol class="stories big" id="n-list"></ol>
      </section></div>`;
    $("#n-q").addEventListener("input", debounce(e => { S.nf.q = e.target.value.trim(); S.nf.limit = 40; renderNewsList(); }, 150));
    $("#n-src").addEventListener("change", e => { S.nf.src = e.target.value; S.nf.limit = 40; renderNewsList(); });
    $("#n-linked").addEventListener("change", e => { S.nf.linked = e.target.checked; S.nf.limit = 40; renderNewsList(); });
    renderNewsList();
  }
  function newsFiltered(ignoreCats) {
    const ref = Date.parse(D.meta.generated_at), q = S.nf.q.toLowerCase();
    return D.news.filter(n => (ref - Date.parse(n.published)) / 36e5 <= S.nf.hours
      && (ignoreCats === "desk" || S.nf.desk === "all" || (n.desks || [n.desk]).includes(S.nf.desk))
      && (S.nf.src === "all" || n.source === S.nf.src)
      && (!S.nf.linked || (n.tickers && n.tickers.length))
      && (!q || (n.title + " " + (n.summary || "") + " " + n.source).toLowerCase().includes(q))
      && (ignoreCats || !S.nf.cats.size || n.cats.some(c => S.nf.cats.has(c))));
  }
  function renderNewsList() {
    const dc = { all: 0 };
    newsFiltered("desk").forEach(n => { dc.all++; (n.desks || [n.desk]).forEach(d => { dc[d] = (dc[d] || 0) + 1; }); });
    $("#n-desks").innerHTML = [{ id: "all", name: "All desks" }].concat(D.desks || []).map(d => `<button class="cat-btn" data-act="ndesk" data-k="${esc(d.id)}" aria-pressed="${S.nf.desk === d.id}" style="--c:var(--amber)"><span>${esc(d.name)}</span><span class="c">${dc[d.id] || 0}</span></button>`).join("");
    const base = newsFiltered(true), counts = {};
    base.forEach(n => n.cats.forEach(c => { counts[c] = (counts[c] || 0) + 1; }));
    $("#n-cats").innerHTML = D.newscats.map(c => `<button class="cat-btn" data-act="ncat" data-k="${esc(c.id)}" aria-pressed="${S.nf.cats.has(c.id)}" style="--c:${esc(c.color)}"><span class="stk">${esc(c.name)}</span><span class="c">${counts[c.id] || 0}</span></button>`).join("");
    $$("[data-act=nwin]").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === String(S.nf.hours)));
    $$("[data-act=nsort]").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === S.nf.sort));
    let list = newsFiltered(false);
    if (S.nf.sort === "time") list = list.slice().sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
    $("#n-count").textContent = `${list.length} of ${D.news.length} stories`;
    const shown = list.slice(0, S.nf.limit);
    $("#n-list").innerHTML = shown.length
      ? shown.map(n => storyRow(n, { full: true })).join("") + (list.length > shown.length ? `<li style="border:0;padding-top:14px"><button class="fchip" data-act="nmore">Show ${Math.min(40, list.length - shown.length)} more</button></li>` : "")
      : `<li class="empty">No stories match these filters. <button class="link" data-act="nreset">Clear filters</button></li>`;
  }

  // ── Costs and energy ────────────────────────────────────────────────────────
  const ENERGY = { wti: "--amber", brent: "--ink-2", diesel: "--teal", gasoline: "#7b61c4", natgas: "#3f7fc4" };
  const colorFor = k => (ENERGY[k] || "").startsWith("--") ? cssv(ENERGY[k]) : ENERGY[k] || cssv("--ink-3");
  const YOYC = { cpi_rx: "--amber", ppi_pharma: "--teal", ppi_rx_retail: "#7b61c4", cpi_all: "--ink-3", ppi_freight: "#3f7fc4", cpi_medical: "--down", wti: "--ink-2", diesel: "#7a9a2e" };
  const yoyColor = k => (YOYC[k] || "").startsWith("--") ? cssv(YOYC[k]) : YOYC[k] || cssv("--ink-3");

  function energyCell(lbl, fut, key) {
    const m = D.macro[key], t = fut && TK.get(fut);
    let v, chgp, chgLbl, sub = "";
    if (t && ok(t.px)) { v = (t.unit === "$/gal" ? "$" + NF[3].format(t.px) : "$" + NF[2].format(t.px)); chgp = t.chgp; chgLbl = "today, futures"; }
    else if (m) { v = fmt(m.last, m.fmt); chgp = m.chgp; chgLbl = m.freq === "weekly" ? "week" : "prior day"; }
    else return "";
    if (m && ok(m.yoy)) sub = `<span class="pill ${tone(m.yoy, "cost")}">${sgn(m.yoy, 0)}</span> year over year`;
    return `<div class="cell"><div class="l">${esc(lbl)}</div><div class="v">${v}</div><div class="s"><span class="${tone(chgp, "cost")}">${arrow(chgp)} ${sgn(chgp)}</span> ${chgLbl}</div><div class="s" style="margin-top:4px">${sub}</div></div>`;
  }
  function costInsight() {
    const m = D.macro, g = k => (m[k] && ok(m[k].yoy) ? m[k].yoy : null);
    const w = g("wti"), fr = g("ppi_freight"), ph = g("ppi_pharma"), mg = g("ppi_rx_retail"), rx = g("cpi_rx");
    const out = [];
    if (w != null && ph != null) {
      if (w < -5 && ph > 0) out.push(`Crude is ${sgn(w, 0)} from a year ago, yet drug manufacturers' prices are ${sgn(ph, 1)}. Lower energy costs are not reaching what pharmacies pay for product.`);
      else if (w > 5 && fr != null && fr > 0) out.push(`Crude is ${sgn(w, 0)} year over year and truck freight prices are ${sgn(fr, 1)}, which adds distribution cost pressure for wholesalers and pharmacies.`);
      else out.push(`Crude is ${sgn(w, 0)} year over year, while drug manufacturing prices are ${sgn(ph, 1)}.`);
    }
    if (rx != null && mg != null) {
      out.push(mg < 0 ? `Pharmacy dispensing margins are shrinking (${sgn(mg, 1)}) even as consumer prescription and medical goods prices rise ${sgn(rx, 1)}.`
        : `Pharmacy dispensing margins are ${sgn(mg, 1)} year over year, against consumer prescription and medical goods prices at ${sgn(rx, 1)}.`);
    }
    return out.join(" ");
  }
  function renderCosts(el) {
    const avail = Object.keys(ENERGY).filter(k => D.macro[k]);
    el.innerHTML = `
      <div class="strip">${[["WTI crude", "CL=F", "wti"], ["Brent crude", "BZ=F", "brent"], ["Diesel, retail", null, "diesel"], ["Gasoline, retail", null, "gasoline"], ["Natural gas", "NG=F", "natgas"], ["Heating oil (ULSD)", "HO=F", null]].map(a => energyCell(...a)).join("")}</div>
      ${card("Crude and fuel prices", `<div class="ctl-row"><div class="series-chips chips" role="group" aria-label="Series">${avail.map(k => `<button data-act="eser" data-k="${k}" aria-pressed="${S.energy.keys.has(k)}" style="--c:${colorFor(k)}"><i></i>${esc(D.macro[k].short)}</button>`).join("")}</div>${segBtns(["1M", "6M", "1Y", "3Y", "5Y"].map(k => [k, k]), S.energy.range, "erange", "Range")}<label class="check"><input type="checkbox" id="e-rebase"${S.energy.rebase ? " checked" : ""}> Rebase to 100</label></div><div id="e-chart"></div><p class="note" id="e-note"></p>`, { sub: "EIA spot and retail prices via FRED" })}
      ${card("Cost pass-through", `<ol class="chain-wide">${D.costs.chain.map(k => `<li><div class="n"></div><div class="ti">${esc(k.title)}</div><div class="yv ${tone(k.yoy, "cost")}">${sgn(k.yoy, 1)}</div><div class="lv">${fmt(k.last, k.fmt)}${k.units && k.units !== "index" ? " " + esc(k.units.replace("$/", "per ")) : " index"}, ${esc(asOf(k.last_date, k.freq))}</div></li>`).join("")}</ol><p class="insight">${esc(costInsight())}</p>`, { sub: "year-over-year change at each stage, from crude to the pharmacy counter" })}
      <div class="grid g-53">
        ${card("What moves with what", `<div class="tbl-wrap" id="corr"></div><div class="legend" style="margin-top:8px" id="corr-scale"></div>`, { sub: `correlation of year-over-year changes, last ${D.costs.corr.window} months` })}
        ${card("Pair detail", `<div id="corr-detail"></div>`)}
      </div>
      <div class="grid g-2">
        ${card("Lead times", `<div class="ll-pick" id="ll-pick"></div><div id="ll-body"></div>`, { sub: "does one series move first?" })}
        ${card("Drug and pharmacy price trends", `<div class="series-chips chips ctl-row" role="group" aria-label="Series" id="yoy-chips"></div><div id="yoy-chart"></div><p class="note">Year-over-year % change, monthly. The consumer index here covers medical goods, mostly prescription drugs; producer indexes (PPI) track manufacturer prices and pharmacy margins.</p>`)}
      </div>`;
    $("#e-rebase").addEventListener("change", e => { S.energy.rebase = e.target.checked; drawEnergy(); });
    drawEnergy(); renderCorr(); renderLeadLag(); drawYoy();
  }
  function drawEnergy() {
    const host = $("#e-chart");
    if (!host) return;
    $$("[data-act=eser]").forEach(b => b.setAttribute("aria-pressed", S.energy.keys.has(b.dataset.k)));
    $$("[data-act=erange]").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === S.energy.range));
    const keys = [...S.energy.keys].filter(k => D.macro[k]);
    const units = new Set(keys.map(k => D.macro[k].units));
    const forced = units.size > 1;
    const rebase = S.energy.rebase || forced;
    const lastDates = keys.map(k => D.macro[k].dates[D.macro[k].dates.length - 1]).sort();
    const start = rangeStart(S.energy.range, lastDates[lastDates.length - 1] || D.meta.generated_at.slice(0, 10));
    const series = keys.map(k => {
      const m = D.macro[k];
      let i0 = m.dates.findIndex(d => d >= start);
      if (i0 < 0) i0 = m.dates.length;
      return { name: m.short, t: m.dates.slice(i0).map(dms), v: m.values.slice(i0), color: colorFor(k), fmt: m.fmt };
    });
    if (!series.length) { host.innerHTML = `<p class="empty">Select at least one series.</p>`; return; }
    lineChart(host, { series, height: 280, rebase, fmt: series[0].fmt, label: "Crude and fuel prices" });
    $("#e-note").textContent = forced ? "Mixed units ($/bbl, $/gal, $/MMBtu), so each line is rebased to 100 at the start of the range." : rebase ? "Rebased to 100 at the start of the range." : "Retail diesel and gasoline are weekly averages; spot crude and gas are daily.";
  }

  function renderCorr() {
    const C = D.costs.corr, host = $("#corr");
    if (!host) return;
    if (!C.keys.length) { host.innerHTML = `<p class="empty">Not enough economic data yet.</p>`; return; }
    const shortOf = k => (D.macro[k] ? D.macro[k].short : k);
    if (!S.corr) {
      const iw = C.keys.indexOf("wti"), ir = C.keys.indexOf("cpi_rx");
      S.corr = iw >= 0 && ir >= 0 ? [iw, ir] : [0, Math.min(1, C.keys.length - 1)];
    }
    const pos = [11, 110, 105], negc = [184, 50, 42];
    let html = `<table class="corr"><thead><tr><th></th>${C.keys.map(k => `<th class="col" scope="col">${esc(shortOf(k))}</th>`).join("")}</tr></thead><tbody>`;
    C.keys.forEach((a, i) => {
      html += `<tr><th scope="row" style="text-align:right;white-space:nowrap">${esc(shortOf(a))}</th>`;
      C.keys.forEach((b, j) => {
        const r = C.matrix[i][j];
        if (i === j) { html += `<td class="diag"><button disabled aria-label="${esc(shortOf(a))} with itself">1</button></td>`; return; }
        const c = divColor(r, 1, pos, negc);
        const sel = S.corr && ((S.corr[0] === i && S.corr[1] === j) || (S.corr[0] === j && S.corr[1] === i));
        html += `<td><button data-act="corr" data-i="${i}" data-j="${j}" aria-pressed="${!!sel}" style="background:${c.bg};color:${c.fg}" aria-label="${esc(shortOf(a))} and ${esc(shortOf(b))}: r ${ok(r) ? num(r, 2) : "not available"}">${ok(r) ? num(r, 2).replace("0.", ".") : "–"}</button></td>`;
      });
      html += `</tr>`;
    });
    host.innerHTML = html + `</tbody></table>`;
    const lo = divColor(-1, 1, pos, negc).bg, mid = divColor(0, 1, pos, negc).bg, hi = divColor(1, 1, pos, negc).bg;
    $("#corr-scale").innerHTML = `<span>Opposite (−1)</span><i style="display:inline-block;width:140px;height:8px;border-radius:4px;background:linear-gradient(to right,${lo},${mid},${hi})"></i><span>Together (+1)</span><span>Select a cell for the scatter plot.</span>`;
    renderCorrDetail();
  }
  function strength(r) {
    const a = Math.abs(r);
    return a >= 0.7 ? "strongly" : a >= 0.4 ? "moderately" : a >= 0.2 ? "weakly" : "barely";
  }
  function renderCorrDetail() {
    const host = $("#corr-detail");
    if (!host || !S.corr) return;
    const C = D.costs.corr, [i, j] = S.corr, a = C.keys[i], b = C.keys[j], r = C.matrix[i][j], n = C.n[i][j];
    const Y = D.costs.yoy, xa = Y[a] || [], yb = Y[b] || [];
    const pts = [];
    const from = Math.max(0, Y.dates.length - C.window);
    for (let k = from; k < Y.dates.length; k++) if (ok(xa[k]) && ok(yb[k])) pts.push([xa[k], yb[k], Y.dates[k]]);
    const A = D.macro[a], B = D.macro[b];
    const verdict = !ok(r) ? "There is not enough overlapping history to measure this pair."
      : Math.abs(r) < 0.2 ? `Over the last ${n} months, year-over-year changes in ${A.short} and ${B.short} have shown little consistent relationship (r = ${num(r, 2)}).`
        : `Over the last ${n} months, year-over-year changes in ${A.short} and ${B.short} moved ${strength(r)} ${r > 0 ? "together" : "in opposite directions"} (r = ${num(r, 2)}).`;
    host.innerHTML = `<p class="callout">${esc(verdict)}</p><div id="scatter"></div><p class="note">Each dot is one month. Correlation shows co-movement, not cause: both series can respond to the same inflation cycle.</p>`;
    if (pts.length < 3) return;
    svgBox($("#scatter"), 250, W => scatterSvg(W, 250, pts, A.short, B.short));
  }
  function scatterSvg(W, H, pts, xl, yl) {
    const M = { l: 60, r: 12, t: 10, b: 34 };
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const pad = (a, b) => { const d = (b - a) * 0.08 || 1; return [a - d, b + d]; };
    const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
    const X = v => M.l + ((v - x0) / (x1 - x0)) * (W - M.l - M.r), Y = v => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0, sxx = 0;
    pts.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; });
    const slope = sxx ? sxy / sxx : 0, icpt = my - slope * mx;
    const xt = ticks(x0, x1, 5), yt = ticks(y0, y1, 4);
    let g = "";
    xt.forEach(v => { g += `<line class="gl" x1="${X(v)}" x2="${X(v)}" y1="${M.t}" y2="${H - M.b}"/><text class="ax" x="${X(v)}" y="${H - M.b + 14}" text-anchor="middle">${tickFmt(v, "pctchg", xt.step)}</text>`; });
    yt.forEach(v => { g += `<line class="gl" x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${M.l - 6}" y="${Y(v) + 4}" text-anchor="end">${tickFmt(v, "pctchg", yt.step)}</text>`; });
    const n = pts.length;
    const dots = pts.map(([x, y, d], k) => `<circle cx="${X(x).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="${k === n - 1 ? 5 : 3.4}" fill="${k === n - 1 ? cssv("--amber") : cssv("--teal")}" fill-opacity="${k === n - 1 ? 1 : 0.25 + 0.6 * (k / n)}"><title>${FU.monY.format(dms(d))}: ${sgn(x, 1)}, ${sgn(y, 1)}</title></circle>`).join("");
    const line = `<line x1="${X(x0)}" y1="${Y(icpt + slope * x0)}" x2="${X(x1)}" y2="${Y(icpt + slope * x1)}" stroke="${cssv("--ink-3")}" stroke-dasharray="4 3" stroke-width="1.3"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Scatter of monthly year-over-year changes, ${esc(xl)} against ${esc(yl)}"><defs><clipPath id="sc"><rect x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}"/></clipPath></defs>${g}<g clip-path="url(#sc)">${line}</g>${dots}<text class="ax" x="${(M.l + W - M.r) / 2}" y="${H - 4}" text-anchor="middle">${esc(xl)}, y/y</text><text class="ax" x="12" y="${(M.t + H - M.b) / 2}" transform="rotate(-90 12 ${(M.t + H - M.b) / 2})" text-anchor="middle">${esc(yl)}, y/y</text></svg><div class="legend"><span><i class="sw" style="background:${cssv("--amber")}"></i>Latest month</span><span><i class="sw" style="background:${cssv("--teal")};opacity:.6"></i>Earlier months, fading with age</span><span>Dashed line: best fit</span></div>`;
  }

  function renderLeadLag() {
    const L = D.costs.leadlag, pick = $("#ll-pick"), body = $("#ll-body");
    if (!pick) return;
    if (!L.length) { body.innerHTML = `<p class="empty">Not enough history to test lead times.</p>`; return; }
    const sh = k => (D.macro[k] ? D.macro[k].short : k);
    pick.innerHTML = L.map((p, i) => `<button data-act="ll" data-k="${i}" aria-pressed="${i === S.ll}">${esc(sh(p.a))} → ${esc(sh(p.b))}</button>`).join("");
    const p = L[S.ll] || L[0];
    let msg;
    if (!ok(p.best_r) || p.best_r < 0.2) msg = `No reliable lead: ${sh(p.a)} and ${sh(p.b)} show little positive relationship at any lag up to a year.`;
    else if (p.best_lag > 0 && p.best_r - (p.r0 || 0) >= 0.05) msg = `${sh(p.a)} tends to lead ${sh(p.b)} by about ${p.best_lag} month${p.best_lag > 1 ? "s" : ""} (r = ${num(p.best_r, 2)} at that lag, ${num(p.r0, 2)} with no lag).`;
    else msg = `${sh(p.a)} and ${sh(p.b)} move in the same month rather than one leading the other (r = ${num(p.r0, 2)}).`;
    body.innerHTML = `<p class="callout">${esc(msg)}</p><div id="ll-chart"></div><p class="note">Bars show how closely ${esc(sh(p.a))}, shifted forward by 0 to 12 months, tracks ${esc(sh(p.b))} (year-over-year changes, last ${D.costs.corr.window} months). The amber bar is the strongest lag.</p>`;
    svgBox($("#ll-chart"), 170, W => {
      const H = 170, M = { l: 30, r: 6, t: 10, b: 22 }, n = 13, bw = (W - M.l - M.r) / n;
      const Y = v => M.t + (1 - (v + 1) / 2) * (H - M.t - M.b);
      let g = [-1, -0.5, 0, 0.5, 1].map(v => `<line class="${v === 0 ? "zl" : "gl"}" x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${M.l - 5}" y="${Y(v) + 4}" text-anchor="end">${v === 0 ? "0" : num(v, 1).replace("0.", ".")}</text>`).join("");
      p.lags.forEach((r, k) => {
        const x = M.l + k * bw + bw * 0.18, w = bw * 0.64;
        g += `<text class="ax" x="${M.l + k * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${k}</text>`;
        if (!ok(r)) return;
        const y = Math.min(Y(r), Y(0)), h = Math.abs(Y(r) - Y(0));
        g += `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(1, h)}" rx="2" fill="${k === p.best_lag ? cssv("--amber") : cssv("--rule")}"><title>Lag ${k} months: r = ${num(r, 2)}</title></rect>`;
      });
      return `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Correlation by lag in months">${g}</svg><div class="legend" style="justify-content:center">Lag in months (how far ${esc(sh(p.a))} is shifted ahead)</div>`;
    });
  }
  function drawYoy() {
    const Y = D.costs.yoy, host = $("#yoy-chart");
    if (!host) return;
    const avail = ["cpi_rx", "ppi_pharma", "ppi_rx_retail", "ppi_freight", "cpi_medical", "cpi_all"].filter(k => Y[k]);
    $("#yoy-chips").innerHTML = avail.map(k => `<button data-act="yoy" data-k="${k}" aria-pressed="${S.yoyKeys.has(k)}" style="--c:${yoyColor(k)}"><i></i>${esc(D.macro[k] ? D.macro[k].short : k)}</button>`).join("");
    const t = Y.dates.map(dms);
    const series = avail.filter(k => S.yoyKeys.has(k)).map(k => ({ name: D.macro[k] ? D.macro[k].short : k, t, v: Y[k], color: yoyColor(k), fmt: "pctchg", width: k === "cpi_rx" ? 2.4 : 1.7 }));
    if (!series.length) { host.innerHTML = `<p class="empty">Select at least one series.</p>`; return; }
    lineChart(host, { series, height: 260, fmt: "pctchg", zero: true, monthly: true, label: "Year-over-year price changes" });
  }

  // ── Supply and safety ───────────────────────────────────────────────────────
  const CLS_COL = { "Class I": "--down", "Class II": "--amber", "Class III": "#8a9aa5" };
  const clsColor = c => ((CLS_COL[c] || "").startsWith("--") ? cssv(CLS_COL[c]) : CLS_COL[c] || "#8a9aa5");
  function renderSupply(el) {
    const sh = D.fda.shortages, rc = D.fda.recalls;
    if (!sh && !rc) { el.innerHTML = card("Supply and safety", `<p class="empty">FDA data is unavailable on this build.</p>`); return; }
    const c = rc ? rc.by_class : {};
    el.innerHTML = `
      <div class="strip">
        <div class="cell"><div class="l">Drugs in shortage</div><div class="v">${sh ? sh.drugs : "–"}</div><div class="s">${sh ? `${sh.entries} listed presentations` : ""}</div></div>
        <div class="cell"><div class="l">Shortages updated</div><div class="v">${sh ? sh.updated_30d : "–"}</div><div class="s">in the last 30 days</div></div>
        <div class="cell"><div class="l">Drug recalls</div><div class="v">${rc ? rc.total : "–"}</div><div class="s">reported in ${rc ? rc.lookback_days : 30} days</div></div>
        <div class="cell"><div class="l">Class I recalls</div><div class="v down">${c["Class I"] || 0}</div><div class="s">most serious: risk of serious harm</div></div>
      </div>
      ${rc && rc.weekly ? card("Recalls by week", `<div id="rc-weekly"></div><div class="legend">${["Class I", "Class II", "Class III"].map(k => `<span><i class="sw" style="background:${clsColor(k)}"></i>${k}</span>`).join("")}</div>`, { sub: `FDA enforcement reports, last ${rc.weekly.length} weeks` }) : ""}
      ${sh ? `<div class="grid g-53">
        ${card("Current shortages", `<div class="ctl-row"><input class="input" id="sh-q" type="search" placeholder="Search drug, company or reason" aria-label="Search shortages" style="flex:1" value="${esc(S.sup.q)}"><span class="muted" id="sh-count"></span></div><div class="list" id="sh-list"></div>`, { tools: `<a class="link" href="https://dps.fda.gov/drugshortages" target="_blank" rel="noopener">FDA shortage database</a>` })}
        ${card("By therapeutic area", `<div id="sh-cats"></div><p class="note">Select an area to filter the list. A drug can appear in more than one area.</p>`)}
      </div>` : ""}
      ${rc ? card("Recent recalls", `<div class="ctl-row">${segBtns([["all", "All"], ["Class I", "Class I"], ["Class II", "Class II"], ["Class III", "Class III"]], S.sup.cls, "rcls", "Recall class")}<input class="input" id="rc-q" type="search" placeholder="Search product, firm or reason" aria-label="Search recalls" style="flex:1" value="${esc(S.sup.rq)}"></div><div class="list" id="rc-list"></div>`, { tools: `<a class="link" href="https://www.accessdata.fda.gov/scripts/ires/index.cfm" target="_blank" rel="noopener">FDA enforcement reports</a>` }) : ""}`;
    if (sh) {
      $("#sh-q").addEventListener("input", debounce(e => { S.sup.q = e.target.value.trim(); renderShortages(); }, 120));
      renderShortages();
    }
    if (rc) {
      $("#rc-q").addEventListener("input", debounce(e => { S.sup.rq = e.target.value.trim(); renderRecalls(); }, 120));
      renderRecalls();
      if (rc.weekly) drawWeekly(rc.weekly);
    }
  }
  function drawWeekly(weeks) {
    svgBox($("#rc-weekly"), 180, W => {
      const H = 180, M = { l: 30, r: 6, t: 10, b: 24 }, n = weeks.length, bw = (W - M.l - M.r) / n;
      const tot = weeks.map(w => w["Class I"] + w["Class II"] + w["Class III"]);
      const max = Math.max(4, ...tot), yt = ticks(0, max, 4);
      const Y = v => M.t + (1 - v / Math.max(max, yt[yt.length - 1])) * (H - M.t - M.b);
      let g = yt.map(v => `<line class="gl" x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${M.l - 5}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join("");
      weeks.forEach((w, k) => {
        let acc = 0;
        const x = M.l + k * bw + bw * 0.14, bwid = bw * 0.72;
        for (const cls of ["Class I", "Class II", "Class III"]) {
          const v = w[cls];
          if (!v) continue;
          const y = Y(acc + v), h = Y(acc) - Y(acc + v);
          g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bwid.toFixed(1)}" height="${h.toFixed(1)}" fill="${clsColor(cls)}"/>`;
          acc += v;
        }
        g += `<rect class="hit" data-k="${k}" x="${M.l + k * bw}" y="${M.t}" width="${bw}" height="${H - M.t - M.b}" fill="transparent"/>`;
        if (k % Math.ceil(n / Math.max(2, Math.floor((W - M.l) / 70))) === 0) g += `<text class="ax" x="${M.l + k * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${FU.day.format(dms(w.week))}</text>`;
      });
      return `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Weekly drug recalls by class">${g}</svg>`;
    });
    const host = $("#rc-weekly");
    host.onpointermove = e => {
      const r = e.target.closest ? e.target.closest(".hit") : null;
      if (!r) return gtip(e, null);
      const w = weeks[+r.dataset.k];
      gtip(e, `<b>Week of ${FU.dayY.format(dms(w.week))}</b><br>Class I: ${w["Class I"]}<br>Class II: ${w["Class II"]}<br>Class III: ${w["Class III"]}`);
    };
    host.onpointerleave = e => gtip(e, null);
  }
  function renderShortages() {
    const sh = D.fda.shortages, q = S.sup.q.toLowerCase();
    const cats = sh.by_category, max = Math.max(1, ...cats.map(c => c[1]));
    $("#sh-cats").innerHTML = cats.map(([name, n]) => `<button class="hbar" data-act="shcat" data-k="${esc(name)}" aria-pressed="${S.sup.cat === name}"><span>${esc(name)}</span><span class="t"><i style="width:${(n / max) * 100}%"></i></span><span class="v">${n}</span></button>`).join("");
    const rows = sh.list.filter(d => (!S.sup.cat || d.cats.includes(S.sup.cat)) && (!q || (d.name + " " + d.company + " " + d.reason + " " + d.cats.join(" ")).toLowerCase().includes(q)));
    $("#sh-count").textContent = `${rows.length} shown`;
    $("#sh-list").innerHTML = rows.slice(0, 150).map(d => `<div class="sh-row"><b>${esc(d.name)}</b><span class="muted">${d.updated ? "updated " + esc(FU.day.format(dms(d.updated))) : ""}</span><small>${esc(d.cats.join(", "))}${d.company ? " · " + esc(d.company) : ""}${d.reason ? " · " + esc(d.reason) : ""}</small></div>`).join("") || `<p class="empty">No shortages match.</p>`;
  }
  function renderRecalls() {
    const rc = D.fda.recalls, q = S.sup.rq.toLowerCase();
    $$("[data-act=rcls]").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === S.sup.cls));
    const rows = rc.list.filter(r => (S.sup.cls === "all" || r.class === S.sup.cls) && (!q || (r.product + " " + r.firm + " " + r.reason).toLowerCase().includes(q)));
    $("#rc-list").innerHTML = rows.slice(0, 120).map(r => `<details class="rc"><summary><span class="muted">${r.date ? esc(FU.day.format(dms(r.date))) : ""}</span><span class="cls" style="background:${clsColor(r.class)}">${esc(r.class.replace("Class ", "Class\u00a0"))}</span><span class="prod">${esc(r.product)}</span><span class="firm muted">${esc(r.firm)}</span></summary><div class="body"><div><b>Reason:</b> ${esc(r.reason)}</div><div><b>Distribution:</b> ${esc(r.states || "not stated")} · <b>Status:</b> ${esc(r.status || "–")}${r.number ? " · " + esc(r.number) : ""}</div></div></details>`).join("") || `<p class="empty">No recalls match.</p>`;
  }

  // ── Macro ───────────────────────────────────────────────────────────────────
  function renderMacro(el) {
    const m = D.macro;
    const cell = (k, lbl, how) => {
      const x = m[k];
      if (!x) return "";
      const v = how === "yoy" ? sgn(x.yoy, 1) : fmt(x.last, x.fmt);
      const yr = x.fmt === "pct" ? (ok(x.chg_1y) ? sgn(x.chg_1y, 2, "") + " pts vs a year ago, " : "") : ok(x.yoy) ? sgn(x.yoy, 1) + " year over year, " : "";
      const sub = how === "yoy" ? `year over year, ${asOf(x.last_date, x.freq)}` : `${yr}${asOf(x.last_date, x.freq)}`;
      return `<div class="cell"><div class="l">${esc(lbl)}</div><div class="v">${v}</div><div class="s">${esc(sub)}</div></div>`;
    };
    el.innerHTML = `
      <div class="strip">${cell("ust10", "10-year Treasury")}${cell("fedfunds", "Fed funds rate")}${cell("cpi_all", "All-items inflation", "yoy")}${cell("cpi_medical", "Medical care inflation", "yoy")}${cell("cpi_rx", "Rx drug inflation", "yoy")}${cell("unrate", "Unemployment")}${cell("t10y2y", "10y minus 2y")}${cell("hy_spread", "High-yield spread")}${cell("retail_hpc", "Health store sales")}${cell("pharm_sales", "Pharmacy sales")}</div>
      <div class="grid g-2">
        ${card("Inflation", `<div id="m-infl"></div>`, { sub: "year-over-year % change, monthly" })}
        ${card("Interest rates", `<div id="m-rates"></div>`, { sub: "financing costs for pharmacy operators and acquirers" })}
        ${m.t10y2y ? card("Yield curve", `<div id="m-curve"></div>`, { sub: "10-year minus 2-year Treasury; below zero (inverted) has often preceded recessions" }) : ""}
        ${m.hy_spread ? card("Credit stress", `<div id="m-hy"></div>`, { sub: "high-yield bond spread over Treasuries; rising means more stress" }) : ""}
        ${m.unrate ? card("Unemployment rate", `<div id="m-unrate"></div>`, { sub: "monthly, seasonally adjusted" }) : ""}
        ${m.freight_tsi || m.indpro ? card("Freight and industry", `<div id="m-freight"></div>`, { sub: "freight services and industrial production, rebased to 100" }) : ""}
        ${card("Pharmacy and drug store sales", `<div id="m-jobs"></div>`, { sub: "monthly, $ millions, not seasonally adjusted (December spikes are normal)" })}
        ${card("Health and personal care store sales", `<div id="m-hpc"></div>`, { sub: "monthly, $ millions" })}
      </div>`;
    const Y = D.costs.yoy, t = Y.dates.map(dms);
    const infl = [["cpi_all", "--ink-3"], ["cpi_medical", "--teal"], ["cpi_rx", "--amber"]].filter(([k]) => Y[k]).map(([k, c]) => ({ name: m[k] ? m[k].short : k, t, v: Y[k], color: cssv(c), fmt: "pctchg" }));
    if (infl.length) lineChart($("#m-infl"), { series: infl, height: 240, fmt: "pctchg", zero: true, monthly: true, legend: true, label: "Inflation" });
    const lvl = (k, c) => m[k] ? { name: m[k].short, t: m[k].dates.map(dms), v: m[k].values, color: c, fmt: m[k].fmt } : null;
    const rates = [lvl("ust10", cssv("--amber")), lvl("fedfunds", cssv("--ink-2"))].filter(Boolean);
    if (rates.length) lineChart($("#m-rates"), { series: rates, height: 240, fmt: "pct", legend: true, label: "Interest rates" });
    const curve = lvl("t10y2y", cssv("--amber"));
    if (curve) lineChart($("#m-curve"), { series: [curve], height: 220, fmt: "pct", zero: true, label: "Yield curve" });
    const hy = lvl("hy_spread", cssv("--down"));
    if (hy) lineChart($("#m-hy"), { series: [hy], height: 220, area: true, fmt: "pct", label: "High-yield spread" });
    const ur = lvl("unrate", cssv("--teal"));
    if (ur) lineChart($("#m-unrate"), { series: [ur], height: 220, fmt: "pct", monthly: true, label: "Unemployment rate" });
    const fr = [lvl("freight_tsi", cssv("--amber")), lvl("indpro", cssv("--teal"))].filter(Boolean);
    if (fr.length) lineChart($("#m-freight"), { series: fr, height: 220, rebase: true, monthly: true, legend: true, label: "Freight and industry" });
    const jobs = lvl("pharm_sales", cssv("--teal"));
    if (jobs) lineChart($("#m-jobs"), { series: [jobs], height: 220, area: true, fmt: "musd", monthly: true, label: "Pharmacy sales" });
    const hpc = lvl("retail_hpc", cssv("--amber"));
    if (hpc) lineChart($("#m-hpc"), { series: [hpc], height: 220, area: true, fmt: "musd", monthly: true, label: "Health store sales" });
  }

  // ── Sources ─────────────────────────────────────────────────────────────────
  function renderSources(el) {
    const st = { ok: ["ok", "Healthy"], stale: ["warn", "Using cache"], error: ["bad", "Failing"], partial: ["warn", "Partial"] };
    const rows = (D.health || []).map(h => `<tr><td>${esc(h.group)}</td><td>${h.url ? `<a href="${href(h.url)}" target="_blank" rel="noopener">${esc(h.label)}</a>` : esc(h.label)}</td><td><span class="st"><span class="dot ${(st[h.status] || st.error)[0]}"></span>${(st[h.status] || ["", h.status])[1]}</span></td><td class="num">${h.count ?? ""}</td><td>${esc(h.detail)}</td><td class="muted">${h.as_of ? ago(h.as_of) : ""}</td></tr>`).join("");
    const csvs = [["watchlist.csv", "Watchlist metrics"], ["prices_daily.csv", "Daily prices, 2 years"], ["economic_series.csv", "Economic series"], ["headlines.csv", "Headlines"], ["shortages.csv", "Shortages"], ["recalls.csv", "Recalls"]];
    el.innerHTML = `
      ${card("Source health", `<div class="tbl-wrap"><table class="src-tbl"><thead><tr><th class="l">Group</th><th class="l">Source</th><th class="l">Status</th><th>Items</th><th class="l">Detail</th><th class="l">Checked</th></tr></thead><tbody>${rows}</tbody></table></div><p class="note">When a source fails, the dashboard keeps showing its last good data and marks it here instead of going blank.</p>`, { sub: `build ${esc(D.meta.build_id)}, ${esc(F.full.format(new Date(D.meta.generated_at)))}` })}
      <div class="grid g-2">
        ${card("Download the data", `<p class="prose" style="margin-bottom:10px">Every build publishes CSV files at stable addresses, so Power BI or Excel can refresh from them directly (Get Data, then Web, then paste the address).</p>${D.meta.demo ? `<p class="note">Downloads appear here once the live site is running.</p>` : `<div class="dl-list">${csvs.map(([f, l]) => `<a href="data/csv/${f}" download>${l}</a>`).join("")}<a href="data/latest.json">Full JSON</a></div>`}`)}
        ${card("How it works", `<div class="prose">
          <p>A scheduled job runs every 15 minutes in market hours and every few hours otherwise. It pulls prices, economic series, FDA data and headlines, computes everything on this page, and publishes a static site. An open page checks for a new build every few minutes and updates in place.</p>
          <h3>Impact score</h3><p>Stories are ranked 0 to 100 on how many outlets covered them, source reliability, recency, how many topics they touch, market-moving terms in the headline (lawsuit, recall, acquisition), and whether a named company is moving 2% or more today.</p>
          <h3>Correlations and lead times</h3><p>Series are converted to monthly year-over-year changes before comparing, which removes trend and seasonality. Lead times shift one series forward 0 to 12 months and report the strongest match. Both measure co-movement, not cause.</p>
          <h3>Limits</h3><p>Stock quotes come from free, unofficial sources and can be delayed or briefly wrong. Economic series arrive monthly with a lag. Consumer Rx price indexes sample retail prescriptions, so they understate specialty drug trends. Nothing here is investment advice.</p></div>`)}
      </div>`;
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  const CMDS = {
    TOP: ["Top stories, all desks", () => goNews("all")], N: ["News", () => goNews("all")],
    WEI: ["Market monitor", () => goTo("overview", "#mon")], MON: ["Market monitor", () => goTo("overview", "#mon")],
    MKT: ["Markets", () => goTo("markets")], IMAP: ["Heatmap", () => goTo("markets", "#heat")], WL: ["Watchlist", () => goTo("markets", "#watchlist")],
    ECO: ["Macro and economy", () => goTo("macro")], CMDTY: ["Costs and energy", () => goTo("costs")], OIL: ["Costs and energy", () => goTo("costs")],
    FDA: ["Supply and safety", () => goTo("supply")], SRC: ["Sources and data health", () => goTo("sources")],
    FIN: ["Markets desk news", () => goNews("markets")], TECH: ["Tech desk news", () => goNews("tech")],
    SCM: ["Supply chain desk news", () => goNews("supply")], WRLD: ["World and policy news", () => goNews("world")],
    RX: ["Health and pharmacy news", () => goNews("health")], HLTH: ["Health and pharmacy news", () => goNews("health")],
  };
  function goTo(tab, sel) { closeSearch(); $("#q").value = ""; showTab(tab); requestAnimationFrame(() => scrollToEl(sel ? $(sel) : $(".tabs-bar"))); }
  function goNews(desk) { S.nf.desk = desk; S.nf.limit = 40; rendered.delete("news"); goTo("news"); }
  function runSearch() {
    const input = $("#q"), box = $("#q-results"), q = input.value.trim().toLowerCase();
    if (!q) { box.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
    const cmds = Object.entries(CMDS).filter(([c]) => c.toLowerCase().startsWith(q)).slice(0, 5);
    const tks = D.tickers.filter(t => !t.missing && (t.s.toLowerCase().startsWith(q) || t.n.toLowerCase().includes(q) || (t.short || "").toLowerCase().startsWith(q))).slice(0, 6);
    const ns = D.news.filter(n => n.title.toLowerCase().includes(q)).slice(0, 7);
    box.innerHTML = (cmds.length ? `<h3>Commands</h3>${cmds.map(([c, [l]]) => `<button class="q-item" data-cmd="${c}"><b>${c}</b><span>${esc(l)}</span></button>`).join("")}` : "")
      + (tks.length ? `<h3>Markets and companies</h3>${tks.map(t => `<button class="q-item" data-act="spot" data-s="${esc(t.s)}"><b>${esc(label(t))}</b><span>${esc(t.n)}</span><span class="${tone(t.chgp)}" style="flex:none">${sgn(t.chgp)}</span></button>`).join("")}` : "")
      + (ns.length ? `<h3>Headlines</h3>${ns.map(n => `<a class="q-item" href="${href(n.url)}" target="_blank" rel="noopener"><span>${esc(n.title)}</span><span class="muted" style="flex:none">${esc(n.source)}</span></a>`).join("")}` : "")
      || `<p class="q-empty">Nothing matches “${esc(input.value.trim())}”.</p>`;
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }
  function closeSearch() { const box = $("#q-results"); if (box) box.hidden = true; $("#q").setAttribute("aria-expanded", "false"); }

  // ── Navigation ──────────────────────────────────────────────────────────────
  const PANELS = { overview: renderOverview, markets: renderMarkets, news: renderNews, costs: renderCosts, supply: renderSupply, macro: renderMacro, sources: renderSources };
  const rendered = new Set();
  function showTab(id, { push = true, focusPanel = false } = {}) {
    if (!PANELS[id]) id = "overview";
    S.tab = id;
    for (const t of TABS) {
      const b = $("#t-" + t.id), on = t.id === id;
      b.setAttribute("aria-selected", on);
      b.tabIndex = on ? 0 : -1;
      $("#p-" + t.id).hidden = !on;
    }
    const p = $("#p-" + id);
    if (!rendered.has(id)) { PANELS[id](p); rendered.add(id); }
    else $$(".chart", p).forEach(c => c.__c && c.__c.draw());
    if (push) setHash();
    if (focusPanel) p.focus({ preventScroll: true });
  }
  function setHash() {
    const h = S.tab + (S.tab === "markets" && S.spot ? "/" + S.spot : "");
    if (decodeURIComponent(location.hash.slice(1)) !== h) history.replaceState(null, "", "#" + encodeURIComponent(S.tab) + (S.tab === "markets" && S.spot ? "/" + encodeURIComponent(S.spot) : ""));
  }
  function readHash() {
    const [t, s] = decodeURIComponent(location.hash.slice(1)).split("/");
    if (s && TK.has(s)) S.spot = s;
    return TABS.some(x => x.id === t) ? t : "overview";
  }
  function scrollToEl(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  }
  function openSpot(s) {
    if (!TK.has(s)) return;
    S.spot = s;
    closeSearch();
    if (S.tab !== "markets") showTab("markets");
    else { renderSpot(); setHash(); }
    requestAnimationFrame(() => scrollToEl($("#spot")));
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  app.addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b || !app.contains(b) || b.disabled) return;
    const a = b.dataset.act, k = b.dataset.k;
    if (b.tagName === "A") e.preventDefault();
    switch (a) {
      case "tab": showTab(b.dataset.tab); closeSearch(); if (EMBED) scrollToEl($(".tabs-bar")); break;
      case "goto": if (b.dataset.s) S.spot = b.dataset.s; showTab(b.dataset.tab); scrollToEl($(".tabs-bar")); break;
      case "spot": openSpot(b.dataset.s); break;
      case "star": {
        e.stopPropagation();
        const s = b.dataset.s;
        S.stars.has(s) ? S.stars.delete(s) : S.stars.add(s);
        store.set("stars", [...S.stars]);
        renderTape(); renderWatchlist();
        if ($("#spot")) renderSpot();
        break;
      }
      case "mover": S.mover = k; renderMovers(); break;
      case "seg-go": S.wlSeg = k; S.wlSort = { k: "seg", dir: 1 }; showTab("markets"); renderWatchlist(); requestAnimationFrame(() => scrollToEl($("#watchlist"))); break;
      case "heat": S.heat = k; renderHeat(); break;
      case "wlseg": S.wlSeg = k; renderWatchlist(); break;
      case "wlgroup": S.wlSort = { k: "seg", dir: 1 }; renderWatchlist(); break;
      case "wlsort": S.wlSort = S.wlSort.k === k ? { k, dir: -S.wlSort.dir } : { k, dir: k === "s" ? 1 : -1 }; renderWatchlist(); break;
      case "range": S.range = k; $$("[data-act=range]").forEach(x => x.setAttribute("aria-pressed", x.dataset.k === k)); drawSpotChart(); break;
      case "cmp": { const s = b.dataset.s; S.cmp.has(s) ? S.cmp.delete(s) : S.cmp.add(s); b.setAttribute("aria-pressed", S.cmp.has(s)); drawSpotChart(); break; }
      case "ncat": S.nf.cats.has(k) ? S.nf.cats.delete(k) : S.nf.cats.add(k); S.nf.limit = 40; renderNewsList(); break;
      case "nwin": S.nf.hours = +k; S.nf.limit = 40; renderNewsList(); break;
      case "nsort": S.nf.sort = k; renderNewsList(); break;
      case "nmore": S.nf.limit += 40; renderNewsList(); break;
      case "nreset": S.nf = { desk: "all", cats: new Set(), src: "all", linked: false, q: "", sort: "score", hours: 72, limit: 40 }; rendered.delete("news"); showTab("news"); break;
      case "ndesk": S.nf.desk = k; S.nf.limit = 40; renderNewsList(); break;
      case "eser": if (S.energy.keys.has(k) && S.energy.keys.size > 1) S.energy.keys.delete(k); else S.energy.keys.add(k); drawEnergy(); break;
      case "erange": S.energy.range = k; drawEnergy(); break;
      case "yoy": if (S.yoyKeys.has(k) && S.yoyKeys.size > 1) S.yoyKeys.delete(k); else S.yoyKeys.add(k); drawYoy(); break;
      case "corr": S.corr = [+b.dataset.i, +b.dataset.j]; $$("[data-act=corr]").forEach(x => x.setAttribute("aria-pressed", (+x.dataset.i === S.corr[0] && +x.dataset.j === S.corr[1]) || (+x.dataset.i === S.corr[1] && +x.dataset.j === S.corr[0]))); renderCorrDetail(); break;
      case "ll": S.ll = +k; renderLeadLag(); break;
      case "shcat": S.sup.cat = S.sup.cat === k ? null : k; renderShortages(); break;
      case "rcls": S.sup.cls = k; renderRecalls(); break;
      case "theme": {
        const order = ["terminal", "dark", "light", "auto"], cur = document.documentElement.dataset.theme || "auto";
        const next = order[(order.indexOf(cur) + 1) % order.length];
        document.documentElement.dataset.theme = next;
        store.set("theme", next);
        rerenderAll();
        break;
      }
    }
  });
  app.addEventListener("keydown", e => {
    const el = e.target;
    if ((e.key === "Enter" || e.key === " ") && el.matches && el.matches("tr[data-act]")) { e.preventDefault(); el.click(); }
    if (el.getAttribute && el.getAttribute("role") === "tab" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const i = TABS.findIndex(t => t.id === S.tab), n = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
      showTab(TABS[n].id);
      $("#t-" + TABS[n].id).focus();
    }
  });
  document.addEventListener("keydown", e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (e.key === "Escape") { closeSearch(); if (typing) document.activeElement.blur(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
    else if (/^[1-7]$/.test(e.key)) { showTab(TABS[+e.key - 1].id); }
  });
  document.addEventListener("click", e => { if (!e.target.closest(".search")) closeSearch(); });

  function wireSearch() {
    const input = $("#q");
    input.addEventListener("input", debounce(runSearch, 100));
    input.addEventListener("focus", () => { if (input.value.trim()) runSearch(); });
    input.addEventListener("keydown", e => {
      const items = $$("#q-results .q-item");
      if (e.key === "ArrowDown" && items.length) { e.preventDefault(); items[0].focus(); }
      if (e.key === "Enter") {
        const cmd = input.value.trim().toUpperCase();
        if (CMDS[cmd]) { e.preventDefault(); CMDS[cmd][1](); return; }
        if (items.length) { e.preventDefault(); items[0].click(); }
      }
    });
    $("#q-results").addEventListener("click", e => { const b = e.target.closest("[data-cmd]"); if (b) CMDS[b.dataset.cmd][1](); });
    $("#q-results").addEventListener("keydown", e => {
      const items = $$("#q-results .q-item"), i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); i <= 0 ? input.focus() : items[i - 1].focus(); }
    });
  }

  // ── Render all, live updates ────────────────────────────────────────────────
  function renderTop() {
    renderStatus(); renderBanner(); renderTape(); renderLabel(); renderKpis(); renderTabCounts(); renderFoot();
  }
  function rerenderAll() {
    renderTop();
    rendered.clear();
    showTab(S.tab, { push: false });
  }
  function flashPrices(prev) {
    for (const [s, old] of prev) {
      const t = TK.get(s);
      if (!t || !ok(t.px) || !ok(old) || t.px === old) continue;
      $$(`[data-px="${CSS.escape(s)}"]`).forEach(el => {
        el.classList.remove("flash-up", "flash-down");
        void el.offsetWidth;
        el.classList.add(t.px > old ? "flash-up" : "flash-down");
      });
    }
  }
  let failures = 0;
  async function poll() {
    if (location.protocol === "file:") return;
    try {
      const r = await fetch(`data/meta.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const meta = await r.json();
      failures = 0;
      if (meta.build_id && meta.build_id !== D.meta.build_id) {
        const r2 = await fetch(`data/latest.json?t=${Date.now()}`, { cache: "no-store" });
        if (!r2.ok) throw new Error(r2.status);
        const next = await r2.json();
        const prev = new Map(D.tickers.map(t => [t.s, t.px]));
        D = next;
        index();
        rerenderAll();
        flashPrices(prev);
        $("#live").textContent = "Dashboard updated with new data.";
      }
    } catch (err) {
      failures++;
    }
    renderStatus();
  }

  function tick() {
    $$("[data-ago]").forEach(el => { el.textContent = ago(el.dataset.ago); });
  }

  function postHeight() {
    if (!EMBED || window.parent === window) return;  // only when framed by the embed snippet
    const h = Math.ceil(document.body.getBoundingClientRect().height);
    try { window.parent.postMessage({ type: "rxpulse:height", height: h }, "*"); } catch (e) { /* ignore */ }
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  shell();
  wireSearch();
  renderTop();
  showTab(readHash(), { push: false });
  window.addEventListener("hashchange", () => showTab(readHash(), { push: false }));
  setInterval(tick, 30e3);
  setInterval(renderStatus, 60e3);
  setInterval(poll, Math.max(1, +SITE.poll_minutes || 3) * 60e3);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  if (EMBED) {
    new ResizeObserver(postHeight).observe(document.body);
    window.addEventListener("load", postHeight);
  }
  const mq = matchMedia("(prefers-color-scheme: dark)");
  if (mq.addEventListener) mq.addEventListener("change", () => { if ((document.documentElement.dataset.theme || "auto") === "auto") rerenderAll(); });
})();
