/*
 * Solix X1 card for Home Assistant: one screen for an Anker SOLIX X1 home battery system.
 *
 * Dependency-free. Live values come from the Anker Solix integration's entities (the 5-minute averages the
 * cloud reports), history from the cloud's own statistics through the integration's raw-request action, so
 * the day, week, month and year views are the Anker app's figures from the first day.
 *
 * Layout: on a laptop, one screen cut to the window's height: on the left a column for the period (the title bar,
 * the home drawn with its power flowing beside the battery's ring, the power chart), on the right a column for the
 * place (its name, the period's six headline figures, the battery's charge on a small chart, the period's meaning).
 * The two charts read the same moment. A phone stacks the parts, the house and its battery first, and scrolls.
 *
 * Rules the screen keeps: every figure derives from the same flows (solar = to home + to battery + to grid;
 * home = from solar + from battery + from grid); directions are words, signs live only in the chart; the
 * reserve is drawn wherever the charge is; nothing moves the layout; the card claims only what is reported.
 *
 * Config:
 *   type: custom:solix-x1-card
 *   site: <site id>              # found from the integration's site device when omitted
 *   name: Home                   # heads the Now column
 *   reserve: 20                  # backup reserve, %, as set in the Anker app (the cloud does not report it)
 *   capacity_kwh: 40             # found from the battery modules when omitted
 *   array_kw: 6.5                # the most the array makes, its best clear-day output: every pixel lights at it
 *   view: day                    # day | week | month | year; the viewer's last choice wins
 *   rate_import: 0.42            # optional, per kWh in the home's currency: prices each period's saving
 *   rate_export: 0.07
 */
(() => {
  "use strict";
  const TAG = "solix-x1-card";
  const VERSION = "1.0.22";
  if (customElements.get(TAG)) return;

  const DAY = 864e5, HOUR = 36e5, FIVE_MIN = 3e5;
  const VIEWS = ["day", "week", "month", "year"];
  const VIEW_KEY = "solix-x1-card:view";
  const HINT_KEY = "solix-x1-card:hinted";
  const PEAK_KEY = "solix-x1-card:peaks";
  const NB = " ";
  const REFRESH_MS = 5 * 60e3;
  const LIVE_KEYS = ["state_of_charge", "solar_power", "home_demand", "grid_import", "grid_export", "charge_power", "discharge_power", "data_time", "cloud_state"];
  const SITE_KEYS = ["cost_savings", "co2_savings", "yield_total", "battery_modules", "parallel_devices", "connection"];
  const MODES = { 0: "Self-consumption", 1: "Time of use", 2: "Off-grid use", 11: "Bill saving", 16: "Time slots", 20: "AI energy management" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = (n) => String(n).padStart(2, "0");
  // the sources' icons above the drawing, each filled in its source's colour: the sun, a battery on its side with its
  // terminal a pixel clear of the body, and a power plant for the grid
  const ICONS = {
    // one family on a 20-unit grid: each box centred on 10,10, about a third of the square in ink, corners softened like the
    // battery's. The sun and the plant are drawn half a unit inside their size and stroked back out by a grade per theme
    // (--x1-grade-*), so each carries the same weight on either ground; the battery is the ungraded reference
    solar: `<svg class="pi solar" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.9"/><path d="M16.7 10L18.4 10M14.74 14.74L15.94 15.94M10 16.7L10 18.4M5.26 14.74L4.06 15.94M3.3 10L1.6 10M5.26 5.26L4.06 4.06M10 3.3L10 1.6M14.74 5.26L15.94 4.06"/></svg>`,
    batt: `<svg class="pi batt" viewBox="0 0 20 20" aria-hidden="true"><rect x="1.8" y="5.3" width="14.4" height="9.4" rx="3"/><rect x="17.2" y="7.6" width="1.8" height="4.8" rx=".9"/></svg>`,
    grid: `<svg class="pi grid" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.9 16.9V11.1l3.7 2.2V11.1l3.7 2.2V11.1l3.7 2.2V3.3h2.8v13.6Z"/></svg>`,
  };
  // The drawing's frame, in metres of house: D deep, LN long, HT to the eaves, R the roof's rise, e the overhang; the
  // service pole in the gable's plane just past the overhang; the array's columns. Across, the frame runs from just past
  // the panels' far corner (UL) to the pole's crossarm (UR), SPAN in all, at 0.707 k a metre; TOP is the figures' band.
  const FLOW = (() => {
    const D = 8.6, LN = 12, HT = 3, R = 2.4, e = 0.5, td = 0.375;
    const poleA = 0, poleB0 = D + e + 0.25, poleR = 0.12, arm1 = 0.6, arm2 = 0.42;
    const cols = 4, rows = 2, cw = 1.4, aa0 = 0.35, aa1 = aa0 + cols * cw, pb0 = 0.6, pb1 = D / 2 - 0.55;
    const UL = -0.707 * (aa1 - pb0) - 0.25, UR = 0.707 * (poleB0 - poleA + arm1) + 0.12;
    return { D, LN, HT, R, e, td, poleA, poleB0, poleR, arm1, arm2, cols, rows, cw, aa0, aa1, pb0, pb1, UL, UR, SPAN: UR - UL, TOP: 10 };
  })();
  // The panels' pixels light in one fixed random order, the same on every screen: a pixel lit at 2 kW stays lit at
  // 3 kW, so a change of power lights or darkens a few more and never reshuffles the rest.
  const PANELS = 8, PX = 48;
  let pxOrder = null;
  const pixelOrder = () => {
    if (pxOrder) return pxOrder;
    const n = PANELS * PX * PX, o = new Uint16Array(n);
    for (let i = 0; i < n; i++) o[i] = i;
    let x = 0x9e3779b9;
    const rnd = () => { x |= 0; x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)), t = o[i]; o[i] = o[j]; o[j] = t; }
    return (pxOrder = o);
  };

  /* ----- formatting in the home's language and time zone ----- */
  class Fmt {
    constructor(lang, tz, clock, numbers) {
      this.lang = lang || "en"; this.tz = tz;
      const base = { timeZone: tz };
      const h12 = clock === "12" ? true : clock === "24" ? false : undefined;
      this._time = new Intl.DateTimeFormat(this.lang, { ...base, hour: "numeric", minute: "2-digit", ...(h12 === undefined ? {} : { hour12: h12 }) });
      this._hour = new Intl.DateTimeFormat(this.lang, { ...base, hour: "numeric", ...(h12 === undefined ? {} : { hour12: h12 }) });
      this._wd = new Intl.DateTimeFormat(this.lang, { ...base, weekday: "short" });
      this._wdd = new Intl.DateTimeFormat(this.lang, { ...base, weekday: "short", month: "short", day: "numeric" });
      this._md = new Intl.DateTimeFormat(this.lang, { ...base, month: "short", day: "numeric" });
      this._mon = new Intl.DateTimeFormat(this.lang, { ...base, month: "short" });
      this._monY = new Intl.DateTimeFormat(this.lang, { ...base, month: "long", year: "numeric" });
      this._long = new Intl.DateTimeFormat(this.lang, { ...base, weekday: "long", month: "long", day: "numeric" });
      this._parts = new Intl.DateTimeFormat("en-US", { ...base, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hour12: false });
      this._nums = numbers === "comma_decimal" ? "en-US" : numbers === "decimal_comma" ? "de-DE" : numbers === "space_comma" ? "fr-FR" : this.lang;
      this._nf = {};
    }
    num(v, dp = 0) { if (!Number.isFinite(v)) return "—"; const k = dp; this._nf[k] = this._nf[k] ?? new Intl.NumberFormat(this._nums, { minimumFractionDigits: dp, maximumFractionDigits: dp }); return this._nf[k].format(v); }
    time(t) { return this._time.format(new Date(t)); }
    hour(t) { return this._hour.format(new Date(t)); }
    weekday(t) { return this._wd.format(new Date(t)); }
    wdd(t) { return this._wdd.format(new Date(t)); }
    md(t) { return this._md.format(new Date(t)); }
    mon(t) { return this._mon.format(new Date(t)); }
    monY(t) { return this._monY.format(new Date(t)); }
    long(t) { return this._long.format(new Date(t)); }
    parts(t) { const o = {}; for (const p of this._parts.formatToParts(new Date(t))) if (p.type !== "literal") o[p.type] = Number(p.value); if (o.hour === 24) o.hour = 0; return o; }
    // local calendar helpers: dates as "YYYY-MM-DD" in the home's zone
    dateStr(t) { const p = this.parts(t); return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`; }
    // the instant of local midnight for a date string, found by walking from the UTC guess
    midnight(ds) {
      const [y, m, d] = ds.split("-").map(Number);
      let t = Date.UTC(y, m - 1, d, 12);
      for (let i = 0; i < 3; i++) { const p = this.parts(t); t -= ((p.hour * 60 + p.minute) * 60e3); if (p.day !== d || p.month !== m) t += DAY * Math.sign(d - p.day || m - p.month); }
      const p = this.parts(t); return p.hour === 0 && p.minute === 0 && p.day === d ? t : t - ((p.hour * 60 + p.minute) * 60e3);
    }
    addDays(ds, n) { return this.dateStr(this.midnight(ds) + n * DAY + 12 * HOUR); }
    daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
    dur(ms) { const h = Math.floor(ms / HOUR), m = Math.round((ms % HOUR) / 60e3); return h ? `${h}${NB}h${m ? ` ${m}${NB}min` : ""}` : `${m}${NB}min`; }
    ago(ms) { if (ms < 59.5e3) return `${Math.max(1, Math.round(ms / 1e3))}${NB}s ago`; if (ms < 90 * 60e3) return `${Math.max(1, Math.round(ms / 60e3))}${NB}min ago`; if (ms < DAY) return `${Math.round(ms / HOUR)}${NB}h ago`; return `${Math.round(ms / DAY)}${NB}d ago`; }
  }

  // Sunrise and sunset for a day, NOAA's approximation: good to a couple of minutes, enough for a daylight ribbon.
  function sunTimes(midnightLocal, lat, lon) {
    const rad = Math.PI / 180, noon = midnightLocal + 12 * HOUR;
    const jd = noon / DAY + 2440587.5, n = jd - 2451545;
    const L = (280.46 + 0.9856474 * n) % 360, g = (357.528 + 0.9856003 * n) * rad;
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, eps = 23.439 * rad;
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / rad;
    const eqt = ((L - (ra + 360) % 360 + 540) % 360 - 180) * 4;
    const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
    if (cosH < -1 || cosH > 1) return { rise: null, set: null };
    const H = Math.acos(cosH) / rad;
    const solarNoonUtc = 720 - 4 * lon - eqt;
    const utcMidnight = Math.floor(noon / DAY) * DAY;
    return { rise: utcMidnight + (solarNoonUtc - H * 4) * 60e3, set: utcMidnight + (solarNoonUtc + H * 4) * 60e3 };
  }

  const STYLE = `
:host {
  display: block;
  /* the sources keep one colour everywhere: solar amber, the battery blue, the grid violet; solar sold is green.
     The blue and the violet are set apart in lightness so they part for colour-blind eyes too (validated pairwise) */
  --x1-solar: #eda100; --x1-batt: #43a3e8; --x1-grid: #7b3fbf; --x1-sold: #2f9e5b; --x1-home: var(--x1-ink);
  /* the icons' grade: amber is the faintest of the three on white and violet the faintest on black, so each is drawn a little fuller there */
  --x1-grade-solar: 1.5px; --x1-grade-grid: .5px;
  --x1-solar-tint: color-mix(in srgb, var(--x1-solar) 40%, var(--x1-surface)); --x1-grid-tint: color-mix(in srgb, var(--x1-grid) 40%, var(--x1-surface));
  --x1-muted: #898781; --x1-grid-line: #e1e0d9; --x1-axis: #c3c2b7; --x1-wash: rgba(11,11,11,0.035);
  --x1-on: #ffffff; --x1-off: #2f7fe0; --x1-fault: #d03b3b;
  --x1-surface: var(--ha-card-background, var(--card-background-color, #fff));
  --x1-ink: var(--primary-text-color, #0b0b0b);
  --x1-ink2: var(--secondary-text-color, #52514e);
  --x1-fs-read: var(--ha-font-size-2xl, 24px);
  --x1-fs-stat: 28px;
  --x1-fs-title: var(--ha-font-size-l, 16px);
  --x1-fs-body: var(--ha-font-size-m, 14px);
  --x1-fs-small: var(--ha-font-size-s, 12px);
  --x1-w-regular: var(--ha-font-weight-normal, 400);
  --x1-w-medium: var(--ha-font-weight-medium, 500);
  --x1-gap: var(--ha-space-4, 16px);
  --x1-pad: var(--ha-space-5, 20px);
  --x1-well: color-mix(in srgb, var(--x1-ink) 3%, var(--x1-surface));
  /* a tile: a surface inside a card, set apart by its own tone, so it reads in a theme that draws no card borders */
  --x1-tile: color-mix(in srgb, var(--x1-ink) 4%, var(--x1-surface)); --x1-tile-line: color-mix(in srgb, var(--x1-ink) 11%, var(--x1-surface)); --x1-tile-r: 8px;
  /* The sun stands high at the upper right. Each plane of the house takes the light its facing gets: the back slope the
     most, the front slope next, the gable and the long wall only the sky's. A light theme draws the house high in key, a
     dark one low, and in both the lit planes are the lightest; inside each plane a gradient carries the light (the
     ridge catching it, the wall dark under the eave, the feet occluded), and planes meet by value, never by an outline.
     --x1-key is the ink the house is toned with, a little cool, toward the panels' glass. */
  --x1-key: color-mix(in srgb, var(--x1-ink) 88%, #3f5f99);
  --x1-roof-back: color-mix(in srgb, var(--x1-key) 6%, var(--x1-surface));
  --x1-roof-hi: color-mix(in srgb, var(--x1-key) 5.5%, var(--x1-surface)); --x1-roof: color-mix(in srgb, var(--x1-key) 8.5%, var(--x1-surface)); --x1-roof-lo: color-mix(in srgb, var(--x1-key) 12%, var(--x1-surface));
  --x1-gable-hi: color-mix(in srgb, var(--x1-key) 10%, var(--x1-surface)); --x1-gable: color-mix(in srgb, var(--x1-key) 14%, var(--x1-surface)); --x1-gable-lo: color-mix(in srgb, var(--x1-key) 18%, var(--x1-surface));
  --x1-wall-hi: color-mix(in srgb, var(--x1-key) 18%, var(--x1-surface)); --x1-wall: color-mix(in srgb, var(--x1-key) 21%, var(--x1-surface)); --x1-wall-lo: color-mix(in srgb, var(--x1-key) 27%, var(--x1-surface)); --x1-wall-foot: color-mix(in srgb, var(--x1-key) 24%, var(--x1-surface));
  --x1-trim: color-mix(in srgb, var(--x1-key) 13%, var(--x1-surface)); --x1-trim-g: color-mix(in srgb, var(--x1-key) 16.5%, var(--x1-surface));
  --x1-box: color-mix(in srgb, var(--x1-key) 13%, var(--x1-surface)); --x1-box-top: color-mix(in srgb, var(--x1-key) 5%, var(--x1-surface));
  --x1-shadow: rgba(16, 22, 38, .16); --x1-frame: color-mix(in srgb, var(--x1-ink) 6%, var(--x1-surface));
  --x1-cab: color-mix(in srgb, var(--x1-batt) 19%, var(--x1-surface)); --x1-cab-lit: color-mix(in srgb, var(--x1-batt) 11%, var(--x1-surface)); --x1-cab-top: color-mix(in srgb, var(--x1-batt) 7%, var(--x1-surface));
  --x1-plate-front: color-mix(in srgb, var(--x1-plate) 95%, #000); --x1-plate-top: color-mix(in srgb, var(--x1-plate) 55%, #fff); --x1-plate-side: color-mix(in srgb, var(--x1-plate) 72%, #000);
  --x1-cast: #1a1e2e; --x1-cast-a: .2; --x1-pshade-a: .2;
  --x1-batt-shade: color-mix(in srgb, var(--x1-batt) 80%, #000);
  --x1-pole-dark: var(--x1-wall); --x1-pole-lit: var(--x1-gable); --x1-pole-top: color-mix(in srgb, var(--x1-ink) 2%, var(--x1-surface)); --x1-pole-edge: color-mix(in srgb, var(--x1-ink) 19%, var(--x1-surface));
  /* the panels are glass: a sheen toward the sun at their upper right, deepening across them */
  --x1-panel-off: color-mix(in srgb, #2c3a52 80%, var(--x1-surface)); --x1-panel-on: color-mix(in srgb, var(--x1-solar) 72%, var(--x1-surface));
  --x1-panel-sheen: color-mix(in srgb, #4f6286 74%, var(--x1-surface)); --x1-panel-deep: color-mix(in srgb, #1f2a40 90%, var(--x1-surface));
  /* a line carrying nothing shows faintly against the house: a quiet step from the planes it crosses, in both themes */
  --x1-plate: #ffffff; --x1-wire-idle: color-mix(in srgb, var(--x1-ink) 34%, var(--x1-surface));
  --x1-batt-lit: color-mix(in srgb, var(--x1-batt) 78%, #fff); --x1-batt-top: color-mix(in srgb, var(--x1-batt) 58%, #fff);
  font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif);
  font-size: var(--x1-fs-body); line-height: 20px; font-weight: var(--x1-w-regular);
  color: var(--x1-ink);
  -webkit-font-smoothing: antialiased;
}
:host(.dark) {
  --x1-solar: #f2b036; --x1-batt: #62b4f0; --x1-grid: #9468e6; --x1-sold: #5ac28a; --x1-grid-line: #34342f; --x1-axis: #4a4a43;
  --x1-grade-solar: .8px; --x1-grade-grid: 1.6px;
  --x1-tile: color-mix(in srgb, var(--x1-ink) 6.5%, var(--x1-surface)); --x1-tile-line: color-mix(in srgb, var(--x1-ink) 15%, var(--x1-surface));
  --x1-solar-tint: color-mix(in srgb, var(--x1-solar) 66%, var(--x1-surface)); --x1-grid-tint: color-mix(in srgb, var(--x1-grid) 62%, var(--x1-surface));
  --x1-roof-back: color-mix(in srgb, var(--x1-key) 12.5%, var(--x1-surface));
  --x1-roof-hi: color-mix(in srgb, var(--x1-key) 14%, var(--x1-surface)); --x1-roof: color-mix(in srgb, var(--x1-key) 10.5%, var(--x1-surface)); --x1-roof-lo: color-mix(in srgb, var(--x1-key) 7%, var(--x1-surface));
  --x1-gable-hi: color-mix(in srgb, var(--x1-key) 9.5%, var(--x1-surface)); --x1-gable: color-mix(in srgb, var(--x1-key) 5.5%, var(--x1-surface)); --x1-gable-lo: color-mix(in srgb, var(--x1-key) 1.5%, var(--x1-surface));
  --x1-wall-hi: color-mix(in srgb, #000 16%, var(--x1-surface)); --x1-wall: color-mix(in srgb, #000 27%, var(--x1-surface)); --x1-wall-lo: color-mix(in srgb, #000 44%, var(--x1-surface)); --x1-wall-foot: color-mix(in srgb, #000 38%, var(--x1-surface));
  --x1-trim: color-mix(in srgb, var(--x1-key) 3%, var(--x1-surface)); --x1-trim-g: color-mix(in srgb, var(--x1-key) 3.5%, var(--x1-surface));
  --x1-box: color-mix(in srgb, var(--x1-key) 2%, var(--x1-surface)); --x1-box-top: color-mix(in srgb, var(--x1-key) 8%, var(--x1-surface));
  --x1-shadow: rgba(0, 0, 0, .45); --x1-frame: color-mix(in srgb, var(--x1-key) 18%, var(--x1-surface));
  --x1-cab: color-mix(in srgb, var(--x1-batt) 14%, var(--x1-surface)); --x1-cab-lit: color-mix(in srgb, var(--x1-batt) 22%, var(--x1-surface)); --x1-cab-top: color-mix(in srgb, var(--x1-batt) 28%, var(--x1-surface));
  --x1-batt-lit: color-mix(in srgb, var(--x1-batt) 80%, #fff);
  --x1-cast: #000; --x1-cast-a: .6; --x1-pshade-a: .55;
  --x1-pole-dark: var(--x1-wall); --x1-pole-lit: var(--x1-gable); --x1-pole-top: var(--x1-roof-back); --x1-pole-edge: color-mix(in srgb, #000 40%, var(--x1-surface));
  --x1-panel-off: color-mix(in srgb, #1a2540 82%, var(--x1-surface)); --x1-panel-on: color-mix(in srgb, var(--x1-solar) 76%, var(--x1-surface));
  --x1-panel-sheen: color-mix(in srgb, #34476c 82%, var(--x1-surface)); --x1-panel-deep: color-mix(in srgb, #0a1120 86%, var(--x1-surface));
  --x1-plate: #d9d9d3; --x1-wire-idle: color-mix(in srgb, var(--x1-ink) 26%, var(--x1-surface));
  --x1-wash: rgba(255,255,255,0.045); --x1-on: #e9e9e9; --x1-off: #6aa7f4; --x1-fault: #f06a5f;
}
* { box-sizing: border-box; }
.wrap { margin: 0 auto; padding: var(--x1-gap); display: grid; gap: var(--x1-gap); max-width: 1680px; }
/* the period's column on the left; the place's on the right, a third of the width, wide enough for the six figures
   three to a row */
.wrap.wide { grid-template-columns: minmax(0, 1fr) clamp(320px, 34%, 460px); height: var(--x1-h, auto); }
.wrap.wide.tight { grid-template-columns: minmax(0, 1fr) clamp(320px, 30%, 400px); }
.wide .col-period { grid-column: 1; grid-row: 1; }
.wide .col-now { grid-column: 2; grid-row: 1; }
.col-now, .col-period { display: flex; flex-direction: column; gap: var(--x1-gap); min-width: 0; min-height: 0; }
.card.now { flex: none; }
.card { background: var(--x1-surface); border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
  box-shadow: var(--ha-card-box-shadow, none); padding: var(--x1-pad); min-width: 0; display: flex; flex-direction: column; }
.wide .card { min-height: 0; overflow: hidden; }
.narrow .card { padding: var(--x1-gap); }
.narrow .flow { min-height: 208px; }
.split .flow { margin-left: calc(-1 * var(--x1-pad)); margin-right: calc(-1 * var(--x1-pad)); align-items: flex-end; }
.wide .card.now { gap: 12px; }
.wide.tight .card.now { gap: 8px; }
/* the drawing's card under the title bar: the drawing rooted at the card's left edge, cut there as the house runs off
   it, with twice the chart cards' padding above and below; on a wide screen a panel on its right holds the line of
   sources at the top, level with the top figures, and the battery's ring under it */
.card.house { flex: none; gap: 8px; }
.card.house > .lede { margin: 0; }
.card.house > .flow { flex: 1 1 auto; margin-top: 0; min-height: 0; }
.split .card.house { height: var(--x1-house, 300px); padding: 28px 14px; display: grid; grid-template-columns: minmax(0, 1fr) var(--x1-panel, clamp(236px, 33%, 296px)); grid-template-rows: auto minmax(0, 1fr); column-gap: 16px; row-gap: 8px; }
.wide.tight .card.house { padding: 20px 10px; }
/* the panel is a tile standing in the card's padding, as far from the card's top, right and bottom edges as the card's
   side padding; the line of sources is its head, over a hairline, and the ring and its words fill the rest */
.split .card.house::before { content: ""; grid-column: 2; grid-row: 1 / span 2; margin: -14px 0; background: var(--x1-tile); border: var(--ha-card-border-width, 1px) solid var(--x1-tile-line); border-radius: var(--x1-tile-r); }
.wide.tight .card.house::before { margin: -10px 0; }
.split .card.house > .lede { padding: 0 12px 13px; border-bottom: 1px solid var(--x1-tile-line); }
.wide.tight .card.house > .lede { padding-bottom: 9px; }
.split .card.house > .flow { grid-column: 1; grid-row: 1 / span 2; }
.split .card.house > .lede { grid-column: 2; grid-row: 1; justify-self: stretch; justify-content: center; }
.split .card.house > .hero-row { grid-column: 2; grid-row: 2; align-self: center; flex-direction: column; align-items: center; gap: 10px; margin: 0; min-width: 0; padding: 0 12px; }
.split .card.house .hero-txt { flex: none; width: 100%; justify-items: center; text-align: center; gap: 2px; }
.split .card.house .hero-txt .v { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
/* a phone: the same battery tile, first, over the drawing; the line of sources its head over a hairline, the ring and
   its words in a row under it */
.narrow:not(.split) .card.house { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; }
.narrow:not(.split) .card.house::before { content: ""; grid-column: 1; grid-row: 1 / span 2; background: var(--x1-tile); border: var(--ha-card-border-width, 1px) solid var(--x1-tile-line); border-radius: var(--x1-tile-r); }
.narrow:not(.split) .card.house > .lede { grid-row: 1; grid-column: 1; margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--x1-tile-line); justify-content: center; }
.narrow:not(.split) .card.house > .hero-row { grid-row: 2; grid-column: 1; margin: 0; padding: 14px; gap: 16px; }
.narrow:not(.split) .card.house > .flow { grid-row: 3; grid-column: 1; margin-top: 14px; }
/* stacked, a phone reads the house and its battery first, then the place and the period's figures, the period's
   bar over its charts, the power, the battery's charge and the period's meaning */
.narrow .col-now, .narrow .col-period { display: contents; }
.narrow .card.house { order: 1; }
.narrow .card.now { order: 2; }
.narrow .pbar { order: 3; }
.narrow .col-period > .pbody { order: 4; }
.narrow .pbody.pb2 { order: 5; }
.narrow .meaning { order: 6; }
.split .card.house > .flow { margin: 0 0 0 -14px; }
.wide.tight .card.house > .flow { margin: 0 0 0 -10px; }
.pbody.pb2 { flex: none; }
.wide .pbody.pb2 { flex: none; height: var(--x1-charts, auto); min-height: 0; }
/* the place's two cards stand level with the house card: they share its extra height two to one (two rows of tiles to
   one), their tiles grow with it, and each tile's figure sits at its foot, its name at the top */
.wide .col-now > .card.now { flex: 2 1 auto; }
.wide .col-now > .card.meaning { flex: 1 1 auto; }
.wide .col-now .card.now .heads { flex: 1 1 auto; grid-auto-rows: 1fr; }
.wide .heads .cell.card { display: flex; flex-direction: column; }
.wide .heads .cell .cv { margin-top: auto; }
.wide .card.meaning .rings { flex: 1 1 auto; grid-auto-rows: 1fr; }
.wide .card.meaning .rg { align-content: space-between; }
/* the period's six figures in the Now column, three by two */
.col-now .heads { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.card.now { container: now / inline-size; }
@container now (min-width: 760px) { .col-now .card.now .heads { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
.narrow .pbody.pb2 { min-height: 0; }
/* the battery's strip in the Now column: its key over it, in a row */
.col-now .chart { grid-template-columns: minmax(0, 1fr); row-gap: 6px; }
.col-now .ck { flex-direction: row; flex-wrap: wrap; gap: 2px 14px; margin-top: 2px; font-size: 13px; line-height: 18px; }
.col-now .ck .sw { width: 12px; height: 12px; margin-right: 6px; vertical-align: -1px; }
.col-now .ck .kgp:has(.say) { flex-basis: 100%; }
.col-now .ct { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 12px; }
.col-now .ct .ck { flex: 1 1 auto; }
.tight { --x1-gap: 10px; --x1-pad: var(--ha-space-4, 16px); }
.tight .flow { min-height: 132px; margin-top: 6px; }
.tight .hero-row { margin-top: 8px; }
h2 { font-size: var(--x1-fs-title); line-height: 24px; font-weight: var(--x1-w-medium); margin: 0; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-height: 24px; }
.small { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); }
.meta { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.unit { font-size: var(--x1-fs-body); color: var(--x1-ink2); margin-left: 2px; font-weight: var(--x1-w-regular); }
.lamp { display: inline-flex; align-items: baseline; gap: 6px; font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); margin-left: auto; white-space: nowrap; }
.lamp i { width: 9px; height: 9px; border-radius: 50%; background: var(--x1-ink2); flex: none; }
.lamp.stale i { background: transparent; border: 1.5px dashed var(--x1-ink2); }
.lamp.unknown i { background: transparent; border: 1.5px solid var(--x1-ink2); }

/* The Now column: the battery, what it means, the flow, today's four figures. */
.hero-row { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
/* the ring is sized by the window's height (--x1-ring), and the figure inside it by the ring */
.ring { flex: none; position: relative; width: var(--x1-ring, 148px); height: var(--x1-ring, 148px); }
.ring svg { display: block; width: 100%; height: 100%; overflow: visible; }
.ring .track { stroke: var(--x1-grid-line); }
.ring .arc { stroke: var(--x1-batt); transition: stroke-dasharray .6s ease; }
.ring .res { stroke: var(--x1-axis); }
/* the charge alone at the ring's centre, its word under it */
.ring .lbl { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
/* the figures' visual middle sits a little above the ring's: Roboto's figures are cap height under a 1.0 line, so
   they are lifted a hair from the line's centre */
.ring .lbl .hero { transform: translateY(-.035em); font-weight: var(--x1-w-regular); }
.hero { font-size: calc(var(--x1-ring, 148px) * .4); line-height: 1; letter-spacing: -0.02em; font-weight: var(--x1-w-medium); font-variant-numeric: tabular-nums; display: flex; align-items: flex-start; }
.hero.n3 { font-size: calc(var(--x1-ring, 148px) * .285); }
.hero .u { font-size: calc(var(--x1-ring, 148px) * .162); line-height: 1; letter-spacing: 0; color: var(--x1-ink2); margin: calc(var(--x1-ring, 148px) * .04) 0 0 2px; }
.hero-txt { flex: 1 1 auto; min-width: 0; display: grid; gap: 4px; align-content: center; }
.hero-txt .k { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); }
.hero-txt .v { font-size: var(--x1-fs-body); line-height: 20px; text-wrap: balance; }
.hero-txt .s { font-weight: var(--x1-w-medium); }
.lede { display: flex; align-items: center; gap: 4px; font-size: var(--x1-fs-title); line-height: 24px; margin: 14px 0 0; min-height: 24px; }
.lede > span { margin-left: 5px; }
.lede .pi { width: 20px; height: 20px; flex: none; fill: currentColor; stroke: currentColor; stroke-linejoin: round; stroke-linecap: round; }
.lede .pi.solar { color: var(--x1-solar); } .lede .pi.batt { color: var(--x1-batt); } .lede .pi.grid { color: var(--x1-grid); }
.lede .pi.solar { stroke-width: var(--x1-grade-solar); } .lede .pi.solar path { fill: none; stroke-width: calc(var(--x1-grade-solar) + 1.4px); }
.lede .pi.grid { stroke-width: var(--x1-grade-grid); } .lede .pi.batt { stroke: none; }
.lede.old .pi { filter: grayscale(1); opacity: .55; }
.lede.in { animation: x1-arrive 240ms ease-out both; }
.tight .lede { font-size: var(--x1-fs-body); line-height: 20px; min-height: 20px; margin-top: 10px; }
.tight .lede .pi { width: 18px; height: 18px; }
.flow { margin-top: 12px; flex: 1 1 auto; min-height: 150px; display: flex; align-items: center; }
.flow .stage { position: relative; flex: none; }
.flow .stage > svg, .flow .stage > canvas { position: absolute; left: 0; top: 0; display: block; }
.flow .stage > svg { width: 100%; height: 100%; overflow: visible; }
.flow .over { z-index: 2; }
.flow canvas { z-index: 1; pointer-events: none; }
.flow .under { z-index: 0; overflow: hidden; pointer-events: none; }
.flow .px-ink { color: var(--x1-panel-on); }
.flow .face, .flow .cab, .flow .charge, .flow .shade, .flow .cast { stroke: none; }
.flow .pane { stroke: color-mix(in srgb, var(--x1-surface) 55%, transparent); stroke-width: .75; stroke-linejoin: round; }
.flow .hub { stroke: none; }
.flow .cast { fill-opacity: var(--x1-cast-a); }
/* the bottom figures stand clear of every line, over the house's shadow, so they carry no halo */
.flow [data-n="2"], .flow [data-n="3"], .flow [data-v="2"], .flow [data-v="3"] { stroke: none; }
.flow .arm { stroke: none; }
/* the pole's roundness: dark at both edges, the light off centre toward the sun */
.flow .pl0 { stop-color: var(--x1-pole-edge); } .flow .pl1 { stop-color: var(--x1-pole-dark); } .flow .pl2 { stop-color: var(--x1-pole-top); } .flow .pl3 { stop-color: var(--x1-pole-lit); } .flow .pl4 { stop-color: var(--x1-pole-dark); }
.flow .pole-cast { fill: none; stroke: var(--x1-cast); stroke-opacity: var(--x1-cast-a); stroke-width: 1.5; stroke-linecap: round; }
.flow .pshade { fill: var(--x1-cast); fill-opacity: var(--x1-pshade-a); stroke: none; }
.flow .panel { stroke: none; }
.flow .array { fill: none; stroke: var(--x1-frame); stroke-width: 1; stroke-linejoin: round; }
.flow .mark { fill: none; stroke: var(--x1-ink); stroke-opacity: .55; stroke-width: 1; }
.flow .wire { fill: none; stroke: var(--x1-grid-line); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.flow .wire:not(.on) { stroke: var(--x1-wire-idle); }
.flow .wire.on { stroke-opacity: .9; }
.flow .lane { fill: none; stroke-width: 2; stroke-opacity: .35; stroke-linecap: round; stroke-linejoin: round; }
.flow .port { font-size: var(--x1-fs-small); fill: var(--x1-ink2); paint-order: stroke; stroke: var(--x1-surface); stroke-width: 4px; stroke-linejoin: round; }
.flow .lead { stroke: var(--x1-ink2); stroke-opacity: .6; stroke-width: 1; }
.flow .tag { fill: var(--x1-surface); fill-opacity: .94; stroke: var(--x1-grid-line); stroke-width: 1; }
.flow .port.v { fill: var(--x1-ink); font-weight: var(--x1-w-medium); font-variant-numeric: tabular-nums; }
/* the flow: short beads every 10 px along the solid line, drifting at 1.83 px a second before the playback rate */
.flow .dots { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 2.5 3.5; animation: x1-drift 3.27s linear infinite; }
@keyframes x1-drift { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -6px; } }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 6px; }

/* The period side: a title bar, six headline cards, a chart card each for power and the battery, a meaning card. */
.pbar { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 16px; flex: none; container-type: inline-size; }

.heads .cell { display: block; container-type: inline-size; }
/* the six figures are tiles inside their card, each in its own tone; a hairline only where the theme draws card borders */
.heads .cell.card { background: var(--x1-tile); border: var(--ha-card-border-width, 1px) solid var(--x1-tile-line); border-radius: var(--x1-tile-r); box-shadow: none; }
/* a card too narrow for its figure at the ledger's size steps the figure down rather than clip it; the steps are
   measured on the widest figure ("29.8 kWh": its unit 28 px, its number about two ems) */
@container (max-width: 84px) { .heads .cell.card .cv { font-size: var(--x1-fs-read); line-height: 26px; } }
@container (max-width: 76px) { .heads .cell.card .cv { font-size: 20px; line-height: 26px; } }
@container (max-width: 68px) { .heads .cell.card .cv { font-size: 18px; line-height: 26px; } }
@container (max-width: 64px) { .heads .cell.card .cv { font-size: 16px; line-height: 26px; } }
/* six cards sharing less than 700 px give their figures the room of a tighter margin */
.heads { container-type: inline-size; }
@container (max-width: 700px) { .heads .cell.card { padding-left: 9px; padding-right: 9px; } }
.pbar h2 { min-width: 0; }
.nav { display: inline-flex; gap: 2px; }
.nav button, .seg button, .tbtn { font: inherit; font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); background: none; border: 0; cursor: pointer; }
.nav button { min-width: 28px; min-height: 28px; padding: 4px 6px; border-radius: 6px; }
.nav .chev { font-size: 18px; line-height: 20px; }
.nav button:disabled { opacity: .35; cursor: default; }
.head-r { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-left: auto; }
.seg { display: inline-flex; gap: 14px; }
.seg button { min-height: 28px; padding: 6px 0 4px; border-bottom: 2px solid transparent; }
.seg button[aria-pressed="true"] { color: var(--x1-ink); border-bottom-color: var(--x1-ink); }
.tbtn { min-height: 28px; padding: 5px 10px; border: 1px solid var(--x1-grid-line); border-radius: 6px; }
.pbar .pvs { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pbar .pvs.reading { color: var(--x1-ink); font-weight: var(--x1-w-medium); }
@container (max-width: 560px) { .col-period .pbar .pvs { flex: 1 0 100%; order: 3; } .col-period .pbar .head-r { order: 4; flex: 1 0 100%; margin-left: 0; justify-content: space-between; } }
.nav button:hover, .seg button:hover, .tbtn:hover { color: var(--x1-ink); }
.nav button:focus-visible, .seg button:focus-visible, .tbtn:focus-visible { outline: 2px solid var(--primary-color, #2a78d6); outline-offset: 2px; }
.heads { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--x1-gap); flex: none; }
.narrow .heads { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.cell { min-width: 0; padding: 10px 12px; }
.tight .cell { padding: 8px 12px; }
.cell .cn { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cell .cv { font-size: var(--x1-fs-stat); line-height: 32px; font-weight: var(--x1-w-medium); letter-spacing: -0.01em; white-space: nowrap; font-variant-numeric: tabular-nums; overflow: hidden; }
.tight .cell .cv, .narrow .cell .cv, .cell.m .cv { font-size: var(--x1-fs-read); line-height: 26px; }
.narrow .cell { padding: 8px 10px; }
.cell .cv .unit { font-size: var(--x1-fs-small); line-height: 1; letter-spacing: 0; }
.cell .cd { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 16px; font-variant-numeric: tabular-nums; }
.pbody { position: relative; flex: 1 1 auto; min-height: 0; }
.narrow .pbody { min-height: 320px; }
.mg { display: flex; flex-direction: column; gap: var(--x1-gap); position: relative; outline: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
/* a chart card: its name and key in a head row, the plot the card's full width under it */
.chart { display: grid; grid-template-columns: minmax(0, 1fr); row-gap: 8px; align-items: start; }
.ct { min-width: 0; }
.ct .ctn { font-size: var(--x1-fs-body); line-height: 20px; font-weight: var(--x1-w-medium); }
.ct .ctv { font-size: var(--x1-fs-read); line-height: 28px; font-weight: var(--x1-w-medium); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ct .ctv .unit { font-size: var(--x1-fs-body); }
.ct .ctd { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); margin-top: 2px; text-wrap: pretty; }
.tight .ctd { display: none; }
.tick.on { fill: var(--x1-ink); font-weight: var(--x1-w-medium); }
/* a band's name in the ink that reads on its band (white on the grid's violet, and on its tint in the dark), haloed in
   the band's own colour so it stays legible where it overhangs the plot, never ringed in the surface's colour */
.tick.band { paint-order: stroke; stroke-width: 3px; stroke-linejoin: round; fill: #1b1b1b; font-weight: var(--x1-w-medium); }
.tick.band.bGh, :host(.dark) .tick.band.bGb { fill: #ffffff; }
.soc-fill { fill: var(--x1-batt); fill-opacity: .16; }
:host(.dark) .soc-fill { fill-opacity: .24; }
.ck { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; font-size: var(--x1-fs-body); line-height: 20px; color: var(--x1-ink2); }
.narrow .ck { flex-direction: row; flex-wrap: wrap; gap: 4px 20px; }
.kgp { display: grid; gap: 0; }
.ck .kt { font-weight: var(--x1-w-medium); color: var(--x1-ink); line-height: 16px; }
.ck .kg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ck .kg.say { font-size: var(--x1-fs-small); line-height: 18px; }
.tight .ck { font-size: 13px; line-height: 18px; gap: 2px; margin-top: 4px; }
.tight .ck .sw { width: 12px; height: 12px; margin-right: 6px; vertical-align: -1px; }
.ck .kg b { font-weight: var(--x1-w-medium); color: var(--x1-ink); }
.ck .sw { width: 14px; height: 14px; border-radius: 3px; margin: 0 8px 0 0; border: 1px solid color-mix(in srgb, var(--x1-ink) 12%, transparent); vertical-align: -2px; }
.ck .sw + .sw, .ck span + .sw { margin-left: 6px; }
.ck .sw.line { height: 0; border: 0; border-radius: 0; border-top: 2px dashed var(--x1-ink2); vertical-align: 4px; }
.ck .sw.dot { border-radius: 50%; background: var(--x1-batt); border: 0; width: 10px; height: 10px; margin-right: 8px; }
.ck .sw.fill { background: color-mix(in srgb, var(--x1-batt) 24%, var(--x1-surface)); border: 0; border-top: 3px solid var(--x1-batt); border-radius: 2px; }
.narrow .ck { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.col-period .ct { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 24px; }
.col-period .ck { flex-direction: row; flex-wrap: wrap; gap: 4px 18px; margin: 0; }
.cs { min-width: 0; }
.mg:focus-visible { outline: 2px solid var(--primary-color, #2a78d6); outline-offset: 4px; border-radius: 4px; }
.mg-p, .mg-axis { touch-action: pan-y; }
.mg-p { min-width: 0; position: relative; overflow: hidden; }
.mg-p svg, .mg-axis svg { display: block; overflow: visible; }
.mg-none { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; color: var(--x1-ink2); }
.tick { font-size: var(--x1-fs-small); fill: var(--x1-ink2); font-variant-numeric: tabular-nums; }
.tick.halo { paint-order: stroke; stroke: var(--x1-surface); stroke-width: 4px; stroke-linejoin: round; }
.tick.day { fill: var(--x1-ink); }
.tick.now { font-weight: var(--x1-w-medium); }
.tick.hint { fill: var(--x1-ink2); }
.sname { font-size: var(--x1-fs-small); fill: var(--x1-ink2); font-weight: var(--x1-w-medium); }
.meaning { flex: none; padding: 12px var(--x1-pad); }
/* the period's meaning in the Now column: three figures, each a tile with its name over it as the place's six have, in
   the same three columns and tone; the detail is the tooltip */
.rings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.rg { display: grid; gap: 2px; min-width: 0; align-content: start; padding: 10px 9px; container-type: inline-size;
  background: var(--x1-tile); border: var(--ha-card-border-width, 1px) solid var(--x1-tile-line); border-radius: var(--x1-tile-r); }
.tight .rg { padding: 8px; }
.tight .meaning { padding-top: 10px; padding-bottom: 10px; } .tight .foot { margin-top: 8px; }
.rg .rtop { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rg svg { flex: none; width: 24px; height: 24px; display: block; }
.rg .track { stroke: var(--x1-grid-line); }
.rg .rv { font-size: var(--x1-fs-read); line-height: 28px; font-weight: var(--x1-w-medium); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* a name wraps at its hyphen before it clips, in the narrowest column; a figure steps down as the place's do */
.rg .rn { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); }
@container (max-width: 76px) { .rg .rv { font-size: 20px; } .rg svg { width: 20px; height: 20px; } }
@container (max-width: 64px) { .rg .rv { font-size: 18px; } }
.foot { margin-top: 10px; min-height: 34px; font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); display: grid; gap: 2px; }
.foot span:empty { display: none; }
.narrow .foot { flex-wrap: wrap; }


/* Motion: crossfades for a change of view; figures crossfade in place; all off under reduced motion. */
.mg-ghost { position: absolute; inset: 0; overflow: hidden; pointer-events: none; animation: x1-fade 220ms ease-out both; }
.mg-ghost * { animation: none !important; }
.swap > .mg { animation: x1-arrive 220ms ease-out both; }
.mg-ghost .card { border-color: transparent; }
@keyframes x1-arrive { from { opacity: 0; } to { opacity: 1; } }
@keyframes x1-fade { to { opacity: 0; } }
.xf { position: relative; animation: x1-ink 220ms ease-out both; }
.xf::after { content: attr(data-old); position: absolute; left: 0; top: 0; color: var(--x1-ink); white-space: nowrap; pointer-events: none; animation: x1-fade 220ms ease-out both; }
@keyframes x1-ink { from { color: transparent; } }
@media (prefers-reduced-motion: reduce) { .mg-ghost { display: none; } .lede.in { animation: none; } .swap > .mg, .xf, .flow .dots { animation: none; } .xf::after { content: none; } .ring .arc { transition: none; } }
@media (forced-colors: active) {
  .mg-p, .flow, .ring, .rg svg, .lamp i, .sw, .ck .sw, .lede .pi { forced-color-adjust: none; }
  .seg button[aria-pressed="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
}
@media (prefers-contrast: more) {
  :host { --x1-ink2: color-mix(in srgb, var(--x1-ink) 82%, var(--x1-surface)); --x1-grid-line: color-mix(in srgb, var(--x1-ink) 22%, var(--x1-surface)); --x1-axis: color-mix(in srgb, var(--x1-ink) 40%, var(--x1-surface)); }
}
@media print { .seg, .tbtn, .nav { display: none; } .card { break-inside: avoid; box-shadow: none; } }
`;

  class SolixX1Card extends HTMLElement {
    static getStubConfig() { return {}; }
    static getConfigForm() {
      const labels = { site: "Site id", name: "Place name", reserve: "Backup reserve (%)", capacity_kwh: "Battery capacity (kWh)", array_kw: "Solar array's best output (kW)", view: "Opens on", rate_import: "Import rate per kWh", rate_export: "Export rate per kWh" };
      const helpers = {
        site: "The Anker site id. Found from the integration's site device when left empty.",
        name: "Heads the Now column.",
        reserve: "The backup reserve set in the Anker app; the cloud does not report it, so the card draws what you enter.",
        capacity_kwh: "Found from the battery modules when left empty.",
        array_kw: "The most the array makes, such as its best clear-day output at noon; every pixel on the drawn panels lights at this power. When left empty, the card uses the most the array has made in five minutes over the last 30 days.",
        view: "Each viewer's last choice is remembered in their browser.",
        rate_import: "Optional, in your home's currency. With a rate the card prices what each period saved; without one it shows Anker's lifetime figure.",
        rate_export: "Optional.",
      };
      return {
        schema: [
          { name: "site", selector: { text: {} } }, { name: "name", selector: { text: {} } },
          { name: "reserve", selector: { number: { min: 0, max: 100, mode: "box" } } },
          { name: "capacity_kwh", selector: { number: { min: 1, max: 1000, step: 0.1, mode: "box" } } },
          { name: "array_kw", selector: { number: { min: 0.1, max: 1000, step: 0.1, mode: "box" } } },
          { name: "view", selector: { select: { mode: "dropdown", options: VIEWS.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) } } },
          { name: "rate_import", selector: { number: { min: 0, max: 10, step: 0.001, mode: "box" } } },
          { name: "rate_export", selector: { number: { min: 0, max: 10, step: 0.001, mode: "box" } } },
        ],
        computeLabel: (s) => labels[s.name], computeHelper: (s) => helpers[s.name],
      };
    }

    setConfig(config) {
      if (!config || typeof config !== "object") throw new Error(`${TAG}: invalid configuration`);
      const before = this._config;
      this._config = { reserve: 20, ...config };
      if (before && before.site !== this._config.site) { this._cache = {}; this._site = null; }
      if (!this._view) {
        let stored = null;
        try { stored = window.localStorage.getItem(VIEW_KEY); } catch (e) { stored = null; }
        this._view = VIEWS.includes(stored) ? stored : VIEWS.includes(config.view) ? config.view : "day";
      }
      if (this._hass) { this._resolve(); this._renderAll(); }
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (!this._ents && (!this._resolvedAt || Date.now() - this._resolvedAt > 10e3)) { this._resolvedAt = Date.now(); this._resolve(); }
      const dark = !!hass.themes?.darkMode;
      this.classList.toggle("dark", dark);
      if (!this._ents) { if (!this._missing) { this._missing = true; this._renderMissing(); } return; }
      this._missing = false;
      if (!this.isConnected) return;
      const key = `${dark}|${Object.values(this._ents).map((id) => hass.states[id]?.last_updated ?? "").join("|")}`;
      if (!first && this._mounted && key === this._hassKey) return;
      this._hassKey = key;
      if (first || !this._mounted) { this._mount(); this._refresh(); }
      else if (!this._livePending) { this._livePending = true; requestAnimationFrame(() => { this._livePending = false; this._applyLive(); }); }
    }

    get hass() { return this._hass; }
    getCardSize() { return 12; }
    getGridOptions() { return { columns: "full", rows: "auto" }; }
    connectedCallback() {
      this._timer = setInterval(() => this._refresh(), REFRESH_MS);
      this._tick = setInterval(() => this._applyLive(), 10e3);
      this._onResize = this._onResize ?? (() => this._layout());
      window.addEventListener("resize", this._onResize);
      // hass may have arrived before the card was in the document
      if (this._hass && this._ents && !this._mounted) { this._hassKey = null; this._mount(); this._refresh(); }
    }
    disconnectedCallback() {
      clearInterval(this._timer); clearInterval(this._tick); clearTimeout(this._rz);
      window.removeEventListener("resize", this._onResize);
      this._ro?.disconnect(); this._mounted = false;
    }

    /* ----- entities ----- */

    // The integration names entities after their devices. The Backup Controller carries the live averages; the site
    // device carries savings and totals; the account's Api Usage switch is the target of the raw-request action.
    _resolve() {
      const states = this._hass.states, over = this._config.entities ?? {};
      const groups = {};
      for (const id of Object.keys(states)) {
        if (!id.startsWith("sensor.")) continue;
        for (const k of LIVE_KEYS) if (id.endsWith("_" + k)) (groups[id.slice(7, -k.length - 1)] = groups[id.slice(7, -k.length - 1)] ?? {})[k] = id;
      }
      const best = Object.entries(groups).sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length)[0];
      if (!best || !best[1].state_of_charge || !best[1].home_demand) { this._ents = null; return; }
      const ents = { ...best[1] };
      const site = {};
      for (const id of Object.keys(states)) for (const k of SITE_KEYS) if ((id.startsWith("sensor.") || id.startsWith("binary_sensor.")) && id.endsWith("_" + k)) { const p = id.replace(/^(binary_)?sensor\./, "").slice(0, -k.length - 1); (site[p] = site[p] ?? {})[k] = id; }
      const sbest = Object.entries(site).filter(([, g]) => g.cost_savings || g.yield_total).sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length)[0];
      if (sbest) for (const [k, id] of Object.entries(sbest[1])) ents["site_" + k] = id;
      const acct = Object.keys(states).find((id) => id.startsWith("switch.") && id.endsWith("_api_usage"));
      if (acct) ents.account = acct;
      for (const [k, id] of Object.entries(over)) ents[k] = id;
      this._ents = ents;
      // capacity: the site's module count times one module's capacity. The count comes from the site, since Home
      // Assistant can hold capacity numbers that belong to no module (one live system has three such); one module's
      // capacity is the median of the modules' own numbers, or of all of them when no number names a module
      const caps = [];
      for (const [id, st] of Object.entries(states)) if (id.startsWith("number.") && id.includes("battery_capacity") && st.attributes?.device_class === "energy_storage") { const v = parseFloat(st.state); if (v > 0) caps.push({ id, v }); }
      const mods = caps.filter((c) => c.id.includes("battery_module")), pool = mods.length ? mods : caps;
      const per = pool.length ? pool.map((c) => c.v).sort((x, y) => x - y)[Math.floor(pool.length / 2)] : 0;
      const modules = parseFloat(states[ents.site_battery_modules]?.state ?? "");
      const n = Number.isFinite(modules) && modules > 0 ? modules : pool.length;
      this._capacity = this._config.capacity_kwh ?? (per > 0 && n > 0 ? (per * n) / 1000 : null);
      this._packs = n || null;
      this._cache = this._cache ?? {};
    }
    _st(k) { const id = this._ents?.[k]; return id ? this._hass.states[id] : undefined; }
    _money(v, dp = 0) {
      const cur = this._hass?.config?.currency || "USD", lang = this._fmt().lang;
      try { return new Intl.NumberFormat(lang, { style: "currency", currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v); } catch (e) { return `${this._fmt().num(v, dp)}${NB}${cur}`; }
    }
    _num(k) { const s = this._st(k); const v = s ? parseFloat(s.state) : NaN; return Number.isFinite(v) ? v : null; }
    _fmt() {
      const lang = this._hass.locale?.language ?? this._hass.language ?? "en", tz = this._hass.config?.time_zone;
      const clock = this._hass.locale?.time_format, numbers = this._hass.locale?.number_format, c = this._fmtCache;
      if (!c || c.lang !== lang || c.tz !== tz || c.clock !== clock || c.numbers !== numbers) this._fmtCache = new Fmt(lang, tz, clock, numbers);
      return this._fmtCache;
    }
    _motion() { return !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; }

    /* ----- the live model ----- */

    _live() {
      const f = this._fmt(), now = Date.now();
      const kw = (k) => this._num(k);
      const soc = kw("state_of_charge"), solar = kw("solar_power") ?? 0, home = kw("home_demand") ?? 0;
      const imp = kw("grid_import") ?? 0, exp = kw("grid_export") ?? 0, chg = kw("charge_power") ?? 0, dis = kw("discharge_power") ?? 0;
      // one reconciled set of flows (R1): the house is supplied by solar, the battery and the grid; solar goes to the house, the battery and the grid
      const Bd = Math.max(0, dis - chg), Bc = Math.max(0, chg - dis), Gi = Math.max(0, imp - exp), Ge = Math.max(0, exp - imp);
      const Sh = Math.max(0, Math.min(solar, home - Bd - Gi));
      const Gb = Math.max(0, Math.min(Bc, Gi - Math.max(0, home - Bd - Sh)));
      const Sb = Math.max(0, Math.min(Bc - Gb, solar - Sh));
      const Sg = Math.max(0, Math.min(Ge, solar - Sh - Sb));
      const Bg = Math.max(0, Math.min(Bd, Ge - Sg));
      const flows = { Sh, Sb, Sg, Gh: Math.max(0, Gi - Gb), Gb, Bh: Math.max(0, Bd - Bg), Bg };
      const dt = Date.parse(String(this._st("data_time")?.state ?? "").replace(" ", "T"));
      const upd = Math.max(...LIVE_KEYS.map((k) => Date.parse(this._st(k)?.last_updated ?? "") || 0));
      const age = now - (Number.isFinite(dt) ? Math.max(dt, upd - 5 * 60e3) : upd);
      const online = this._st("site_connection") ? this._st("site_connection").state === "on" : this._st("cloud_state") ? this._st("cloud_state").state === "online" : true;
      const stale = age > 10 * 60e3;
      const cap = this._capacity, reserve = clamp(Number(this._config.reserve) || 0, 0, 100);
      const usable = soc !== null && cap ? Math.max(0, (soc - reserve) / 100) * cap : null;
      const hours = usable !== null && Bd > 0.05 ? usable / Bd : null;
      const toFull = soc !== null && cap && Bc > 0.05 ? ((100 - soc) / 100) * cap / Bc : null;
      const state = !online ? "unknown" : "on";
      return { now, f, soc, solar, home, imp, exp, chg, dis, flows, age, stale, online, state, cap, reserve, usable, hours, toFull,
        savings: this._num("site_cost_savings"), co2: this._num("site_co2_savings"), yieldMwh: this._num("site_yield_total"), packs: this._packs ?? this._num("site_battery_modules"), towers: this._parallel ?? this._num("site_parallel_devices") };
    }

    // One line in words: what the house is running on and what the rest of the system is doing. The figures live in
    // the flow and the headline cards, the timing under the battery, so the sentence repeats none of them.
    _lede(L) {
      const s = this._ledeNow(L);
      if (!(L.stale || L.state === "unknown")) return s;
      return `As of ${L.f.time(L.now - L.age)}, ${s[0].toLowerCase()}${s.slice(1)}`;
    }
    _ledeNow(L) {
      if (L.home <= 0.05) return "The house is drawing almost nothing.";
      const run = [];
      if (L.flows.Sh > 0.05) run.push("solar");
      if (L.flows.Bh > 0.05) run.push("the battery");
      if (L.flows.Gh > 0.05) run.push("the grid");
      let s = run.length ? `Running on ${run.length > 1 ? run.slice(0, -1).join(", ") + " and " + run[run.length - 1] : run[0]}` : "Running, source unknown";
      const more = [];
      const fromGrid = L.flows.Gb > L.flows.Sb;
      if (L.chg > 0.05 && fromGrid && run.length === 1 && run[0] === "the grid") s += " and charging the battery from it";
      else if (L.chg > 0.05) more.push(fromGrid ? "charging the battery from the grid" : "charging the battery");
      if (L.exp > 0.05) more.push(run.includes("solar") ? "selling the rest" : "selling to the grid");
      if (L.dis > 0.05 && L.soc !== null && L.soc < L.reserve - 0.5) more.push("below its reserve");
      else if (L.dis > 0.05 && L.usable !== null && L.usable < 0.05) more.push("at its reserve");
      if (more.length) s += `, ${more.join(" and ")}`;
      return s + ".";
    }
    async _siteId() {
      if (this._config.site) return this._config.site;
      if (this._site) return this._site;
      if (this._sitePending) return this._sitePending;
      this._sitePending = (async () => {
        try {
          const devs = await this._hass.callWS({ type: "config/device_registry/list" });
          const d = (devs ?? []).find((x) => x.model === "Hes Site" && x.identifiers?.some((i) => i[0] === "anker_solix")) ?? (devs ?? []).find((x) => x.identifiers?.some((i) => i[0] === "anker_solix" && /^[0-9a-f-]{36}$/.test(i[1])));
          this._site = d?.identifiers.find((i) => i[0] === "anker_solix")?.[1] ?? null;
        } catch (e) { this._site = null; }
        this._sitePending = null;
        return this._site;
      })();
      return this._sitePending;
    }

    async _cloud(payload) {
      const key = JSON.stringify(payload);
      const c = this._cache[key];
      if (c && (c.final || Date.now() - c.at < REFRESH_MS)) return c.data;
      if (this._inflight?.[key]) return this._inflight[key];
      (this._inflight = this._inflight ?? {})[key] = (async () => {
        const res = await this._hass.callWS({ type: "call_service", domain: "anker_solix", service: "api_request", return_response: true,
          target: { entity_id: this._ents.account }, service_data: { method: "post", endpoint: "charging_hes_svc/get_energy_statistics", payload } });
        const r = Object.values(res?.response ?? {})[0];
        if (!r || r.error) throw new Error(r?.error ?? "no response");
        const data = r.response?.data ?? r.data ?? null;
        if (!data) throw new Error(r.response?.msg ?? "empty");
        this._cache[key] = { data, at: Date.now(), final: !this._isCurrent(payload) };
        delete this._inflight[key];
        return data;
      })().catch((e) => { delete this._inflight[key]; throw e; });
      return this._inflight[key];
    }
    _isCurrent(p) { const f = this._fmt(), today = f.dateStr(Date.now()); return p.end === today || p.end === "" && (p.start === today.slice(0, 7) || p.start === today.slice(0, 4)) || (p.dateType === "day" && p.start === today); }

    // The period in view: its payloads, buckets, totals and labels. anchor is a local date (day, week), a month
    // ("YYYY-MM") or a year ("YYYY"); the week is the seven days ending on the anchor.
    _period(view, anchor) {
      const f = this._fmt(), today = f.dateStr(Date.now());
      if (view === "day") {
        const t0 = f.midnight(anchor);
        return { view, anchor, t0, t1: t0 + DAY, start: anchor, end: anchor, dateType: "day", title: anchor === today ? "Today" : anchor === f.addDays(today, -1) ? "Yesterday" : f.long(t0 + 12 * HOUR), isNow: anchor === today, prev: f.addDays(anchor, -1), next: anchor < today ? f.addDays(anchor, 1) : null };
      }
      if (view === "week") {
        const start = f.addDays(anchor, -6), t0 = f.midnight(start);
        return { view, anchor, t0, t1: f.midnight(anchor) + DAY, start, end: anchor, dateType: "week", title: anchor === today ? "This week" : `Week to ${f.md(f.midnight(anchor) + 12 * HOUR)}`, isNow: anchor === today, prev: f.addDays(anchor, -7), next: anchor < today ? f.addDays(anchor, 7) > today ? today : f.addDays(anchor, 7) : null };
      }
      if (view === "month") {
        const [y, m] = anchor.split("-").map(Number), days = f.daysIn(y, m), t0 = f.midnight(`${anchor}-01`);
        const thisMonth = today.slice(0, 7);
        const pm = m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`, nm = m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`;
        return { view, anchor, t0, t1: f.midnight(`${anchor}-${pad2(days)}`) + DAY, days, start: anchor, end: "", dateType: "month", title: anchor === thisMonth ? "This month" : f.monY(t0 + 15 * DAY), isNow: anchor === thisMonth, prev: pm, next: anchor < thisMonth ? nm : null };
      }
      const y = Number(anchor), t0 = f.midnight(`${anchor}-01-01`);
      return { view, anchor, t0, t1: f.midnight(`${y + 1}-01-01`), start: anchor, end: "", dateType: "year", title: anchor === today.slice(0, 4) ? "This year" : anchor, isNow: anchor === today.slice(0, 4), prev: String(y - 1), next: anchor < today.slice(0, 4) ? String(y + 1) : null };
    }

    async _fetchPeriod(P) {
      const site = await this._siteId();
      if (!site) throw new Error("No Anker site found. Set site: in the card's configuration.");
      const sources = ["solar", "hes", "home", "grid"];
      const out = {};
      for (const s of sources) {
        out[s] = await this._cloud({ siteId: site, sourceType: s, dateType: P.dateType, start: P.start, end: P.end });
        await new Promise((r) => setTimeout(r, 120));
      }
      return out;
    }

    // The cloud's answers turned into one reconciled set of buckets (R1) plus the period's totals.
    _buckets(P, raw) {
      const f = this._fmt(), now = Date.now();
      const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
      const scale = (d) => (/mwh/i.test(d?.totalEnergyUnit ?? "") ? 1000 : 1);
      const out = [];
      if (P.view === "day") {
        // a point the cloud marks isFix is a filled gap, not a reading: it is left out, and the chart bridges it
        const series = {};
        for (const s of ["solar", "hes", "home", "grid"]) series[s] = (raw[s]?.power ?? []).map((p) => (p.powerInfos?.[0]?.isFix ? null : num(p.powerInfos?.[0]?.value)));
        const soc = (raw.hes?.chargeLevel ?? []).map((c) => (c.isFix ? null : num(c.value)));
        const n = Math.max(series.solar.length, series.home.length, 288);
        const cut = P.isNow ? Math.floor((now - P.t0) / FIVE_MIN) + 1 : n;
        for (let i = 0; i < n; i++) {
          const t = P.t0 + i * FIVE_MIN;
          if (i >= cut) { out.push({ t, t1: t + FIVE_MIN, empty: true }); continue; }
          const gap = series.home[i] === null && series.solar[i] === null && series.hes[i] === null && series.grid[i] === null;
          if (gap) { out.push({ t, t1: t + FIVE_MIN, empty: true, gap: true, soc: null }); continue; }
          const S = Math.max(0, series.solar[i] ?? 0), L = Math.max(0, series.home[i] ?? 0), B = series.hes[i] ?? 0, G = series.grid[i] ?? 0;
          out.push({ t, t1: t + FIVE_MIN, ...flowsOf(S, L, B, G), soc: soc[i] ?? null, kw: true });
        }
        // short gaps are bridged with the neighbours' average so the areas and the charge line stay whole
        for (let i = 0; i < out.length; i++) {
          if (!out[i].gap) continue;
          let j = i; while (j < out.length && out[j].gap) j++;
          const a = out[i - 1], b = out[j];
          if (a && b && !a.empty && !b.empty && j - i <= 6) for (let k = i; k < j; k++) { const w = (k - i + 1) / (j - i + 1); const mix = {}; for (const key of ["S", "L", "Bd", "Bc", "Gi", "Ge", "Sh", "Sb", "Sg", "Gh", "Gb", "Bh"]) mix[key] = a[key] * (1 - w) + b[key] * w; out[k] = { t: out[k].t, t1: out[k].t1, ...mix, soc: a.soc !== null && b.soc !== null ? a.soc * (1 - w) + b.soc * w : null, kw: true, bridged: true }; }
          i = j;
        }
      } else if (P.view === "year") {
        for (let mo = 0; mo < 12; mo++) {
          const t = f.midnight(`${P.anchor}-${pad2(mo + 1)}-01`), t1 = mo === 11 ? P.t1 : f.midnight(`${P.anchor}-${pad2(mo + 2)}-01`);
          if (t > now) { out.push({ t, t1, empty: true }); continue; }
          const g = (s) => (raw[s]?.energy?.[mo] ?? null), k = (s) => scale(raw[s]);
          const S = num(g("solar")?.value) * k("solar"), L = num(g("home")?.value) * k("home"), Bd = num(g("hes")?.value) * k("hes");
          const Gi = num(g("grid")?.value) * k("grid"), Ge = Math.abs(num(g("grid")?.negValue)) * k("grid");
          out.push({ t, t1, ...flowsOfEnergy(S, L, Bd, Gi, Ge) });
        }
      } else {
        const n = P.view === "month" ? P.days : 7;
        for (let i = 0; i < n; i++) {
          const ds = f.addDays(P.start === "" ? `${P.anchor}-01` : P.view === "month" ? `${P.anchor}-01` : P.start, i);
          const t = f.midnight(ds), t1 = t + DAY;
          if (t > now) { out.push({ t, t1, empty: true }); continue; }
          const g = (s) => (raw[s]?.energy?.[i] ?? null);
          const S = num(g("solar")?.value), L = num(g("home")?.value), Bd = num(g("hes")?.value), Gi = num(g("grid")?.value), Ge = Math.abs(num(g("grid")?.negValue));
          out.push({ t, t1, ...flowsOfEnergy(S, L, Bd, Gi, Ge) });
        }
      }
      // totals: the cloud's period aggregates where they exist, else the buckets' sums
      const agg = (s, title) => { const a = (raw[s]?.aggregates ?? []).find((x) => x.title === title); return a ? num(a.value) * scale(raw[s]) : null; };
      const sum = (k) => out.reduce((a, b) => a + (b.empty ? 0 : (b[k] ?? 0) * (b.kw ? FIVE_MIN / HOUR : 1)), 0);
      const T = { S: sum("S"), L: sum("L"), Bd: sum("Bd"), Bc: sum("Bc"), Gi: sum("Gi"), Ge: sum("Ge"), Sh: sum("Sh"), Sb: sum("Sb"), Sg: sum("Sg"), Gh: sum("Gh"), Gb: sum("Gb") };
      // a cloud total counts only when the cloud gave one; an empty string is absent, not zero
      const tot = (s, k) => { const v = raw[s]?.[k]; if (v === null || v === undefined || v === "") return null; const n = parseFloat(v); return Number.isFinite(n) ? n * scale(raw[s]) : null; };
      const cloud = {
        S: tot("solar", "totalEnergy"), L: tot("home", "totalEnergy"), Bd: tot("hes", "totalEnergy"),
        Gi: tot("grid", "totalImportedEnergy"), Ge: tot("grid", "totalExportedEnergy"),
        Sb: agg("solar", "Battery charging capacity"), Sh: agg("solar", "Load power consumption"), Sg: agg("solar", "Sold power"),
        Gb: agg("grid", "Battery charging capacity"), Gh: agg("home", "Grid power consumption"), Bh: agg("home", "Battery power supply"),
      };
      for (const k of ["S", "L", "Bd", "Gi", "Ge", "Sb", "Sh", "Sg", "Gb", "Gh"]) if (cloud[k] !== null && cloud[k] !== undefined) T[k] = cloud[k];
      T.Bc = (cloud.Sb ?? T.Sb) + (cloud.Gb ?? T.Gb);
      T.Bh = cloud.Bh ?? T.Bd;
      // the three rings (R5): house covered without the grid; solar kept at home or stored; the house's supply split
      T.selfSuff = T.L > 0 ? clamp(1 - Math.min(T.L, T.Gh) / T.L, 0, 1) : null;
      T.kept = T.S > 0 ? clamp(1 - Math.min(T.S, T.Sg) / T.S, 0, 1) : null;
      const sup = T.Sh + T.Bh + T.Gh;
      T.split = sup > 0 ? { solar: T.Sh / sup, batt: T.Bh / sup, grid: T.Gh / sup } : null;
      return { buckets: out, T };
    }

    async _loadPeriod(fade) {
      const P = this._period(this._view, this._anchor ?? this._defaultAnchor());
      const token = (this._loadToken = (this._loadToken ?? 0) + 1);
      let raw = null, error = null;
      try { raw = await this._fetchPeriod(P); } catch (e) { error = e?.message ?? String(e); }
      if (token !== this._loadToken) return;
      this._P = P; this._data = raw ? this._buckets(P, raw) : null; this._perror = error;
      this._renderPeriod(fade);
      // the previous period's totals, for the deltas, after the view is drawn; a period still running is compared
      // with the same elapsed part of the previous one, not with the whole of it
      if (raw) {
        const prev = this._period(this._view, P.prev);
        try {
          const praw = await this._fetchPeriod(prev);
          if (token === this._loadToken) {
            const pb = this._buckets(prev, praw);
            if (P.isNow) {
              const elapsed = Date.now() - P.t0;
              const part = pb.buckets.filter((b) => !b.empty && b.t - prev.t0 < elapsed);
              const sum = (k) => part.reduce((a, b) => a + (b[k] ?? 0) * (b.kw ? FIVE_MIN / HOUR : 1), 0);
              this._prevT = { S: sum("S"), L: sum("L"), Gi: sum("Gi"), Ge: sum("Ge"), Bc: sum("Bc"), Bd: sum("Bd"), partial: true };
            } else this._prevT = pb.T;
            this._renderLedger();
          }
        } catch (e) { /* no deltas */ }
      }
    }
    _defaultAnchor() { const f = this._fmt(), t = f.dateStr(Date.now()); return this._view === "month" ? t.slice(0, 7) : this._view === "year" ? t.slice(0, 4) : t; }

    async _refresh() {
      if (!this._hass || !this._ents || !this._mounted) return;
      this._applyLive();
      if (!this._P || this._P.isNow) await this._loadPeriod(false);
      await this._ensurePeak().catch(() => {});
      await this._ensureMode();
    }
    // The most the array makes: the config's figure when it gives one, else the best five-minute average of the
    // last 30 days. Today's and yesterday's day statistics are the ones the day view already fetched; each day's best
    // is kept in the browser, so the record grows from visits without asking the cloud for more.
    _peaks() {
      if (!this._peakRec) { let r = null; try { r = JSON.parse(window.localStorage.getItem(PEAK_KEY) ?? "null"); } catch (e) { r = null; } this._peakRec = r && typeof r === "object" ? r : {}; }
      return this._peakRec;
    }
    _peak() {
      if (this._config.array_kw > 0) return this._config.array_kw;
      const site = this._site ?? "_", rec = this._peaks()[site] ?? {}, vals = Object.values(rec).filter((v) => v > 0);
      return vals.length ? Math.max(...vals) : null;
    }
    async _ensurePeak() {
      if (this._config.array_kw > 0) return;
      const site = await this._siteId();
      if (!site) { if (!this._peakTried) { this._peakTried = true; this._drawFlow(); } return; }
      const f = this._fmt(), today = f.dateStr(Date.now()), from = f.addDays(today, -29);
      const best = (d) => (d?.power ?? []).reduce((m, p) => (p.powerInfos?.[0]?.isFix ? m : Math.max(m, parseFloat(p.powerInfos?.[0]?.value) || 0)), 0);
      const all = this._peaks(), rec = { ...(all[site] ?? {}) }, before = this._peak();
      for (const day of [f.addDays(today, -1), today]) {
        try { const v = best(await this._cloud({ siteId: site, sourceType: "solar", dateType: "day", start: day, end: day })); if (v > 0) rec[day] = Math.round(Math.max(v, rec[day] ?? 0) * 1000) / 1000; } catch (e) { /* keep the record */ }
      }
      for (const d of Object.keys(rec)) if (d < from || d > today) delete rec[d];
      all[site] = rec;
      try { window.localStorage.setItem(PEAK_KEY, JSON.stringify(all)); } catch (e) { /* the record lasts this visit */ }
      const first = !this._peakTried;
      this._peakTried = true;
      if (first || this._peak() !== before) this._drawFlow();
    }
    // The work mode, from the system's running info, once an hour: the word beside the place name.
    async _ensureMode() {
      if (!this._hass || !this._ents?.account) return;
      if (this._modeAt && Date.now() - this._modeAt < HOUR) return;
      this._modeAt = Date.now();
      try {
        const site = await this._siteId();
        if (!site) return;
        const res = await this._hass.callWS({ type: "call_service", domain: "anker_solix", service: "api_request", return_response: true,
          target: { entity_id: this._ents.account }, service_data: { method: "post", endpoint: "charging_hes_svc/get_system_running_info", payload: { siteId: site } } });
        const r = Object.values(res?.response ?? {})[0], d = r?.response?.data ?? null;
        if (d) { this._modeWord = MODES[d.mode] ?? ""; this._parallel = d.numberOfParallelDevice ?? null; this._applyLive(); }
      } catch (e) { /* the mode stays unsaid */ }
    }
    /* ----- shell and layout ----- */

    _renderMissing() {
      this._mountShell();
      this._body.innerHTML = `<section class="card"><h2>Solix X1</h2><p class="small">No Anker Solix X1 found. The card reads the Anker Solix integration's Backup Controller entities (state of charge, solar power, home demand, grid import and export, charge and discharge power).</p></section>`;
    }
    _mountShell() {
      if (this._root) return;
      this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = `<style>${STYLE}</style><div class="wrap"></div>`;
      this._body = this._root.querySelector(".wrap");
      this._root.addEventListener("click", (e) => {
        const v = e.target.closest?.("[data-view]");
        if (v) { if (v.dataset.view === this._view) return; this._setView(v.dataset.view); return; }
        const nav = e.target.closest?.("[data-nav]");
        if (nav && !nav.disabled) { const to = nav.dataset.nav === "now" ? null : this._P?.[nav.dataset.nav]; if (nav.dataset.nav === "now" || to) { this._anchor = to; this._mgT = null; this._prevT = null; this._loadPeriod(true); } return; }
        if (e.target.closest?.("[data-csv]")) this._downloadCsv();
      });
      const away = () => { if (this._mgHold === "pointer") { this._mgHold = null; this._mgShow(null); } };
      this._root.addEventListener("pointermove", (e) => { if (!e.target.closest?.(".mg")) away(); });
      this.addEventListener("pointerleave", away);
    }
    _setView(view) {
      this._view = view; this._anchor = null; this._mgT = null; this._prevT = null;
      try { window.localStorage.setItem(VIEW_KEY, view); } catch (e) { /* not remembered */ }
      this._syncTabs();
      this._loadPeriod(true);
    }
    _mount() {
      this._mountShell();
      this._mounted = true;
      this._ro = this._ro ?? new ResizeObserver(() => { clearTimeout(this._rz); this._rz = setTimeout(() => this._layout(), 80); });
      this._renderAll();
      this._ro.observe(this);
    }
    _mode() {
      const w = this.clientWidth || window.innerWidth;
      return w >= 1000 ? "wide" : "narrow";
    }
    // Three tiers by the card's own width: wide (two columns), a tablet (600 px up: one column in the phone's order,
    // each card as on the desktop, the house beside its battery tile) and a phone (the tile over the drawing)
    _tier() {
      const w = this.clientWidth || window.innerWidth, mode = this._mode();
      return { mode, tablet: mode === "narrow" && w >= 600 };
    }
    _cls(mode, tablet, tight) { return `wrap ${mode}${mode === "wide" || tablet ? " split" : ""}${tablet ? " tablet" : ""}${tight ? " tight" : ""}`; }
    _layout() {
      if (!this._body || !this._mounted) return;
      const mode = this._mode();
      const top = this.getBoundingClientRect().top + window.scrollY;
      const h = Math.max(520, window.innerHeight - top);
      const tight = mode === "wide" && h < 700, { tablet } = this._tier();
      const cls = this._cls(mode, tablet, tight);
      this._tight = tight; this._tablet = tablet;
      if (this._body.className !== cls) this._body.className = cls;
      this._body.style.setProperty("--x1-h", mode === "wide" ? `${h}px` : "auto");
      if (mode !== this._lastMode || tight !== this._lastTight || tablet !== this._lastTablet) { this._lastMode = mode; this._lastTight = tight; this._lastTablet = tablet; this._renderAll(); return; }
      this._frame(mode, h);
      this._drawFlow(); this._drawChart();
    }

    // The drawing's card takes a little over half of the period column under its title bar, and the battery's ring,
    // in the card's right-hand panel under the line of sources, is sized to what the panel's height leaves after its
    // words. A stacked screen scrolls, so its ring keeps one size.
    _frame(mode, h) {
      const col = this._body.querySelector(".col-period"), pbar = col?.querySelector(".pbar"), houseEl = col?.querySelector(".card.house");
      let house = "", ring = this._tablet || mode === "wide" ? "148px" : "116px", panel = "";
      if (((mode === "wide" && col && pbar) || this._tablet) && houseEl) {
        // The battery's tile takes a third of the house card's width and the drawing the rest: the card is as tall as it
        // takes for the drawing (sized by its height) to fill its two thirds. On the desktop that height comes out of
        // the charts' row, which keeps at least a third of the column (240 px; 190 when tight), and the place's two cards beside it grow to end
        // level with it, so the two charts still begin on one line and are one height; a card capped short of that
        // gives the tile what the drawing cannot use, so no empty band opens between the pole and the tile.
        const cs = getComputedStyle(houseEl), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const innerW = houseEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), bleed = parseFloat(cs.paddingLeft);
        const third = Math.max(236, Math.round(innerW / 3)), drawCol = innerW - third - 16 + bleed;
        const want = (7.2 * drawCol) / FLOW.SPAN + 56 + FLOW.TOP + padY;
        let hh, charts = "";
        if (mode === "wide") {
          const gap = parseFloat(getComputedStyle(col).rowGap) || 16, colH = col.clientHeight, pb = pbar.offsetHeight;
          // the place's two cards at their own height (they stretch to the row's line once it is set)
          const natural = (el) => { if (!el) return 0; const f0 = el.style.flex; el.style.flex = "none"; const v = el.offsetHeight; el.style.flex = f0; return v; };
          const now = this._body.querySelector(".card.now"), mean = this._body.querySelector(".card.meaning");
          const level = now && mean ? natural(now) + gap + natural(mean) - pb - gap : 0;
          // the charts' row keeps enough height for the power chart to carry a scale on both sides of its line
          const cap = colH - Math.max(this._tight ? 190 : 240, colH * 0.32) - gap - pb - gap;
          hh = Math.round(Math.max(level, Math.min(want, cap), 240));
          charts = `${Math.max(0, Math.round(colH - pb - gap - hh - gap))}px`;
        } else hh = Math.round(clamp(want, 300, 460));
        const inner = hh - padY;
        const drawW = FLOW.SPAN * ((inner - 56 - FLOW.TOP) / 7.2);
        const colW = Math.round(clamp(innerW - 16 - (drawW - bleed) - 12, third, innerW * 0.5));
        // the panel's tile: its head (the line of sources, its padding and hairline), a row gap, the ring, its two lines
        // of words; and no wider than the tile's column less its padding
        const head = (this._tight ? 20 + 9 : 24 + 13) + 1;
        house = `${hh}px`; panel = `${colW}px`;
        ring = `${Math.round(clamp(Math.min(inner - head - 8 - 42 - 10 - 12, colW - 24 - 24), 96, 220))}px`;
        if (this._body.style.getPropertyValue("--x1-charts") !== charts) { if (charts) this._body.style.setProperty("--x1-charts", charts); else this._body.style.removeProperty("--x1-charts"); }
      } else this._body.style.removeProperty("--x1-charts");
      if (this._body.style.getPropertyValue("--x1-ring") !== ring) this._body.style.setProperty("--x1-ring", ring);
      if (this._body.style.getPropertyValue("--x1-house") !== house) { if (house) this._body.style.setProperty("--x1-house", house); else this._body.style.removeProperty("--x1-house"); }
      if (this._body.style.getPropertyValue("--x1-panel") !== panel) { if (panel) this._body.style.setProperty("--x1-panel", panel); else this._body.style.removeProperty("--x1-panel"); }
    }

    _renderAll(fade = false) {
      if (!this._root || !this._ents || !this._hass) return;
      const mode = this._mode();
      const top = this.getBoundingClientRect().top + window.scrollY;
      const h = Math.max(520, window.innerHeight - top);
      this._tight = mode === "wide" && h < 700; this._tablet = this._tier().tablet;
      this._lastMode = mode; this._lastTight = this._tight; this._lastTablet = this._tablet;
      this._body.className = this._cls(mode, this._tablet, this._tight);
      this._body.style.setProperty("--x1-h", mode === "wide" ? `${h}px` : "auto");
      this._body.innerHTML = this._nowCol() + this._periodCol();
      this._renderRings();
      // the two cards over the battery's chart set where the charts' row begins, so a change in their height re-levels it
      for (const el of this._roCards ?? []) this._ro?.unobserve(el);
      this._roCards = [...this._body.querySelectorAll(".card.now, .card.meaning")];
      for (const el of this._roCards) this._ro?.observe(el);
      this._frame(mode, h);
      this._applyLive();
      this._loadPeriod(fade);
    }

    /* ----- the Now column ----- */

    _nowCol() {
      const name = this._config.name || "Home";
      return `<section class="col-now"><section class="card now">
        <div class="head"><h2>${esc(name)}</h2><span class="meta" data-k="mode"></span><span class="lamp" data-k="lamp"><i></i><span data-k="lamp-t"></span></span></div>
        <div class="heads" data-ledger>${["Solar", "House", "Bought", "Sold", "Charged", "Discharged"].map((n) => `<div class="cell card"><div class="cn">${n}</div><div class="cv">—</div><div class="cd"></div></div>`).join("")}</div></section>
        <section class="card meaning"><div class="rings" data-rings></div>
        <div class="foot"><span data-k="foot">Anker cloud statistics</span><span class="fr" data-k="footr"></span></div></section>
        <div class="pbody pb2" data-mg2></div></section>`;
    }

    _applyLive() {
      if (!this._root || !this._ents || !this._hass || !this._mounted) return;
      const L = this._live(); this._L = L;
      const f = L.f;
      const set = (k, v, fade = false) => { const el = this._root.querySelector(`[data-k="${k}"]`); if (!el) return; if (fade) this._swapText(el, v); else if (el.textContent !== v) el.textContent = v; };
      set("mode", this._modeWord ?? "");
      const lamp = this._root.querySelector('[data-k="lamp"]');
      if (lamp) {
        const cls = `lamp ${L.state === "unknown" ? "unknown" : L.stale ? "stale" : "on"}`;
        if (lamp.className !== cls) lamp.className = cls;
        // what the lamp knows is the cloud's connection and the data's age; nothing reports the grid's state
        set("lamp-t", L.state === "unknown" ? "Cloud unreachable" : L.stale ? `Last update ${f.ago(L.age)}` : `Updated ${f.ago(L.age)}`);
      }
      this._drawRing(L);
      set("h1", L.cap ? `${f.num(L.cap, 0)}${NB}kWh in ${L.packs ?? "—"} packs` : `${L.packs ?? "—"} packs`);
      const resWord = `${f.num(L.reserve)}%${NB}reserve`;
      set("h2", L.soc === null || !L.cap ? resWord : L.soc < L.reserve - 0.5 ? `${f.num(((L.reserve - L.soc) / 100) * L.cap, 1)}${NB}kWh below the ${resWord}` : L.usable < 0.05 ? `At the ${resWord}` : `${f.num(L.usable, 1)}${NB}kWh above the ${resWord}`);
      this._drawPowered(L);
      this._drawFlow();
    }

    // Above the drawing, what the house runs on at a glance: an icon for each source feeding it, in its colour and in
    // the drawing's order (the sun, the battery, the power plant for the grid), then "Powered". The full sentence,
    // with what the battery and the grid are doing, is its label and its tooltip. Old data greys the icons.
    _drawPowered(L) {
      const el = this._root.querySelector('[data-k="lede"]');
      if (!el) return;
      const say = this._lede(L), share = { solar: L.flows.Sh, batt: L.flows.Bh, grid: L.flows.Gh };
      const src = L.home <= 0.05 ? null : ["solar", "batt", "grid"].filter((k) => share[k] > 0.05);
      const word = src === null ? "House idle" : src.length ? "Powered" : "Powered, source unknown", old = L.stale || L.state === "unknown";
      if (el.getAttribute("aria-label") !== say) { el.setAttribute("aria-label", say); el.title = say; }
      const key = `${src ? src.join("+") : "idle"}|${word}|${old}`;
      if (el.dataset.key === key) return;
      el.classList.toggle("old", old);
      el.innerHTML = `${(src ?? []).map((k) => ICONS[k]).join("")}<span>${word}</span>`;
      // a change of source fades the new line in; the first drawing does not
      if (el.dataset.key && this._motion()) { el.classList.remove("in"); void el.offsetWidth; el.classList.add("in"); }
      el.dataset.key = key;
    }

    _drawRing(L) {
      const host = this._root.querySelector("[data-ring]");
      if (!host) return;
      const S = 148, c = S / 2, r = 61, C = 2 * Math.PI * r;
      const soc = L.soc ?? 0, res = L.reserve;
      if (!host.firstElementChild) {
        // the charge is the arc; under it the reserve is a darker segment of the track from the top to the reserve mark,
        // seen whenever the charge falls short of it; a tick outside the ring marks it whatever the charge (R4)
        host.innerHTML = `<svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Battery state of charge">
          <circle class="track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="13"/>
          <circle class="res" data-res cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="13" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 ${c} ${c})"/>
          <circle class="arc" data-arc cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="13" stroke-linecap="butt" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 ${c} ${c})"/>
          <line data-resmark x1="${c}" y1="${c - r - 9}" x2="${c}" y2="${c - r + 9}" stroke="var(--x1-ink)" stroke-width="2"/></svg>
          <div class="lbl"><div class="hero"><span data-k="soc">—</span></div></div>`;
      }
      host.querySelector("[data-arc]").setAttribute("stroke-dasharray", soc >= 99.95 ? "none" : `${soc} 100`);
      host.querySelector("[data-res]").setAttribute("stroke-dasharray", `${res} 100`);
      host.querySelector("[data-resmark]").setAttribute("transform", `rotate(${(res / 100) * 360} ${c} ${c})`);
      const el = host.querySelector('[data-k="soc"]');
      const socTxt = L.soc === null ? "—" : L.f.num(L.soc);
      this._swapText(el, socTxt);
      el.parentElement.classList.toggle("n3", socTxt.length >= 3);
      const svgEl = host.querySelector("svg");
      const txt = L.chg > 0.05 ? "charging" : L.dis > 0.05 ? "discharging" : "idle";
      const say = L.soc === null ? "Battery state of charge unknown" : `Battery ${L.f.num(L.soc)}%, ${txt}, reserve ${L.f.num(res)}%`;
      if (svgEl && svgEl.getAttribute("aria-label") !== say) svgEl.setAttribute("aria-label", say);
    }

    // The flow, drawn as the home: a gabled house seen from its front corner, in a true dimetric projection (the
    // camera 18° above the ground, so both walls run nearly level and the roof is seen from above). The panels lie
    // on the front slope, the X1 sits on the gable wall and every wire crosses there: solar down from the ridge,
    // the house out to the windows, the battery towers round the corner at the long wall's foot, the grid along
    // the ground and off the frame. A live wire takes its source's colour and its dots drift the way the power goes;
    // an idle one stays as the house's wiring. The figures sit at the corners, one per port, each with a dotted
    // lead to the thing it names; the hub carries none.
    _drawFlow() {
      const host = this._root.querySelector("[data-flow]"), L = this._L;
      if (!host || !L) return;
      // The frame is pushed in on the junction: it runs from just past the panels' far corner on the left to the pole's
      // crossarm on the right, measured in k (0.707 of a metre across), with a band over the drawing for the top figures.
      // the house, the array and the frame (FLOW); the service pole: in the gable's plane just past the roof's overhang, so
      // the grid's line runs straight along the gable into it and the roof's edge passes in front of it; its height is
      // set below, to the top of the figures' band
      const { D, LN, HT, R, e, td, poleA, poleB0, poleR, arm1, arm2, cols, rows, cw, aa0, aa1, pb0, pb1, UL, UR, SPAN, TOP } = FLOW;
      // the figures' columns: Solar's crosses the panels, House's is the wall box and Battery's is the root tower, the
      // rightmost; Grid shares Battery's, set over it in the top row beside the pole, with no lead
      const cS = 1.25, cH = -1.695;
      const W = Math.max(240, host.clientWidth), natural = Math.round((7.2 * W) / SPAN + 56 + TOP);
      let room = host.clientHeight || natural;
      if (this._mode() === "wide" || this._tablet) {
        // the drawing's card is cut to its share of the period column; the drawing has the card's height inside its
        // padding, the line of sources and the ring standing in the panel beside it
        const card = host.parentElement, cs = getComputedStyle(card);
        room = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      }
      // stacked, the page scrolls, so the drawing takes the height its width gives it, up to 300 px
      const H = Math.max(150, this._mode() === "wide" || this._tablet ? Math.min(natural, room) : Math.min(natural, 300));
      const f = L.f;
      // one unit is a metre of house; the axes carry the projection's foreshortening (0.74 along the ground, 0.95 up)
      const k = Math.min(W / SPAN, (H - 56 - TOP) / 7.2);
      const a = [-0.707 * k, -0.216 * k], b = [0.707 * k, -0.216 * k], up = 0.952 * k;
      // The drawing is rooted at the frame's left edge, cut where it always is (just past the panels' far corner), so
      // the house runs off the left as it did in the Now column; a frame wider than that leaves its room on the right.
      const O = [-UL * k, H - 30];
      const P = (la, lb, lw) => [O[0] + la * a[0] + lb * b[0], O[1] + la * a[1] + lb * b[1] - lw * up];
      // the pole stands two pixels left of where the frame was measured, so the figures keep their places
      const poleB = poleB0 - 2 / (0.707 * k), poleTop = (P(poleA, poleB, 0)[1] - 2 - 0.305 * poleR * k) / up;
      const pt = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      const poly = (ps, cls, fill) => `<polygon points="${ps.map(pt).join(" ")}" class="${cls}" fill="${fill}"/>`;
      const zE = HT - 0.15, zR = HT + R, roofZ = (lb) => zE + ((lb + e) / (D / 2 + e)) * (zR - zE);
      let g = "";
      // The house is lit, never outlined. A gradient runs through each plane with its bands parallel to the screen
      // direction u (an edge of the plane), from the band through p0 to the band through p1; without u it runs straight
      // from p0 to p1. Stops are tokens, so each theme keys the same light high or low.
      const fx = (v) => v.toFixed(1);
      const band = (id, p0, p1, u, stops) => {
        let x2 = p1[0], y2 = p1[1];
        if (u) { const ul = Math.hypot(u[0], u[1]) || 1, ux = u[0] / ul, uy = u[1] / ul, dot = (p1[0] - p0[0]) * ux + (p1[1] - p0[1]) * uy; x2 -= dot * ux; y2 -= dot * uy; }
        const st = stops.map(([o, c, op]) => `<stop offset="${o}" style="stop-color:var(${c})${op === undefined ? "" : `;stop-opacity:${op}`}"/>`).join("");
        return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fx(p0[0])}" y1="${fx(p0[1])}" x2="${fx(x2)}" y2="${fx(y2)}">${st}</linearGradient>`;
      };
      // a plane laid under its neighbours bleeds a hair under their edges, so no seam of the card shows where two meet
      const face = (ps, id) => `<polygon points="${ps.map(pt).join(" ")}" class="face" fill="url(#${id})" style="stroke:url(#${id});stroke-width:.8px;stroke-linejoin:round"/>`;
      g += `<defs>${[
        // the long wall: darkest under the eave, lightest a little above its foot, occluded where it meets the ground
        band("x1-gw", P(0, 0, HT), P(0, 0, 0), a, [[0, "--x1-wall-lo"], [0.32, "--x1-wall"], [0.84, "--x1-wall-hi"], [1, "--x1-wall-foot"]]),
        // the gable: in shade under the rake and at the house's corner, lighter toward its far foot
        band("x1-gg", P(0, 0, zE + 0.5), P(0, D, 0.2), null, [[0, "--x1-gable-lo"], [0.5, "--x1-gable"], [1, "--x1-gable-hi"]]),
        // the front slope: the ridge catching the sun, falling off toward the eave
        band("x1-gr", P(0, D / 2, zR), P(0, -e, zE), a, [[0, "--x1-roof-hi"], [0.22, "--x1-roof"], [1, "--x1-roof-lo"]]),
        // the house's shadow, darkest at the long wall's foot and softening as it falls away; the feet's contact shade
        band("x1-gc", P(0, 0, 0), P(0, -1.6, 0), a, [[0, "--x1-cast", 1], [0.55, "--x1-cast", 0.45], [1, "--x1-cast", 0.08]]),
        band("x1-gf", P(0, 0, 0), P(0, -0.5, 0), a, [[0, "--x1-cast", 1], [1, "--x1-cast", 0]]),
        band("x1-gh", P(0, 0, 0), P(-0.5, 0, 0), b, [[0, "--x1-cast", 1], [1, "--x1-cast", 0]]),
      ].join("")}<linearGradient id="x1-gk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--x1-cab-lit)"/><stop offset="1" style="stop-color:color-mix(in srgb, var(--x1-cab-lit) 78%, #000)"/></linearGradient><linearGradient id="x1-gq" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--x1-batt)"/><stop offset="1" style="stop-color:color-mix(in srgb, var(--x1-batt) 82%, #000)"/></linearGradient><linearGradient id="x1-gp" x1="1" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--x1-panel-sheen)"/><stop offset=".45" style="stop-color:var(--x1-panel-off)"/><stop offset="1" style="stop-color:var(--x1-panel-deep)"/></linearGradient></defs>`;
      // The sun stands high, 20° from overhead, at the upper right and a little behind the house: the roof takes the
      // most light, the gable less and the long wall least, and every shadow falls short toward the lower left. The
      // house's lies on the ground along the feet of the long wall and the gable, the shape of the whole house (walls,
      // overhangs and ridge) cast flat. SD is how far a point's shadow moves on the ground per metre of its height.
      const SUN = [0.25, 0.97], TILT = Math.tan((20 * Math.PI) / 180), SL = Math.hypot(SUN[0], SUN[1]);
      const SD = [(-SUN[0] / SL) * TILT, (-SUN[1] / SL) * TILT], cast = (la, lb, z) => [la + SD[0] * z, lb + SD[1] * z];
      const hull = (pts) => {
        const q = [...pts].sort((m, n) => m[0] - n[0] || m[1] - n[1]), x = (o, m, n) => (m[0] - o[0]) * (n[1] - o[1]) - (m[1] - o[1]) * (n[0] - o[0]);
        const lo = [], hi = [];
        for (const v of q) { while (lo.length > 1 && x(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop(); lo.push(v); }
        for (const v of q.reverse()) { while (hi.length > 1 && x(hi[hi.length - 2], hi[hi.length - 1], v) <= 0) hi.pop(); hi.push(v); }
        return lo.slice(0, -1).concat(hi.slice(0, -1));
      };
      const solid = [[0, 0, 0], [LN, 0, 0], [LN, D, 0], [0, D, 0], [-e, -e, zE], [LN + e, -e, zE], [LN + e, D + e, zE], [-e, D + e, zE], [-e, D / 2, zR], [LN + e, D / 2, zR]];
      g += poly(hull(solid.map(([la, lb, z]) => cast(la, lb, z))).map(([la, lb]) => P(la, lb, 0)), "cast", "url(#x1-gc)");
      // the pole's shadow: a thin line along the light's fall, with its crossarms
      const pc = (lb, z) => P(...cast(poleA, lb, z), 0);
      g += `<path class="pole-cast" d="M${pt(P(poleA, poleB, 0))}L${pt(pc(poleB, poleTop))}M${pt(P(...cast(poleA - arm1, poleB, poleTop - 0.35), 0))}L${pt(P(...cast(poleA + arm1, poleB, poleTop - 0.35), 0))}M${pt(P(...cast(poleA - arm2, poleB, poleTop - 0.9), 0))}L${pt(P(...cast(poleA + arm2, poleB, poleTop - 0.9), 0))}"/>`;
      // where both walls meet the ground, a contact shade fading out from the foot, mitred at the corner; the two walls,
      // the back slope seen over the ridge, the front slope, the roof's thickness at its edges
      g += poly([P(LN, 0, 0), P(0, 0, 0), P(-0.5, -0.5, 0), P(LN, -0.5, 0)], "cast", "url(#x1-gf)");
      g += poly([P(0, 0, 0), P(0, D, 0), P(-0.5, D, 0), P(-0.5, -0.5, 0)], "cast", "url(#x1-gh)");
      g += face([P(0, 0, 0), P(LN, 0, 0), P(LN, 0, HT), P(0, 0, HT)], "x1-gw");
      g += face([P(0, 0, 0), P(0, D, 0), P(0, D, HT), P(0, D / 2, zR), P(0, 0, HT)], "x1-gg");
      // the house's end of the circuit: a plain box on the long wall in the wall's colour, half as deep as a battery
      // tower, centred on House's column; the house's line ends in it
      const od = td / 2, laH = -cH / 0.707 - od, oa0 = laH - 1.3, oa1 = laH + 1.3, oz0 = 0.8, oz1 = 2.2, sh = 0.14;
      g += poly([P(oa0 + sh, 0, oz0 - sh), P(oa1 + sh, 0, oz0 - sh), P(oa1 + sh, 0, oz1 - sh), P(oa0 + sh, 0, oz1 - sh)], "shade", "var(--x1-shadow)");
      g += poly([P(oa0, -od, oz0), P(oa1, -od, oz0), P(oa1, -od, oz1), P(oa0, -od, oz1)], "face", "var(--x1-box)");
      g += poly([P(oa0, -od, oz1), P(oa1, -od, oz1), P(oa1, 0, oz1), P(oa0, 0, oz1)], "face", "var(--x1-box-top)");
      g += poly([P(oa0, -od, oz0), P(oa0, 0, oz0), P(oa0, 0, oz1), P(oa0, -od, oz1)], "face", "var(--x1-gable)");
      // The service pole stands just past the roof, behind its edge, and rises to the top of the figures' band, where it
      // is Grid's pointer. It is a cylinder: a gradient across its width runs from the shaded side through the light,
      // which comes from the upper right, to a narrow falloff at its far edge, under a lighter cap; its two crossarms
      // are beams laid across the line, each showing its top, its long side and its end, the half behind the pole drawn
      // before it and the half in front after. It is toned from the house's own palette, so it recedes into the card.
      {
        const a = poleA, pb = poleB, base = P(a, pb, 0), top = P(a, pb, poleTop), rw = poleR * k, ry = 0.305 * poleR * k, f1 = (v) => v.toFixed(1);
        g += `<defs><linearGradient id="x1-pole" x1="0" x2="1" y1="0" y2="0"><stop offset="0" class="pl0"/><stop offset=".28" class="pl1"/><stop offset=".62" class="pl2"/><stop offset=".86" class="pl3"/><stop offset="1" class="pl4"/></linearGradient></defs>`;
        const beam = (a0, a1, z0, z1, w) => poly([P(a0, pb - w, z1), P(a1, pb - w, z1), P(a1, pb + w, z1), P(a0, pb + w, z1)], "arm", "var(--x1-pole-top)")
          + poly([P(a0, pb - w, z0), P(a1, pb - w, z0), P(a1, pb - w, z1), P(a0, pb - w, z1)], "arm", "var(--x1-pole-dark)")
          + poly([P(a0, pb - w, z0), P(a0, pb + w, z0), P(a0, pb + w, z1), P(a0, pb - w, z1)], "arm", "var(--x1-pole-lit)");
        const arms = [[arm1, poleTop - 0.35], [arm2, poleTop - 0.9]], th = 0.16, w = 0.08;
        for (const [L, zt] of arms) g += beam(a + poleR, a + L, zt - th, zt, w);
        g += `<path class="arm" fill="url(#x1-pole)" d="M${f1(base[0] - rw)},${f1(base[1])}L${f1(top[0] - rw)},${f1(top[1])}A${f1(rw)},${f1(ry)} 0 0 1 ${f1(top[0] + rw)},${f1(top[1])}L${f1(base[0] + rw)},${f1(base[1])}A${f1(rw)},${f1(ry)} 0 0 1 ${f1(base[0] - rw)},${f1(base[1])}Z"/>`;
        g += `<ellipse class="arm" cx="${f1(top[0])}" cy="${f1(top[1])}" rx="${f1(rw)}" ry="${f1(ry)}" fill="var(--x1-pole-top)"/>`;
        for (const [L, zt] of arms) g += beam(a - L, a - poleR, zt - th, zt, w);
      }
      g += poly([P(-e, D / 2, zR), P(LN + e, D / 2, zR), P(LN + e, D + e, zE), P(-e, D + e, zE)], "face", "var(--x1-roof-back)");
      g += face([P(-e, -e, zE), P(LN + e, -e, zE), P(LN + e, D / 2, zR), P(-e, D / 2, zR)], "x1-gr");
      const t = 0.18;
      g += poly([P(-e, -e, zE), P(-e, D / 2, zR), P(-e, D + e, zE), P(-e, D + e, zE - t), P(-e, D / 2, zR - t), P(-e, -e, zE - t)], "face", "var(--x1-trim-g)");
      g += poly([P(-e, -e, zE), P(LN + e, -e, zE), P(LN + e, -e, zE - t), P(-e, -e, zE - t)], "face", "var(--x1-trim)");
      // Eight panels on the front slope, two rows of four from the gable end. Each is a grid of 48 by 48 pixels laid
      // in the roof's plane, so the pixels foreshorten with it; the share lit is the array's output over the most it
      // makes, scattered at random, none at night and all at full power. The roof and the dark panels are drawn under
      // the pixels, the panels' outlines and everything else over them.
      const rh = (pb1 - pb0) / rows, gap = 0.1, onRoof = (la, lb) => P(la, lb, roofZ(lb));
      const panels = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const la0 = aa0 + c * cw + gap / 2, lb0 = pb0 + r * rh + gap / 2, la1 = la0 + cw - gap, lb1 = lb0 + rh - gap;
        panels.push({ o: onRoof(la0, lb0), u: onRoof(la1, lb0), v: onRoof(la0, lb1), q: [onRoof(la0, lb0), onRoof(la1, lb0), onRoof(la1, lb1), onRoof(la0, lb1)] });
        // the panel stands off the roof: its shadow is the panel moved along the light's fall, a sliver below it
        const [sa, sb] = cast(0, 0, 0.35);
        g += poly([onRoof(la0 + sa, lb0 + sb), onRoof(la1 + sa, lb0 + sb), onRoof(la1 + sa, lb1 + sb), onRoof(la0 + sa, lb1 + sb)], "pshade", "none");
      }
      for (const p of panels) g += poly(p.q, "panel", "url(#x1-gp)");
      const under = g;
      g = "";
      for (const p of panels) g += `<polygon points="${p.q.map(pt).join(" ")}" class="array"/>`;
      // The circuit is a cross on the gable, as the X1 is installed: a vertical trunk under the ridge carries solar down
      // to the junction and the battery's power up from the foot of the wall; a horizontal trunk carries the house's
      // power along the wall into the house and the grid's out to the pole. The junction is a flush plate where the
      // trunks cross. The battery towers stand at the foot of the gable beside the vertical trunk, larger than life,
      // each a bar of charge with the reserve marked across it.
      // The solar line leaves the top row of panels at its gable end, runs down the slope's edge to the rake and drops
      // straight down the gable into the junction, which sits under the drop
      const Ls = 3.2, hd = 0.12, hubB = Ls + e - hd, hubZ = 1.95, hw = 0.4, hh = 0.4;
      // The towers are rooted at the right: the last stands where the gable's foot ends and each added pack pushes the
      // row left, so with fewer packs the battery's line runs farther along the wall. Battery's figure stands on the root.
      const towers = Math.max(1, Math.min(4, Math.round(L.towers ?? 1))), tg = 0.22, th = 1.5, tEnd = D - 0.23;
      const tw = Math.min(0.95, (tEnd - hubB - 0.6 - (towers - 1) * tg) / towers), t0 = tEnd - towers * tw - (towers - 1) * tg;
      // Battery's column is the root tower's centre at its full width, so a narrower row of four never moves the figure
      const cB = 0.707 * (tEnd - 0.475 + td);
      const towerLb = (i) => t0 + i * (tw + tg);
      const soc = L.soc === null ? null : clamp(L.soc, 0, 100) / 100, resZ = (L.reserve / 100) * th;
      // every line ends at one point on the wall behind the plate's centre, hidden by it: the house's and the grid's
      // run level along the gable, the battery's rises plumb from the wall's foot, solar's drops plumb from the rake
      const hubC = P(0, Ls + e, hubZ);
      // Every wire carries one lane per source of the energy on it, side by side in the source's colour: the house
      // line can carry solar, the battery and the grid at once, the battery line solar and the grid while charging,
      // the grid line solar and the battery while selling. A wire never carries power both ways at once (the cloud
      // reports net flows), so lanes are sources, not directions. Each lane's beads drift at a speed set by its power.
      // A direction counts only above the threshold its figure uses, so a trickle never reads as charging or selling.
      const charging = L.chg > 0.05 && L.chg > L.dis, selling = L.exp > 0.05 && L.exp > L.imp;
      const wires = [
        ["solar", [onRoof(aa0, Ls), P(-e, Ls, roofZ(Ls)), hubC], false, { solar: L.solar }],
        ["home", [P(oa0, -od / 2, hubZ), P(0, 0, hubZ), hubC], true, { solar: L.flows.Sh, batt: L.flows.Bh, grid: L.flows.Gh }],
        ["batt", [P(0, t0, 0.22), P(0, Ls + e, 0.22), hubC], charging, charging ? { solar: L.flows.Sb, grid: L.flows.Gb } : { batt: L.dis }],
        ["grid", [P(poleA, poleB - poleR, hubZ), hubC], selling, selling ? { solar: L.flows.Sg, batt: L.flows.Bg } : { grid: L.imp }],
      ];
      const LANE = 3.5, ORDER = ["solar", "batt", "grid"];
      const maxP = Math.max(0.5, L.solar, L.imp, L.exp, L.chg, L.dis, L.home);
      const rateOf = (kw) => 6 / (6 - 5 * Math.min(1, kw / maxP));
      // a polyline moved sideways by d px, with mitred corners, so parallel lanes keep their spacing round a bend
      const shift = (pts, d) => {
        if (!d) return pts;
        const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; };
        return pts.map((q, i) => {
          const n0 = i > 0 ? nrm(pts[i - 1], q) : null, n1 = i < pts.length - 1 ? nrm(q, pts[i + 1]) : null;
          if (!n0 || !n1) { const n = n0 ?? n1; return [q[0] + n[0] * d, q[1] + n[1] * d]; }
          const m = [n0[0] + n1[0], n0[1] + n1[1]], ml = Math.hypot(m[0], m[1]) || 1, k = d / Math.max(0.3, (m[0] * n0[0] + m[1] * n0[1]) / ml);
          return [q[0] + (m[0] / ml) * k, q[1] + (m[1] / ml) * k];
        });
      };
      const path = (pts, back) => { const q = back ? [...pts].reverse() : pts; return `M${q.map(pt).join("L")}`; };
      const live = [];
      for (const [key, pts, away, shares] of wires) {
        const srcs = ORDER.filter((k) => (shares[k] ?? 0) > 0.05), n = srcs.length;
        // the lanes are laid out on the wire as drawn toward the hub, so a change of direction never swaps them
        const lanes = srcs.map((src, i) => ({ src, kw: shares[src], col: `var(--x1-${src})`, d: path(shift(pts, (i - (n - 1) / 2) * LANE), away) }));
        g += `<path class="wire${n ? " on" : ""}" d="${path(pts, away)}"${n ? ` stroke-width="${(n * LANE + 2.5).toFixed(1)}"` : ""}/>`;
        for (const l of lanes) g += `<path class="lane" d="${l.d}" stroke="${l.col}"/>`;
        live.push({ key, lanes });
      }
      g += poly([P(0, hubB - hw - 0.1, hubZ - hh - 0.1), P(0, hubB + hw - 0.1, hubZ - hh - 0.1), P(0, hubB + hw - 0.1, hubZ + hh - 0.1), P(0, hubB - hw - 0.1, hubZ + hh - 0.1)], "shade", "var(--x1-shadow)");
      // the plate itself is drawn over the lines and their beads: its face toward the gable's side, its top catching the
      // high sun, its narrow side in shade
      const plate = poly([P(-hd, hubB - hw, hubZ - hh), P(0, hubB - hw, hubZ - hh), P(0, hubB - hw, hubZ + hh), P(-hd, hubB - hw, hubZ + hh)], "hub", "var(--x1-plate-side)")
        + poly([P(-hd, hubB - hw, hubZ + hh), P(-hd, hubB + hw, hubZ + hh), P(0, hubB + hw, hubZ + hh), P(0, hubB - hw, hubZ + hh)], "hub", "var(--x1-plate-top)")
        + poly([P(-hd, hubB - hw, hubZ - hh), P(-hd, hubB + hw, hubZ - hh), P(-hd, hubB + hw, hubZ + hh), P(-hd, hubB - hw, hubZ + hh)], "hub", "var(--x1-plate-front)");
      // the towers, the farthest first so the nearer ones stand in front of it
      // a shadow on the ground under the row; each tower a cabinet tinted with the battery's colour, its charge a solid
      // fill from the floor, the narrow side away from the light darker and the top lightest, the reserve marked across
      g += poly([P(-td - 0.12, t0 - 0.12, 0), P(-td - 0.12, tEnd + 0.06, 0), P(0, tEnd + 0.06, 0), P(0, t0 - 0.12, 0)], "shade", "var(--x1-shadow)");
      for (let i = towers - 1; i >= 0; i--) {
        const lb0 = towerLb(i), lb1 = lb0 + tw;
        const face = (z0, z1) => [P(-td, lb0, z0), P(-td, lb1, z0), P(-td, lb1, z1), P(-td, lb0, z1)];
        const side = (z0, z1) => [P(-td, lb0, z0), P(0, lb0, z0), P(0, lb0, z1), P(-td, lb0, z1)];
        const lid = (z) => [P(-td, lb0, z), P(-td, lb1, z), P(0, lb1, z), P(0, lb0, z)];
        g += poly(face(0, th), "cab", "url(#x1-gk)") + poly(side(0, th), "cab", "var(--x1-cab)") + poly(lid(th), "cab", "var(--x1-cab-top)");
        if (soc !== null && soc > 0.01) {
          const z = soc * th;
          g += poly(face(0, z), "charge", "url(#x1-gq)") + poly(side(0, z), "charge", "var(--x1-batt-shade)") + poly(lid(z), "charge", "var(--x1-batt-top)");
        }
        g += `<path class="mark" d="M${pt(P(-td, lb0, resZ))}L${pt(P(-td, lb1, resZ))}"/>`;
      }
      // the four figures, each named and figured, with a lead to what it names
      const kw = (v) => (v > 0.05 ? `${f.num(v, v >= 10 ? 0 : 1)}${NB}kW` : `0${NB}kW`);
      const words = [
        ["Solar", kw(L.solar)],
        ["Grid", kw(Math.max(L.imp, L.exp))],
        ["House", kw(L.home)],
        [`Battery${towers > 1 ? ` ×${towers}` : ""}`, kw(Math.max(L.chg, L.dis))],
      ];
      // the skeleton is built once per size: the scene group is redrawn freely, the dot strands persist so a refresh
      // or a change of speed never restarts their drift, and the labels keep their nodes
      const size = `${W}x${H}`;
      let svg = host.querySelector("svg");
      if (!svg || svg.dataset.size !== size) {
        this._pxKey = null;
        host.innerHTML = `<div class="stage" style="width:${W}px;height:${H}px"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="over" role="img" data-size="${size}"><defs><clipPath id="x1fc"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#x1fc)" data-scene></g><g clip-path="url(#x1fc)" data-beads>${live.map((w) => [0, 1, 2].map((i) => `<path class="dots" data-w="${w.key}" data-i="${i}" visibility="hidden"/>`).join("")).join("")}</g><g data-top></g><g>${words.map((w_, i) => `<line class="lead" data-l="${i}"/>${i < 2 ? `<rect class="tag" data-t="${i}" rx="6" width="0" height="0"/>` : ""}<text class="port" data-n="${i}"></text><text class="port v" data-v="${i}"></text>`).join("")}</g></svg><canvas data-px aria-hidden="true"></canvas><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="under" aria-hidden="true"><g data-under></g></svg><i class="px-ink" hidden></i></div>`;
        svg = host.querySelector("svg");
      }
      const underG = host.querySelector("[data-under]");
      if (underG.innerHTML !== under) underG.innerHTML = under;
      this._paintPixels(host, panels, W, H, L);
      const lede = `Power flow: ${this._lede(L)}`;
      if (svg.getAttribute("aria-label") !== lede) svg.setAttribute("aria-label", lede);
      const scene = svg.querySelector("[data-scene]");
      if (scene.innerHTML !== g) scene.innerHTML = g;
      const topG = svg.querySelector("[data-top]");
      if (topG.innerHTML !== plate) topG.innerHTML = plate;
      const setA = (el, a, v) => { if (el.getAttribute(a) !== String(v)) el.setAttribute(a, v); };
      // old data draws no drift: the wires keep their colours, the dots stand still until a fresh report
      const motion = this._motion() && !L.stale && L.state !== "unknown";
      for (const w of live) for (let i = 0; i < 3; i++) {
        const el = svg.querySelector(`[data-w="${w.key}"][data-i="${i}"]`), lane = motion ? w.lanes[i] : null;
        if (!lane) { setA(el, "visibility", "hidden"); continue; }
        setA(el, "d", lane.d); setA(el, "stroke", lane.col); setA(el, "visibility", "visible");
        // each lane's speed is its animation's playback rate, so neither a tick nor a change of power restarts it
        const rate = rateOf(lane.kw);
        if (el.getAnimations) for (const a of el.getAnimations()) if (Math.abs(a.playbackRate - rate) > 0.01) a.playbackRate = rate;
      }
      // The four figures stand on one grid: their leads are the four evenly spaced columns, solid and upright, and the
      // figures sit in two rows, Solar and Grid in the band over the drawing, House and Battery under it. Each is set
      // flush right against its lead, which runs its height and on to what it names; one that would meet its neighbour
      // or the frame's edge moves right, and its lead then stops short of it. Each is measured in its widest words,
      // so a new figure never moves it. A top figure with no open sky behind it sits on a tag.
      const near = P(-e, D / 2, zR), far = P(LN + e, D / 2, zR), back = P(-e, D + e, zE);
      const rise = (near[1] - far[1]) / Math.max(1, near[0] - far[0]);
      const topY = (x) => (x <= near[0] ? near[1] - (near[0] - x) * rise : near[1] + (x - near[0]) * (back[1] - near[1]) / Math.max(1, back[0] - near[0]));
      const INK = 30, GAP = 6, across = (x) => (x - O[0]) / (0.707 * k), lbTop = pb1 - gap / 2;
      const lx = [cS, cB, cH, cB].map((c) => Math.round(O[0] + c * k) + 0.5);
      const hit = [
        onRoof(lbTop - across(lx[0]), lbTop)[1] - 2, 0,
        P(-across(lx[2]) - od, -od, oz0)[1] + 2, P(-td, across(lx[3]) - td, 0)[1] + 2,
      ];
      const wKey = `${size}|${towers}`;
      if (this._labW?.key !== wKey) {
        const widest = [["Solar", "8.8 kW"], ["Grid", "8.8 kW"], ["House", "8.8 kW"], [`Battery${towers > 1 ? ` ×${towers}` : ""}`, "8.8 kW"]];
        const ws = widest.map(([nm, vl], i) => {
          const n = svg.querySelector(`[data-n="${i}"]`), v = svg.querySelector(`[data-v="${i}"]`);
          n.textContent = nm; v.textContent = vl;
          return Math.max(n.getComputedTextLength?.() ?? 0, v.getComputedTextLength?.() ?? 0);
        });
        this._labW = ws.every((w) => w > 0) ? { key: wKey, ws } : { key: null, ws: widest.map(([nm, vl]) => Math.max(nm.length * 6.6, vl.length * 7.4)) };
      }
      const ws = this._labW.ws, right = [], flush = [];
      for (const row of [[0, 1], [2, 3]]) {
        let edge = 2;
        for (const i of row) {
          const want = lx[i] - GAP, r = want - ws[i] >= edge ? want : Math.min(W - 2, edge + ws[i]);
          right[i] = r; flush[i] = r === want; edge = r + 12;
        }
      }
      words.forEach(([name, val], i) => {
        const n = svg.querySelector(`[data-n="${i}"]`), v = svg.querySelector(`[data-v="${i}"]`), l = svg.querySelector(`[data-l="${i}"]`), tag = svg.querySelector(`[data-t="${i}"]`);
        if (n.textContent !== name) n.textContent = name;
        if (v.textContent !== val) v.textContent = val;
        const top = i < 2, y = top ? 12 : H - 18, x = right[i].toFixed(1);
        setA(n, "x", x); setA(n, "y", y); setA(n, "text-anchor", "end");
        setA(v, "x", x); setA(v, "y", y + 16); setA(v, "text-anchor", "end");
        if (tag) { const open = topY(right[i] - ws[i]) >= INK + 3; setA(tag, "visibility", open ? "hidden" : "visible"); setA(tag, "x", (right[i] - ws[i] - 4).toFixed(1)); setA(tag, "y", (y - 13).toFixed(1)); setA(tag, "width", (ws[i] + 8).toFixed(1)); setA(tag, "height", "34"); }
        // Grid stands beside its pole, set over Battery's column, and needs no lead
        const [y1, y2] = top ? [flush[i] ? 2 : INK + 4, hit[i]] : [hit[i], flush[i] ? H - 4 : H - 32];
        setA(l, "visibility", i !== 1 && y2 > y1 + 4 ? "visible" : "hidden"); setA(l, "x1", lx[i]); setA(l, "x2", lx[i]); setA(l, "y1", y1.toFixed(1)); setA(l, "y2", y2.toFixed(1));
      });
    }

    // The panels' pixels, painted on a canvas sized to the array: each panel's 48 by 48 grid is drawn into its
    // parallelogram by an affine transform, nearest pixel, so every pixel on the screen is on or off. Painted only
    // when the count, the colour, the size or the screen's density changes. Nothing is ever read back.
    _paintPixels(host, panels, W, H, L) {
      const cv = host.querySelector("[data-px]"), ink = host.querySelector(".px-ink");
      if (!cv?.getContext) return;
      const peak = this._peak(), solar = L.solar > 0.05 && (peak !== null || this._peakTried) ? L.solar : 0;
      const frac = solar > 0 ? clamp(solar / Math.max(peak ?? solar, solar), 0, 1) : 0;
      const order = pixelOrder(), total = order.length, lit = Math.round(frac * total);
      const col = getComputedStyle(ink).color, dpr = Math.min(3, window.devicePixelRatio || 1);
      const xs = panels.flatMap((p) => p.q.map((q) => q[0])), ys = panels.flatMap((p) => p.q.map((q) => q[1]));
      const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
      const x1 = Math.min(W, Math.ceil(Math.max(...xs)) + 1), y1 = Math.min(H, Math.ceil(Math.max(...ys)) + 1);
      const key = `${W}x${H}|${dpr}|${lit}|${col}|${x0},${y0},${x1},${y1}`;
      if (cv.dataset.lit !== String(lit)) cv.dataset.lit = String(lit);
      if (this._pxKey === key) return;
      this._pxKey = key;
      const bw = Math.max(1, Math.round((x1 - x0) * dpr)), bh = Math.max(1, Math.round((y1 - y0) * dpr));
      if (cv.width !== bw) cv.width = bw;
      if (cv.height !== bh) cv.height = bh;
      Object.assign(cv.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      const ctx = cv.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bw, bh);
      if (!lit) return;
      // the lit pixels, one row of the texture per panel row of pixels, the eight panels stacked
      const tex = (this._pxTex = this._pxTex ?? document.createElement("canvas"));
      if (tex.width !== PX) tex.width = PX;
      if (tex.height !== PX * PANELS) tex.height = PX * PANELS;
      const t = tex.getContext("2d");
      t.clearRect(0, 0, PX, PX * PANELS);
      t.fillStyle = "#e8a33d"; t.fillStyle = col;
      for (let i = 0; i < lit; i++) { const j = order[i], pi = (j / (PX * PX)) | 0, r = j % (PX * PX); t.fillRect(r % PX, pi * PX + ((r / PX) | 0), 1, 1); }
      ctx.imageSmoothingEnabled = false;
      panels.forEach((p, i) => {
        const ux = (p.u[0] - p.o[0]) / PX, uy = (p.u[1] - p.o[1]) / PX, vx = (p.v[0] - p.o[0]) / PX, vy = (p.v[1] - p.o[1]) / PX;
        ctx.setTransform(ux * dpr, uy * dpr, vx * dpr, vy * dpr, (p.o[0] - x0) * dpr, (p.o[1] - y0) * dpr);
        ctx.drawImage(tex, 0, i * PX, PX, PX, 0, 0, PX, PX);
      });
    }

    /* ----- the period column ----- */

    _periodCol() {
      return `<section class="col-period">
        <div class="card pbar"><h2 data-k="ptitle">Today</h2>
          <span class="nav"><button class="chev" data-nav="prev" title="Previous period" aria-label="Previous period">‹</button><button class="chev" data-nav="next" title="Next period" aria-label="Next period">›</button><button data-nav="now" title="Back to now">Now</button></span><span class="meta pvs" data-k="pvs"></span>
          <div class="head-r"><span class="seg" role="group" aria-label="Period">${VIEWS.map((v) => `<button data-view="${v}" aria-pressed="${this._view === v}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join("")}</span>
          <button class="tbtn" data-csv title="Download this period as CSV">CSV</button></div></div>
        <section class="card house"><div class="lede" data-k="lede" role="img"></div>
          <div class="hero-row">
            <div class="ring" data-ring></div>
            <div class="hero-txt">
              <div class="v" data-k="h2"></div>
              <div class="k" data-k="h1"></div>
            </div>
          </div>
          <div class="flow" data-flow></div></section>
        <div class="pbody" data-mg></div></section>`;
    }
    _syncTabs() { this._root.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === this._view))); }

    _renderPeriod(fade) {
      const P = this._P;
      if (!P || !this._root) return;
      const f = this._fmt();
      this._swapText(this._root.querySelector('[data-k="ptitle"]'), P.title);
      const prev = this._root.querySelector('[data-nav="prev"]'), next = this._root.querySelector('[data-nav="next"]'), now = this._root.querySelector('[data-nav="now"]');
      if (next) next.disabled = !P.next; if (now) now.disabled = P.isNow;
      this._renderLedger();
      this._renderRings();
      // the meaning card's foot is set before the charts are drawn: the battery's strip takes the Now column's
      // remaining height, which the foot's wrapping changes
      const foot = this._root.querySelector('[data-k="foot"]'), footr = this._root.querySelector('[data-k="footr"]');
      if (foot) { foot.textContent = this._perror ? "Statistics unavailable" : `Anker's totals · charts from its ${P.view === "day" ? "5-minute averages" : P.view === "year" ? "monthly totals" : "daily totals"}`; foot.title = this._perror ? String(this._perror) : ""; }
      // the lifetime saving sits in the meaning card until a tariff prices each period, then here
      const tariff = Number(this._config.rate_import) > 0, LL = this._L;
      if (footr) footr.textContent = LL?.yieldMwh ? `${f.num(LL.yieldMwh, 2)}${NB}MWh since install${tariff && LL.savings ? ` · ${this._money(LL.savings)} saved by Anker's count` : ""}` : "";
      const host = this._root.querySelector("[data-mg]"), host2 = this._root.querySelector("[data-mg2]");
      const ghost = fade ? this._ghost(host) : null, ghost2 = fade ? this._ghost(host2) : null;
      this._drawChart();
      this._settle(host, ghost); this._settle(host2, ghost2);
      if (P.isNow && P.view === "day") this._applyLive();
    }

    _renderLedger(bucket = null) {
      const host = this._root.querySelector("[data-ledger]"), D = this._data, f = this._fmt();
      if (!host) return;
      const cells = host.querySelectorAll(".cell");
      const T = bucket ? bucket : D?.T;
      const kw = !!bucket?.kw;
      const vals = T ? [T.S, T.L, T.Gi, T.Ge, T.Bc, T.Bd] : [null, null, null, null, null, null];
      const keys = ["S", "L", "Gi", "Ge", "Bc", "Bd"];
      const unit = kw ? "kW" : "kWh";
      let shown = null;
      vals.forEach((v, i) => {
        const cv = cells[i].querySelector(".cv"), cd = cells[i].querySelector(".cd");
        const big = !kw && v !== null && v !== undefined && v >= 1000;
        const txt = v === null || v === undefined ? "—" : big ? f.num(v / 1000, v >= 10000 ? 1 : 2) : f.num(v, kw ? (v >= 10 ? 1 : 2) : v >= 100 ? 0 : 1);
        const want = txt === "—" ? "—" : `${txt}<span class="unit">${NB}${big ? "MWh" : unit}</span>`;
        if (cv.innerHTML !== want) cv.innerHTML = want;
        let d = "", title = "";
        if (!bucket && T && this._prevT && v !== null && v !== undefined) {
          const p = this._prevT[keys[i]], vs = this._P.view === "day" ? "yesterday" : this._P.view === "week" ? "last week" : this._P.view === "month" ? "last month" : "last year";
          const diff = v - p, pct = p > 0 ? (diff / p) * 100 : null;
          // a small base makes a silly percentage; the difference then says it better, in the cell's own unit;
          // a previous period with nothing recorded makes no comparison at all. What it is compared with is said
          // once, in the title bar, so each card carries only its change.
          const ab = Math.abs(diff), adiff = ab >= 1000 ? `${f.num(ab / 1000, 1)}${NB}MWh` : `${f.num(ab, ab >= 100 ? 0 : 1)}${NB}kWh`;
          // a change that rounds to nothing is no change, never "−0%"
          const rp = pct === null ? null : Math.round(Math.abs(pct));
          d = p <= 0 ? "" : ab < 0.05 || rp === 0 ? "no change" : rp !== null && rp <= 200 && p >= 0.5 ? `${pct >= 0 ? "+" : "−"}${f.num(rp)}%` : `${diff >= 0 ? "+" : "−"}${adiff}`;
          title = !d ? "" : this._prevT.partial ? `Compared with the same part of ${vs}, up to this time` : `Compared with the whole of ${vs}`;
          if (d) shown = vs;
        }
        else if (bucket) d = "";
        if (i === 4 && T && T.Sb !== undefined) { const e = (v) => (!kw && v >= 1000 ? `${f.num(v / 1000, 2)} MWh` : `${f.num(v, 1)} ${unit}`); title = `${title ? title + ". " : ""}Charged ${e(T.Sb)} from solar and ${e(T.Gb)} from the grid`; }
        if (cd.textContent !== d) cd.textContent = d;
        if ((cd.title || "") !== title) cd.title = title;
      });
      // the comparison, once: against the same part of the previous period while this one runs, else its whole
      const pvs = this._root.querySelector('[data-k="pvs"]');
      if (pvs) {
        const txt = shown ? (this._prevT?.partial ? `Changes vs ${shown}, same hours` : `Changes vs ${shown}`) : "";
        const t = bucket ? bucket.when : this._P?.view === "day" ? txt : txt.replace(", same hours", ", so far");
        if (pvs.textContent !== t) pvs.textContent = t;
        pvs.classList.toggle("reading", !!bucket);
      }
    }

    _renderRings() {
      const host = this._root.querySelector("[data-rings]"), T = this._data?.T, f = this._fmt();
      if (!host) return;
      const r = 17, C = 2 * Math.PI * r;
      const ring = (segs) => { let off = 0; const arcs = segs.map(([share, col]) => { const a = `<circle cx="22" cy="22" r="${r}" fill="none" stroke="${col}" stroke-width="7" stroke-dasharray="${(C * share).toFixed(2)} ${C}" stroke-dashoffset="${(-off * C).toFixed(2)}" transform="rotate(-90 22 22)"/>`; off += share; return a; }).join(""); return `<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="${r}" fill="none" stroke-width="7"/>${arcs}</svg>`; };
      // each a tile as the place's six are: its name at the top, its figure under it (at the tile's foot when the tile
      // is taller than its words)
      const item = (svg, value, name, note, title) => `<div class="rg${svg ? "" : " fig"}" title="${esc([note, title].filter(Boolean).join(". "))}"><div class="rn">${esc(name)}</div><div class="rtop">${svg}<span class="rv">${esc(value)}</span></div></div>`;
      const kwh = (v) => (v >= 1000 ? `${f.num(v / 1000, v >= 10000 ? 1 : 2)}${NB}MWh` : `${f.num(v, v >= 100 ? 0 : 1)}${NB}kWh`);
      let html = "";
      if (!T) html += item(ring([[0, "transparent"]]), "—", "self-sufficient", "", "") + item("", "—", "solar kept", "", "");
      if (T) {
        // the split's percentages are rounded to add up to 100, and self-sufficiency is the two that are not the grid
        const sp = T.split ? shares([T.split.solar, T.split.batt, T.split.grid]) : null;
        html += item(ring(T.split ? [[T.split.solar, "var(--x1-solar)"], [T.split.batt, "var(--x1-batt)"], [T.split.grid, "var(--x1-grid)"]] : [[0, "transparent"]]),
          sp ? `${f.num(100 - sp[2])}%` : "—", "self-sufficient", sp ? `solar ${sp[0]}% · battery ${sp[1]}% · grid ${sp[2]}%` : "nothing used yet",
          `Of what the house used (${kwh(T.L)}), the share that did not come from the grid: solar and battery together.`);
        html += item("", T.kept === null ? "—" : `${f.num(T.kept * 100)}%`, "solar kept", T.S > 0 ? `sold ${kwh(T.Sg)} of ${kwh(T.S)}` : "no solar yet",
          "Solar used at home or stored, as a share of what was produced over this period.");
      }
      // the saving: this period's at the owner's tariff when one is set, else Anker's own lifetime figure
      const ri = Number(this._config.rate_import) || 0, re = Number(this._config.rate_export) || 0, life = this._L?.savings;
      if (ri > 0 && T) {
        const saved = (T.L - T.Gi) * ri + T.Ge * re;
        html += item("", `${saved < 0 ? "−" : ""}${this._money(Math.abs(saved), Math.abs(saved) >= 100 ? 0 : 2)}`, "saved", `at ${this._money(ri, 2)} bought${re ? `, ${this._money(re, 2)} sold` : ""} per kWh`,
          "What the period cost less than buying everything the house used: (used − bought) × import rate + sold × export rate.");
      } else if (life) html += item("", this._money(life), "saved", "Anker's figure since install", "Anker's own count over the system's life. Set an import rate in the card's options to price each period at your tariff.");
      else html += item("", "—", "saved", T ? "set a tariff in the card's options" : "", "Set rate_import (and rate_export) in the card's options to price each period at your tariff.");
      if (host.innerHTML !== html) host.innerHTML = html;
    }

    /* ----- the chart: two strips on one axis ----- */

    _drawChart() {
      // The power chart stands under the drawing in the period column; the battery's strip stands compact in the Now
      // column under the ring, its key above it. Each has its own width and scale, and a reading moves both.
      const host = this._root?.querySelector("[data-mg]"), host2 = this._root?.querySelector("[data-mg2]"), P = this._P, D = this._data;
      if (!host || !host2 || !P) return;
      const f = this._fmt(), narrow = this._mode() === "narrow", wide = this._mode() === "wide";
      const W = Math.max(240, host.clientWidth), total = wide ? host.clientHeight : narrow ? 380 : 300;
      const pad = this._tight ? 10 : 14, axisH = 24;
      const sw_width = Math.max(200, W - 2 * pad - 2);
      const x0 = P.t0, x1 = P.t1;
      // the power card spends its padding, its border, its head row (its name and key: one 20 px line and the row gap,
      // or wrapped to two lines on a phone) and its axis; the rest is strip
      // (on a wide screen the head row is measured after a first drawing, since its height follows the theme's fonts)
      const fixKey = `${this._tight}`, fix = wide && this._chromeFix?.k === fixKey ? this._chromeFix.v : 0;
      const chrome = 2 * pad + axisH + 2 + (narrow ? 60 : 28) + fix;
      const H1 = Math.max(this._tight ? 100 : 120, total - chrome);
      // the battery's strip: in the wide layout it takes the height the Now column leaves it (fitted after a first
      // drawing measures its key and axis); stacked, a fixed height
      let H2 = narrow ? 96 : 80;
      const W2 = Math.max(200, host2.clientWidth), sw2 = Math.max(160, W2 - 2 * pad - 2);
      const buckets = D?.buckets ?? [];
      const have = buckets.filter((b) => !b.empty);
      // strip 1's scale and ticks come first, so the tick column is as wide as the widest label it draws
      const up = (b) => (b.empty ? 0 : b.Sh + b.Bh + b.Gh), dn = (b) => (b.empty ? 0 : b.Sb + b.Gb + b.Sg);
      const maxUp = Math.max(0.1, ...have.map(up)), maxDn = Math.max(0.05, ...have.map(dn));
      // the captions take the plot's top and bottom margins, so they never touch a bar, an area or a gridline
      const padT = 20, padB = 18, ph1 = H1 - padT - padB;
      const scale = ph1 / (maxUp * 1.08 + maxDn * 1.08);
      const zero = padT + maxUp * 1.08 * scale;
      const sy1 = (v) => zero - v * scale;
      // one tick step on both sides of zero, so the halves read against each other, in one unit; no ticks without data
      const big = Math.max(maxUp, maxDn);
      const nice = (x) => { const q = 10 ** Math.floor(Math.log10(x)), m = x / q; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * q; };
      const raise = (x) => { const q = 10 ** Math.floor(Math.log10(x) + 1e-9), m = Math.round(x / q); return (m >= 5 ? 10 : m >= 2 ? 5 : 2) * q; };
      let step = big > 0 ? nice(big / 3.5) : 0;
      while (step > 0 && step * scale < 22) step = raise(step);
      // a plot too short for that keeps one tick a side, at the largest round value inside the taller half, if it
      // clears a label's height above the line
      let single = false;
      if (step > big * 1.02) { step = nice(big); single = step * scale >= 12; if (!single) step = 0; }
      const frac = (x) => Math.abs(x - Math.round(x)) > 1e-6, dp = !frac(step) ? 0 : !frac(step * 10) ? 1 : 2;
      const mdp = !frac(step / 1000) ? 0 : !frac(step / 100) ? 1 : 2;
      const tickLabel = (v) => (big >= 1000 ? `${f.num(v / 1000, mdp)}${NB}MWh` : `${f.num(v, dp)}${NB}${P.view === "day" ? "kW" : "kWh"}`);
      const ticks = [];
      if (have.length && step > 0) {
        for (let k = 1; k <= (single ? 1 : 5) && k * step <= maxUp * 1.02; k++) { const y = sy1(k * step); if (y > padT + 4) ticks.push([y, tickLabel(k * step)]); }
        for (let k = 1; k <= (single ? 1 : 5) && k * step <= maxDn * 1.02; k++) { const y = zero + k * step * scale; if (y < H1 - padB + 4) ticks.push([y, tickLabel(k * step)]); }
      }
      const padL = Math.max(40, 14 + Math.ceil(6.8 * Math.max(4, ...ticks.map(([, t]) => t.length)))), padR = 10;
      const pw = sw_width - padL - padR;
      const sx = (t) => padL + ((t - x0) / (x1 - x0)) * pw;
      const markX = P.isNow && P.view === "day" ? sx(Math.min(x1, Date.now())) : null;
      this._mgGeom = { P, sx, padL, pw, W: sw_width, strips: [] };
      const grid = (y) => `<line x1="${padL}" x2="${padL + pw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--x1-grid-line)"/>`;
      const label = (v, y) => `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="tick">${esc(v)}</text>`;
      // strip 1: what supplied the house, stacked above zero; below it, what charged the battery and the solar sold.
      // Hue is the source (solar, battery, grid): full strength supplies the house, a tint charges the battery; solar
      // sold is green.
      let g1 = "";
      const clear = []; // boxes the band names keep out of: the cloud's edge note and the names already placed
      if (have.length) g1 += grid(zero);
      for (const [y, t] of ticks) g1 += grid(y) + label(t, y);
      if (markX !== null) g1 += `<line x1="${markX.toFixed(1)}" x2="${markX.toFixed(1)}" y1="0" y2="${H1}" stroke="var(--x1-axis)"/>`;
      const FILL = { Sh: "var(--x1-solar)", Bh: "var(--x1-batt)", Gh: "var(--x1-grid)", Sb: "var(--x1-solar-tint)", Gb: "var(--x1-grid-tint)", Sg: "var(--x1-sold)" };
      if (P.view === "day") {
        // stacked areas through the midpoints of the 5-minute buckets; a run of readings is one polygon
        const area = (key, base, col) => {
          let top = [], bot = [];
          const flush = () => { if (top.length > 1) g1 += `<path d="M${top.join("L")}L${bot.reverse().join("L")}Z" fill="${col}"/>`; top = []; bot = []; };
          for (let i = 0; i < buckets.length; i++) {
            const b = buckets[i];
            if (b.empty) { flush(); continue; }
            const xm = (sx(b.t) + sx(b.t1)) / 2, y0 = sy1(base(b)), y1 = sy1(base(b) + (key(b) || 0));
            if (!top.length) { const xa = sx(b.t); top.push(`${xa.toFixed(1)},${y1.toFixed(1)}`); bot.push(`${xa.toFixed(1)},${y0.toFixed(1)}`); }
            top.push(`${xm.toFixed(1)},${y1.toFixed(1)}`); bot.push(`${xm.toFixed(1)},${y0.toFixed(1)}`);
            if (i === buckets.length - 1 || buckets[i + 1].empty) { const xb = sx(b.t1); top.push(`${xb.toFixed(1)},${y1.toFixed(1)}`); bot.push(`${xb.toFixed(1)},${y0.toFixed(1)}`); flush(); }
          }
        };
        area((b) => b.Sh, () => 0, FILL.Sh);
        area((b) => b.Bh, (b) => b.Sh, FILL.Bh);
        area((b) => b.Gh, (b) => b.Sh + b.Bh, FILL.Gh);
        area((b) => -b.Sb, () => 0, FILL.Sb);
        area((b) => -b.Gb, (b) => -b.Sb, FILL.Gb);
        area((b) => -b.Sg, (b) => -b.Sb - b.Gb, FILL.Sg);
        // where the cloud's series ends short of now, the edge says so
        const last = have[have.length - 1];
        if (P.isNow && last && Date.now() - last.t1 > 10 * 60e3) {
          // in the top margin, which no area reaches, ending at the series' end; over the zero line only when the series
          // ends so early that the note would meet the half's caption
          const ex = sx(last.t1) - 4, note = `cloud to ${f.time(last.t1)}`, nw = note.length * 6.6;
          const ny = ex - nw > padL + 6 + 13 * 6.6 + 12 ? 13 : zero - 6;
          g1 += `<text x="${ex.toFixed(1)}" y="${ny.toFixed(1)}" text-anchor="end" class="tick halo">${esc(note)}</text>`;
          clear.push([ex - nw, ex, ny - 12, ny + 4]);
        }
      } else {
        const n = buckets.length, slot = pw / n, bw = Math.max(3, Math.min(28, slot * 0.6));
        for (let i = 0; i < n; i++) {
          const b = buckets[i]; if (b.empty) continue;
          const x = padL + slot * i + (slot - bw) / 2;
          const bar = (v, base, col) => { if (!(v > 0)) return ""; const yTop = sy1(base + v), yBase = sy1(base); return `<rect x="${x.toFixed(1)}" y="${Math.min(yTop, yBase).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(yBase - yTop).toFixed(1)}" fill="${col}"/>`; };
          g1 += bar(b.Sh, 0, FILL.Sh) + bar(b.Bh, b.Sh, FILL.Bh) + bar(b.Gh, b.Sh + b.Bh, FILL.Gh);
          // below zero, drawn downward from the zero line: the battery's charging, then the solar sold
          const down = (v, base, col) => { if (!(v > 0)) return ""; const yTop = zero + base * scale, h = v * scale, fill = col === FILL.Sg && h < 4 ? "var(--x1-solar)" : col; return `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`; };
          g1 += down(b.Sb, 0, FILL.Sb) + down(b.Gb, b.Sb, FILL.Gb) + down(b.Sg, b.Sb + b.Gb, FILL.Sg);
        }
      }
      // the two halves named where they begin, and each band labelled where it is widest, if it is wide enough
      const unitWord = P.view === "day" ? "Power" : "Energy";
      if (have.length) g1 += `<text x="${padL + 6}" y="13" class="tick halo">${unitWord} demand</text><text x="${padL + 6}" y="${H1 - 4}" class="tick halo">${unitWord} surplus</text>`;
      const bands = [["Sh", "solar", 0], ["Bh", "battery", 0], ["Gh", "grid", 0], ["Sb", "to battery", 1], ["Gb", "grid to battery", 1], ["Sg", "sold", 1]];
      const win = P.view === "day" ? 9 : 0;
      // only the day's areas take labels: a bar is narrower than its band's name
      // where its band is widest, or the next widest place clear of the edge note and the names placed before it
      if (P.view === "day") for (const [key, name, below] of bands) {
        const cand = [];
        for (let i = 0; i < buckets.length; i++) { let sum = 0, n = 0; for (let j = i - win; j <= i + win; j++) { const b = buckets[j]; if (b && !b.empty) { sum += b[key]; n++; } } const v = n === 2 * win + 1 || win === 0 ? sum / n : 0; if (v * scale >= 15 && !buckets[i].empty) cand.push([v, i]); }
        cand.sort((a, c) => c[0] - a[0]);
        const hw = name.length * 3.4 + 4;
        for (const [, at] of cand) {
          const b = buckets[at];
          const base = key === "Sh" ? 0 : key === "Bh" ? b.Sh : key === "Gh" ? b.Sh + b.Bh : key === "Sb" ? 0 : key === "Gb" ? b.Sb : b.Sb + b.Gb;
          const mid = below ? zero + (base + b[key] / 2) * scale : sy1(base + b[key] / 2);
          const x = (sx(b.t) + sx(b.t1)) / 2;
          if (clear.some(([a0, a1, c0, c1]) => x + hw > a0 && x - hw < a1 && mid + 8 > c0 && mid - 8 < c1)) continue;
          g1 += `<text x="${x.toFixed(1)}" y="${(mid + 4).toFixed(1)}" text-anchor="middle" class="tick band b${key}" stroke="${FILL[key]}">${esc(name)}</text>`;
          clear.push([x - hw, x + hw, mid - 8, mid + 8]);
          break;
        }
      }
      g1 += `<line data-xh x1="0" x2="0" y1="0" y2="${H1}" stroke="var(--x1-ink2)" visibility="hidden"/>`;
      this._mgGeom.strips.push({ H: H1, sy: sy1, zero, sx, padL, pw });
      // strip 2: state of charge (day) or self-sufficiency per bucket, on the Now column's width
      const padL2 = 40, pw2 = sw2 - padL2 - 10, sx2 = (t) => padL2 + ((t - x0) / (x1 - x0)) * pw2;
      const markX2 = P.isNow && P.view === "day" ? sx2(Math.min(x1, Date.now())) : null;
      const grid2 = (y) => `<line x1="${padL2}" x2="${padL2 + pw2}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--x1-grid-line)"/>`;
      const label2 = (v, y) => `<text x="${padL2 - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="tick">${esc(v)}</text>`;
      const res = clamp(Number(this._config.reserve) || 0, 0, 100);
      const strip2 = (H2) => {
      let g2 = "";
      const p2T = 10, p2B = 6, ph2 = H2 - p2T - p2B, sy2 = (v) => p2T + ph2 - (v / 100) * ph2;
      g2 += grid2(sy2(100)) + grid2(sy2(50)) + label2("100%", sy2(100)) + label2("50%", sy2(50));
      if (markX2 !== null) g2 += `<line x1="${markX2.toFixed(1)}" x2="${markX2.toFixed(1)}" y1="0" y2="${H2}" stroke="var(--x1-axis)"/>`;
      let when = "";
      if (P.view === "day") {
        // the charge over the day as a fill level, the towers' picture: a soft mass under the line, the reserve rule
        // over the mass, the line on top
        const runs = []; let cur = null;
        for (const b of buckets) { if (b.empty || b.soc === null || b.soc === undefined) { cur = null; continue; } if (!cur) { cur = []; runs.push(cur); } cur.push([(sx2(b.t) + sx2(b.t1)) / 2, sy2(b.soc)]); }
        const floor = sy2(0), xy = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
        for (const r of runs) if (r.length > 1) g2 += `<path class="soc-fill" d="M${r.map(xy).join("L")}L${r[r.length - 1][0].toFixed(1)},${floor.toFixed(1)}L${r[0][0].toFixed(1)},${floor.toFixed(1)}Z"/>`;
        g2 += `<line x1="${padL2}" x2="${padL2 + pw2}" y1="${sy2(res).toFixed(1)}" y2="${sy2(res).toFixed(1)}" stroke="var(--x1-ink2)" stroke-dasharray="4 4"/>`;
        const d = runs.filter((r) => r.length > 1).map((r) => `M${r.map(xy).join("L")}`).join("");
        if (d) g2 += `<path d="${d}" fill="none" stroke="var(--x1-batt)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        const last = [...have].reverse().find((b) => b.soc !== null && b.soc !== undefined);
        if (last) g2 += `<circle cx="${((sx2(last.t) + sx2(last.t1)) / 2).toFixed(1)}" cy="${sy2(last.soc).toFixed(1)}" r="4" fill="var(--x1-batt)" stroke="var(--x1-surface)" stroke-width="2"/>`;
        // the longest run below the reserve is named in the tile, not drawn over the line
        let run = null, best = null;
        for (const b of buckets) { const below = !b.empty && b.soc !== null && b.soc !== undefined && b.soc < res - 0.5; if (below) { run = run ?? { t: b.t, n: 0 }; run.n++; run.t1 = b.t1; } else if (run) { if (!best || run.n > best.n) best = run; run = null; } }
        if (run && (!best || run.n > best.n)) best = run;
        const lastT1 = have.length ? have[have.length - 1].t1 : null;
        const going = P.isNow && best && best.t1 === lastT1;
        when = !best || best.n < 3 ? "" : going ? `Below reserve since ${best.t === P.t0 ? "midnight" : f.time(best.t)}` : best.t === P.t0 ? (best.t1 >= P.t1 ? "Below reserve all day" : `Below reserve until ${f.time(best.t1)}`) : `Below reserve ${f.time(best.t)}–${f.time(best.t1)}`;
      } else {
        // each bucket's self-sufficiency as a bar under its energy bar, split the way the ring splits it: the solar
        // share, then the battery share, up to the share not bought; a share nothing attributes stays neutral
        const n = buckets.length, slot = pw2 / n, bw = Math.max(3, Math.min(28, slot * 0.6));
        const rect = (x, v0, v1, fill) => (v1 - v0 > 0.05 ? `<rect x="${x.toFixed(1)}" y="${sy2(v1).toFixed(1)}" width="${bw.toFixed(1)}" height="${(sy2(v0) - sy2(v1)).toFixed(1)}" fill="${fill}"/>` : "");
        for (let i = 0; i < n; i++) {
          const b = buckets[i]; if (b.empty || !(b.L > 0)) continue;
          const v = clamp(1 - Math.min(b.L, b.Gh) / b.L, 0, 1) * 100, own = b.Sh + b.Bh, x = padL2 + slot * i + (slot - bw) / 2;
          if (!(own > 0)) { g2 += rect(x, 0, v, "var(--x1-axis)"); continue; }
          const vs = v * (b.Sh / own);
          g2 += rect(x, 0, vs, "var(--x1-solar)") + rect(x, vs, v, "var(--x1-batt)");
        }
      }
      g2 += `<line data-xh x1="0" x2="0" y1="0" y2="${H2}" stroke="var(--x1-ink2)" visibility="hidden"/>`;
      return { g2, when, sy2 };
      };
      let s2 = strip2(H2);
      const empty = this._perror ? `Anker's cloud didn't answer.${P.isNow ? " Trying again in five minutes." : " Choose the period again to retry."}` : !D ? "Loading…" : have.length ? "" : P.view === "day" && P.isNow ? "The day has just begun." : "No data for this period.";
      // the tiles: each chart's name, and its key in three short lines
      const sw = (col, extra = "") => `<i class="sw${extra}"${col ? ` style="background:${col}"` : ""}></i>`;
      const T = D?.T;
      const grp = (title, line) => `<div class="kgp">${title ? `<div class="kt">${title}</div>` : ""}<div class="kg">${line}</div></div>`;
      // a statement under a key (when the battery crosses its reserve, the period's share) stays small, on one line
      const say = (line) => `<div class="kgp"><div class="kg say">${line}</div></div>`;
      // one key: each source once, in the colour it has everywhere (a tint of it below the line is the same source,
      // stored), and solar sold
      const powerTile = `<div class="ct"><div class="ctn">${P.view === "day" ? "Power" : "Energy"}</div>
        <div class="ck">${grp("", `${sw(FILL.Sh)}Solar`)}${grp("", `${sw(FILL.Bh)}Battery`)}${grp("", `${sw(FILL.Gh)}Grid`)}${grp("", `${sw("var(--x1-sold)")}Solar sold`)}</div></div>`;
      const when = s2.when;
      const battTile = P.view === "day"
        ? `<div class="ct"><div class="ctn">Battery</div><div class="ck">${grp("", `${sw(null, " fill")}State of charge`)}${grp("", `${sw(null, " line")}Reserve ${f.num(res)}%`)}${when ? say(`<b>${esc(when)}</b>`) : ""}</div></div>`
        : `<div class="ct"><div class="ctn">Self-sufficient</div><div class="ctd">The house's use not bought from the grid.</div><div class="ck">${grp("", `${sw("var(--x1-solar)")}solar ${sw("var(--x1-batt)")}battery`)}${T && T.selfSuff !== null ? say(`<b>${f.num(T.selfSuff * 100)}% over the period</b>`) : ""}</div></div>`;
      const axis = (chip) => `<div class="mg-axis"><svg width="${sw_}" height="${axisH}" aria-hidden="true">${this._axis(P, sx, padL, pw, markX)}${chip ? `<g data-xt visibility="hidden"><line data-xtl y1="0" y2="6" stroke="var(--x1-ink2)"/><rect data-xtb y="6" height="18" rx="4" fill="var(--x1-well)"/><text data-xtt y="19" text-anchor="middle" class="tick day now"></text></g>` : ""}</svg></div>`;
      const sw_ = sw_width;
      this._redrawing = true;
      const aria = (what) => esc(`${P.title}: ${what}. Use the arrow keys to read values.`);
      const none = (msg, left) => (msg ? `<div class="mg-none small" style="left:${left + 8}px">${esc(msg)}</div>` : "");
      host.innerHTML = `<div class="mg" data-strip="0" tabindex="0" role="img" aria-label="${aria(P.view === "day" ? "power" : "energy")}">
        <section class="card chart" style="padding:${pad}px">${powerTile}<div class="cs"><div class="mg-p" style="height:${H1}px"><svg width="${sw_}" height="${H1}" aria-hidden="true">${g1}</svg>${none(empty, padL)}</div>${axis(true)}</div></section></div>`;
      // the power card fills its slot exactly, as the battery's does beside it: a head row taller or shorter than the
      // estimate is measured once and the strip redrawn to fit
      if (wide && !this._refit1) {
        const off = Math.round(host.querySelector(".card").getBoundingClientRect().height - host.clientHeight);
        if (off && (off < 0 || H1 > (this._tight ? 100 : 120))) { this._chromeFix = { k: fixKey, v: fix + off }; this._refit1 = true; try { this._drawChart(); } finally { this._refit1 = false; } return; }
      }
      const markup2 = () => `<div class="mg" data-strip="1" tabindex="0" role="img" aria-label="${aria(P.view === "day" ? "the battery's charge" : "self-sufficiency")}">
        <section class="card chart" style="padding:${pad}px">${battTile}<div class="cs"><div class="mg-p" style="height:${H2}px"><svg width="${sw2}" height="${H2}" aria-hidden="true">${s2.g2}</svg>${none(this._perror ? "" : empty, padL2)}</div><div class="mg-axis"><svg width="${sw2}" height="${axisH}" aria-hidden="true">${this._axis(P, sx2, padL2, pw2, markX2)}</svg></div></div></section></div>`;
      host2.innerHTML = markup2();
      // the battery's card is always the power card's height: beside it on the desktop it fills the row they share,
      // stacked under it it is measured against it
      {
        const card2 = host2.querySelector(".card"), chrome2 = card2.getBoundingClientRect().height - H2;
        const target = wide ? host2.clientHeight : host.querySelector(".card").getBoundingClientRect().height, fit = Math.max(56, Math.floor(target - chrome2));
        if (Math.abs(fit - H2) > 1) { H2 = fit; s2 = strip2(H2); host2.innerHTML = markup2(); }
      }
      this._mgGeom.strips.push({ H: H2, sy: s2.sy2, sx: sx2, padL: padL2, pw: pw2 });
      this._redrawing = false;
      this._bindChart();
      const keep = !!this._mgHold && this._mgT != null && this._mgT >= x0 && this._mgT < x1;
      if (!keep) this._mgHold = null;
      this._mgShow(keep ? this._mgT : null);
    }

    _axis(P, sx, padL, pw, markX) {
      const f = this._fmt(), out = [];
      const put = (x, text, day, now) => out.push(`<text x="${x.toFixed(1)}" y="19" text-anchor="middle" class="tick${day ? " day" : ""}${now ? " now" : ""}">${esc(text)}</text>`);
      const clear = (x) => x >= padL + 14 && x <= padL + pw - 14 && (markX === null || Math.abs(x - markX) >= 34);
      if (P.view === "day") {
        const cfg = this._hass.config ?? {}, st = sunTimes(P.t0, cfg.latitude ?? 0, cfg.longitude ?? 0);
        if (st.rise && st.set) out.push(`<rect x="${sx(Math.max(P.t0, st.rise)).toFixed(1)}" y="2" width="${(sx(Math.min(P.t1, st.set)) - sx(Math.max(P.t0, st.rise))).toFixed(1)}" height="3" rx="1.5" fill="var(--x1-solar)" fill-opacity="0.55"/>`);
        const every = pw / 24 < 14 ? 12 : pw / 24 < 30 ? 6 : 3;
        for (let h = 0; h < 24; h += every) { const t = P.t0 + h * HOUR; if (h && clear(sx(t))) put(sx(t), f.hour(t)); }
        if (markX !== null) put(markX, "Now", true, true);
      } else if (P.view === "year") {
        for (let mo = 0; mo < 12; mo++) { const t = f.midnight(`${P.anchor}-${pad2(mo + 1)}-01`) + 15 * DAY; put(sx(t), f.mon(t)); }
      } else {
        const n = P.view === "month" ? P.days : 7, slot = pw / n, every = Math.max(1, Math.ceil(52 / slot));
        const today = f.dateStr(Date.now()), base = P.view === "month" ? `${P.anchor}-01` : P.start;
        const dates = Array.from({ length: n }, (_, i) => f.addDays(base, i)), ti = dates.indexOf(today);
        for (let i = 0; i < n; i++) {
          // a day's own label gives way to "Today" wherever the two would touch
          if (i !== ti && (i % every || (ti >= 0 && Math.abs(i - ti) * slot < 40))) continue;
          const t = f.midnight(dates[i]) + 12 * HOUR;
          put(padL + slot * (i + 0.5), i === ti ? "Today" : P.view === "month" ? String(i + 1) : f.weekday(t), i === ti);
        }
      }
      return out.join("");
    }

    _bindChart() {
      const G = this._mgGeom;
      if (!G) return;
      this._root.querySelectorAll(".mg[data-strip]").forEach((mg) => this._bindStrip(mg, G.strips[Number(mg.dataset.strip)] ?? G.strips[0]));
    }
    // each strip maps the pointer through its own scale; the reading it starts is shared
    _bindStrip(mg, S) {
      const G = this._mgGeom, P = G.P, buckets = this._data?.buckets ?? [];
      const snap = (t) => { const b = buckets.find((x) => t >= x.t && t < x.t1) ?? buckets[buckets.length - 1]; return b ? b.t : null; };
      const clampT = (t) => Math.max(P.t0, Math.min(P.t1 - 1, t));
      const fromEvent = (e) => {
        const svg = e.target.closest?.(".mg-p svg, .mg-axis svg") ?? (this._mgTouch === e.pointerId ? mg.querySelector(".mg-p svg") : null);
        if (!svg) return null;
        const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
        if (x < S.padL || x > S.padL + S.pw) return null;
        return snap(clampT(P.t0 + ((x - S.padL) / S.pw) * (P.t1 - P.t0)));
      };
      const scrub = (e) => { const t = fromEvent(e); if (t !== null) { this._mgHold = "pointer"; this._mgShow(t); } };
      mg.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" || !e.isPrimary) return; const t = fromEvent(e); if (t === null) return; this._mgTouch = e.pointerId; try { mg.setPointerCapture(e.pointerId); } catch (err) { /* lifted */ } this._mgHold = "pointer"; this._mgShow(t); });
      mg.addEventListener("pointermove", (e) => { if (e.pointerType === "touch" && this._mgTouch !== e.pointerId) return; scrub(e); });
      const release = () => { this._mgTouch = null; if (mg.isConnected && !this._redrawing) { this._mgHold = null; this._mgShow(null); } };
      mg.addEventListener("pointerleave", release);
      mg.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") release(); });
      mg.addEventListener("pointercancel", release);
      mg.addEventListener("contextmenu", (e) => { if (this._mgTouch != null) e.preventDefault(); });
      mg.addEventListener("blur", release);
      mg.addEventListener("keydown", (e) => {
        const step = P.view === "day" ? (e.shiftKey ? HOUR : FIVE_MIN) : P.view === "year" ? 31 * DAY : DAY;
        const cur = this._mgT ?? snap(Math.min(P.t1 - 1, Date.now()));
        if (e.key === "ArrowLeft") { this._mgHold = "key"; this._mgShow(snap(clampT(cur - step))); e.preventDefault(); }
        if (e.key === "ArrowRight") { this._mgHold = "key"; this._mgShow(snap(clampT(cur + (P.view === "year" ? 32 * DAY : step)))); e.preventDefault(); }
        if (e.key === "Escape") { this._mgHold = null; this._mgShow(null); }
      });
    }

    // A reading: the crosshair at t across both strips, the ledger reading that bucket, the chip on the axis saying when.
    _mgShow(t) {
      const G = this._mgGeom;
      if (!G || !this._root) return;
      const P = G.P, f = this._fmt();
      this._mgT = t;
      const xh = this._root.querySelectorAll(".mg[data-strip] [data-xh]");
      const b = t === null ? null : (this._data?.buckets ?? []).find((x) => t >= x.t && t < x.t1);
      if (t === null || !b || b.empty) {
        xh.forEach((l) => l.setAttribute("visibility", "hidden"));
        this._renderLedger(null);
        if (t === null) { if (this._hinted) this._chip(null); else this._mgHint(); } else this._chip(null);
        return;
      }
      if (!this._hinted) { this._hinted = true; try { window.localStorage.setItem(HINT_KEY, "9"); } catch (e) { /* no storage */ } }
      const x = (G.sx(b.t) + G.sx(b.t1)) / 2;
      xh.forEach((l) => {
        const S = G.strips[Number(l.closest(".mg").dataset.strip)] ?? G.strips[0], xs = (S.sx(b.t) + S.sx(b.t1)) / 2;
        l.setAttribute("x1", xs.toFixed(1)); l.setAttribute("x2", xs.toFixed(1)); l.setAttribute("visibility", "visible");
      });
      const when = P.view === "day" ? f.time(b.t) : P.view === "year" ? f.monY(b.t + 15 * DAY) : f.wdd(b.t + 12 * HOUR);
      this._renderLedger({ ...b, when: P.view === "day" ? `At ${when}${b.soc !== null && b.soc !== undefined ? ` · battery ${f.num(b.soc)}%` : ""}` : when });
      this._chip(when, x);
    }

    _chip(label, x, hint = false) {
      const xt = this._root.querySelector("[data-xt]");
      if (!xt) return;
      const labels = xt.ownerSVGElement.querySelectorAll(":scope > text");
      if (!label) { xt.setAttribute("visibility", "hidden"); labels.forEach((lab) => { lab.style.visibility = ""; }); return; }
      const txt = xt.querySelector("[data-xtt]"), bg = xt.querySelector("[data-xtb]"), tick = xt.querySelector("[data-xtl]");
      const right = Number(xt.ownerSVGElement.getAttribute("width"));
      if (txt.textContent !== label) txt.textContent = label;
      txt.setAttribute("class", hint ? "tick hint" : "tick day now");
      const w = txt.getComputedTextLength() + 16, cx = Math.max(w / 2, Math.min(right - w / 2, x));
      txt.setAttribute("x", cx.toFixed(1)); bg.setAttribute("x", (cx - w / 2).toFixed(1)); bg.setAttribute("width", w.toFixed(1));
      tick.setAttribute("x1", x.toFixed(1)); tick.setAttribute("x2", x.toFixed(1)); tick.setAttribute("visibility", hint ? "hidden" : "visible");
      xt.setAttribute("visibility", "visible");
      const lo = cx - w / 2 - 4, hi = cx + w / 2 + 4;
      labels.forEach((lab) => { const bb = lab.getBBox(); lab.style.visibility = bb.x < hi && bb.x + bb.width > lo ? "hidden" : ""; });
    }
    _mgHint() {
      if (this._hinted) return;
      let n = 0;
      try { n = Number(window.localStorage.getItem(HINT_KEY)) || 0; } catch (e) { n = 0; }
      if (n >= 3) { this._hinted = true; this._chip(null); return; }
      if (!this._hintCounted) { this._hintCounted = true; try { window.localStorage.setItem(HINT_KEY, String(n + 1)); } catch (e) { /* not remembered */ } }
      const G = this._mgGeom, xt = this._root.querySelector("[data-xt]");
      if (!G || !xt) return;
      const boxes = [...xt.ownerSVGElement.querySelectorAll(":scope > text")].map((l) => l.getBBox()).sort((a, b) => a.x - b.x);
      let best = { gap: -1, x: G.padL + G.pw / 2 }, prev = G.padL;
      for (const b of [...boxes, { x: G.padL + G.pw, width: 0 }]) { if (b.x - prev > best.gap) best = { gap: b.x - prev, x: (prev + b.x) / 2 }; prev = Math.max(prev, b.x + b.width); }
      const touch = !!window.matchMedia?.("(hover: none)")?.matches;
      this._chip(touch ? "Drag to read" : "Hover or ← → to read", best.x, true);
    }

    /* ----- CSV ----- */

    _downloadCsv() {
      const P = this._P, D = this._data, f = this._fmt();
      if (!P || !D) return;
      const rows = [];
      const n = (v, dp) => (v === null || v === undefined ? "" : (Math.round(v * 10 ** dp) / 10 ** dp).toString());
      if (P.view === "day") {
        rows.push(["time", "solar_kw", "house_kw", "battery_kw", "grid_kw", "state_of_charge_pct"]);
        for (const b of D.buckets) if (!b.empty) rows.push([f.time(b.t), n(b.S, 2), n(b.L, 2), n(b.Bd - b.Bc, 2), n(b.Gi - b.Ge, 2), n(b.soc, 0)]);
      } else {
        rows.push(["period", "solar_kwh", "house_kwh", "bought_kwh", "sold_kwh", "charged_kwh", "discharged_kwh", "self_sufficient_pct", "solar_kept_pct"]);
        for (const b of D.buckets) if (!b.empty) rows.push([P.view === "year" ? f.monY(b.t + 15 * DAY) : f.dateStr(b.t + 12 * HOUR), n(b.S, 2), n(b.L, 2), n(b.Gi, 2), n(b.Ge, 2), n(b.Bc, 2), n(b.Bd, 2), b.L > 0 ? n((1 - Math.min(b.L, b.Gh) / b.L) * 100, 0) : "", b.S > 0 ? n((1 - Math.min(b.S, b.Sg) / b.S) * 100, 0) : ""]);
      }
      const cell = (c) => { const v = String(c).replace(/ /g, " "); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
      const csv = rows.map((r) => r.map(cell).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
      a.download = `solix-x1-${P.view}-${P.anchor}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    /* ----- motion helpers ----- */

    _ghost(host) {
      if (!host?.firstElementChild || !this._motion()) return null;
      host.querySelector(":scope > .mg-ghost")?.remove();
      const g = document.createElement("div"); g.className = "mg-ghost"; g.setAttribute("aria-hidden", "true"); g.inert = true;
      g.append(...host.childNodes); g.querySelectorAll("[tabindex]").forEach((el) => el.removeAttribute("tabindex"));
      return g;
    }
    _settle(host, ghost) {
      if (!host || !ghost) return;
      host.appendChild(ghost); host.classList.add("swap");
      clearTimeout(this._swapT); this._swapT = setTimeout(() => { ghost.remove(); host.classList.remove("swap"); }, 300);
    }
    _swapText(el, text) {
      if (!el || el.textContent === text) return;
      const old = el.textContent; el.textContent = text;
      if (!old || !this._motion()) return;
      el.dataset.old = old; el.classList.remove("xf"); void el.offsetWidth; el.classList.add("xf");
      clearTimeout(el._xf); el._xf = setTimeout(() => { el.classList.remove("xf"); delete el.dataset.old; }, 260);
    }
  }

  // Reconciled flows from one bucket's powers (kW) or energies (kWh): solar S, house L, battery B (+ discharging), grid G (+ importing).
  function flowsOf(S, L, B, G) {
    const Bd = Math.max(0, B), Bc = Math.max(0, -B), Gi = Math.max(0, G), Ge = Math.max(0, -G);
    return flowsOfEnergy(S, L, Bd, Gi, Ge, Bc);
  }
  function flowsOfEnergy(S, L, Bd, Gi, Ge, Bc = null) {
    const Bh = Math.min(Bd, L);
    const Gh = Math.max(0, Math.min(Gi, L - Bh));
    const Gb = Math.max(0, Gi - Gh);
    const Sh = Math.max(0, Math.min(S, L - Bh - Gh));
    const Sg = Math.max(0, Math.min(Ge, S - Sh));
    const Sb = Math.max(0, S - Sh - Sg);
    const chg = Bc === null ? Sb + Gb : Math.max(Bc, Sb + Gb);
    return { S, L, Bd, Bc: chg, Gi, Ge, Sh, Sb, Sg, Gh, Gb, Bh };
  }
  // Integer percentages that add up to 100, by largest remainder.
  function shares(parts) {
    const tot = parts.reduce((a, b) => a + b, 0);
    if (!(tot > 0)) return parts.map(() => 0);
    const raw = parts.map((v) => (v / tot) * 100), out = raw.map(Math.floor);
    let left = 100 - out.reduce((a, b) => a + b, 0);
    for (const [, i] of raw.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0])) { if (left <= 0) break; out[i]++; left--; }
    return out;
  }
  function niceTick(max) {
    if (!(max > 0)) return 0;
    const p = 10 ** Math.floor(Math.log10(max)), m = max / p;
    const step = m >= 5 ? 5 * p : m >= 2 ? 2 * p : p;
    return Math.floor((max * 0.9) / step) * step || step / 2;
  }

  customElements.define(TAG, SolixX1Card);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: TAG, name: "Solix X1 Card", description: "One screen for an Anker SOLIX X1: the battery, the flow, today's figures, and day, week, month and year statistics.", preview: false, documentationURL: "https://github.com/Treehouse-00/solix-x1-card" });
  console.info(`%c SOLIX-X1-CARD %c ${VERSION} `, "color: white; background: #2f9e5b; font-weight: 700;", "color: #2f9e5b; background: white; font-weight: 700;");
})();
