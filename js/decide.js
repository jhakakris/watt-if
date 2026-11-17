// Decision layer: reads only the table of simulated plans, so every call is instant.
// Targets (cost and carbon ceilings) give the earliest opening month; must haves filter plans.

import { RESOURCES } from "./engine.js";

export const LABEL = { utility_solar: "solar", wind: "wind", battery_4h: "battery", gas_turbine: "gas turbine",
  nuclear: "nuclear", gas_engine: "gas engine", fuel_cell: "fuel cell" };
export const NAME = { utility_solar: "Solar contract", wind: "Wind contract", nuclear: "Nuclear PPA",
  battery_4h: "Battery", gas_turbine: "Gas turbine", gas_engine: "Gas engine", fuel_cell: "Fuel cell" };

/** Turn the columnar plans file into row objects. */
export function loadPlans(cols) {
  const n = cols.start.length, rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = { id: i, start: cols.start[i], full: cols.start[i] + 10, lowc: !!cols.lowc[i], t2: !!cols.t2[i],
      cost: cols.cost[i], co2: cols.co2[i], total: cols.total[i], co2t: cols.co2t[i], clean: cols.clean[i],
      served: cols.served[i], moved: cols.moved[i], paused: cols.paused[i] };
    for (const k of RESOURCES) r[k] = cols[k][i];
    rows[i] = r;
  }
  return rows;
}

const byCost = (a, b) => a.cost - b.cost || a.co2 - b.co2 || a.id - b.id;
const byCo2 = (a, b) => a.co2 - b.co2 || a.cost - b.cost || a.id - b.id;
const minOf = (arr, key) => arr.reduce((m, r) => Math.min(m, r[key]), Infinity);
const minBy = (arr, cmp) => arr.reduce((best, r) => (best === null || cmp(r, best) < 0 ? r : best), null);

/** f = {allowed: [...sources], noT2: bool}; start = month or null for any month. */
export function eligible(rows, f, start = null) {
  const banned = RESOURCES.filter(k => !f.allowed.includes(k));
  return rows.filter(r => (start === null || r.start === start) && banned.every(k => r[k] === 0) && !(f.noT2 && r.paused > 1e-6));
}

export function testedMonths(rows) {
  return [...new Set(rows.map(r => r.start))].sort((a, b) => a - b);
}

/** Cost vs carbon ladder: cheapest first, each rung strictly cleaner. */
export function frontier(d) {
  const out = []; let best = Infinity;
  for (const r of [...d].sort(byCost)) if (r.co2 < best - 0.05) { out.push(r); best = r.co2; }
  return out;
}

function balancedIndex(ladder, pool) {
  const range = key => { let lo = Infinity, hi = -Infinity; for (const r of pool) { lo = Math.min(lo, r[key]); hi = Math.max(hi, r[key]); } return [lo, hi]; };
  const [cl, ch] = range("cost"), [gl, gh] = range("co2");
  const norm = (v, lo, hi) => (hi > lo ? (v - lo) / (hi - lo) : 0);
  let bi = 0, bs = -Infinity;
  ladder.forEach((r, i) => { const s = 0.5 * (1 - norm(r.cost, cl, ch)) + 0.5 * (1 - norm(r.co2, gl, gh)); if (s > bs) { bs = s; bi = i; } });
  return bi;
}

export function planLadder(rows, f, start) {
  const d = eligible(rows, f, start);
  if (!d.length) return { ladder: [], def: null };
  const ladder = frontier(d);
  return { ladder, def: balancedIndex(ladder, d) };
}

export function relaxation(rows, f) {
  const tips = [];
  for (const k of RESOURCES.filter(k => !f.allowed.includes(k)))
    if (eligible(rows, { ...f, allowed: [...f.allowed, k] }).length) tips.push(`Allow ${LABEL[k]}.`);
  if (f.noT2 && eligible(rows, { ...f, noT2: false }).length) tips.push("Allow pausing Tier 2 work during stress hours.");
  return tips.length ? tips : ["No single change found. Allow more energy sources."];
}

export function describe(r) {
  const parts = RESOURCES.filter(k => r[k]).map(k => `${r[k]} MW ${LABEL[k]}`);
  let text = parts.length ? parts.join(", ") : "grid power only";
  if (r.lowc) text += " (low carbon dispatch)";
  return text;
}

const months = n => `${n} month${n === 1 ? "" : "s"}`;
const pct = (a, b) => (b ? 100 * (a / b - 1) : null);

export function explainChange(old, nw, oldName = "the default") {
  if (!old || !nw) return "";
  if (old.id === nw.id) return `This is ${oldName}.`;
  const diffs = [];
  for (const k of RESOURCES) {
    if (nw[k] > old[k]) diffs.push(`adds ${nw[k] - old[k]} MW ${LABEL[k]}`);
    else if (old[k] > nw[k]) diffs.push(`removes ${old[k] - nw[k]} MW ${LABEL[k]}`);
  }
  if (old.start !== nw.start) diffs.push(`opens at month ${nw.start} instead of ${old.start}`);
  const dc = pct(nw.cost, old.cost), de = pct(nw.co2, old.co2);
  return `Compared with ${oldName}, this plan ${diffs.join(", ") || "only changes how resources are run"}. ` +
    `Cost ${dc >= 0 ? "up" : "down"} ${Math.abs(dc).toFixed(0)}%, carbon ${de >= 0 ? "up" : "down"} ${Math.abs(de).toFixed(0)}%.`;
}

function card(r, label, note, ref, start) {
  return { label, note, row: r, plan: describe(r), monthsVsStart: r.start - start,
    costVs: ref ? pct(r.cost, ref.cost) : null, co2Vs: ref ? pct(r.co2, ref.co2) : null };
}

/** Alternatives for the pick: A same opening, different mix; B move the opening month. */
export function alternatives(rows, f, pick) {
  const s = pick.start, groups = { A: [], B: [] };
  const lad = planLadder(rows, f, s);
  if (lad.ladder.length) {
    const L = lad.ladder;
    groups.A = [card(L[0], "Cheapest", `Lowest cost for an opening at month ${s}.`, pick, s),
      card(L[lad.def], "Balanced", "Equal weight on cost and carbon.", pick, s),
      card(L[L.length - 1], "Cleanest", `Lowest carbon for an opening at month ${s}.`, pick, s)];
  }
  const any = eligible(rows, f);
  if (any.length) {
    const first = minOf(any, "start");
    const fast = minBy(any.filter(r => r.start === first), byCost), cheap = minBy(any, byCost), clean = minBy(any, byCo2);
    const when = r => { const m = r.start - s; return m === 0 ? "same month" : `${months(Math.abs(m))} ${m < 0 ? "sooner" : "later"}`; };
    const served = r => { const dt = (r.served - pick.served) / 1e6; return Math.abs(dt) < 0.005 ? "" : ` Serves ${Math.abs(dt).toFixed(2)} TWh ${dt > 0 ? "more" : "less"} before month 120.`; };
    groups.B = [card(fast, "Fastest", `Earliest opening that works: month ${first} (${when(fast)}).${served(fast)}`, pick, s),
      card(cheap, "Cheapest", `Lowest cost per MWh of any opening month: month ${cheap.start} (${when(cheap)}).${served(cheap)}`, pick, s),
      card(clean, "Cleanest", `Lowest carbon of any opening month: month ${clean.start} (${when(clean)}).${served(clean)}`, pick, s)];
  }
  return groups;
}

export function targetRanges(rows, f) {
  const d = eligible(rows, f);
  if (!d.length) return null;
  const q98 = key => { const v = d.map(r => r[key]).sort((a, b) => a - b); const p = 0.98 * (v.length - 1), lo = Math.floor(p); return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (p - lo); };
  return { costMin: Math.floor(minOf(d, "cost")), costMax: Math.ceil(q98("cost")),
    co2Min: Math.floor(minOf(d, "co2")), co2Max: Math.ceil(q98("co2")) };
}

/** One row per tested opening month: cheapest plan under the carbon target and whether it meets cost too. */
export function monthTable(rows, f, maxCost, maxCo2) {
  const groups = new Map();
  for (const r of eligible(rows, f)) { if (!groups.has(r.start)) groups.set(r.start, []); groups.get(r.start).push(r); }
  return [...groups.keys()].sort((a, b) => a - b).map(m => {
    const best = minBy(groups.get(m).filter(r => r.co2 <= maxCo2), byCost);
    return { month: m, best, meetsBoth: !!best && best.cost <= maxCost };
  });
}

export function earliestForTargets(rows, f, maxCost, maxCo2) {
  const ok = eligible(rows, f).filter(r => r.cost <= maxCost + 1e-9 && r.co2 <= maxCo2 + 1e-9);
  const out = { maxCost, maxCo2, monthsOk: [...new Set(ok.map(r => r.start))].sort((a, b) => a - b), month: null, pick: null };
  if (ok.length) {
    out.month = out.monthsOk[0];
    out.pick = minBy(ok.filter(r => r.start === out.month), byCost);
  }
  return out;
}

const fmt1 = v => v.toFixed(1);

/** Like earliestForTargets, but if nothing meets both targets it moves ONE target by the smallest percent change. */
export function resolveTargets(rows, f, maxCost, maxCo2) {
  let res = { ...earliestForTargets(rows, f, maxCost, maxCo2), adjusted: false, requestedCost: maxCost, requestedCo2: maxCo2, message: "" };
  if (res.month !== null) return res;
  const d = eligible(rows, f);
  if (!d.length) { res.message = "No tested plan meets your must haves. " + relaxation(rows, f).join(" "); return res; }
  const rel = (nw, old) => (nw - old) / Math.max(Math.abs(old), 1e-9);
  const options = [];
  const c = d.filter(r => r.co2 <= maxCo2);
  if (c.length) { const nc = Math.ceil(minOf(c, "cost") * 2) / 2; options.push([rel(nc, maxCost), nc, maxCo2, "cost"]); }
  const g = d.filter(r => r.cost <= maxCost);
  if (g.length) { const ne = Math.ceil(minOf(g, "co2")); options.push([rel(ne, maxCo2), maxCost, ne, "carbon"]); }
  if (!options.length) {
    const dist = r => Math.max(r.cost / Math.max(maxCost, 1e-9) - 1, 0) + Math.max(r.co2 / Math.max(maxCo2, 1e-9) - 1, 0);
    const r = minBy(d, (a, b) => dist(a) - dist(b));
    options.push([0, Math.ceil(r.cost * 2) / 2, Math.ceil(r.co2), "both"]);
  }
  const [, nc, ne, which] = options.reduce((a, b) => (b[0] < a[0] ? b : a));
  res = { ...earliestForTargets(rows, f, nc, ne), adjusted: true, requestedCost: maxCost, requestedCo2: maxCo2 };
  const what = { cost: `cost target from $${fmt1(maxCost)} to $${fmt1(nc)}/MWh`,
    carbon: `carbon target from ${maxCo2.toFixed(0)} to ${ne.toFixed(0)} kg CO2/MWh`,
    both: `cost target to $${fmt1(nc)}/MWh and carbon target to ${ne.toFixed(0)} kg CO2/MWh` }[which];
  res.message = `No tested plan met $${fmt1(maxCost)}/MWh and ${maxCo2.toFixed(0)} kg CO2/MWh together, so we moved the ${what}, the smallest change that works.`;
  return res;
}

/** Three qualifying plans: earliest opening, lowest cost, cleanest (all meet both targets). */
export function strategies(rows, f, maxCost, maxCo2, res) {
  const ok = eligible(rows, f).filter(r => r.cost <= maxCost + 1e-9 && r.co2 <= maxCo2 + 1e-9);
  if (!ok.length || !res.pick) return null;
  return { earliest_opening: res.pick, lowest_cost: minBy(ok, byCost), cleanest: minBy(ok, byCo2) };
}

export const ROLE = {
  wind: "Cheapest energy available ($35/MWh flat, from month 12), but it arrives through the shared grid connection and is paid for even when unused.",
  utility_solar: "Cheap daytime energy ($40/MWh, from month 24) that complements night time wind; also paid for even when unused.",
  nuclear: "Clean, steady power, but $95/MWh, only from month 60, at most 25 MW, and it shares the grid connection.",
  battery_4h: "At most 12 MW / 48 MWh; can only charge from spare clean contract power. Useful in stress hours and price spikes, not as a main source.",
  gas_turbine: "Lowest cost onsite power per MW from month 18; covers months when demand is above the grid limit. Emits about 500 kg CO2/MWh.",
  gas_engine: "Onsite power in small 5 MW steps from month 16; costs more per MW than the turbine but fits small gaps. About 450 kg CO2/MWh.",
  fuel_cell: "Only onsite source ready at month 14, and the cleanest gas option (about 345 kg CO2/MWh), but by far the most expensive per MW.",
};

/** For every source: what happens if we remove it (if used) or add it (if not), same opening month. */
export function whySources(rows, f, pick, maxCost, maxCo2, maxMw) {
  const pool = eligible(rows, f, pick.start);
  const meets = r => r.cost <= maxCost + 1e-9 && r.co2 <= maxCo2 + 1e-9;
  return RESOURCES.map(k => {
    const used = pick[k] > 0;
    if (!f.allowed.includes(k)) return { k, used, verdict: "Excluded by your must haves.", result: "", good: false };
    const cand = pool.filter(r => (used ? r[k] === 0 : r[k] > 0));
    if (!cand.length) return { k, used, result: "no workable plan", good: false,
      verdict: used ? "Needed: no tested plan for this opening month works without it." : "Not possible here: no tested plan for this month includes it." };
    const dist = r => Math.round((RESOURCES.filter(j => j !== k).reduce((s, j) => s + Math.abs(r[j] - pick[j]) / maxMw[j], 0) + 0.01 * (r.lowc !== pick.lowc)) * 1e6);
    const best = minBy(cand, (a, b) => dist(a) - dist(b) || a.cost - b.cost);
    const dc = 100 * (best.cost / pick.cost - 1), dg = pick.co2 ? 100 * (best.co2 / pick.co2 - 1) : 0;
    const sg = v => (v >= 0 ? "+" : "") + v.toFixed(0);
    const result = `Closest plan: ${describe(best)}: $${best.cost.toFixed(1)}/MWh (${sg(dc)}%), ${best.co2.toFixed(0)} kg (${sg(dg)}%)`;
    let verdict, good = false;
    if (meets(best)) {
      good = true;
      verdict = dc > 0.5 ? `Also meets your targets but costs ${dc.toFixed(0)}% more.` : "Also meets your targets at about the same cost (a close alternative).";
      if (dc < -0.5) verdict = `Also meets your targets and is ${Math.abs(dc).toFixed(0)}% cheaper; it ranks lower only on other targets or month.`;
      if (used && dc <= 0.5) verdict = "Optional: an equally good plan exists without it.";
    } else {
      const broke = [];
      if (best.cost > maxCost) broke.push(`cost target ($${maxCost.toFixed(1)})`);
      if (best.co2 > maxCo2) broke.push(`carbon target (${maxCo2.toFixed(0)} kg)`);
      verdict = `${used ? "Removing" : "Adding"} it breaks your ${broke.join(" and ") || "targets"}.`;
    }
    return { k, used, result, verdict, good };
  });
}

/** [24, 25, 26, 40] -> "24 to 26 and 40" (consecutive among the tested months). */
export function monthRanges(ms, universe) {
  const pos = new Map(universe.map((m, i) => [m, i])), runs = [];
  for (const m of ms) {
    if (runs.length && pos.get(m) === pos.get(runs[runs.length - 1][1]) + 1) runs[runs.length - 1][1] = m;
    else runs.push([m, m]);
  }
  const parts = runs.map(([a, b]) => (a === b ? `${a}` : `${a} to ${b}`));
  return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}
