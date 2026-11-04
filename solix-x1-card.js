/*
 * Solix X1 card for Home Assistant: one screen for an Anker SOLIX X1 home battery system.
 *
 * Dependency-free. Live values come from the Anker Solix integration's entities (the 5-minute averages the
 * cloud reports), history from the cloud's own statistics through the integration's raw-request action, so
 * the day, week, month and year views are the Anker app's figures from the first day.
 *
 * Layout: on a laptop, one screen cut to the window's height: a Now column (the battery, a sentence, the home
 * drawn with its power flowing) and a period column (the title bar, six headline figures, a power chart and a
 * battery chart on one time axis, the meaning row). Narrower screens stack the same parts and scroll.
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
 *   view: day                    # day | week | month | year; the viewer's last choice wins
 *   rate_import: 0.42            # optional, per kWh in the home's currency: prices each period's saving
 *   rate_export: 0.07
 */
(() => {
  "use strict";
  const TAG = "solix-x1-card";
  const VERSION = "1.0.1";
  if (customElements.get(TAG)) return;

  const DAY = 864e5, HOUR = 36e5, FIVE_MIN = 3e5;
  const VIEWS = ["day", "week", "month", "year"];
  const VIEW_KEY = "solix-x1-card:view";
  const HINT_KEY = "solix-x1-card:hinted";
  const NB = " ";
  const REFRESH_MS = 5 * 60e3;
  const LIVE_KEYS = ["state_of_charge", "solar_power", "home_demand", "grid_import", "grid_export", "charge_power", "discharge_power", "data_time", "cloud_state"];
  const SITE_KEYS = ["cost_savings", "co2_savings", "yield_total", "battery_modules", "parallel_devices", "connection"];
  const MODES = { 0: "Self-consumption", 1: "Time of use", 2: "Off-grid use", 11: "Bill saving", 16: "Time slots", 20: "AI energy management" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = (n) => String(n).padStart(2, "0");

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
  --x1-solar: #eda100; --x1-batt: #2f9e5b; --x1-grid: #6250d6; --x1-home: var(--x1-ink);
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
  --x1-wall: color-mix(in srgb, var(--x1-ink) 4%, var(--x1-surface)); --x1-gable: color-mix(in srgb, var(--x1-ink) 8%, var(--x1-surface)); --x1-roof: color-mix(in srgb, var(--x1-ink) 24%, var(--x1-surface)); --x1-rake: color-mix(in srgb, var(--x1-ink) 40%, var(--x1-surface));
  --x1-panel-off: color-mix(in srgb, #2c3a52 78%, var(--x1-surface)); --x1-panel-on: color-mix(in srgb, var(--x1-solar) 72%, var(--x1-surface));
  --x1-window-on: color-mix(in srgb, var(--x1-solar) 45%, var(--x1-surface)); --x1-glass: color-mix(in srgb, var(--x1-ink) 34%, var(--x1-surface));
  --x1-plate: #ffffff;
  --x1-batt-side: color-mix(in srgb, var(--x1-batt) 72%, #000); --x1-batt-top: color-mix(in srgb, var(--x1-batt) 58%, #fff);
  font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif);
  font-size: var(--x1-fs-body); line-height: 20px; font-weight: var(--x1-w-regular);
  color: var(--x1-ink);
  -webkit-font-smoothing: antialiased;
}
:host(.dark) {
  --x1-solar: #f2b036; --x1-batt: #5ac28a; --x1-grid: #9085e9; --x1-grid-line: #34342f; --x1-axis: #4a4a43;
  --x1-solar-tint: color-mix(in srgb, var(--x1-solar) 50%, var(--x1-surface)); --x1-grid-tint: color-mix(in srgb, var(--x1-grid) 50%, var(--x1-surface));
  --x1-wall: color-mix(in srgb, var(--x1-ink) 16%, var(--x1-surface)); --x1-gable: color-mix(in srgb, var(--x1-ink) 11%, var(--x1-surface)); --x1-roof: color-mix(in srgb, var(--x1-ink) 24%, var(--x1-surface)); --x1-rake: color-mix(in srgb, var(--x1-ink) 36%, var(--x1-surface));
  --x1-panel-off: color-mix(in srgb, #34405a 70%, var(--x1-surface)); --x1-panel-on: color-mix(in srgb, var(--x1-solar) 76%, var(--x1-surface));
  --x1-window-on: color-mix(in srgb, var(--x1-solar) 58%, var(--x1-surface)); --x1-glass: #20242c;
  --x1-plate: #d9d9d3;
  --x1-wash: rgba(255,255,255,0.045); --x1-on: #e9e9e9; --x1-off: #6aa7f4; --x1-fault: #f06a5f;
}
* { box-sizing: border-box; }
.wrap { margin: 0 auto; padding: var(--x1-gap); display: grid; gap: var(--x1-gap); max-width: 1680px; }
/* the Now column takes a third of the width while the period column keeps 740 px for six readable headline cards */
.wrap.wide { grid-template-columns: clamp(300px, min(34%, 100% - 740px), 460px) minmax(0, 1fr); height: var(--x1-h, auto); }
.wrap.wide.tight { grid-template-columns: clamp(300px, 30%, 400px) minmax(0, 1fr); }
.col-now, .col-period { display: flex; flex-direction: column; gap: var(--x1-gap); min-width: 0; min-height: 0; }
.card.now { flex: 1 1 auto; }
.card { background: var(--x1-surface); border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
  box-shadow: var(--ha-card-box-shadow, none); padding: var(--x1-pad); min-width: 0; display: flex; flex-direction: column; }
.wide .card { min-height: 0; overflow: hidden; }
.narrow .card { padding: var(--x1-gap); }
.narrow .flow { min-height: 208px; }
.wide .flow { margin-left: calc(-1 * var(--x1-pad)); align-items: flex-end; }
.wide .flow svg { height: auto; max-height: none; }
.wide .card.now { gap: 12px; }
.wide.tight .card.now { gap: 8px; }
.wide .card.now > .hero-row, .wide .card.now > .lede { margin-top: auto; }
.wide .card.now > .flow { flex: none; margin-top: 0; min-height: 0; }
.wide:not(.tight) .hero-row { flex-direction: column; align-items: center; gap: 12px; }
.wide:not(.tight) .hero-txt { flex: none; width: 100%; justify-items: center; text-align: center; gap: 2px; }
.wide:not(.tight) .hero-txt .v { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.wide:not(.tight) .hero-txt .s { font-size: var(--x1-fs-title); line-height: 24px; }
.wide:not(.tight) .lede { text-align: center; }
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
.ring .lbl { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.hero { font-size: calc(var(--x1-ring, 148px) * .432); line-height: 1; letter-spacing: -0.02em; font-weight: var(--x1-w-medium); font-variant-numeric: tabular-nums; display: flex; align-items: flex-start; }
.hero.n3 { font-size: calc(var(--x1-ring, 148px) * .285); }
.hero .u { font-size: calc(var(--x1-ring, 148px) * .162); line-height: 1; letter-spacing: 0; color: var(--x1-ink2); margin: calc(var(--x1-ring, 148px) * .04) 0 0 2px; }
.hero-txt { flex: 1 1 auto; min-width: 0; display: grid; gap: 4px; align-content: center; }
.hero-txt .k { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); }
.hero-txt .v { font-size: var(--x1-fs-body); line-height: 20px; text-wrap: balance; }
.hero-txt .s { font-weight: var(--x1-w-medium); }
.lede { font-size: var(--x1-fs-title); line-height: 24px; margin: 14px 0 0; text-wrap: balance; min-height: 48px; }
.tight .lede { font-size: var(--x1-fs-body); line-height: 20px; min-height: 40px; margin-top: 10px; }
.flow { margin-top: 12px; flex: 1 1 auto; min-height: 150px; display: flex; align-items: center; }
.flow svg { display: block; width: 100%; height: 100%; max-height: 224px; overflow: visible; }
.flow .face { stroke: var(--x1-ink2); stroke-width: 1; stroke-linejoin: round; }
.flow .pane { stroke: color-mix(in srgb, var(--x1-surface) 55%, transparent); stroke-width: .75; stroke-linejoin: round; }
.flow .edge { fill: none; stroke: var(--x1-ink2); stroke-width: 1; stroke-linejoin: round; stroke-linecap: round; }
.flow .hub { fill: var(--x1-plate); stroke: var(--x1-ink2); stroke-width: 1; stroke-linejoin: round; }
.flow .array { stroke: var(--x1-ink2); stroke-width: .75; stroke-linejoin: round; }
.flow .cells { fill: none; stroke: var(--x1-surface); stroke-opacity: .5; stroke-width: .75; }
.flow .tower { fill: var(--x1-surface); stroke: var(--x1-batt); stroke-width: 1.25; stroke-linejoin: round; }
.flow .tower-line { fill: none; stroke: var(--x1-batt); stroke-width: 1.25; stroke-linejoin: round; }
.flow .charge { stroke: none; }
.flow .mark { fill: none; stroke: var(--x1-ink); stroke-width: 1; }
.flow .wire { fill: none; stroke: var(--x1-grid-line); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.flow .wire.on { stroke-opacity: .9; }
.flow .lane { fill: none; stroke-width: 2; stroke-opacity: .35; stroke-linecap: round; stroke-linejoin: round; }
.flow .port { font-size: var(--x1-fs-small); fill: var(--x1-ink2); paint-order: stroke; stroke: var(--x1-surface); stroke-width: 4px; stroke-linejoin: round; }
.flow .lead { stroke: var(--x1-ink2); stroke-width: 1; stroke-dasharray: 1 3; stroke-linecap: round; }
.flow .tag { fill: var(--x1-surface); fill-opacity: .94; stroke: var(--x1-grid-line); stroke-width: 1; }
.flow .port.v { fill: var(--x1-ink); font-weight: var(--x1-w-medium); font-variant-numeric: tabular-nums; }
/* the flow: short beads every 10 px along the solid line, drifting at 1.83 px a second before the playback rate */
.flow .dots { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 2.5 3.5; animation: x1-drift 3.27s linear infinite; }
@keyframes x1-drift { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -6px; } }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 6px; }
.sw.hatch { background: repeating-linear-gradient(45deg, var(--x1-solar) 0 1.8px, transparent 1.8px 5px); }

/* The period side: a title bar, six headline cards, a chart card each for power and the battery, a meaning card. */
.pbar { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 16px; flex: none; container-type: inline-size; }

.heads .cell { display: block; container-type: inline-size; }
/* a card too narrow for its figure at the ledger's size steps the figure down one size rather than clip it */
@container (max-width: 92px) { .heads .cell .cv { font-size: var(--x1-fs-read); line-height: 26px; } }
@container (max-width: 78px) { .heads .cell .cv { font-size: 20px; line-height: 26px; } }
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
@container (max-width: 560px) { .col-period .pbar .pvs { flex: 1 0 100%; order: 3; } .col-period .pbar .head-r { order: 4; } }
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
.chart { display: grid; grid-template-columns: var(--x1-tile, 168px) minmax(0, 1fr); column-gap: 14px; align-items: start; }
.narrow .chart { grid-template-columns: minmax(0, 1fr); row-gap: 8px; }
.ct { min-width: 0; }
.ct .ctn { font-size: var(--x1-fs-body); line-height: 20px; font-weight: var(--x1-w-medium); }
.ct .ctv { font-size: var(--x1-fs-read); line-height: 28px; font-weight: var(--x1-w-medium); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ct .ctv .unit { font-size: var(--x1-fs-body); }
.ct .ctd { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); margin-top: 2px; text-wrap: pretty; }
.tight .ctd { display: none; }
.tick.on { fill: var(--x1-ink); font-weight: var(--x1-w-medium); }
.soc-fill { fill: var(--x1-batt); fill-opacity: .16; }
:host(.dark) .soc-fill { fill-opacity: .24; }
.ck { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; font-size: var(--x1-fs-small); line-height: 18px; color: var(--x1-ink2); }
.narrow .ck { flex-direction: row; flex-wrap: wrap; gap: 4px 20px; }
.kgp { display: grid; gap: 0; }
.ck .kt { font-weight: var(--x1-w-medium); color: var(--x1-ink); line-height: 16px; }
.ck .kg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ck .kg b { font-weight: var(--x1-w-medium); color: var(--x1-ink); }
.ck .sw { width: 11px; height: 11px; margin: 0 4px 0 0; border: 1px solid color-mix(in srgb, var(--x1-ink) 12%, transparent); vertical-align: -1px; }
.ck .sw + .sw, .ck span + .sw { margin-left: 6px; }
.ck .sw.line { height: 0; border: 0; border-top: 2px dashed var(--x1-ink2); vertical-align: 2px; }
.ck .sw.dot { border-radius: 50%; background: var(--x1-batt); border: 0; width: 8px; height: 8px; margin-right: 6px; }
.ck .sw.fill { background: color-mix(in srgb, var(--x1-batt) 24%, var(--x1-surface)); border: 0; border-top: 2.5px solid var(--x1-batt); border-radius: 1px; }
.narrow .ck { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
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
.rings { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px 16px; min-height: 60px; }
.rg { display: flex; align-items: center; gap: 10px; min-width: 0; }
.rg svg { flex: none; width: 44px; height: 44px; display: block; }
.rg .track { stroke: var(--x1-grid-line); }
.rg .rt { min-width: 0; display: grid; }
.rg.fig { padding-left: 2px; }
.rg .rv { font-size: var(--x1-fs-read); line-height: 26px; font-weight: var(--x1-w-medium); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rg .rn { font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot { margin-top: 10px; font-size: var(--x1-fs-small); line-height: 16px; color: var(--x1-ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; gap: 12px; }
.foot span { white-space: nowrap; }
.foot .fr { margin-left: auto; }
.narrow .foot { flex-wrap: wrap; }
.narrow .rings { grid-template-columns: minmax(0, 1fr); gap: 8px; }
.narrow .rg { gap: 12px; }
.narrow .rg .rt { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; min-width: 0; }

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
@media (prefers-reduced-motion: reduce) { .mg-ghost { display: none; } .swap > .mg, .xf, .flow .dots { animation: none; } .xf::after { content: none; } .ring .arc { transition: none; } }
@media (forced-colors: active) {
  .mg-p, .flow, .ring, .rg svg, .lamp i, .sw, .ck .sw { forced-color-adjust: none; }
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
      const labels = { site: "Site id", name: "Place name", reserve: "Backup reserve (%)", capacity_kwh: "Battery capacity (kWh)", view: "Opens on", rate_import: "Import rate per kWh", rate_export: "Export rate per kWh" };
      const helpers = {
        site: "The Anker site id. Found from the integration's site device when left empty.",
        name: "Heads the Now column.",
        reserve: "The backup reserve set in the Anker app; the cloud does not report it, so the card draws what you enter.",
        capacity_kwh: "Found from the battery modules when left empty.",
        view: "Each viewer's last choice is remembered in their browser.",
        rate_import: "Optional, in your home's currency. With a rate the card prices what each period saved; without one it shows Anker's lifetime figure.",
        rate_export: "Optional.",
      };
      return {
        schema: [
          { name: "site", selector: { text: {} } }, { name: "name", selector: { text: {} } },
          { name: "reserve", selector: { number: { min: 0, max: 100, mode: "box" } } },
          { name: "capacity_kwh", selector: { number: { min: 1, max: 1000, step: 0.1, mode: "box" } } },
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
    // The battery's answer: when it fills or empties, or what it is holding. It returns the words and a note for the
    // tooltip; nothing it says repeats the ring's word or the line about the reserve.
    _stateLine(L) {
      const f = L.f, AT_RATE = "At the present charging rate", AT_LOAD = "At the present load, down to the reserve";
      if (L.soc !== null && L.soc >= 99.5) return ["Full", ""];
      if (L.chg > 0.05) {
        if (L.toFull === null) return ["Charging", ""];
        const at = L.now + L.toFull * HOUR;
        return at < f.midnight(f.addDays(f.dateStr(L.now), 1)) ? [`Full by ${f.time(at)}`, AT_RATE] : ["Not full today", AT_RATE];
      }
      const low = L.soc !== null && (L.soc < L.reserve - 0.5 || (L.usable !== null && L.usable < 0.05));
      if (L.dis > 0.05) {
        if (low) return ["Drawing on the reserve", ""];
        if (L.hours === null) return ["Discharging", ""];
        // within a day a clock time names its next occurrence, so it needs no "tomorrow"
        return L.hours < 23 ? [`Lasts until ${f.time(L.now + L.hours * HOUR)}`, AT_LOAD] : ["Lasts over a day", AT_LOAD];
      }
      if (low) return ["Kept for outages", "What is left below the reserve is held for an outage"];
      if (L.usable !== null && L.home > 0.05) { const h = L.usable / L.home; return [h < 23 ? `Would last ${f.dur(h * HOUR)}` : "Would last over a day", "If it ran the house at its present load, down to the reserve"]; }
      return ["Idle", ""];
    }

    /* ----- the cloud: statistics through the integration's raw-request action ----- */

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
      await this._ensureMode();
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
      this._renderAll();
      this._ro = this._ro ?? new ResizeObserver(() => { clearTimeout(this._rz); this._rz = setTimeout(() => this._layout(), 80); });
      this._ro.observe(this);
    }
    _mode() {
      const w = this.clientWidth || window.innerWidth;
      return w >= 1000 ? "wide" : "narrow";
    }
    _layout() {
      if (!this._body || !this._mounted) return;
      const mode = this._mode();
      const top = this.getBoundingClientRect().top + window.scrollY;
      const h = Math.max(520, window.innerHeight - top);
      const tight = mode === "wide" && h < 700;
      const cls = `wrap ${mode}${tight ? " tight" : ""}`;
      this._tight = tight;
      if (this._body.className !== cls) this._body.className = cls;
      this._body.style.setProperty("--x1-h", mode === "wide" ? `${h}px` : "auto");
      if (mode !== this._lastMode || tight !== this._lastTight) { this._lastMode = mode; this._lastTight = tight; this._renderAll(); return; }
      this._frame(mode, h);
      this._drawFlow(); this._drawChart();
    }

    // The battery's ring grows with the window's height in the wide layout, where the Now column is one card cut to
    // the window and stands alone above its facts when the card is tall; beside them when it is short. A stacked
    // screen scrolls, so its ring keeps one size.
    _ringSize(mode, h, w = 0) {
      if (mode !== "wide") return 148;
      if (h < 700) return Math.round(clamp(h * 0.235, 124, 160));
      return Math.round(Math.min(clamp(h * 0.28, 160, 240), w > 0 ? 0.72 * w : Infinity));
    }
    // The ring's size is set once the Now card's width is known: a stacked ring takes at most 72% of it.
    _frame(mode, h) {
      const card = this._body.querySelector(".card.now"), cs = card ? getComputedStyle(card) : null;
      const w = card ? card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : 0;
      const ring = `${this._ringSize(mode, h, w)}px`;
      if (this._body.style.getPropertyValue("--x1-ring") !== ring) this._body.style.setProperty("--x1-ring", ring);
    }

    _renderAll(fade = false) {
      if (!this._root || !this._ents || !this._hass) return;
      const mode = this._mode();
      const top = this.getBoundingClientRect().top + window.scrollY;
      const h = Math.max(520, window.innerHeight - top);
      this._tight = mode === "wide" && h < 700;
      this._lastMode = mode; this._lastTight = this._tight;
      this._body.className = `wrap ${mode}${this._tight ? " tight" : ""}`;
      this._body.style.setProperty("--x1-h", mode === "wide" ? `${h}px` : "auto");
      this._body.innerHTML = this._nowCol() + this._periodCol();
      this._frame(mode, h);
      this._applyLive();
      this._loadPeriod(fade);
    }

    /* ----- the Now column ----- */

    _nowCol() {
      const name = this._config.name || "Home";
      return `<section class="col-now"><section class="card now">
        <div class="head"><h2>${esc(name)}</h2><span class="meta" data-k="mode"></span><span class="lamp" data-k="lamp"><i></i><span data-k="lamp-t"></span></span></div>
        <div class="hero-row">
          <div class="ring" data-ring></div>
          <div class="hero-txt">
            <div class="k">Battery</div>
            <div class="v s" data-k="h3"></div>
            <div class="v" data-k="h2"></div>
            <div class="k" data-k="h1"></div>
          </div>
        </div>
        <p class="lede" data-k="lede"></p>
        <div class="flow" data-flow></div></section></section>`;
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
      const [stWords, stNote] = this._stateLine(L);
      set("h3", stWords);
      const h3 = this._root.querySelector('[data-k="h3"]'); if (h3 && (h3.title || "") !== stNote) h3.title = stNote;
      set("lede", this._lede(L), true);
      this._drawFlow();
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
          <div class="lbl"><div class="hero"><span data-k="soc">—</span><span class="u">%</span></div><div class="small" data-k="socl"></div></div>`;
      }
      host.querySelector("[data-arc]").setAttribute("stroke-dasharray", soc >= 99.95 ? "none" : `${soc} 100`);
      host.querySelector("[data-res]").setAttribute("stroke-dasharray", `${res} 100`);
      host.querySelector("[data-resmark]").setAttribute("transform", `rotate(${(res / 100) * 360} ${c} ${c})`);
      const el = host.querySelector('[data-k="soc"]');
      const socTxt = L.soc === null ? "—" : L.f.num(L.soc);
      this._swapText(el, socTxt);
      el.parentElement.classList.toggle("n3", socTxt.length >= 3);
      const lbl = host.querySelector('[data-k="socl"]'), svgEl = host.querySelector("svg");
      const txt = L.chg > 0.05 ? "charging" : L.dis > 0.05 ? "discharging" : "idle";
      if (lbl.textContent !== txt) lbl.textContent = txt;
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
      const W = Math.max(240, host.clientWidth), natural = Math.round((7.2 * W) / 14 + 56);
      let room = host.clientHeight || natural;
      if (this._mode() === "wide") {
        // the card is cut to the window: the drawing takes what the header, the battery, the sentence and the gaps
        // leave, up to the height its width allows; any height left over is split above the battery and the sentence
        const card = host.parentElement, cs = getComputedStyle(card), kids = [...card.children].filter((c) => c !== host);
        room = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (parseFloat(cs.rowGap) || 0) * kids.length - kids.reduce((a, c) => a + c.getBoundingClientRect().height, 0);
      }
      const H = Math.max(150, Math.min(natural, room));
      const f = L.f;
      // one unit is a metre of house; the axes carry the projection's foreshortening (0.74 along the ground, 0.95 up)
      const k = Math.min(W / 14, (H - 56) / 7.2);
      const a = [-0.707 * k, -0.216 * k], b = [0.707 * k, -0.216 * k], up = 0.952 * k;
      const D = 8.6, LN = 12, HT = 3, R = 2.4, e = 0.5;
      const O = [W * 0.42, H - 30];
      const P = (la, lb, lw) => [O[0] + la * a[0] + lb * b[0], O[1] + la * a[1] + lb * b[1] - lw * up];
      const pt = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      const poly = (ps, cls, fill) => `<polygon points="${ps.map(pt).join(" ")}" class="${cls}" fill="${fill}"/>`;
      const zE = HT - 0.15, zR = HT + R, roofZ = (lb) => zE + ((lb + e) / (D / 2 + e)) * (zR - zE);
      let g = "";
      // the two walls, the back slope seen over the ridge, the front slope, the roof's thickness at its edges
      g += poly([P(0, 0, 0), P(LN, 0, 0), P(LN, 0, HT), P(0, 0, HT)], "face", "var(--x1-wall)");
      g += poly([P(0, 0, 0), P(0, D, 0), P(0, D, HT), P(0, D / 2, zR), P(0, 0, HT)], "face", "var(--x1-gable)");
      g += poly([P(-e, D / 2, zR), P(LN + e, D / 2, zR), P(LN + e, D + e, zE), P(-e, D + e, zE)], "face", "var(--x1-rake)");
      g += poly([P(-e, -e, zE), P(LN + e, -e, zE), P(LN + e, D / 2, zR), P(-e, D / 2, zR)], "face", "var(--x1-roof)");
      const t = 0.18;
      g += poly([P(-e, -e, zE), P(-e, D / 2, zR), P(-e, D + e, zE), P(-e, D + e, zE - t), P(-e, D / 2, zR - t), P(-e, -e, zE - t)], "face", "var(--x1-rake)");
      g += poly([P(-e, -e, zE), P(LN + e, -e, zE), P(LN + e, -e, zE - t), P(-e, -e, zE - t)], "face", "var(--x1-rake)");
      // one panel array on the front slope, its cells ruled in, lit while producing
      const lit = L.solar > 0.05, cw = 1.5, cols = Math.floor((LN - 1) / cw), pb0 = 0.4, pb1 = D / 2 - 0.8;
      const aa0 = 0.6, aa1 = 0.6 + cols * cw, onRoof = (la, lb) => P(la, lb, roofZ(lb));
      g += poly([onRoof(aa0, pb0), onRoof(aa1, pb0), onRoof(aa1, pb1), onRoof(aa0, pb1)], "array", lit ? "var(--x1-panel-on)" : "var(--x1-panel-off)");
      let cells = `M${pt(onRoof(aa0, (pb0 + pb1) / 2))}L${pt(onRoof(aa1, (pb0 + pb1) / 2))}`;
      for (let i = 1; i < cols; i++) cells += `M${pt(onRoof(aa0 + cw * i, pb0))}L${pt(onRoof(aa0 + cw * i, pb1))}`;
      g += `<path class="cells" d="${cells}"/>`;
      // the pole just past the gable's corner; the grid's line reaches it at the junction's height
      const poleB = D + 1.7, poleTop = 4.1;
      g += `<path class="edge" d="M${pt(P(0, poleB, 0))}L${pt(P(0, poleB, poleTop))}M${pt(P(0, poleB - 0.65, poleTop - 0.3))}L${pt(P(0, poleB + 0.65, poleTop - 0.3))}M${pt(P(0, poleB - 0.45, poleTop - 0.7))}L${pt(P(0, poleB + 0.45, poleTop - 0.7))}"/>`;
      // a small box for each thing on or by the house: its front, its top and the side the viewer sees
      const box = (la, lb, lw, da, db, dh, cls, fill, front) => {
        let o = "";
        o += poly([P(la, lb, lw + dh), P(la + da, lb, lw + dh), P(la + da, lb + db, lw + dh), P(la, lb + db, lw + dh)], cls, fill);
        if (front === "gable") o += poly([P(la, lb, lw), P(la, lb + db, lw), P(la, lb + db, lw + dh), P(la, lb, lw + dh)], cls, fill) + poly([P(la, lb, lw), P(la + da, lb, lw), P(la + da, lb, lw + dh), P(la, lb, lw + dh)], cls, fill);
        else o += poly([P(la, lb, lw), P(la + da, lb, lw), P(la + da, lb, lw + dh), P(la, lb, lw + dh)], cls, fill) + poly([P(la, lb, lw), P(la, lb + db, lw), P(la, lb + db, lw + dh), P(la, lb, lw + dh)], cls, fill);
        return o;
      };
      // The circuit is a cross on the gable, as the X1 is installed: a vertical trunk under the ridge carries solar down
      // to the junction and the battery's power up from the foot of the wall; a horizontal trunk carries the house's
      // power along the wall into the house and the grid's out to the pole. The junction is a flush plate where the
      // trunks cross. The battery towers stand at the foot of the gable beside the vertical trunk, larger than life,
      // each a bar of charge with the reserve marked across it.
      const hubB = D / 2, hubZ = 1.95, hw = 0.4, hh = 0.4, hd = 0.06;
      const towers = Math.max(1, Math.min(4, Math.round(L.towers ?? 1))), tg = 0.22, td = 0.75, th = 1.5;
      const t0 = hubB + hw + 0.6, tw = Math.min(0.95, (D - 0.15 - t0 - (towers - 1) * tg) / towers);
      const towerLb = (i) => t0 + i * (tw + tg);
      const soc = L.soc === null ? null : clamp(L.soc, 0, 100) / 100, resZ = (L.reserve / 100) * th;
      const hubL = P(-hd, hubB - hw, hubZ), hubR = P(-hd, hubB + hw, hubZ), hubT = P(-hd, hubB, hubZ + hh), hubD = P(-hd, hubB, hubZ - hh);
      // Every wire carries one lane per source of the energy on it, side by side in the source's colour: the house
      // line can carry solar, the battery and the grid at once, the battery line solar and the grid while charging,
      // the grid line solar and the battery while selling. A wire never carries power both ways at once (the cloud
      // reports net flows), so lanes are sources, not directions. Each lane's beads drift at a speed set by its power.
      // A direction counts only above the threshold its figure uses, so a trickle never reads as charging or selling.
      const charging = L.chg > 0.05 && L.chg > L.dis, selling = L.exp > 0.05 && L.exp > L.imp;
      const wires = [
        ["solar", [onRoof(aa0, pb1), P(0, hubB, zR - 0.1), hubT], false, { solar: L.solar }],
        ["home", [P(LN, 0, hubZ), P(0, 0, hubZ), hubL], true, { solar: L.flows.Sh, batt: L.flows.Bh, grid: L.flows.Gh }],
        ["batt", [P(0, t0, 0.22), P(0, hubB, 0.22), hubD], charging, charging ? { solar: L.flows.Sb, grid: L.flows.Gb } : { batt: L.dis }],
        ["grid", [P(0, poleB, hubZ), P(0, D, hubZ), hubR], selling, selling ? { solar: L.flows.Sg, batt: L.flows.Bg } : { grid: L.imp }],
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
      g += box(-hd, hubB - hw, hubZ - hh, hd, 2 * hw, 2 * hh, "hub", "var(--x1-plate)", "gable");
      // the towers, the farthest first so the nearer ones stand in front of it
      for (let i = towers - 1; i >= 0; i--) {
        const lb0 = towerLb(i);
        g += box(-td, lb0, 0, td, tw, th, "tower", "var(--x1-surface)", "gable");
        if (soc !== null && soc > 0.01) {
          const z = soc * th;
          g += poly([P(-td, lb0, 0), P(-td, lb0 + tw, 0), P(-td, lb0 + tw, z), P(-td, lb0, z)], "charge", "var(--x1-batt)");
          g += poly([P(-td, lb0, 0), P(0, lb0, 0), P(0, lb0, z), P(-td, lb0, z)], "charge", "var(--x1-batt-side)");
          g += poly([P(-td, lb0, z), P(-td, lb0 + tw, z), P(0, lb0 + tw, z), P(0, lb0, z)], "charge", "var(--x1-batt-top)");
        }
        g += box(-td, lb0, 0, td, tw, th, "tower-line", "none", "gable");
        g += `<path class="mark" d="M${pt(P(-td, lb0, resZ))}L${pt(P(-td, lb0 + tw, resZ))}"/>`;
      }
      // the four ports, named and figured, each with a dotted lead to what it names: Solar over its panels and Grid
      // over its pole above the house; House under the long wall its line runs into, and Battery under the towers
      const kw = (v) => (v > 0.05 ? `${f.num(v, v >= 10 ? 0 : 1)}${NB}kW` : `0${NB}kW`);
      const words = [
        ["Solar", kw(L.solar)],
        [`Grid · ${selling ? "selling" : L.imp > 0.05 ? "buying" : "idle"}`, kw(Math.max(L.imp, L.exp))],
        ["House", kw(L.home)],
        [`Battery${towers > 1 ? ` ×${towers}` : ""} · ${L.chg > 0.05 ? "charging" : L.dis > 0.05 ? "discharging" : "idle"}`, kw(Math.max(L.chg, L.dis))],
      ];
      // the skeleton is built once per size: the scene group is redrawn freely, the dot strands persist so a refresh
      // or a change of speed never restarts their drift, and the labels keep their nodes
      const size = `${W}x${H}`;
      let svg = host.querySelector("svg");
      if (!svg || svg.dataset.size !== size) {
        host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" data-size="${size}"><defs><clipPath id="x1fc"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#x1fc)" data-scene></g><g clip-path="url(#x1fc)">${live.map((w) => [0, 1, 2].map((i) => `<path class="dots" data-w="${w.key}" data-i="${i}" visibility="hidden"/>`).join("")).join("")}</g><g>${words.map((w_, i) => `<line class="lead" data-l="${i}"/>${i < 2 ? `<rect class="tag" data-t="${i}" rx="6" width="0" height="0"/>` : ""}<text class="port" data-n="${i}"></text><text class="port v" data-v="${i}"></text>`).join("")}</g></svg>`;
        svg = host.querySelector("svg");
      }
      const lede = `Power flow: ${this._lede(L)}`;
      if (svg.getAttribute("aria-label") !== lede) svg.setAttribute("aria-label", lede);
      const scene = svg.querySelector("[data-scene]");
      if (scene.innerHTML !== g) scene.innerHTML = g;
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
      // The top two labels take open sky where the drawing leaves it, measured against its top edge: the ridge up to
      // its near end, then the back slope's rake falling away. Grid stands over its pole; Solar stands as far over
      // the panels as the ridge allows and no closer to Grid than a gap. Only where no sky is open does a label sit
      // on a tag. Each label is placed for its widest words, so a new figure never moves it.
      const near = P(-e, D / 2, zR), far = P(LN + e, D / 2, zR), back = P(-e, D + e, zE);
      const rise = (near[1] - far[1]) / Math.max(1, near[0] - far[0]);
      const topY = (x) => (x <= near[0] ? near[1] - (near[0] - x) * rise : near[1] + (x - near[0]) * (back[1] - near[1]) / Math.max(1, back[0] - near[0]));
      const ridgeX = (y) => near[0] - (near[1] - y) / Math.max(1e-6, rise);
      const HW = 21, HWG = 44, INK = 30, SKY = 6;
      const poleAt = P(0, poleB, poleTop), gEnd = Math.min(W - 4, poleAt[0] + HWG), gx = gEnd - HWG;
      const panelEdge = onRoof(aa0 + 0.08, pb1 - 0.08)[0];
      const lo = ridgeX(INK + SKY) + HW, hi = Math.min(gx - HWG - 10 - HW, panelEdge - 4);
      const sx = Math.max(HW + 4, lo <= hi ? lo : hi);
      const lbS = pb1 - 0.3, laS = clamp((O[0] + lbS * b[0] - sx) / -a[0], aa0 + 0.3, aa1 - 0.3), panelAt = onRoof(laS, lbS);
      // the bottom two: Battery under the middle of the towers, House under the long wall, clear of Battery
      const tMid = P(-td, t0 + (towers * (tw + tg) - tg) / 2, 0), bxB = clamp(tMid[0], 82, W - 82);
      const hxB = clamp(O[0] * 0.5, 30, bxB - 82 - 30), houseAt = P((O[0] - hxB) / -a[0], 0, hubZ);
      const place = [
        [sx, 12, panelAt[0], panelAt[1] - 2, true, HW], [gx, 12, poleAt[0], poleAt[1] - 2, true, HWG, gEnd],
        [hxB, H - 18, hxB, houseAt[1] + 4, false, 0], [bxB, H - 18, bxB, tMid[1] + 3, false, 0],
      ];
      place.forEach(([x, y, lx, ly, top, hwx, end], i) => {
        const n = svg.querySelector(`[data-n="${i}"]`), v = svg.querySelector(`[data-v="${i}"]`), l = svg.querySelector(`[data-l="${i}"]`), tag = svg.querySelector(`[data-t="${i}"]`);
        const [name, val] = words[i];
        if (n.textContent !== name) n.textContent = name;
        if (v.textContent !== val) v.textContent = val;
        // a label is centred on its lead, or set flush right when its lead stands too near the edge to centre on
        const tx = end ?? x, anchor = end === undefined ? "middle" : "end";
        setA(n, "x", tx.toFixed(1)); setA(n, "y", y); setA(n, "text-anchor", anchor);
        setA(v, "x", tx.toFixed(1)); setA(v, "y", y + 16); setA(v, "text-anchor", anchor);
        if (tag) { const open = topY(x - hwx) >= INK + 3; setA(tag, "visibility", open ? "hidden" : "visible"); setA(tag, "x", (x - hwx - 4).toFixed(1)); setA(tag, "y", (y - 13).toFixed(1)); setA(tag, "width", String(2 * hwx + 8)); setA(tag, "height", "34"); }
        // a top label's lead runs from the label down to what it names; a bottom label's from the drawing down to it
        const [x1, y1, x2, y2] = top ? [end === undefined ? x : lx, INK + 4, lx, ly] : [lx, ly, lx, H - 32];
        setA(l, "visibility", y2 > y1 + 4 ? "visible" : "hidden"); setA(l, "x1", x1.toFixed(1)); setA(l, "x2", x2.toFixed(1)); setA(l, "y1", y1.toFixed(1)); setA(l, "y2", y2.toFixed(1));
      });
    }

    /* ----- the period column ----- */

    _periodCol() {
      return `<section class="col-period">
        <div class="card pbar"><h2 data-k="ptitle">Today</h2>
          <span class="nav"><button class="chev" data-nav="prev" title="Previous period" aria-label="Previous period">‹</button><button class="chev" data-nav="next" title="Next period" aria-label="Next period">›</button><button data-nav="now" title="Back to now">Now</button></span><span class="meta pvs" data-k="pvs"></span>
          <div class="head-r"><span class="seg" role="group" aria-label="Period">${VIEWS.map((v) => `<button data-view="${v}" aria-pressed="${this._view === v}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join("")}</span>
          <button class="tbtn" data-csv title="Download this period as CSV">CSV</button></div></div>
        <div class="heads" data-ledger>${["Solar", "House", "Bought", "Sold", "Charged", "Discharged"].map((n) => `<div class="cell card"><div class="cn">${n}</div><div class="cv">—</div><div class="cd"></div></div>`).join("")}</div>
        <div class="pbody" data-mg></div>
        <section class="card meaning"><div class="rings" data-rings></div>
        <div class="foot"><span data-k="foot">Anker cloud statistics</span><span class="fr" data-k="footr"></span></div></section></section>`;
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
      const host = this._root.querySelector("[data-mg]");
      const ghost = fade ? this._ghost(host) : null;
      this._drawChart();
      this._settle(host, ghost);
      const foot = this._root.querySelector('[data-k="foot"]'), footr = this._root.querySelector('[data-k="footr"]');
      if (foot) { foot.textContent = this._perror ? "Statistics unavailable" : `Anker's totals · charts from its ${P.view === "day" ? "5-minute averages" : P.view === "year" ? "monthly totals" : "daily totals"}`; foot.title = this._perror ? String(this._perror) : ""; }
      // the lifetime saving sits in the meaning card until a tariff prices each period, then here
      const tariff = Number(this._config.rate_import) > 0, LL = this._L;
      if (footr) footr.textContent = LL?.yieldMwh ? `${f.num(LL.yieldMwh, 2)}${NB}MWh since install${tariff && LL.savings ? ` · ${this._money(LL.savings)} saved by Anker's count` : ""}` : "";
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
      const item = (svg, value, name, note, title) => `<div class="rg${svg ? "" : " fig"}" title="${esc(title)}">${svg}<div class="rt"><div class="rv">${esc(value)}</div><div class="rn">${esc(name)}</div><div class="rn">${esc(note)}</div></div></div>`;
      const kwh = (v) => (v >= 1000 ? `${f.num(v / 1000, v >= 10000 ? 1 : 2)}${NB}MWh` : `${f.num(v, v >= 100 ? 0 : 1)}${NB}kWh`);
      let html = "";
      if (!T) html += item(ring([[0, "transparent"]]), "—", "self-sufficient", "", "") + item("", "—", "of solar kept", "", "");
      if (T) {
        // the split's percentages are rounded to add up to 100, and self-sufficiency is the two that are not the grid
        const sp = T.split ? shares([T.split.solar, T.split.batt, T.split.grid]) : null;
        html += item(ring(T.split ? [[T.split.solar, "var(--x1-solar)"], [T.split.batt, "var(--x1-batt)"], [T.split.grid, "var(--x1-grid)"]] : [[0, "transparent"]]),
          sp ? `${f.num(100 - sp[2])}%` : "—", "self-sufficient", sp ? `solar ${sp[0]}% · battery ${sp[1]}% · grid ${sp[2]}%` : "nothing used yet",
          `Of what the house used (${kwh(T.L)}), the share that did not come from the grid: solar and battery together.`);
        html += item("", T.kept === null ? "—" : `${f.num(T.kept * 100)}%`, "of solar kept", T.S > 0 ? `sold ${kwh(T.Sg)} of ${kwh(T.S)}` : "no solar yet",
          "Solar used at home or stored, as a share of what was produced over this period.");
      }
      // the saving: this period's at the owner's tariff when one is set, else Anker's own lifetime figure
      const ri = Number(this._config.rate_import) || 0, re = Number(this._config.rate_export) || 0, life = this._L?.savings;
      if (ri > 0 && T) {
        const saved = (T.L - T.Gi) * ri + T.Ge * re;
        html += item("", `${saved < 0 ? "−" : ""}${this._money(Math.abs(saved), Math.abs(saved) >= 100 ? 0 : 2)}`, "saved", `at ${this._money(ri, 2)} bought${re ? `, ${this._money(re, 2)} sold` : ""} per kWh`,
          "What the period cost less than buying everything the house used: (used − bought) × import rate + sold × export rate.");
      } else if (life) html += item("", this._money(life), "saved since install", "Anker's figure", "Anker's own count over the system's life. Set an import rate in the card's options to price each period at your tariff.");
      else html += item("", "—", "saved", T ? "set a tariff in the card's options" : "", "Set rate_import (and rate_export) in the card's options to price each period at your tariff.");
      if (host.innerHTML !== html) host.innerHTML = html;
    }

    /* ----- the chart: two strips on one axis ----- */

    _drawChart() {
      const host = this._root?.querySelector("[data-mg]"), P = this._P, D = this._data;
      if (!host || !P) return;
      const f = this._fmt(), narrow = this._mode() === "narrow", wide = this._mode() === "wide";
      const W = Math.max(240, host.clientWidth), total = wide ? host.clientHeight : narrow ? 560 : 380;
      const pad = this._tight ? 10 : 14, gap = this._tight ? 10 : 16, tile = narrow ? 0 : 168 + 14, axisH = 24;
      const sw_width = Math.max(200, W - 2 * pad - tile - 2);
      const x0 = P.t0, x1 = P.t1;
      // two cards share the height: each spends its padding, its border and its axis, the rest is strip
      const chrome = 2 * pad + axisH + 2 + (narrow ? 60 : 0);
      const body = Math.max(140, total - 2 * chrome - gap);
      const H1 = Math.round(body * 0.7), H2 = body - H1;
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
      const frac = (x) => Math.abs(x - Math.round(x)) > 1e-6, dp = !frac(step) ? 0 : !frac(step * 10) ? 1 : 2;
      const mdp = !frac(step / 1000) ? 0 : !frac(step / 100) ? 1 : 2;
      const tickLabel = (v) => (big >= 1000 ? `${f.num(v / 1000, mdp)}${NB}MWh` : `${f.num(v, dp)}${NB}${P.view === "day" ? "kW" : "kWh"}`);
      const ticks = [];
      if (have.length && step > 0) {
        for (let k = 1; k <= 5 && k * step <= maxUp * 1.02; k++) { const y = sy1(k * step); if (y > padT + 4) ticks.push([y, tickLabel(k * step)]); }
        for (let k = 1; k <= 5 && k * step <= maxDn * 1.02; k++) { const y = zero + k * step * scale; if (y < H1 - padB + 4) ticks.push([y, tickLabel(k * step)]); }
      }
      const padL = Math.max(40, 14 + Math.ceil(6.8 * Math.max(4, ...ticks.map(([, t]) => t.length)))), padR = 10;
      const pw = sw_width - padL - padR;
      const sx = (t) => padL + ((t - x0) / (x1 - x0)) * pw;
      const markX = P.isNow && P.view === "day" ? sx(Math.min(x1, Date.now())) : null;
      this._mgGeom = { P, sx, padL, pw, W: sw_width, strips: [] };
      const grid = (y) => `<line x1="${padL}" x2="${padL + pw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--x1-grid-line)"/>`;
      const label = (v, y) => `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="tick">${esc(v)}</text>`;
      // strip 1: what supplied the house, stacked above zero; below it, what charged the battery and the solar sold.
      // Hue is the source (solar, battery, grid): full strength supplies the house, a tint charges the battery, a hatch is sold.
      let g1 = `<defs><pattern id="x1h" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="1.8" height="6" fill="var(--x1-solar)"/></pattern></defs>`;
      if (have.length) g1 += grid(zero);
      for (const [y, t] of ticks) g1 += grid(y) + label(t, y);
      if (markX !== null) g1 += `<line x1="${markX.toFixed(1)}" x2="${markX.toFixed(1)}" y1="0" y2="${H1}" stroke="var(--x1-axis)"/>`;
      const FILL = { Sh: "var(--x1-solar)", Bh: "var(--x1-batt)", Gh: "var(--x1-grid)", Sb: "var(--x1-solar-tint)", Gb: "var(--x1-grid-tint)", Sg: "url(#x1h)" };
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
        if (P.isNow && last && Date.now() - last.t1 > 10 * 60e3) g1 += `<text x="${(sx(last.t1) - 4).toFixed(1)}" y="${(zero - 6).toFixed(1)}" text-anchor="end" class="tick halo">cloud to ${esc(f.time(last.t1))}</text>`;
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
      if (have.length) g1 += `<text x="${padL + 6}" y="13" class="tick halo">House ran on</text><text x="${padL + 6}" y="${H1 - 4}" class="tick halo">Stored · sold</text>`;
      const bands = [["Sh", "solar", 0], ["Bh", "battery", 0], ["Gh", "grid", 0], ["Sb", "to battery", 1], ["Gb", "grid to battery", 1], ["Sg", "sold", 1]];
      const win = P.view === "day" ? 9 : 0;
      // only the day's areas take labels: a bar is narrower than its band's name
      if (P.view === "day") for (const [key, name, below] of bands) {
        let best = -1, at = -1;
        for (let i = 0; i < buckets.length; i++) { let sum = 0, n = 0; for (let j = i - win; j <= i + win; j++) { const b = buckets[j]; if (b && !b.empty) { sum += b[key]; n++; } } const v = n === 2 * win + 1 || win === 0 ? sum / n : 0; if (v > best) { best = v; at = i; } }
        const b = at >= 0 ? buckets[at] : null;
        if (!b || best * scale < 15) continue;
        const base = key === "Sh" ? 0 : key === "Bh" ? b.Sh : key === "Gh" ? b.Sh + b.Bh : key === "Sb" ? 0 : key === "Gb" ? b.Sb : b.Sb + b.Gb;
        const mid = below ? zero + (base + b[key] / 2) * scale : sy1(base + b[key] / 2);
        const x = P.view === "day" ? (sx(b.t) + sx(b.t1)) / 2 : padL + (pw / buckets.length) * (at + 0.5);
        g1 += `<text x="${x.toFixed(1)}" y="${(mid + 4).toFixed(1)}" text-anchor="middle" class="tick halo on">${esc(name)}</text>`;
      }
      g1 += `<line data-xh x1="0" x2="0" y1="0" y2="${H1}" stroke="var(--x1-ink2)" visibility="hidden"/>`;
      this._mgGeom.strips.push({ H: H1, sy: sy1, zero });
      // strip 2: state of charge (day) or self-sufficiency per bucket
      let g2 = "";
      const p2T = 10, p2B = 6, ph2 = H2 - p2T - p2B, sy2 = (v) => p2T + ph2 - (v / 100) * ph2;
      g2 += grid(sy2(100)) + grid(sy2(50)) + label("100%", sy2(100)) + label("50%", sy2(50));
      if (markX !== null) g2 += `<line x1="${markX.toFixed(1)}" x2="${markX.toFixed(1)}" y1="0" y2="${H2}" stroke="var(--x1-axis)"/>`;
      let when = "";
      const res = clamp(Number(this._config.reserve) || 0, 0, 100);
      if (P.view === "day") {
        // the charge over the day as a fill level, the towers' picture: a soft mass under the line, the reserve rule
        // over the mass, the line on top
        const runs = []; let cur = null;
        for (const b of buckets) { if (b.empty || b.soc === null || b.soc === undefined) { cur = null; continue; } if (!cur) { cur = []; runs.push(cur); } cur.push([(sx(b.t) + sx(b.t1)) / 2, sy2(b.soc)]); }
        const floor = sy2(0), xy = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
        for (const r of runs) if (r.length > 1) g2 += `<path class="soc-fill" d="M${r.map(xy).join("L")}L${r[r.length - 1][0].toFixed(1)},${floor.toFixed(1)}L${r[0][0].toFixed(1)},${floor.toFixed(1)}Z"/>`;
        g2 += `<line x1="${padL}" x2="${padL + pw}" y1="${sy2(res).toFixed(1)}" y2="${sy2(res).toFixed(1)}" stroke="var(--x1-ink2)" stroke-dasharray="4 4"/>`;
        const d = runs.filter((r) => r.length > 1).map((r) => `M${r.map(xy).join("L")}`).join("");
        if (d) g2 += `<path d="${d}" fill="none" stroke="var(--x1-batt)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        const last = [...have].reverse().find((b) => b.soc !== null && b.soc !== undefined);
        if (last) g2 += `<circle cx="${((sx(last.t) + sx(last.t1)) / 2).toFixed(1)}" cy="${sy2(last.soc).toFixed(1)}" r="4" fill="var(--x1-batt)" stroke="var(--x1-surface)" stroke-width="2"/>`;
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
        const n = buckets.length, slot = pw / n, bw = Math.max(3, Math.min(28, slot * 0.6));
        const rect = (x, v0, v1, fill) => (v1 - v0 > 0.05 ? `<rect x="${x.toFixed(1)}" y="${sy2(v1).toFixed(1)}" width="${bw.toFixed(1)}" height="${(sy2(v0) - sy2(v1)).toFixed(1)}" fill="${fill}"/>` : "");
        for (let i = 0; i < n; i++) {
          const b = buckets[i]; if (b.empty || !(b.L > 0)) continue;
          const v = clamp(1 - Math.min(b.L, b.Gh) / b.L, 0, 1) * 100, own = b.Sh + b.Bh, x = padL + slot * i + (slot - bw) / 2;
          if (!(own > 0)) { g2 += rect(x, 0, v, "var(--x1-axis)"); continue; }
          const vs = v * (b.Sh / own);
          g2 += rect(x, 0, vs, "var(--x1-solar)") + rect(x, vs, v, "var(--x1-batt)");
        }
      }
      g2 += `<line data-xh x1="0" x2="0" y1="0" y2="${H2}" stroke="var(--x1-ink2)" visibility="hidden"/>`;
      this._mgGeom.strips.push({ H: H2, sy: sy2 });
      const empty = this._perror ? `Anker's cloud didn't answer.${P.isNow ? " Trying again in five minutes." : " Choose the period again to retry."}` : !D ? "Loading…" : have.length ? "" : P.view === "day" && P.isNow ? "The day has just begun." : "No data for this period.";
      // the tiles: each chart's name, and its key in three short lines
      const sw = (col, extra = "") => `<i class="sw${extra}"${col ? ` style="background:${col}"` : ""}></i>`;
      const T = D?.T;
      const grp = (title, line) => `<div class="kgp">${title ? `<div class="kt">${title}</div>` : ""}<div class="kg">${line}</div></div>`;
      const powerTile = `<div class="ct"><div class="ctn">${P.view === "day" ? "Power" : "Energy"}</div><div class="ctd">Above the line, what ran the house. Below it, what was stored or sold.</div>
        <div class="ck">${grp("House from", `${sw(FILL.Sh)}solar ${sw(FILL.Bh)}battery ${sw(FILL.Gh)}grid`)}${grp("Battery from", `${sw(FILL.Sb)}solar ${sw(FILL.Gb)}grid`)}${grp("", `${sw(null, " hatch")}Solar sold`)}</div></div>`;
      const battTile = P.view === "day"
        ? `<div class="ct"><div class="ctn">Battery</div><div class="ck">${grp("", `${sw(null, " fill")}State of charge`)}${grp("", `${sw(null, " line")}Reserve ${f.num(res)}%`)}${when ? grp("", `<b>${esc(when)}</b>`) : ""}</div></div>`
        : `<div class="ct"><div class="ctn">Self-sufficient</div><div class="ctd">The house's use not bought from the grid.</div><div class="ck">${grp("", `${sw("var(--x1-solar)")}solar ${sw("var(--x1-batt)")}battery`)}${T && T.selfSuff !== null ? grp("", `<b>${f.num(T.selfSuff * 100)}% over the period</b>`) : ""}</div></div>`;
      const axis = (chip) => `<div class="mg-axis"><svg width="${sw_}" height="${axisH}" aria-hidden="true">${this._axis(P, sx, padL, pw, markX)}${chip ? `<g data-xt visibility="hidden"><line data-xtl y1="0" y2="6" stroke="var(--x1-ink2)"/><rect data-xtb y="6" height="18" rx="4" fill="var(--x1-well)"/><text data-xtt y="19" text-anchor="middle" class="tick day now"></text></g>` : ""}</svg></div>`;
      const sw_ = sw_width;
      this._redrawing = true;
      host.innerHTML = `<div class="mg" tabindex="0" role="img" aria-label="${esc(`${P.title}: ${P.view === "day" ? "power and battery" : "energy and self-sufficiency"}. Use the arrow keys to read values.`)}">
        <section class="card chart" style="padding:${pad}px">${powerTile}<div class="cs"><div class="mg-p" style="height:${H1}px"><svg width="${sw_}" height="${H1}" aria-hidden="true">${g1}</svg>${empty ? `<div class="mg-none small" style="left:${padL + 8}px">${esc(empty)}</div>` : ""}</div>${axis(false)}</div></section>
        <section class="card chart" style="padding:${pad}px">${battTile}<div class="cs"><div class="mg-p" style="height:${H2}px"><svg width="${sw_}" height="${H2}" aria-hidden="true">${g2}</svg>${empty && !this._perror ? `<div class="mg-none small" style="left:${padL + 8}px">${esc(empty)}</div>` : ""}</div>${axis(true)}</div></section></div>`;
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
      const mg = this._root.querySelector(".mg"), G = this._mgGeom;
      if (!mg || !G) return;
      const P = G.P, buckets = this._data?.buckets ?? [];
      const snap = (t) => { const b = buckets.find((x) => t >= x.t && t < x.t1) ?? buckets[buckets.length - 1]; return b ? b.t : null; };
      const clampT = (t) => Math.max(P.t0, Math.min(P.t1 - 1, t));
      const fromEvent = (e) => {
        const svg = e.target.closest?.(".mg-p svg, .mg-axis svg") ?? (this._mgTouch === e.pointerId ? mg.querySelector(".mg-p svg") : null);
        if (!svg) return null;
        const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
        if (x < G.padL || x > G.padL + G.pw) return null;
        return snap(clampT(P.t0 + ((x - G.padL) / G.pw) * (P.t1 - P.t0)));
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
      const xh = this._root.querySelectorAll(".mg [data-xh]");
      const b = t === null ? null : (this._data?.buckets ?? []).find((x) => t >= x.t && t < x.t1);
      if (t === null || !b || b.empty) {
        xh.forEach((l) => l.setAttribute("visibility", "hidden"));
        this._renderLedger(null);
        if (t === null) { if (this._hinted) this._chip(null); else this._mgHint(); } else this._chip(null);
        return;
      }
      if (!this._hinted) { this._hinted = true; try { window.localStorage.setItem(HINT_KEY, "9"); } catch (e) { /* no storage */ } }
      const x = P.view === "day" ? (G.sx(b.t) + G.sx(b.t1)) / 2 : (G.sx(b.t) + G.sx(b.t1)) / 2;
      xh.forEach((l) => { l.setAttribute("x1", x.toFixed(1)); l.setAttribute("x2", x.toFixed(1)); l.setAttribute("visibility", "visible"); });
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
