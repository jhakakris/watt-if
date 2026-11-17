# Watt If: power planner for a data-center campus

Watt If helps a data-center developer choose an energy portfolio for a 75 MW campus in Williamson County, Texas, over a 120-month horizon. You set a **cost ceiling** ($/MWh) and a **carbon ceiling** (kg CO2/MWh) plus hard requirements. The tool returns the **earliest opening month** that meets both, offers three qualifying plans (earliest, cheapest, cleanest), and shows every plan hour by hour.

**Live site: [watt-if-xi.vercel.app](https://watt-if-xi.vercel.app)**

The campus is a fictional benchmark. Costs are in constant 2023 USD.

## How it works

1. **Search.** 155,893 portfolios were simulated hour by hour over 87,600 hours (10 years). 134,966 of them are feasible and ship with the site in `data/plans.json`. They cover every opening month from 14 to 109 crossed with these sizes:

   | Source | Sizes searched |
   | --- | --- |
   | Wind | 0 to 200 MW in 50 MW steps |
   | Solar | 0 to 150 MW in 50 MW steps |
   | Nuclear | 0 or 25 MW |
   | Battery | 0 or 12 MW |
   | Gas turbine | 0 to 75 MW |
   | Gas engine | 0 to 50 MW |
   | Fuel cell | 0 to 30 MW |

   Each size combination was run in two dispatch modes (lowest cost, low carbon), with Tier 2 pauses allowed or not.
2. **Filter.** Keep the plans that meet every must have (allowed sources, never pause Tier 2 work).
3. **Earliest month.** Find the earliest opening month with a plan at or under both targets, and show the cheapest such plan.
4. **If nothing meets both,** move one target to the nearest value that works, whichever needs the smaller percent change, and say so.
5. **Alternatives.** Same opening month with a different mix (cheapest, balanced, cleanest), or a different opening month (fastest, cheapest, cleanest).

## Hourly operation

Each hour, clean contracts (wind, solar, nuclear) serve the campus first, up to the shared grid connection limit. The battery charges only from leftover clean output and discharges in each day's most valuable hours. The remaining need is met cheapest first from gas units and merchant grid power within the limit. In grid stress hours only, Tier 1 work can move to a remote site and Tier 2 work can pause. Tier 0 demand is always served on campus.

The chosen plan is re-simulated in the browser (`js/engine.js`, about 0.1 s), which drives the drill-down chart, the worst stress event, the cost and carbon breakdown and the `dispatch.csv` download. The page checks the result against the results table.

## Run locally

It is a static site with no build step:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Layout

| Path | Contents |
| --- | --- |
| `index.html`, `css/style.css` | Page shell and styles |
| `js/app.js` | Pages: Project, Recommendations, Demand profile, Export |
| `js/decide.js` | Decision logic: filters, earliest month, cost-carbon ladder, alternatives |
| `js/engine.js` | Hourly inputs, merit-order dispatch and cost/carbon accounting |
| `data/plans.json` | The 134,966 feasible simulated plans |
| `data/hourly.json`, `data/params.json` | Reference-year hourly inputs and resource, price and response parameters |

## Limitations

* Rule-based dispatch with a daily battery heuristic, not a global optimization.
* Coarse search grid (50 MW steps for wind and solar); finer sizes may be slightly better.
* Capacities are fixed up front (no staged additions).
* One repeated reference weather and price year with smooth real-terms trends; no outages, startup or ramping constraints.
