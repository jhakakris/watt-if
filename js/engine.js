// Hourly engine: inputs, merit-order dispatch and common accounting for one plan.
// Runs in the browser. The hourly inputs are one reference year (8,760 hours)
// repeated over the 120-month horizon with smooth real-terms price and carbon trends.

export const RESOURCES = ["utility_solar", "wind", "battery_4h", "gas_turbine", "nuclear", "gas_engine", "fuel_cell"];
export const CLEAN = ["wind", "utility_solar", "nuclear"];
export const GAS = ["gas_turbine", "gas_engine", "fuel_cell"];
export const DISPATCH_COLUMNS = ["model_hour", "grid_mw", "tier1_relocated_mw", "tier2_curtailed_mw", "utility_solar_mw",
  "wind_mw", "battery_4h_charge_mw", "battery_4h_discharge_mw", "battery_4h_soc_mwh", "gas_turbine_mw", "nuclear_mw",
  "gas_engine_mw", "fuel_cell_mw"];
const EPS = 1e-9;
const NFILL = 6; // gas turbine, gas engine, fuel cell, merchant, relocate, interrupt

export function makeEngine(params, hourly) {
  const { catalog, case: cs, response: rp, rates, ramp, grid_schedule: schedule } = params;
  const HPM = cs.hours_per_model_month, HPY = cs.hours_per_year;
  const N = cs.horizon_months * HPM;

  // ---------- inputs that do not depend on the opening month ----------
  const month = new Int32Array(N), year = new Int32Array(N), ref = new Int32Array(N);
  const gridPrice = new Float64Array(N), gasPrice = new Float64Array(N), gridCo2 = new Float64Array(N);
  const remoteCo2 = new Float64Array(N), active = new Uint8Array(N), impfrac = new Float64Array(N);
  const localHour = new Int32Array(N);
  const profile = {};
  for (const c of ["wind_proxy_cf", "solar_proxy_cf", "firm_clean_available_fraction"]) profile[c] = new Float64Array(N);
  const H = hourly;
  for (let t = 0; t < N; t++) {
    const r = t % HPY, yrs = t / HPY;
    month[t] = Math.floor(t / HPM); year[t] = Math.floor(t / 8760); ref[t] = r;
    const mW = Math.pow(1 + rates.wholesale_energy, yrs), mG = Math.pow(1 + rates.henry_hub, yrs),
      mC = Math.pow(1 + rates.grid_co2, yrs);
    gridPrice[t] = H.wholesale_price_usd_per_mwh[r] * mW + H.grid_adder_usd_per_mwh[r];
    gasPrice[t] = H.henry_hub_usd_per_mmbtu[r] * mG + H.delivered_gas_adder_usd_per_mmbtu[r];
    gridCo2[t] = H.grid_co2_t_per_mwh[r] * mC;
    remoteCo2[t] = rp.remote_co2_t_per_mwh * mC;
    active[t] = H.stress_active[r] ? 1 : 0;
    impfrac[t] = H.stress_import_fraction[r];
    localHour[t] = H.local_hour[r];
    for (const c in profile) profile[c][t] = H[c][r];
  }
  const relocationPrice = rp.remote_energy_multiplier * rp.remote_electricity_usd_per_mwh + rp.relocation_service_usd_per_local_mwh;
  const interruptionPrice = rp.interruption_consequence_usd_per_mwh;

  const cache = new Map();
  function inputs(start, delay = 0) {
    const key = start + ":" + delay;
    if (cache.has(key)) return cache.get(key);
    const load = new Float64Array(N), t0 = new Float64Array(N), t1 = new Float64Array(N), t2 = new Float64Array(N);
    const ordinary = new Float64Array(N), limit = new Float64Array(N);
    const relocLimit = new Float64Array(N), curtLimit = new Float64Array(N);
    const remoteCap = rp.remote_capacity_mw / rp.remote_energy_multiplier;
    for (let t = 0; t < N; t++) {
      const rel = month[t] - start, r = ref[t];
      const frac = rel < 0 ? 0 : rel >= ramp.length - 1 ? 1 : ramp[rel];
      load[t] = H.load_mw[r] * frac;
      t1[t] = H.tier1_relocatable_mw[r] * frac;
      t2[t] = H.tier2_interruptible_mw[r] * frac;
      t0[t] = load[t] - t1[t] - t2[t];
      let o = 0;
      for (const [from, mx] of schedule) if (month[t] >= from + (mx > 0 ? delay : 0)) o = mx;
      ordinary[t] = o;
      limit[t] = o * impfrac[t];
      const eligible = active[t] && H.notice_minutes[r] >= rp.relocation_notice_minutes;
      relocLimit[t] = eligible ? Math.min(t1[t], remoteCap) : 0;
      curtLimit[t] = active[t] ? t2[t] * rp.tier2_max_fraction : 0;
    }
    const ctx = { N, start, delay, month, year, ref, load, tier0: t0, tier1: t1, tier2: t2, ordinary, limit, active,
      relocLimit, curtLimit, gridPrice, gasPrice, gridCo2, remoteCo2, relocationPrice, interruptionPrice, localHour, profile };
    cache.set(key, ctx);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return ctx;
  }

  const fromMonth = (k, start) => Math.max(start, catalog[k].available_month);

  // Fill `need` cheapest first, hour by hour. Writes fills into `fill` (N x 6), returns unmet and marginal value.
  function meritFill(ctx, need, headroom, caps, start, allowInt, carbon, fill) {
    const unmet = new Float64Array(N), marginal = new Float64Array(N);
    const gasK = GAS.map(k => catalog[k]), gasFrom = GAS.map(k => fromMonth(k, start));
    const rank = new Float64Array(NFILL), lim = new Float64Array(NFILL), order = [0, 1, 2, 3, 4, 5];
    for (let t = 0; t < N; t++) {
      for (let j = 0; j < 3; j++) {
        const r = gasK[j];
        rank[j] = r.payment_usd_per_mwh + r.heat_rate_mmbtu_per_mwh_hhv * ctx.gasPrice[t] + carbon * r.co2_t_per_mwh;
        lim[j] = month[t] >= gasFrom[j] ? caps[GAS[j]] : 0;
      }
      rank[3] = ctx.gridPrice[t] + carbon * ctx.gridCo2[t]; lim[3] = headroom[t];
      rank[4] = ctx.relocationPrice + carbon * 1.05 * ctx.remoteCo2[t]; lim[4] = ctx.relocLimit[t];
      rank[5] = ctx.interruptionPrice; lim[5] = allowInt ? ctx.curtLimit[t] : 0;
      // stable sort by rank (insertion sort on 6 items)
      for (let i = 0; i < NFILL; i++) order[i] = i;
      for (let i = 1; i < NFILL; i++) {
        const o = order[i]; let j = i - 1;
        while (j >= 0 && rank[order[j]] > rank[o]) { order[j + 1] = order[j]; j--; }
        order[j + 1] = o;
      }
      let before = 0, total = 0, last = -1;
      for (let i = 0; i < NFILL; i++) {
        const o = order[i], l = lim[o];
        const f = Math.min(Math.max(need[t] - before, 0), l);
        if (fill) fill[t * NFILL + o] = f;
        total += f; before += l;
        if (f > EPS) last = o;
      }
      unmet[t] = need[t] - total;
      marginal[t] = last >= 0 ? rank[last] : 0;
    }
    return { unmet, marginal };
  }

  function batteryLoop(bmw, eta, from, surplus, need0, load, value, budget, finalFrom) {
    const r = catalog.battery_4h, eMax = bmw * r.duration_hours, k = Math.trunc(r.duration_hours);
    const thr = new Float64Array(N), day = new Float64Array(24);
    for (let d = 0; d < N / 24; d++) {
      for (let i = 0; i < 24; i++) day[i] = value[d * 24 + i];
      day.sort();
      const v = day[24 - k];
      for (let i = 0; i < 24; i++) thr[d * 24 + i] = v;
    }
    const ch = new Float64Array(N), di = new Float64Array(N), soc = new Float64Array(N);
    const used = new Float64Array(budget.length);
    let s = 0;
    for (let t = 0; t < N; t++) {
      if (month[t] < from) continue;
      const y = year[t], rem = budget[y] - used[y];
      if (t >= finalFrom) {
        const d = Math.min(bmw, s * eta, load[t], rem * eta);
        if (d > EPS) { di[t] = d; s -= d / eta; used[y] += d / eta; }
      } else if (need0[t] > EPS && s > EPS && value[t] >= thr[t]) {
        const d = Math.min(bmw, s * eta, need0[t], rem * eta);
        if (d > EPS) { di[t] = d; s -= d / eta; used[y] += d / eta; }
      } else if (surplus[t] > EPS) {
        const c = Math.min(bmw, surplus[t], (eMax - s) / eta, Math.max(0, rem - s) / eta);
        if (c > EPS) { ch[t] = c; s += c * eta; }
      }
      s = Math.min(Math.max(s, 0), eMax);
      soc[t] = s;
    }
    return { ch, di, soc };
  }

  /** Simulate one plan. plan = {start, delay, caps:{...}, allowInterruption, carbonPrice}. */
  function simulate(plan) {
    const start = plan.start, delay = plan.delay || 0, ctx = inputs(start, delay);
    const caps = Object.fromEntries(RESOURCES.map(k => [k, +(plan.caps[k] || 0)]));
    const allowInt = plan.allowInterruption !== false, carbon = plan.carbonPrice || 0;
    const { load, limit: cap } = ctx;
    const avail = {};
    for (const k of CLEAN) {
      const a = new Float64Array(N), p = profile[catalog[k].profile_column], fm = fromMonth(k, start), c = caps[k];
      if (c) for (let t = 0; t < N; t++) a[t] = month[t] >= fm ? c * p[t] : 0;
      avail[k] = a;
    }
    const cleanAvail = new Float64Array(N), cleanCap = new Float64Array(N), cleanLoad0 = new Float64Array(N);
    const need0 = new Float64Array(N), head0 = new Float64Array(N);
    for (let t = 0; t < N; t++) {
      cleanAvail[t] = avail.wind[t] + avail.utility_solar[t] + avail.nuclear[t];
      cleanCap[t] = Math.min(cleanAvail[t], cap[t]);
      cleanLoad0[t] = Math.min(cleanCap[t], load[t]);
      need0[t] = load[t] - cleanLoad0[t];
      head0[t] = cap[t] - cleanLoad0[t];
    }
    let ch = new Float64Array(N), di = new Float64Array(N), soc = new Float64Array(N);
    const b = caps.battery_4h;
    if (b > 0) {
      const { marginal } = meritFill(ctx, need0, head0, caps, start, allowInt, carbon, null);
      const r = catalog.battery_4h, eta = Math.sqrt(r.round_trip_efficiency), eMax = b * r.duration_hours;
      const from = fromMonth("battery_4h", start), nYears = year[N - 1] + 1, budget = [];
      for (let y = 0; y < nYears; y++) {
        let cnt = 0;
        for (let t = y * 8760; t < Math.min(N, (y + 1) * 8760); t++) if (month[t] >= from) cnt++;
        budget.push(eMax * r.max_cycles_per_year * cnt / 8760);
      }
      const surplus = new Float64Array(N);
      for (let t = 0; t < N; t++) surplus[t] = cleanCap[t] - cleanLoad0[t];
      ({ ch, di, soc } = batteryLoop(b, eta, from, surplus, need0, load, marginal, budget, N - 24));
    }
    const cleanDisp = new Float64Array(N), need = new Float64Array(N), head = new Float64Array(N);
    for (let t = 0; t < N; t++) {
      const cl = Math.min(cleanCap[t], load[t] - di[t]);
      cleanDisp[t] = cl + ch[t];
      need[t] = load[t] - di[t] - cl;
      head[t] = cap[t] - cleanDisp[t];
    }
    const fill = new Float64Array(N * NFILL);
    const { unmet } = meritFill(ctx, need, head, caps, start, allowInt, carbon, fill);
    const out = {};
    const left = Float64Array.from(cleanDisp);
    for (const k of CLEAN) {
      const o = new Float64Array(N);
      for (let t = 0; t < N; t++) { o[t] = Math.min(avail[k][t], left[t]); left[t] -= o[t]; }
      out[k] = o;
    }
    const col = j => { const a = new Float64Array(N); for (let t = 0; t < N; t++) a[t] = fill[t * NFILL + j]; return a; };
    const df = {
      grid_mw: col(3), tier1_relocated_mw: col(4), tier2_curtailed_mw: col(5),
      utility_solar_mw: out.utility_solar, wind_mw: out.wind, nuclear_mw: out.nuclear,
      battery_4h_charge_mw: ch, battery_4h_discharge_mw: di, battery_4h_soc_mwh: soc,
      gas_turbine_mw: col(0), gas_engine_mw: col(1), fuel_cell_mw: col(2),
    };
    let unmetMwh = 0, firstUnmet = null, curtailed = 0;
    for (let t = 0; t < N; t++) {
      if (unmet[t] > 1e-6) { unmetMwh += unmet[t]; if (firstUnmet === null) firstUnmet = month[t]; }
      curtailed += cleanAvail[t] - cleanDisp[t];
    }
    return { df, caps, ctx, start, delay, info: { feasible: firstUnmet === null, unmet_mwh: unmetMwh, first_unmet_month: firstUnmet, clean_curtailed_mwh: curtailed } };
  }

  const crf = life => { const r = cs.discount_rate_real; return r / (1 - Math.pow(1 + r, -life)); };

  /** Common accounting for a simulated plan, with optional annual rows and a per-resource ledger. */
  function accounting(sim, annual = false) {
    const { df, caps, ctx, start } = sim;
    const cost = new Float64Array(N), co2 = new Float64Array(N), clean = new Float64Array(N);
    const ledger = [];
    for (const k of RESOURCES) {
      const r = catalog[k], mw = caps[k], fm = fromMonth(k, start);
      const fixedPerHour = mw * 1000 * (r.capex_usd_per_kw * crf(r.life_years) + r.fom_usd_per_kw_year) / 8760;
      let fixedSum = 0, paySum = 0, fuelSum = 0, genSum = 0, co2Sum = 0;
      const storage = r.kind === "storage";
      const gen = storage ? null : df[k + "_mw"], prof = r.payment_basis === "available_generation" ? profile[r.profile_column] : null;
      for (let t = 0; t < N; t++) {
        const m = month[t] >= fm;
        const fixed = m ? fixedPerHour : 0;
        let g = 0;
        if (storage) clean[t] += df[k + "_discharge_mw"][t] - df[k + "_charge_mw"][t];
        else { g = gen[t]; if (r.clean_credit) clean[t] += g; }
        const billed = prof ? (m ? mw * prof[t] : 0) : g;
        const pay = billed * r.payment_usd_per_mwh, fuel = g * ctx.gasPrice[t] * r.heat_rate_mmbtu_per_mwh_hhv;
        cost[t] += fixed + pay + fuel; co2[t] += g * r.co2_t_per_mwh;
        fixedSum += fixed; paySum += pay; fuelSum += fuel; genSum += g; co2Sum += g * r.co2_t_per_mwh;
      }
      ledger.push({ k, mw, from: fm, fixed: fixedSum, payment: paySum, fuel: fuelSum, total: fixedSum + paySum + fuelSum, gen: genSum, co2: co2Sum });
    }
    const grid = df.grid_mw, reloc = df.tier1_relocated_mw, intr = df.tier2_curtailed_mw;
    const gridCost = new Float64Array(N), local = new Float64Array(N), remote = new Float64Array(N);
    const rcost = new Float64Array(N), icost = new Float64Array(N), rco2 = new Float64Array(N);
    for (let t = 0; t < N; t++) {
      gridCost[t] = grid[t] * ctx.gridPrice[t];
      cost[t] += gridCost[t]; co2[t] += grid[t] * ctx.gridCo2[t];
      remote[t] = reloc[t] * rp.remote_energy_multiplier;
      local[t] = ctx.load[t] - reloc[t] - intr[t];
      rcost[t] = reloc[t] * ctx.relocationPrice; icost[t] = intr[t] * ctx.interruptionPrice;
      rco2[t] = remote[t] * ctx.remoteCo2[t];
    }
    const div = (a, b) => (b > 0 ? a / b : null);
    function agg(lo, hi) {
      let req = 0, served = 0, rem = 0, lc = 0, rr = 0, ii = 0, ce = 0, re = 0, cm = 0, mv = 0, ps = 0, gm = 0;
      for (let t = lo; t < hi; t++) {
        req += ctx.load[t]; served += local[t]; rem += remote[t]; lc += cost[t]; rr += rcost[t]; ii += icost[t];
        ce += co2[t]; re += rco2[t]; cm += clean[t]; mv += reloc[t]; ps += intr[t]; gm += grid[t];
      }
      return {
        requested_mwh: req, local_served_mwh: served, relocated_local_equivalent_mwh: mv, remote_electricity_mwh: rem,
        interrupted_mwh: ps, local_energy_cost_usd: lc, relocation_cost_usd: rr, interruption_consequence_usd: ii,
        total_decision_cost_usd: lc + rr + ii, local_energy_cost_usd_per_mwh: div(lc, served),
        decision_cost_usd_per_requested_mwh: div(lc + rr + ii, req), local_operational_co2_t: ce,
        remote_operational_co2_t: re, combined_operational_co2_t: ce + re,
        combined_electricity_co2_kg_per_mwh: div(1000 * (ce + re), served + rem), clean_energy_mwh: cm,
        clean_energy_share: div(cm, served), merchant_mwh: gm,
      };
    }
    const total = agg(0, N);
    total.merchant_cost_usd = gridCost.reduce((a, b) => a + b, 0);
    total.ledger = ledger;
    if (annual) {
      total.annual = [];
      for (let y = 0; y <= year[N - 1]; y++) total.annual.push({ model_year: y + 1, ...agg(y * 8760, Math.min(N, (y + 1) * 8760)) });
    }
    return total;
  }

  /** Hourly series for charts. */
  function timeseries(sim) {
    const { df, ctx } = sim;
    const gas = new Float64Array(N), battery = new Float64Array(N);
    for (let t = 0; t < N; t++) {
      gas[t] = df.gas_turbine_mw[t] + df.gas_engine_mw[t] + df.fuel_cell_mw[t];
      battery[t] = Math.max(df.battery_4h_discharge_mw[t] - df.battery_4h_charge_mw[t], 0);
    }
    return {
      N, wind: df.wind_mw, solar: df.utility_solar_mw, nuclear: df.nuclear_mw, gas, battery, grid: df.grid_mw,
      moved: df.tier1_relocated_mw, paused: df.tier2_curtailed_mw, load: ctx.load, tier0: ctx.tier0,
      limit: ctx.limit, ordinary_limit: ctx.ordinary, stress: ctx.active, price: ctx.gridPrice, month: ctx.month,
      hod: ctx.localHour,
    };
  }

  return { N, catalog, params, inputs, simulate, accounting, timeseries, crf };
}
