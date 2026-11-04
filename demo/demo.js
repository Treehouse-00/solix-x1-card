// Demo: the card running against a mock Home Assistant with an invented Anker SOLIX X1 home in San Francisco, so
// it can be tried in a browser before installing. Everything is simulated, five minutes at a time since the start
// of last year: the sun's position, an invented weather, a household's load, an 8.4 kW array and a 40 kWh battery
// that serves the house first. The answers take the shape Anker's cloud gives the Anker Solix integration, and the
// live readings move every 30 seconds.
// Query options: theme=dark, view=day|week|month|year, at=HH:MM (that time of day), date=YYYY-MM-DD (that day as
// today), rate=<price per kWh bought> (prices each period's saving), w=<px>, lang=<code>, clock=12|24.
(() => {
  "use strict";
  const TZ = "America/Los_Angeles", LAT = 37.7749, LON = -122.4194;
  const DAY = 864e5, HOUR = 36e5, STEP = 3e5, N = 288;
  const CAP = 40, RESERVE = 20, PMAX = 7.6, EFF = 0.95, ARRAY = 8.4;
  const IMPORT = 0.38, EXPORT = 0.08; // the invented tariff behind the lifetime saving
  const SITE = "00000000-demo-4000-8000-000000000000";
  const params = new URLSearchParams(location.search);
  const dark = params.get("theme") === "dark";
  const pad = (n) => String(n).padStart(2, "0");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // ?shot=1 hides the nav before the card mounts, so the card measures the window it will really get.
  if (params.get("shot")) document.body.classList.add("shot");
  if (params.get("w")) document.querySelector("#stage").style.maxWidth = `${params.get("w")}px`;
  for (const a of document.querySelectorAll("nav a[href^='?']")) {
    const u = new URL(a.href);
    const keys = ["theme", "view", "at", "rate", "w"], def = { theme: "light" };
    if (keys.every((k) => (u.searchParams.get(k) || def[k] || "") === (params.get(k) || def[k] || ""))) a.setAttribute("aria-current", "true");
  }

  // ---- the home's calendar ----
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = (t) => { const o = {}; for (const p of fmt.formatToParts(new Date(t))) if (p.type !== "literal") o[p.type] = Number(p.value); return o; };
  const offset = (t) => { const p = parts(t); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000; };
  const dateOf = (t) => { const p = parts(t); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
  const midnight = (ds) => { const [y, m, d] = ds.split("-").map(Number), guess = Date.UTC(y, m - 1, d); return guess - offset(guess - offset(guess)); };
  const addDays = (ds, n) => dateOf(midnight(ds) + n * DAY + 12 * HOUR);
  const ymd = (ds) => ds.split("-").map(Number);
  const weekday = (ds) => { const [y, m, d] = ymd(ds); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  const dayOfYear = (ds) => { const [y, m, d] = ymd(ds); return (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / DAY; };
  const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  // ?date pins the day and ?at the time of day; the clock then runs on from there, as it does in a house.
  {
    const real = Date.now(), p = parts(real), at = params.get("at");
    const [hh, mm] = (at || `${p.hour}:${p.minute}`).split(":").map(Number);
    const target = midnight(params.get("date") || dateOf(real)) + (hh * 60 + mm) * 60e3 + (at ? 0 : p.second * 1e3);
    if (Math.abs(target - real) > 1000) { const orig = Date.now.bind(Date), shift = target - real; Date.now = () => orig() + shift; }
  }

  // ---- the simulation: deterministic for each day, so every view and every visit agree ----
  const rng = (key) => {
    let a = 2166136261;
    for (let i = 0; i < key.length; i++) { a ^= key.charCodeAt(i); a = Math.imul(a, 16777619); }
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 15), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };
  // the sine of the sun's elevation over the home at instant t
  const sunHeight = (t) => {
    const rad = Math.PI / 180, n = t / DAY - 10957.5;
    const L = (280.46 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * rad;
    const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, eps = (23.439 - 4e-7 * n) * rad;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24, H = (gmst * 15 + LON) * rad - ra;
    return Math.sin(LAT * rad) * Math.sin(dec) + Math.cos(LAT * rad) * Math.cos(dec) * Math.cos(H);
  };
  // a day's weather: clear, partly cloudy or overcast, cloudier in winter, and summer mornings that start in fog
  const weather = (ds) => {
    const r = rng(`sky ${ds}`), winter = 0.5 + 0.5 * Math.cos(((dayOfYear(ds) - 15) / 365.25) * 2 * Math.PI);
    const x = r(), over = 0.06 + 0.2 * winter, part = 0.18 + 0.14 * winter;
    const kind = x < over ? 0 : x < over + part ? 1 : 2;
    const level = kind === 0 ? 0.16 + 0.22 * r() : kind === 1 ? 0.5 + 0.32 * r() : 0.92 + 0.08 * r();
    return { kind, level, winter, fog: winter < 0.35 && r() < 0.45 ? 10 + 2 * r() : 0, ph: [r() * 6.3, r() * 6.3, r() * 6.3],
      warm: winter < 0.3 && r() < 0.3, chores: r() < 0.5, guests: r() < 0.1 };
  };
  // the house's load in kW at hour h
  const demand = (h, w, weekend, r) => {
    let kw = 0.36 + 0.06 * Math.sin((h / 24) * 6 * Math.PI) + 0.1 * r();
    if (h >= 6.25 && h < 8.75) kw += weekend ? 0.55 : 0.9;
    if (h >= 9 && h < 16.5) kw += weekend ? 0.6 + 0.3 * r() : 0.12;
    if (h >= 17 && h < 22.75) kw += 0.35 + 1.25 * Math.sin(((h - 17) / 5.75) * Math.PI);
    if (w.chores && h >= 19.75 && h < 21) kw += 1.5;
    if (w.warm && h >= 13 && h < 19) kw += 1.2;
    if (w.winter > 0.6 && (h >= 17.5 || h < 7)) kw += 0.45 * w.winter;
    if (w.guests && h >= 18 && h < 23) kw += 0.6;
    return kw;
  };
  // one day, five minutes at a time: solar serves the house, then charges the battery, then is sold; the battery
  // covers what solar cannot, down to its reserve; the grid covers the rest
  const simulate = (ds, soc0) => {
    const w = weather(ds), r = rng(`load ${ds}`), t0 = midnight(ds), wd = weekday(ds), weekend = wd === 0 || wd === 6;
    const S = { solar: new Float64Array(N), home: new Float64Array(N), hes: new Float64Array(N), grid: new Float64Array(N), soc: new Float64Array(N) };
    let soc = soc0;
    for (let i = 0; i < N; i++) {
      const h = (i * 5 + 2.5) / 60, se = sunHeight(t0 + (i + 0.5) * STEP);
      let k = w.level;
      if (w.kind === 1) k *= 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(i / 5.5 + w.ph[0])) * (0.55 + 0.45 * Math.sin(i / 15 + w.ph[1]));
      if (w.fog && h < w.fog) k *= 0.35 + 0.65 * clamp((h - w.fog + 2.5) / 2.5, 0, 1);
      const pv = se > 0.02 ? ARRAY * Math.pow(se, 1.15) * k * (0.98 + 0.02 * Math.sin(i / 2.7 + w.ph[2])) : 0;
      const load = demand(h, w, weekend, r);
      let batt, grid;
      if (pv >= load) {
        const spare = pv - load, room = (Math.max(0, 100 - soc) / 100) * CAP * 12 / EFF, c = Math.min(spare, PMAX, room);
        batt = -c; grid = -(spare - c); soc += ((c * EFF) / 12 / CAP) * 100;
      } else {
        const need = load - pv, avail = (Math.max(0, soc - RESERVE) / 100) * CAP * 12, d = Math.min(need, PMAX, avail);
        batt = d; grid = need - d; soc -= (d / 12 / CAP) * 100;
      }
      soc = clamp(soc, 0, 100);
      S.solar[i] = pv; S.home[i] = load; S.hes[i] = batt; S.grid[i] = grid; S.soc[i] = soc;
    }
    return S;
  };
  const zero = () => ({ solar: 0, home: 0, dis: 0, chg: 0, imp: 0, exp: 0 });
  const add = (a, b) => { if (b) for (const k in a) a[k] += b[k]; return a; };
  const sums = (S, n) => {
    const t = zero();
    for (let i = 0; i < n; i++) {
      t.solar += S.solar[i] / 12; t.home += S.home[i] / 12;
      if (S.hes[i] > 0) t.dis += S.hes[i] / 12; else t.chg -= S.hes[i] / 12;
      if (S.grid[i] > 0) t.imp += S.grid[i] / 12; else t.exp -= S.grid[i] / 12;
    }
    return t;
  };

  // the history, from the first of January last year: each day's starting charge and its totals
  const first = `${ymd(dateOf(Date.now()))[0] - 1}-01-01`, days = new Map();
  let last = null;
  const extendTo = (to) => {
    let ds = last ? addDays(last, 1) : first, soc = last ? days.get(last).end : 62;
    for (; ds <= to; ds = addDays(ds, 1)) { const S = simulate(ds, soc); days.set(ds, { soc0: soc, end: S.soc[N - 1], total: sums(S, N) }); soc = S.soc[N - 1]; last = ds; }
  };
  extendTo(dateOf(Date.now()));
  const info = (ds) => { if (ds < first) return null; if (ds > last) extendTo(ds); return days.get(ds) ?? null; };
  const cache = new Map();
  const series = (ds) => {
    if (!cache.has(ds)) { const d = info(ds); cache.set(ds, d ? simulate(ds, d.soc0) : null); if (cache.size > 40) cache.delete(cache.keys().next().value); }
    return cache.get(ds);
  };
  // the five-minute buckets the cloud has reported for a day: all of a past day, today's up to now, none ahead
  const done = (ds) => { const today = dateOf(Date.now()); return ds < today ? N : ds > today ? 0 : clamp(Math.floor((Date.now() - midnight(ds)) / STEP), 0, N); };
  const totalOf = (ds) => { const n = done(ds), d = info(ds); return !d || !n ? null : n === N ? d.total : sums(series(ds), n); };

  // ---- the cloud's answers, in the shape of charging_hes_svc/get_energy_statistics ----
  const pick = (src, t) => (src === "solar" ? [t.solar, 0] : src === "home" ? [t.home, 0] : src === "hes" ? [t.dis, t.chg] : [t.imp, t.exp]);
  const totals = (src, t, k) => {
    const f = (v) => (v / k).toFixed(2);
    if (src === "grid") return { totalEnergy: f(t.imp - t.exp), totalImportedEnergy: f(t.imp), totalExportedEnergy: f(t.exp) };
    if (src === "hes") return { totalEnergy: f(t.dis), totalImportedEnergy: f(t.chg), totalExportedEnergy: f(t.dis) };
    const v = pick(src, t)[0];
    return { totalEnergy: f(v), totalImportedEnergy: f(v), totalExportedEnergy: "0.00" };
  };
  const dayAnswer = (src, ds) => {
    const S = series(ds), n = S ? done(ds) : 0, time = (i) => `${pad(Math.floor(i / 12))}:${pad((i % 12) * 5)}`;
    const power = Array.from({ length: N }, (_, i) => { const ok = i < n, v = ok ? S[src][i].toFixed(2) : "0.00"; return { time: time(i), powerInfos: [{ value: v, type: src, isFix: !ok, valuePtr: ok ? v : null }] }; });
    const chargeLevel = src === "hes" ? Array.from({ length: N }, (_, i) => ({ time: time(i), value: i < n ? String(Math.round(S.soc[i])) : "0", isFix: i >= n })) : null;
    return { power, chargeLevel, ...totals(src, n ? sums(S, n) : zero(), 1), totalEnergyUnit: "KWh", aggregates: [], energy: null, energyUnit: "", powerUnit: "kw" };
  };
  const energyAnswer = (src, groups, k, unit) => {
    const all = zero();
    const energy = groups.map((g) => {
      const t = zero(); for (const ds of g) add(t, totalOf(ds)); add(all, t);
      const [v, neg] = pick(src, t);
      return { value: (v / k).toFixed(2), negValue: neg ? (-neg / k).toFixed(2) : "0" };
    });
    return { energy, ...totals(src, all, k), totalEnergyUnit: unit, aggregates: [], power: null, chargeLevel: null, energyUnit: "", powerUnit: "kw" };
  };
  const answer = ({ sourceType: src, dateType, start, end }) => {
    if (!["solar", "home", "hes", "grid"].includes(src)) return null;
    if (dateType === "day") return dayAnswer(src, start);
    if (dateType === "week") { const g = []; for (let ds = start; ds <= end; ds = addDays(ds, 1)) g.push([ds]); return energyAnswer(src, g, 1, "KWh"); }
    if (dateType === "month") { const [y, m] = ymd(start); return energyAnswer(src, Array.from({ length: daysIn(y, m) }, (_, i) => [`${start}-${pad(i + 1)}`]), 1, "KWh"); }
    if (dateType === "year") {
      const y = Number(start);
      return energyAnswer(src, Array.from({ length: 12 }, (_, mo) => Array.from({ length: daysIn(y, mo + 1) }, (_, d) => `${start}-${pad(mo + 1)}-${pad(d + 1)}`)), 1000, "MWh");
    }
    return null;
  };

  // ---- the entities the Anker Solix integration would create ----
  const life = (() => {
    const t = zero();
    for (const [ds] of days) add(t, totalOf(ds));
    return { solar: t.solar, saved: (t.home - t.imp) * IMPORT + t.exp * EXPORT };
  })();
  const live = () => {
    const now = Date.now(), ds = dateOf(now), S = series(ds), t0 = midnight(ds);
    // the readings glide from one five-minute average to the next, as the integration's polling makes them
    const x = clamp((now - t0) / STEP - 0.5, 0, N - 1), i = Math.floor(x), j = Math.min(N - 1, i + 1), f = x - i;
    const at = (k) => S[k][i] * (1 - f) + S[k][j] * f;
    const batt = at("hes"), grid = at("grid"), iso = new Date(now).toISOString();
    const report = parts(t0 + Math.floor((now - t0) / STEP) * STEP), off = offset(now) / 60e3;
    const zone = `${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
    const states = {};
    const put = (id, state, attributes = {}) => { states[id] = { entity_id: id, state: String(state), attributes, last_updated: iso, last_changed: iso, last_reported: iso }; };
    const kw = (v) => Math.max(0, v).toFixed(2), power = { unit_of_measurement: "kW", device_class: "power", state_class: "measurement" };
    put("sensor.backup_controller_state_of_charge", Math.round(at("soc")), { unit_of_measurement: "%", device_class: "battery" });
    put("sensor.backup_controller_solar_power", kw(at("solar")), power);
    put("sensor.backup_controller_home_demand", kw(at("home")), power);
    put("sensor.backup_controller_grid_import", kw(grid), power);
    put("sensor.backup_controller_grid_export", kw(-grid), power);
    put("sensor.backup_controller_charge_power", kw(-batt), power);
    put("sensor.backup_controller_discharge_power", kw(batt), power);
    put("sensor.backup_controller_data_time", `${ds} ${pad(report.hour)}:${pad(report.minute)}:00${zone}`);
    put("sensor.backup_controller_cloud_state", "online", { options: ["offline", "online", "unknown"] });
    put("sensor.demo_home_cost_savings", life.saved.toFixed(1), { unit_of_measurement: "$" });
    put("sensor.demo_home_co2_savings", (life.solar * 0.39).toFixed(0), { unit_of_measurement: "kg" });
    put("sensor.demo_home_yield_total", (life.solar / 1000).toFixed(2), { unit_of_measurement: "MWh", device_class: "energy" });
    put("sensor.demo_home_battery_modules", 8);
    put("sensor.demo_home_parallel_devices", 3);
    put("binary_sensor.demo_home_connection", "on", { device_class: "connectivity" });
    put("switch.demo_home_api_usage", "on");
    for (let m = 1; m <= 8; m++) put(`number.x1_battery_module_battery_capacity${m > 1 ? `_${m}` : ""}`, 5000, { unit_of_measurement: "Wh", device_class: "energy_storage" });
    return states;
  };

  // ---- the mock Home Assistant ----
  const delay = () => new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
  let hass = {
    states: live(),
    config: { latitude: LAT, longitude: LON, time_zone: TZ, currency: "USD", location_name: "Demo home", unit_system: { length: "mi" } },
    themes: { darkMode: dark },
    locale: { language: params.get("lang") || "en", number_format: "language", time_format: params.get("clock") || "language" },
    language: params.get("lang") || "en",
    connection: { subscribeMessage: async () => () => {} },
    callService: async () => {},
    callWS: async (msg) => {
      if (msg.type === "config/device_registry/list") return [{ id: "demo-site", model: "Hes Site", name: "Demo home", identifiers: [["anker_solix", SITE]] }];
      if (msg.type === "call_service" && msg.domain === "anker_solix" && msg.service === "api_request") {
        await delay();
        const endpoint = msg.service_data?.endpoint, payload = msg.service_data?.payload ?? {};
        const data = endpoint === "charging_hes_svc/get_system_running_info" ? { mode: 0, numberOfParallelDevice: 3, batCount: 8, connected: true }
          : endpoint === "charging_hes_svc/get_energy_statistics" && payload.siteId === SITE ? answer(payload) : null;
        const response = data ? { code: 0, msg: "success!", data } : { code: -1, msg: "unsupported request", data: null };
        return { response: { [msg.target?.entity_id ?? "switch.demo_home_api_usage"]: { request: { method: "post", endpoint, payload }, response } } };
      }
      throw new Error(`demo: ${msg.type} is not part of this demo`);
    },
  };

  const card = document.createElement("solix-x1-card");
  const config = { type: "custom:solix-x1-card", reserve: RESERVE };
  if (params.get("rate")) { config.rate_import = Number(params.get("rate")); config.rate_export = EXPORT; }
  // the card remembers each viewer's last view; the demo's links choose it instead
  try { localStorage.setItem("solix-x1-card:view", ["day", "week", "month", "year"].includes(params.get("view")) ? params.get("view") : "day"); } catch (e) { /* no storage */ }
  card.setConfig(config);
  card.hass = hass;
  document.querySelector("#stage").appendChild(card);
  setInterval(() => { hass = { ...hass, states: live() }; card.hass = hass; }, 30e3);
})();
