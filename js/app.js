// Watt If: page rendering and shared state. Hash routes: #/, #/project, #/recommendations, #/demand-profile, #/export
import { makeEngine, RESOURCES, DISPATCH_COLUMNS } from "./engine.js";
import * as D from "./decide.js";

const SOURCES = { utility_solar: "Utility solar contract", wind: "Wind contract", battery_4h: "4-hour battery",
  gas_turbine: "Onsite gas turbine", gas_engine: "Onsite gas engine", fuel_cell: "Natural-gas fuel cell", nuclear: "Offsite nuclear PPA" };
const SHORT = { wind: "Wind", utility_solar: "Solar", nuclear: "Nuclear", gas_engine: "Gas engines", gas_turbine: "Gas turbines",
  fuel_cell: "Fuel cells", battery_4h: "Battery (4 hour)" };
const ICONS = { wind: "🌬️", utility_solar: "☀️", nuclear: "⚛️", gas_engine: "⚙️", gas_turbine: "🌀", fuel_cell: "🔋", battery_4h: "🔌" };
const COLORS = { wind: "#2a78d6", utility_solar: "#eda100", nuclear: "#1baf7a", battery_4h: "#6250d6", gas_turbine: "#eb6834",
  gas_engine: "#eb6834", fuel_cell: "#eb6834" };
const PRESETS = { Default: [60, 50], Budget: [55, 120], Clean: [90, 15] };
const PRIORITIES = { earliest_opening: "Earliest opening", lowest_cost: "Lowest cost", cleanest: "Cleanest electricity" };
const SOURCE_ORDER = ["wind", "utility_solar", "nuclear", "gas_engine", "gas_turbine", "fuel_cell", "battery_4h"];
const DEFAULT_PROJECT = { name: "75 MW campus, Williamson County, TX", cost: 60, co2: 50, allowed: [...RESOURCES], noT2: false,
  priority: "earliest_opening", rate: 15, realization: 100 };

const app = document.getElementById("app");
const S = { project: { ...DEFAULT_PROJECT }, applied: null, override: null, selMonth: null, prevPick: null, shownPick: null,
  adjustMessage: null, simCache: new Map() };
let rows, engine, universe, maxMw, charts = [];

// ---------- helpers ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n0 = v => Math.round(v).toLocaleString("en-US");
const n1 = v => v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n2 = v => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const $ = sel => app.querySelector(sel);
const heading = (kicker, title, lead) => `<p class="eyebrow">${kicker}</p><h1 class="title">${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}`;
const metric = (lbl, val, cap = "") => `<div class="card tight metric"><div class="lbl">${lbl}</div><div class="val">${val}</div>${cap ? `<div class="caption">${cap}</div>` : ""}</div>`;
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function killCharts() { charts.forEach(c => c.destroy()); charts = []; }
function storeProject() { try { localStorage.setItem("wattif.project", JSON.stringify(S.project)); } catch (e) { /* storage unavailable */ } }
function loadProject() {
  try { const p = JSON.parse(localStorage.getItem("wattif.project")); if (p && typeof p.cost === "number") S.project = { ...DEFAULT_PROJECT, ...p }; } catch (e) { /* ignore */ }
}

// ---------- shared state (targets -> earliest month -> chosen plan) ----------
const filters = () => ({ allowed: S.project.allowed, noT2: S.project.noT2 });

function applyProject() {
  const p = S.project, f = filters();
  const res = D.resolveTargets(rows, f, +p.cost, +p.co2);
  S.prevPick = S.shownPick;
  S.applied = { f, res, maxCost: res.maxCost, maxCo2: res.maxCo2, requestedCost: res.requestedCost };
  S.override = null; S.adjustMessage = null;
  if (res.month !== null) {
    S.selMonth = res.month;
    const strat = D.strategies(rows, f, res.maxCost, res.maxCo2, res);
    if (strat && p.priority !== "earliest_opening") { const r = strat[p.priority]; S.override = r.id; S.selMonth = r.start; }
  }
  if (res.adjusted) { p.cost = res.maxCost; p.co2 = res.maxCo2; S.adjustMessage = res.message; }
  storeProject();
}

function pick() {
  const A = S.applied, res = A.res;
  if (res.month === null) return null;
  if (!res.monthsOk.includes(S.selMonth)) S.selMonth = res.month;
  let row;
  if (S.override !== null) row = rows[S.override];
  else if (S.selMonth === res.month) row = res.pick;
  else row = D.monthTable(rows, A.f, A.maxCost, A.maxCo2).find(m => m.month === S.selMonth).best;
  S.shownPick = row;
  return row;
}

function simulate(row) {
  if (S.simCache.has(row.id)) return S.simCache.get(row.id);
  const sim = engine.simulate({ start: row.start, delay: 0, caps: Object.fromEntries(RESOURCES.map(k => [k, row[k]])),
    allowInterruption: row.t2, carbonPrice: row.lowc ? 100 : 0 });
  const acc = engine.accounting(sim, true);
  const out = { sim, acc, ts: engine.timeseries(sim) };
  S.simCache.set(row.id, out);
  if (S.simCache.size > 4) S.simCache.delete(S.simCache.keys().next().value);
  return out;
}

function noPlanNotice() {
  return `<div class="notice warn">${esc(S.applied.res.message || "No tested plan meets your must haves.")}</div><a class="btn" href="#/project">✏️ Edit the project</a>`;
}
function adjustNotice() { return S.adjustMessage ? `<div class="notice info">ℹ️ Targets adjusted: ${esc(S.adjustMessage)}</div>` : ""; }
function earliestNotice() {
  const res = S.applied.res, e = res.month, others = res.monthsOk.filter(m => m !== e);
  let msg = `<b>Earliest opening that meets your targets: month ${e}</b>Full demand at month ${e + 10}.`;
  if (others.length) msg += ` Also possible: ${others.length > 1 ? "months" : "month"} ${D.monthRanges(others, universe)}.`;
  return `<div class="notice ok">${msg}</div>`;
}

// ---------- pages ----------
function home() {
  app.innerHTML = `
  <div class="hero-grid">
    <div>
      <div class="hero">
        <p class="eyebrow">The future needs power. You need a plan.</p>
        <h1>Build<br><em>what's next.</em></h1>
        <p>Bring a 75 MW campus to life.<br>Find the energy mix that gets you there.</p>
        <p class="foot">WILLIAMSON COUNTY, TEXAS · 120-MONTH PLAN</p>
      </div>
      <a class="btn primary block mt" href="#/project">Get started &nbsp;→</a>
    </div>
    <div class="art"><img src="assets/campus.svg" alt="Illustration of a data-center campus with solar, wind and grid connections"></div>
  </div>
  <div class="home-cards">
    <p class="eyebrow" style="margin:0">The right power.<br>On your terms.</p>
    <div class="card"><b>🕒 Move sooner.</b><div class="caption">The earliest opening month that meets your targets.</div></div>
    <div class="card"><b>💲 Spend smarter.</b><div class="caption">A cost ceiling in $/MWh, with every dollar counted.</div></div>
    <div class="card"><b>🌿 Go cleaner.</b><div class="caption">A carbon ceiling in kg CO2/MWh, checked hour by hour.</div></div>
  </div>
  <div class="card mt2">
    <p class="eyebrow" style="margin-top:0">How it works</p>
    <div class="grid g3">
      <div><b>134,966 workable plans</b><div class="caption">Every mix of wind, solar, nuclear, battery and onsite gas we tested, for every opening month from 14 to 109, simulated hour by hour over 10 years.</div></div>
      <div><b>Targets, not weights</b><div class="caption">Set a cost ceiling and a carbon ceiling. The planner returns the earliest opening month with a plan under both, plus the cheapest and cleanest alternatives.</div></div>
      <div><b>Every hour, in your browser</b><div class="caption">Pick any plan and the 87,600-hour dispatch runs right here, so you can drill into any month, day or grid stress event.</div></div>
    </div>
  </div>`;
}

function project() {
  const p = S.project;
  const revenue = 75 * p.rate * p.realization / 100;
  app.innerHTML = `
  ${heading("01 / Project brief", "Big ambitions.<br>A clear starting point.", "Your campus. Your requirements. The foundation for every power decision.")}
  <div id="saved"></div>
  <div class="row">
    <div><p class="eyebrow">Williamson County, Texas</p><h2>${esc(p.name)}</h2></div>
    <button class="btn" id="edit">✏️ Edit project</button>
  </div>
  <div class="grid g3 mt">
    <div class="card">💳 Cost ceiling<div class="big">$${n1(+p.cost)}<small> /MWh</small></div><div class="caption">Total decision cost · 120 months</div></div>
    <div class="card">🕒 Priority<div class="big">${PRIORITIES[p.priority]}</div><div class="caption">Opening: earliest month meeting both ceilings</div></div>
    <div class="card">🌿 Carbon ceiling<div class="big">${(+p.co2).toFixed(0)}<small> kg/MWh</small></div><div class="caption">Combined local + remote electricity</div></div>
  </div>
  ${adjustNotice()}
  <div class="grid g2 mt">
    <div class="card">
      <p class="eyebrow" style="margin-top:0">Built to scale</p><h3>Room for ambition.</h3>
      <div style="font-size:64px;font-weight:750;color:var(--blue);letter-spacing:-3px">75<small style="font-size:15px;color:var(--muted);letter-spacing:0"> MW peak demand</small></div>
      <div class="tbl-wrap"><table class="tbl"><tbody>
        ${[["Location", "Williamson County, TX"], ["Mean facility demand", "69 MW"], ["Annual energy at full operation", "604,440 MWh"],
          ["Onsite energy footprint", "8 acres"], ["Campus ready", "Month 14"], ["Initial operating load", "25 MW"],
          ["Commissioning ramp", "+5 MW / month"], ["Planning horizon", "120 months"]].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")}
      </tbody></table></div>
    </div>
    <div class="card">
      <p class="eyebrow" style="margin-top:0">Grid connection</p><h3>More power. Step by step.</h3>
      <div class="grid g4 mt">${[[0, 0], [18, 25], [24, 50], [30, 75]].map(([m, mw]) => `<div class="metric"><div class="lbl">${m ? "Month " + m : "Development start"}</div><div class="val">${mw} MW</div></div>`).join("")}</div>
      <p class="caption">One shared connection for wind, solar, nuclear and grid purchases. During grid stress events the limit drops to 60%.</p>
      <p class="eyebrow">Service and continuity</p>
      <ul>
        <li><b>Protected demand (Tier 0):</b> always served on campus</li>
        <li><b>Tier 2 work:</b> ${p.noT2 ? "never paused" : "may be paused in stress hours"}</li>
        <li><b>Grid connection delay:</b> 0 months</li>
        <li><b>Sources considered:</b> ${SOURCE_ORDER.filter(k => p.allowed.includes(k)).map(k => SHORT[k]).join(", ") || "none"}</li>
      </ul>
    </div>
  </div>
  <div class="card mt row">
    <div><p class="eyebrow" style="margin-top:0">The opportunity at full capacity</p><h3>75 MW. A bigger possibility.</h3>
      <div class="caption">$${n2(+p.rate)}M / MW-year · ${(+p.realization).toFixed(0)}% revenue realization</div></div>
    <div style="text-align:right"><div class="big" style="color:var(--blue)">${revenue >= 1000 ? "$" + n2(revenue / 1000) + "B" : "$" + n0(revenue) + "M"}</div><div class="caption">Potential annual revenue</div></div>
  </div>`;
  $("#edit").onclick = editProject;
  if (S.justSaved) {
    S.justSaved = false;
    $("#saved").innerHTML = `<div class="notice ok">Project saved. Your recommendations are ready. <a href="#/recommendations">See recommendations →</a></div>`;
  }
}

function editProject() {
  const p = S.project;
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal" role="dialog" aria-label="Your project">
    <div class="row"><h2 style="margin:0">Make it yours.</h2><button class="btn" data-close>✕</button></div>
    <p class="caption">Start from a preset, or set each value.</p>
    <div class="grid g3">${Object.entries(PRESETS).map(([n, [c, e]]) => `<button class="btn" data-preset="${n}">${n} · $${c} · ${e} kg</button>`).join("")}</div>
    <label class="field mt">Project name<input id="f-name" value="${esc(p.name)}"></label>
    <div class="grid g2">
      <label class="field">Cost ceiling<input id="f-cost" type="number" min="0" step="0.5" value="${p.cost}"><span class="caption">Total decision cost · $/MWh requested</span></label>
      <label class="field">Decision priority<select id="f-prio">${Object.entries(PRIORITIES).map(([k, v]) => `<option value="${k}" ${k === p.priority ? "selected" : ""}>${v}</option>`).join("")}</select><span class="caption">Which qualifying plan is selected first</span></label>
      <label class="field">Carbon ceiling<input id="f-co2" type="number" min="0" step="1" value="${p.co2}"><span class="caption">Combined operational CO2 · kg/MWh</span></label>
      <label class="field">Grid connection<select disabled><option>None (base case)</option></select><span class="caption">Delay to the grid upgrades</span></label>
      <label class="field">Annual revenue rate<input id="f-rate" type="number" min="0" step="0.5" value="${p.rate}"><span class="caption">$ million per MW of campus capacity</span></label>
      <label class="field">Revenue realization<input id="f-real" type="number" min="0" max="100" step="5" value="${p.realization}"><span class="caption">Percent of capacity earning this rate</span></label>
    </div>
    <h3 class="mt">Energy sources</h3><p class="caption">Choose the sources to consider for your portfolio.</p>
    <div class="grid g3">${SOURCE_ORDER.map(k => `<label class="card tight check"><input type="checkbox" data-src="${k}" ${p.allowed.includes(k) ? "checked" : ""}> ${ICONS[k]} ${SHORT[k]}</label>`).join("")}</div>
    <label class="check mt"><input type="checkbox" id="f-not2" ${p.noT2 ? "checked" : ""}> Never pause Tier 2 work</label>
    <div class="row mt"><span class="caption">Set the direction. We'll find the fit.</span><button class="btn primary" id="f-save">Save project →</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector("[data-close]").onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => {
    const [c, e] = PRESETS[b.dataset.preset];
    bg.querySelector("#f-cost").value = c; bg.querySelector("#f-co2").value = e;
    bg.querySelectorAll("[data-src]").forEach(x => x.checked = true); bg.querySelector("#f-not2").checked = false;
  });
  bg.querySelector("#f-save").onclick = () => {
    const num = (id, d) => { const v = parseFloat(bg.querySelector(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
    Object.assign(p, { name: bg.querySelector("#f-name").value.trim() || DEFAULT_PROJECT.name, cost: num("#f-cost", p.cost),
      co2: num("#f-co2", p.co2), priority: bg.querySelector("#f-prio").value, noT2: bg.querySelector("#f-not2").checked,
      allowed: RESOURCES.filter(k => bg.querySelector(`[data-src="${k}"]`).checked), rate: num("#f-rate", p.rate),
      realization: Math.min(100, num("#f-real", p.realization)) });
    applyProject(); close(); S.justSaved = true; project();
  };
}

const COPY = { earliest_opening: ["🕒", "Get a head start.", "Bring the campus online sooner and unlock more operating time."],
  lowest_cost: ["💲", "Make every dollar count.", "The lowest total cost among the plans that meet your targets."],
  cleanest: ["🌿", "Grow more. Emit less.", "The lowest carbon among the plans that meet your targets."] };
const pills = r => D.describe(r).split(", ").map(x => `<span class="pill">${x}</span>`).join("");

function recommendations() {
  const A = S.applied, res = A.res;
  let html = heading("02 / Your recommendations", "Three paths.<br>One powerful decision.", "Find your balance of cost, carbon and speed to power.");
  if (res.month === null) { app.innerHTML = html + noPlanNotice(); return; }
  const picked = pick(), strat = D.strategies(rows, A.f, A.maxCost, A.maxCo2, res);
  html += adjustNotice() + earliestNotice();
  html += `<p class="caption">All three plans meet $${n1(A.maxCost)}/MWh and ${A.maxCo2.toFixed(0)} kg CO2/MWh and every must have. Pick one; Demand profile and Export follow your choice.</p><div class="grid g3">`;
  for (const role of Object.keys(PRIORITIES)) {
    const r = strat[role], sel = r.id === picked.id, [icon, title, text] = COPY[role];
    html += `<div class="card">
      <p class="eyebrow" style="margin-top:0">${icon} ${PRIORITIES[role]} &nbsp; <span class="tag ${sel ? "" : "muted"}">${sel ? "✓ Selected" : "Option"}</span></p>
      <h3>${title}</h3><p class="caption">${text}</p><div>${pills(r)}</div>
      <div class="grid g3 mt">
        <div class="metric"><div class="lbl">Cost</div><div class="val sm">$${n1(r.cost)}</div></div>
        <div class="metric"><div class="lbl">Opening</div><div class="val sm">M${r.start}</div></div>
        <div class="metric"><div class="lbl">Carbon</div><div class="val sm">${r.co2.toFixed(0)}</div></div>
      </div>
      <p class="caption">$${n0(r.total / 1e6)} M total · ${(100 * r.clean).toFixed(0)}% clean · full demand M${r.full}</p>
      <button class="btn block ${sel ? "primary" : ""}" data-choose="${r.id}" ${sel ? "disabled" : ""}>${sel ? "Your selected plan ✓" : "Choose this plan →"}</button>
    </div>`;
  }
  html += `</div>
  <div class="card mt"><p class="eyebrow" style="margin-top:0">Your selected plan</p><b>${D.describe(picked)}</b>, opening month ${picked.start}
    ${S.prevPick ? `<div class="caption">${esc(D.explainChange(S.prevPick, picked, "your previous plan"))}</div>` : ""}</div>
  <div class="grid g2 mt">
    <a class="card" href="#/demand-profile" style="text-decoration:none;color:inherit"><p class="eyebrow" style="margin-top:0">Demand profile</p><b>See every hour in action.</b> Supply, cost, carbon and grid stress. <span style="color:var(--blue)">Open ↗</span></a>
    <a class="card" href="#/export" style="text-decoration:none;color:inherit"><p class="eyebrow" style="margin-top:0">Ready to decide?</p><b>Take it with you.</b> Portfolio, hourly dispatch and a results summary. <span style="color:var(--blue)">Go to Export ↗</span></a>
  </div>
  <p class="mt"><a href="#/project">✏️ Edit the project requirements</a></p>`;
  app.innerHTML = html;
  app.querySelectorAll("[data-choose]").forEach(b => b.onclick = () => {
    const r = rows[+b.dataset.choose]; S.prevPick = S.shownPick; S.override = r.id; S.selMonth = r.start; recommendations();
  });
}

// ---------- demand profile ----------
const STACK = [["wind", "Wind", "#2a78d6"], ["solar", "Solar", "#eda100"], ["nuclear", "Nuclear", "#1baf7a"], ["battery", "Battery", "#6250d6"],
  ["gas", "Gas", "#eb6834"], ["grid", "Grid power", "#898781"], ["moved", "Tier 1 moved", "#e87ba4"], ["paused", "Tier 2 paused", "#e34948"]];
const lineLegend = `<span><i style="background:none;border-top:2px dashed #52514e;border-radius:0;height:0;width:14px"></i>Grid limit</span><span><i style="background:none;border-top:2px solid #3d3d3a;border-radius:0;height:0;width:14px"></i>Demand</span>`;
const legendHtml = () => STACK.map(s => `<span><i style="background:${s[2]}"></i>${s[1]}</span>`).join("") + lineLegend;

function sidebar() {
  const p = S.project, A = S.applied;
  const rg = D.targetRanges(rows, A.f) || { costMin: 20, costMax: 150, co2Min: 0, co2Max: 400 };
  const cMin = Math.min(rg.costMin, p.cost), cMax = Math.max(rg.costMax, p.cost), eMin = Math.min(rg.co2Min, p.co2), eMax = Math.max(rg.co2Max, p.co2);
  return `<aside class="side card">
    <h3 style="margin-top:0">Presets</h3>
    <div class="grid g3">${Object.keys(PRESETS).map(n => `<button class="btn" data-sp="${n}">${n}</button>`).join("")}</div>
    <h3>Your targets</h3>
    <div class="range-head">Cost at most <span id="v-cost">$${n1(+p.cost)}/MWh</span></div>
    <input type="range" id="s-cost" min="${cMin}" max="${cMax}" step="0.5" value="${p.cost}">
    <div class="range-head mt">Carbon at most <span id="v-co2">${(+p.co2).toFixed(0)} kg</span></div>
    <input type="range" id="s-co2" min="${eMin}" max="${eMax}" step="1" value="${p.co2}">
    <h3>Must haves</h3><p class="caption">Hard requirements. Plans that break any of these are removed.</p>
    ${RESOURCES.map(k => `<label class="check"><input type="checkbox" data-ss="${k}" ${p.allowed.includes(k) ? "checked" : ""}> ${SOURCES[k]}</label>`).join("")}
    <label class="check"><input type="checkbox" id="s-not2" ${p.noT2 ? "checked" : ""}> Never pause Tier 2 work</label>
    <button class="btn primary block mt" id="s-apply">Apply</button>
  </aside>`;
}

function bindSidebar() {
  const p = S.project;
  $("#s-cost").oninput = e => $("#v-cost").textContent = `$${n1(+e.target.value)}/MWh`;
  $("#s-co2").oninput = e => $("#v-co2").textContent = `${(+e.target.value).toFixed(0)} kg`;
  app.querySelectorAll("[data-sp]").forEach(b => b.onclick = () => {
    const [c, e] = PRESETS[b.dataset.sp]; Object.assign(p, { cost: c, co2: e, allowed: [...RESOURCES], noT2: false }); applyProject(); demandProfile();
  });
  $("#s-apply").onclick = () => {
    Object.assign(p, { cost: +$("#s-cost").value, co2: +$("#s-co2").value, noT2: $("#s-not2").checked,
      allowed: RESOURCES.filter(k => app.querySelector(`[data-ss="${k}"]`).checked) });
    applyProject(); demandProfile();
  };
}

function demandProfile() {
  killCharts();
  const A = S.applied, res = A.res;
  let main = heading("03 / Demand profile", "Every hour.<br>Every possibility.", "Explore supply, cost, carbon and the hours when the grid tightens.");
  if (res.month === null) {
    app.innerHTML = `<div class="dp">${sidebar()}<div>${main}${noPlanNotice()}</div></div>`; bindSidebar(); return;
  }
  const picked = pick(), pm = picked.start, e = res.pick;
  main += adjustNotice() + earliestNotice();
  if (pm > res.month) {
    const n = pm - res.month;
    main += `<p>You chose month ${pm}, ${n} month${n !== 1 ? "s" : ""} later than the earliest. Cost $${n1(picked.cost)}/MWh vs $${n1(e.cost)}, carbon ${picked.co2.toFixed(0)} kg vs ${e.co2.toFixed(0)} kg.</p>`;
  }
  if (res.monthsOk.length > 1) {
    const i = res.monthsOk.indexOf(pm);
    main += `<div class="card tight"><div class="range-head">Opening month <span id="v-month">Month ${pm}</span></div>
      <input type="range" id="w-month" min="0" max="${res.monthsOk.length - 1}" step="1" value="${Math.max(i, 0)}">
      <div class="row caption"><span>Month ${res.monthsOk[0]}</span><span>Month ${res.monthsOk[res.monthsOk.length - 1]}</span></div></div>`;
  }
  main += `<div class="grid g5 mt">
    ${metric("Open / full demand (months)", `${pm} / ${picked.full}`)}
    ${metric("Cost ($/MWh)", `$${n1(picked.cost)}`, `target $${n1(A.maxCost)} · $${n0(picked.total / 1e6)} M total`)}
    ${metric("Carbon (kg CO2/MWh)", picked.co2.toFixed(0), `target ${A.maxCo2.toFixed(0)} kg · ${n0(picked.co2t / 1e3)} kt total`)}
    ${metric("Clean share", `${(100 * picked.clean).toFixed(0)}%`)}
    ${metric("Moved / paused (MWh)", `${n0(picked.moved)} / ${n0(picked.paused)}`)}
  </div>
  <div class="section-title">Every opening month at your carbon target</div>
  <div class="card"><div class="chart-box"><canvas id="c-months"></canvas></div>
    <p class="caption">Cheapest plan under ${A.maxCo2.toFixed(0)} kg CO2/MWh for each opening month. Green meets the cost target, gray does not. Click a green point to show that month. The large marker marks the month shown (month ${pm}).</p></div>
  <div class="section-title">The mix (MW)</div>
  <div class="card">${mixBars(picked)}</div>
  <div class="section-title">What changed and why</div>
  <div class="notice info">${S.prevPick ? esc(D.explainChange(S.prevPick, picked, "your previous plan")) : "This is your first plan. Apply new targets to see what changes."}</div>
  <div class="section-title">Power supply over time</div>
  <div class="card" id="drill"><div class="row"><b id="d-title">10 years</b><span class="crumbs" id="d-crumbs"></span></div>
    <div class="legend">${legendHtml()}</div><div class="chart-box tall"><canvas id="c-drill"></canvas></div>
    <p class="caption">Click a bar to open it (10 years → month → day → hours). Use the links above to go back. Red shading = grid stress hours.</p></div>
  <div class="section-title">Worst grid stress event</div><div id="stress"></div>
  <div class="section-title">Alternatives for opening month ${pm}</div><div id="alts"></div>
  <details class="how" id="how"><summary>How the numbers are calculated</summary><div class="body" id="how-body"></div></details>`;
  app.innerHTML = `<div class="dp">${sidebar()}<div>${main}</div></div>`;
  bindSidebar();
  const wm = $("#w-month");
  if (wm) {
    wm.oninput = () => $("#v-month").textContent = `Month ${res.monthsOk[+wm.value]}`;
    wm.onchange = () => { S.prevPick = S.shownPick; S.selMonth = res.monthsOk[+wm.value]; S.override = null; demandProfile(); };
  }
  monthsChart(picked);
  alternativesHtml(picked);
  // the hourly simulation takes a moment; let the page paint first
  setTimeout(() => {
    const { ts, acc, sim } = simulate(picked);
    drilldown(ts);
    stressEvent(ts);
    const how = $("#how");
    let built = false;
    how.ontoggle = () => { if (how.open && !built) { built = true; howNumbers(picked, acc, sim); } };
  }, 30);
}

function mixBars(r) {
  const mix = SOURCE_ORDER.filter(k => r[k] > 0);
  if (!mix.length) return "Grid power only. No energy resources are built.";
  const mx = Math.max(...mix.map(k => r[k]));
  return mix.map(k => `<div class="mix-row"><span>${SOURCES[k]}</span><div class="mix-bar" style="width:${(100 * r[k] / mx).toFixed(1)}%;background:${COLORS[k]}">${r[k]} MW</div></div>`).join("");
}

const hline = (id, items) => ({ id, afterDatasetsDraw(c) {
  const { ctx, chartArea: a, scales: { y } } = c; ctx.save();
  for (const it of items) {
    const py = y.getPixelForValue(it.y); if (py < a.top || py > a.bottom) continue;
    ctx.strokeStyle = it.color; ctx.setLineDash(it.dash); ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = it.color; ctx.font = "12px Inter, sans-serif"; ctx.textAlign = "right"; ctx.fillText(it.text, a.right - 4, py - 5);
  }
  ctx.restore();
} });

function monthsChart(picked) {
  const A = S.applied, res = A.res;
  const ok = D.monthTable(rows, A.f, A.maxCost, A.maxCo2).filter(m => m.best);
  if (!ok.length) { $("#c-months").parentElement.innerHTML = "<p class='caption'>No opening month has a plan under the carbon target.</p>"; return; }
  const lines = [{ y: A.maxCost, color: "#52514e", dash: [6, 4], text: `Cost target $${n1(A.maxCost)}` }];
  if (A.requestedCost !== A.maxCost) lines.push({ y: A.requestedCost, color: "#a9a79f", dash: [2, 3], text: `Requested $${n1(A.requestedCost)}` });
  const chosen = ok.map(m => m.month === picked.start);
  const c = new Chart($("#c-months"), {
    type: "line",
    data: { labels: ok.map(m => m.month), datasets: [{ data: ok.map(m => m.best.cost), borderColor: "#898781", borderWidth: 1.5,
      pointRadius: chosen.map(x => (x ? 9 : 4)), pointHoverRadius: 8,
      pointBackgroundColor: ok.map(m => (m.meetsBoth ? "#0ca30c" : "#898781")),
      pointBorderColor: chosen.map(x => (x ? "#3d3d3a" : "transparent")), pointBorderWidth: chosen.map(x => (x ? 2 : 0)) }] },
    plugins: [hline("targets", lines)],
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: i => `Opening month ${ok[i[0].dataIndex].month}`,
        label: i => { const b = ok[i.dataIndex].best; return [`$${n1(b.cost)}/MWh`, D.describe(b), `${b.co2.toFixed(0)} kg CO2/MWh`, `${(b.served / 1e6).toFixed(2)} TWh served`]; } } } },
      scales: { x: { title: { display: true, text: "Opening month" }, grid: { display: false } }, y: { title: { display: true, text: "$/MWh" }, grid: { color: "#eceae4" } } },
      onClick: (ev, els) => {
        if (!els.length) return;
        const m = ok[els[0].index].month;
        if (res.monthsOk.includes(m)) { S.prevPick = S.shownPick; S.selMonth = m; S.override = null; demandProfile(); }
        else toast(`Month ${m} does not meet your targets`);
      } } });
  charts.push(c);
}

function drilldown(D_) {
  const N = D_.N, MH = 730;
  let st = { lvl: "years" }, chart;
  function agg(lo, hi, lim) {
    const r = {};
    for (const s of STACK) { let t = 0; for (let h = lo; h < hi; h++) t += D_[s[0]][h]; r[s[0]] = t / (hi - lo); }
    let L = 0, mx = 0, stress = 0;
    for (let h = lo; h < hi; h++) { L += D_.load[h]; mx = Math.max(mx, D_[lim][h]); if (D_.stress[h] && D_.load[h] > 0) stress = 1; }
    r.load = L / (hi - lo); r.limit = mx; r.stress = stress; return r;
  }
  function rowsFor() {
    const out = [];
    if (st.lvl === "years") for (let m = 0; m < N / MH; m++) { const r = agg(m * MH, (m + 1) * MH, "ordinary_limit"); r.label = "Month " + m; r.tick = m % 12 === 0 ? "Year " + (m / 12 + 1) : ""; out.push(r); }
    else if (st.lvl === "month") {
      const d0 = Math.floor(st.m * MH / 24), d1 = Math.floor(((st.m + 1) * MH - 1) / 24);
      for (let d = d0; d <= d1; d++) { const lo = d * 24, hi = Math.min(N, lo + 24), r = agg(lo, hi, "ordinary_limit"); r.label = `Month ${st.m}, day ${d - d0 + 1}`; r.tick = String(d - d0 + 1); r.lo = lo; out.push(r); }
    } else for (let h = st.lo; h < Math.min(st.lo + 24, N); h++) { const r = agg(h, h + 1, "limit"), hr = D_.hod[h]; r.label = (hr < 10 ? "0" : "") + hr + ":00"; r.tick = r.label; out.push(r); }
    return out;
  }
  const shade = { id: "shade", beforeDatasetsDraw(c) {
    const R = c.$rows; if (!R) return;
    const { ctx, chartArea: a, scales: { x } } = c;
    const w = R.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : a.right - a.left;
    ctx.save(); ctx.fillStyle = "rgba(227,73,72,0.12)";
    R.forEach((r, i) => { if (r.stress) ctx.fillRect(x.getPixelForValue(i) - w / 2, a.top, w, a.bottom - a.top); });
    ctx.restore();
  } };
  function crumbs() {
    let t = "10 years (average MW per month)", c = "";
    if (st.lvl !== "years") { c = '<span data-l="years">10 years</span>'; t = `Month ${st.m} (average MW per day)`; }
    if (st.lvl === "day") { c += ` › <span data-l="month">Month ${st.m}</span>`; t = `Month ${st.m}, day ${st.d} (MW each hour)`; }
    $("#d-title").textContent = t; const el = $("#d-crumbs"); el.innerHTML = c;
    el.querySelectorAll("span").forEach(x => x.onclick = () => { st = x.dataset.l === "years" ? { lvl: "years" } : { lvl: "month", m: st.m }; draw(); });
  }
  function draw() {
    const R = rowsFor();
    const ds = STACK.map(s => ({ type: "bar", label: s[1], data: R.map(r => +r[s[0]].toFixed(2)), backgroundColor: s[2], stack: "s", barPercentage: 0.95, categoryPercentage: 0.95 }));
    ds.unshift({ type: "line", label: "Demand", stack: "demand", data: R.map(r => +r.load.toFixed(2)), borderColor: "#3d3d3a", borderWidth: 1.5, pointRadius: 0, tension: 0.2, order: 0 });
    ds.unshift({ type: "line", label: "Grid limit", stack: "limit", data: R.map(r => r.limit), borderColor: "#52514e", borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, stepped: "middle", order: 0 });
    if (chart) { charts = charts.filter(c => c !== chart); chart.destroy(); }
    chart = new Chart($("#c-drill"), { data: { labels: R.map(r => r.label), datasets: ds }, plugins: [shade],
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 200 }, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { filter: i => Math.abs(i.parsed.y) > 0.005, callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} MW` } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { color: "#898781", maxRotation: 0, autoSkip: st.lvl !== "years", callback: (v, i) => R[i].tick } },
          y: { stacked: true, min: 0, suggestedMax: 80, grid: { color: "#eceae4" }, ticks: { color: "#898781", callback: v => v + " MW" } } },
        onClick: (ev, els) => {
          const p = chart.getElementsAtEventForMode(ev, "index", { intersect: false }, false); if (!p.length) return;
          const i = p[0].index;
          if (st.lvl === "years") st = { lvl: "month", m: i };
          else if (st.lvl === "month") st = { lvl: "day", m: st.m, d: i + 1, lo: R[i].lo };
          else return;
          draw();
        } } });
    chart.$rows = R; charts.push(chart); crumbs();
  }
  draw();
}

function stressEvent(ts) {
  const el = $("#stress"), pad = 3, N = ts.N;
  const idx = []; for (let t = 0; t < N; t++) if (ts.stress[t] && ts.load[t] > 0) idx.push(t);
  if (!idx.length) { el.innerHTML = "<p class='caption'>This plan has no grid stress event hours.</p>"; return; }
  const events = [[idx[0]]];
  for (let i = 1; i < idx.length; i++) { if (idx[i] - idx[i - 1] > 1) events.push([]); events[events.length - 1].push(idx[i]); }
  const weight = e => e.reduce((s, t) => s + (ts.moved[t] + ts.paused[t]) * 1000 + ts.load[t], 0);
  const ev = events.reduce((a, b) => (weight(b) > weight(a) ? b : a));
  const lo = Math.max(0, ev[0] - pad), hi = Math.min(N, ev[ev.length - 1] + pad + 1), H = [];
  for (let t = lo; t < hi; t++) H.push(t);
  const inside = H.filter(t => ts.stress[t]);
  const imports = inside.map(t => ts.wind[t] + ts.solar[t] + ts.nuclear[t] + ts.grid[t]);
  const sum = (arr, k) => arr.reduce((s, t) => s + ts[k][t], 0);
  el.innerHTML = `<div class="grid g4">
      ${metric("Grid limit during event", `${n1(Math.min(...inside.map(t => ts.limit[t])))} MW`)}
      ${metric("Highest import", `${n1(Math.max(...imports))} MW`)}
      ${metric("Tier 0 served", "100%")}
      ${metric("Moved / paused in event (MWh)", `${n0(sum(inside, "moved"))} / ${n0(sum(inside, "paused"))}`)}
    </div>
    <div class="card mt"><div class="legend">${legendHtml().replace("Demand", "Tier 0 demand")}</div><div class="chart-box tall"><canvas id="c-stress"></canvas></div>
    <p class="caption">Wind, solar, nuclear and grid power are the imports that count against the grid limit. Shaded hours are the stress event (grid limit 60%).</p></div>`;
  let wrapped = false;
  const labels = H.map((t, i) => { if (i && ts.hod[t] < ts.hod[H[i - 1]]) wrapped = true; const h = ts.hod[t]; return `${h < 10 ? "0" : ""}${h}:00${wrapped ? " (next day)" : ""}`; });
  const shade = { id: "shade2", beforeDatasetsDraw(c) {
    const { ctx, chartArea: a, scales: { x } } = c, w = x.getPixelForValue(1) - x.getPixelForValue(0);
    ctx.save(); ctx.fillStyle = "rgba(227,73,72,0.12)";
    H.forEach((t, i) => { if (ts.stress[t]) ctx.fillRect(x.getPixelForValue(i) - w / 2, a.top, w, a.bottom - a.top); });
    ctx.restore();
  } };
  const ds = STACK.map(s => ({ type: "bar", label: s[1], data: H.map(t => +ts[s[0]][t].toFixed(2)), backgroundColor: s[2], stack: "s" }));
  ds.unshift({ type: "line", label: "Tier 0 demand", stack: "demand", data: H.map(t => +ts.tier0[t].toFixed(2)), borderColor: "#3d3d3a", borderWidth: 1.5, pointRadius: 0, order: 0 });
  ds.unshift({ type: "line", label: "Grid limit", stack: "limit", data: H.map(t => +ts.limit[t].toFixed(2)), borderColor: "#52514e", borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, stepped: "middle", order: 0 });
  charts.push(new Chart($("#c-stress"), { data: { labels, datasets: ds }, plugins: [shade],
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { filter: i => Math.abs(i.parsed.y) > 0.005, callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} MW` } } },
      scales: { x: { stacked: true, grid: { display: false }, title: { display: true, text: "Hour of day (local)" } }, y: { stacked: true, min: 0, grid: { color: "#eceae4" }, ticks: { callback: v => v + " MW" } } } } }));
}

function alternativesHtml(picked) {
  const alts = D.alternatives(rows, S.applied.f, picked);
  const change = p => (p === null || Math.abs(p) < 0.05 ? `<span class="caption">same as the pick</span>` : `<span class="${p > 0 ? "up" : "down"}">${p > 0 ? "+" : ""}${p.toFixed(1)}% vs pick</span>`);
  const TITLES = { A: "Same opening, different mix", B: "Move the opening month" };
  let html = "";
  for (const g of ["A", "B"]) {
    if (!alts[g].length) continue;
    html += `<h3 class="mt">${TITLES[g]}</h3><div class="grid g3">` + alts[g].map(c => {
      const r = c.row, mv = c.monthsVsStart;
      let timing = `Open M${r.start} to full M${r.full}`;
      if (mv) timing += ` (${Math.abs(mv)} month${Math.abs(mv) !== 1 ? "s" : ""} ${mv < 0 ? "sooner" : "later"})`;
      return `<div class="card"><span class="pill">${c.label}</span><p><b>${c.plan}</b></p><div>${timing}</div>
        <div>Cost: <b>$${n1(r.cost)}/MWh</b> ${change(c.costVs)}</div><div>Carbon: <b>${r.co2.toFixed(0)} kg CO2/MWh</b> ${change(c.co2Vs)}</div>
        <p class="caption">${esc(c.note)}</p>
        ${g === "A" ? `<button class="btn" data-use="${r.id}" ${r.id === picked.id ? "disabled" : ""}>Use this plan</button>` : ""}</div>`;
    }).join("") + "</div>";
  }
  $("#alts").innerHTML = html;
  app.querySelectorAll("[data-use]").forEach(b => b.onclick = () => { S.prevPick = S.shownPick; S.override = +b.dataset.use; demandProfile(); });
}

function segColor(name) {
  const n = name.toLowerCase();
  for (const [k, c] of [["wind", "#2a78d6"], ["solar", "#eda100"], ["nuclear", "#1baf7a"], ["battery", "#6250d6"], ["gas", "#eb6834"],
    ["fuel", "#eb6834"], ["grid", "#898781"], ["tier", "#e87ba4"], ["remote", "#e87ba4"]]) if (n.includes(k)) return c;
  return "#c3c1b9";
}
function stackBar(items) {
  const total = items.reduce((s, [, v]) => s + v, 0) || 1;
  return `<div class="stackbar">${items.map(([n, v]) => `<div style="width:${(100 * v / total).toFixed(2)}%;background:${segColor(n)}" title="${esc(n)}">${v / total >= 0.1 ? esc(n) : ""}</div>`).join("")}</div>`;
}

function howNumbers(picked, acc, sim) {
  const A = S.applied, why = D.whySources(rows, A.f, picked, A.maxCost, A.maxCo2, maxMw);
  const df = sim.df, sum = a => a.reduce((s, v) => s + v, 0);
  const served = acc.local_served_mwh, remote = acc.remote_electricity_mwh;
  const L = Object.fromEntries(acc.ledger.map(l => [l.k, l]));
  const costRows = RESOURCES.filter(k => picked[k]).map(k => [D.NAME[k], picked[k], L[k].from, L[k].fixed, L[k].payment, L[k].fuel, L[k].total]);
  costRows.push(["Grid power (merchant)", null, null, 0, acc.merchant_cost_usd, 0, acc.merchant_cost_usd]);
  costRows.push(["Tier 1 work moved to remote site", null, null, 0, acc.relocation_cost_usd, 0, acc.relocation_cost_usd]);
  costRows.push(["Tier 2 work paused", null, null, 0, acc.interruption_consequence_usd, 0, acc.interruption_consequence_usd]);
  const co2Rows = RESOURCES.filter(k => picked[k] && engine.catalog[k].kind !== "storage").map(k => [D.NAME[k], L[k].gen, engine.catalog[k].co2_t_per_mwh, L[k].co2]);
  const gridMwh = acc.merchant_mwh, gridCo2 = acc.local_operational_co2_t - co2Rows.reduce((s, r) => s + r[3], 0);
  co2Rows.push(["Grid power (merchant)", gridMwh, gridMwh ? gridCo2 / gridMwh : 0, gridCo2]);
  co2Rows.push(["Remote site (moved work)", remote, remote ? acc.remote_operational_co2_t / remote : 0, acc.remote_operational_co2_t]);
  const energy = RESOURCES.filter(k => picked[k]).map(k => [D.NAME[k], 100 * (k === "battery_4h" ? sum(df.battery_4h_discharge_mw) : L[k].gen) / served]);
  energy.push(["Grid power (merchant)", 100 * gridMwh / served]);
  const matches = Math.abs(acc.decision_cost_usd_per_requested_mwh - picked.cost) < 0.01 && Math.abs(acc.combined_electricity_co2_kg_per_mwh - picked.co2) < 0.01;
  const M = v => (v === null ? "" : n2(v / 1e6));
  const whyCard = w => `<div class="card tight mt"><b>${D.NAME[w.k]}</b><div class="${w.good ? "down" : ""}">${esc(w.verdict)}</div>
    ${w.result ? `<div class="caption">${esc(w.result)}</div>` : ""}<div class="caption">Role: ${esc(D.ROLE[w.k])}</div></div>`;
  $("#how-body").innerHTML = `
    <h3>Why these sources</h3>
    <p class="caption">Each source is tested by changing only that source: removing it if the plan uses it, or adding it if not, and comparing with the closest tested plan.</p>
    <div class="grid g2"><div><b>In the plan</b>${why.filter(w => w.used).map(whyCard).join("") || "<p class='caption'>None.</p>"}</div>
      <div><b>Not in the plan</b>${why.filter(w => !w.used).map(whyCard).join("") || "<p class='caption'>None.</p>"}</div></div>
    <h3 class="mt2">How this works</h3>
    <ul>
      <li><b>You set two targets</b>: the most you will pay per MWh and the most carbon per MWh.</li>
      <li><b>Must haves filter the plans.</b> Allowed energy sources and no Tier 2 pausing are hard requirements. A plan that breaks any of them is removed.</li>
      <li><b>The planner returns the earliest opening month</b> with a tested plan under both targets, and the cheapest such plan in that month. Later months that also work are on the opening month slider.</li>
      <li><b>Every plan was simulated hour by hour</b> for 87,600 hours (10 years). This page re-runs the chosen plan in your browser and checks it against the results table.</li>
      <li><b>Alternatives.</b> A: same opening month, a different mix. B: move the opening month.</li>
    </ul>
    <h3 class="mt2">What each headline number is made of</h3>
    <div class="row"><b>Cost per MWh</b><b>$${n1(acc.decision_cost_usd_per_requested_mwh)}/MWh</b></div>
    ${stackBar(costRows.filter(r => r[6] > 0).map(r => [r[0], r[6]]))}
    <p class="caption">$${n1(acc.total_decision_cost_usd / 1e6)}M ÷ ${n0(acc.requested_mwh)} MWh requested = $${n2(acc.decision_cost_usd_per_requested_mwh)}/MWh</p>
    <div class="row"><b>Carbon per MWh</b><b>${n1(acc.combined_electricity_co2_kg_per_mwh)} kg CO2/MWh</b></div>
    ${stackBar(co2Rows.filter(r => r[3] > 0).map(r => [r[0], r[3]]))}
    <p class="caption">${n0(acc.combined_operational_co2_t)} t ÷ ${n0(served + remote)} MWh × 1000 = ${n1(acc.combined_electricity_co2_kg_per_mwh)} kg CO2/MWh</p>
    <div class="row"><b>Clean share</b><b>${(100 * acc.clean_energy_share).toFixed(0)}%</b></div>
    ${stackBar(energy.filter(r => r[1] > 0))}
    <p class="caption">(wind + solar + nuclear + battery out − battery in) ÷ served MWh = ${n1(100 * acc.clean_energy_share)}%</p>
    <div class="row"><b>Moved / paused</b><b>${n0(acc.relocated_local_equivalent_mwh)} / ${n0(acc.interrupted_mwh)} MWh</b></div>
    <p class="caption">Only in grid stress hours: moved work costs $123.50/MWh, paused work $1,000/MWh; both are included in the cost.</p>
    <h3 class="mt2">Cost calculation</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th>MW</th><th>Charged from month</th><th>Capacity charges $M</th><th>Energy or contract $M</th><th>Fuel $M</th><th>Total $M</th></tr></thead><tbody>
      ${costRows.map(r => `<tr><td>${r[0]}</td><td>${r[1] ?? ""}</td><td>${r[2] ?? ""}</td><td>${M(r[3])}</td><td>${M(r[4])}</td><td>${M(r[5])}</td><td>${M(r[6])}</td></tr>`).join("")}
      <tr class="total"><td>Total</td><td></td><td></td>${[3, 4, 5, 6].map(j => `<td>${M(costRows.reduce((s, r) => s + r[j], 0))}</td>`).join("")}</tr>
    </tbody></table></div>
    <p class="caption">Equipment is charged every hour from its start month to month 120; wind, solar and nuclear are paid on all available output; gas pays running cost plus fuel; grid power pays the hourly price plus $20/MWh.</p>
    <h3 class="mt2">CO2 calculation</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Source</th><th>MWh</th><th>Factor t CO2/MWh</th><th>Tonnes CO2</th></tr></thead><tbody>
      ${co2Rows.map(r => `<tr><td>${r[0]}</td><td>${n0(r[1])}</td><td>${r[2].toFixed(3)}</td><td>${n0(r[3])}</td></tr>`).join("")}
      <tr class="total"><td>Total</td><td>${n0(co2Rows.reduce((s, r) => s + r[1], 0))}</td><td></td><td>${n0(co2Rows.reduce((s, r) => s + r[3], 0))}</td></tr>
    </tbody></table></div>
    <p>÷ ${n0(served + remote)} MWh × 1000 = ${n1(acc.combined_electricity_co2_kg_per_mwh)} kg CO2/MWh</p>
    <p class="caption">Wind, solar, nuclear and the battery count as zero. Gas factor = heat rate × 117 lb CO2/MMBtu. Grid and remote site factors fall 3% a year.</p>
    ${matches ? `<p class="down"><b>✓ Matches the results table</b></p>` : `<p class="up">The browser simulation differs from the results table for this plan.</p>`}`;
}

// ---------- export ----------
function exportPage() {
  const A = S.applied;
  let html = heading("04 / Your decision", "From a clear choice<br>to the next move.", "Your selected portfolio, ready to take with you.");
  if (A.res.month === null) { app.innerHTML = html + noPlanNotice(); return; }
  const r = pick();
  html += `<div class="card row"><div><p class="eyebrow" style="margin-top:0">Your selected plan</p><h2>${D.describe(r)}</h2></div>
    <div><span class="pill">$${n0(r.total / 1e6)}M total cost</span><span class="pill">Opens M${r.start}</span><span class="pill">Full demand M${r.full}</span> <a href="#/recommendations">Compare plans ↗</a></div></div>
  <div class="section-title">Your choice in numbers.</div>
  <div class="grid g5">${metric("Cost", `$${n1(r.cost)}/MWh`)}${metric("Total cost", `$${n0(r.total / 1e6)} M`)}${metric("Carbon", `${r.co2.toFixed(0)} kg CO2/MWh`)}${metric("Clean share", `${(100 * r.clean).toFixed(0)}%`)}${metric("Initial / full", `M${r.start} / M${r.full}`)}</div>
  <div class="grid g2 mt">
    <div class="card"><p class="eyebrow" style="margin-top:0">Your complete power plan</p><h3>Ready for the next conversation.</h3>
      <p>Download the portfolio, the hourly dispatch for all 87,600 hours, and a results summary.</p>
      <button class="btn primary block" id="x-portfolio">Download portfolio.json</button>
      <button class="btn block mt" id="x-dispatch">Download dispatch.csv (87,600 hours)</button>
      <button class="btn block mt" id="x-summary">Download summary.md</button>
      <p class="caption" id="x-status"></p></div>
    <div class="card"><p class="eyebrow" style="margin-top:0">What's inside</p>
      <p><b>01 · Your selected portfolio</b><br><span class="caption">portfolio.json: capacities, opening month and grid delay.</span></p>
      <p><b>02 · Every hour accounted for</b><br><span class="caption">dispatch.csv: 87,600 hours of supply and dispatch, simulated in your browser.</span></p>
      <p><b>03 · The numbers behind the choice</b><br><span class="caption">summary.md: horizon and annual cost, carbon and continuity, plus the capacity cost ledger.</span></p></div>
  </div>`;
  app.innerHTML = html;
  const portfolio = { initial_service_month: r.start, grid_delay_months: 0, capacities_mw: Object.fromEntries(RESOURCES.map(k => [k, r[k]])) };
  $("#x-portfolio").onclick = () => download("portfolio.json", JSON.stringify(portfolio, null, 2), "application/json");
  const busy = (msg, fn) => { $("#x-status").textContent = msg; setTimeout(() => { fn(); $("#x-status").textContent = ""; }, 30); };
  $("#x-dispatch").onclick = () => busy("Simulating 87,600 hours…", () => {
    const { sim } = simulate(r), df = sim.df, lines = [DISPATCH_COLUMNS.join(",")];
    for (let t = 0; t < engine.N; t++) lines.push(t + "," + DISPATCH_COLUMNS.slice(1).map(c => df[c][t].toFixed(10)).join(","));
    download("dispatch.csv", lines.join("\n") + "\n", "text/csv");
  });
  $("#x-summary").onclick = () => busy("Building the summary…", () => download("summary.md", summaryMd(r), "text/markdown"));
}

function summaryMd(row) {
  const { sim, acc } = simulate(row), ctx = sim.ctx, df = sim.df, N = engine.N, cat = engine.catalog;
  let stressN = 0, maxImp = 0, limLo = Infinity, limHi = 0, tier0ok = true;
  for (let t = 0; t < N; t++) {
    if (ctx.load[t] - df.tier1_relocated_mw[t] - df.tier2_curtailed_mw[t] < ctx.tier0[t] - 1e-6) tier0ok = false;
    if (!(ctx.active[t] && ctx.load[t] > 0)) continue;
    stressN++;
    maxImp = Math.max(maxImp, df.grid_mw[t] + df.utility_solar_mw[t] + df.wind_mw[t] + df.nuclear_mw[t]);
    limLo = Math.min(limLo, ctx.limit[t]); limHi = Math.max(limHi, ctx.limit[t]);
  }
  const land = RESOURCES.reduce((s, k) => s + row[k] * (cat[k].land_acres_per_mw || 0), 0);
  const a = acc, L = [
    "# Results summary", "",
    `**Portfolio:** ${D.describe(row)}`,
    `**Initial service:** month ${row.start}  |  **Full demand:** month ${row.full}  |  **Grid delay:** 0 months`,
    `**Dispatch mode:** ${row.lowc ? "low carbon" : "lowest cost"}; Tier 2 interruption ${row.t2 ? "allowed in stress hours" : "not used"}`,
    `**Onsite land used:** ${land.toFixed(2)} of 8 acres`, "",
    "## Horizon results (months 0 to 120)", "", "| Metric | Value |", "| --- | --- |",
    `| Requested demand | ${n0(a.requested_mwh)} MWh |`,
    `| Served locally | ${n0(a.local_served_mwh)} MWh |`,
    `| Relocated (Tier 1, local equivalent) | ${n0(a.relocated_local_equivalent_mwh)} MWh |`,
    `| Interrupted (Tier 2) | ${n0(a.interrupted_mwh)} MWh |`,
    `| Local energy cost | $${n0(a.local_energy_cost_usd)} ($${n2(a.local_energy_cost_usd_per_mwh)}/MWh served) |`,
    `| Relocation cost | $${n0(a.relocation_cost_usd)} |`,
    `| Interruption consequence | $${n0(a.interruption_consequence_usd)} |`,
    `| Total decision cost | $${n0(a.total_decision_cost_usd)} ($${n2(a.decision_cost_usd_per_requested_mwh)}/MWh requested) |`,
    `| CO2 local / remote / combined | ${n0(a.local_operational_co2_t)} / ${n0(a.remote_operational_co2_t)} / ${n0(a.combined_operational_co2_t)} t |`,
    `| Combined intensity | ${n1(a.combined_electricity_co2_kg_per_mwh)} kg CO2/MWh |`,
    `| Clean energy share | ${n1(100 * a.clean_energy_share)}% |`,
    `| Merchant electricity | ${n0(a.merchant_mwh)} MWh |`, "",
    "## Grid stress response", "",
    `* Stress hours with campus demand: ${stressN}`,
    `* Highest import in a stress hour vs limit: ${n1(maxImp)} MW vs ${n1(stressN ? limLo : 0)} to ${n1(limHi)} MW`,
    `* Tier 0 protected demand always served locally: ${tier0ok ? "yes" : "NO"}`,
    `* Relocated ${n0(a.relocated_local_equivalent_mwh)} MWh and interrupted ${n0(a.interrupted_mwh)} MWh, only inside stress windows`, "",
    "## Results by model year", "",
    "| Year | Requested MWh | Decision cost $ | $/MWh requested | kg CO2/MWh | Clean share | Relocated MWh | Interrupted MWh |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const y of a.annual) {
    if (y.requested_mwh <= 0) { L.push(`| ${y.model_year} | 0 | ${n0(y.total_decision_cost_usd)} | | | | | |`); continue; }
    L.push(`| ${y.model_year} | ${n0(y.requested_mwh)} | ${n0(y.total_decision_cost_usd)} | ${y.decision_cost_usd_per_requested_mwh.toFixed(2)} | ${y.combined_electricity_co2_kg_per_mwh.toFixed(1)} | ${(100 * y.clean_energy_share).toFixed(1)}% | ${n0(y.relocated_local_equivalent_mwh)} | ${n0(y.interrupted_mwh)} |`);
  }
  L.push("", "## Capacity cost ledger", "", "| Resource | MW | Charges from month | Capacity charges $ | Energy or VOM $ | Fuel $ | Total $ |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const l of a.ledger) if (l.mw) L.push(`| ${l.k} | ${l.mw} | ${l.from} | ${n0(l.fixed)} | ${n0(l.payment)} | ${n0(l.fuel)} | ${n0(l.total)} |`);
  L.push("", "Common accounting: undiscounted sum of annualized screening charges, constant 2023 USD; not project NPV.");
  return L.join("\n") + "\n";
}

// ---------- routing ----------
const ROUTES = { "": home, project, recommendations, "demand-profile": demandProfile, export: exportPage };
function route() {
  killCharts();
  const r = location.hash.replace(/^#\/?/, "");
  document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.r === r));
  (ROUTES[r] || home)();
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    const [params, hourly, plans] = await Promise.all(["data/params.json", "data/hourly.json", "data/plans.json"].map(u => fetch(u).then(x => {
      if (!x.ok) throw new Error(`${u}: ${x.status}`); return x.json();
    })));
    rows = D.loadPlans(plans);
    universe = D.testedMonths(rows);
    engine = makeEngine(params, hourly);
    maxMw = Object.fromEntries(RESOURCES.map(k => [k, params.catalog[k].max_mw]));
    loadProject();
    applyProject();
    window.addEventListener("hashchange", route);
    route();
  } catch (e) {
    app.innerHTML = `<div class="notice warn">Could not load the plan data (${esc(e.message)}). Please reload the page.</div>`;
  }
}
boot();
