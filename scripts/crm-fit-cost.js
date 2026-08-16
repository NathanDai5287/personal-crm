'use strict';
// crm-fit-cost.js — refit and print the self-calibrating cost model.
//
// The merge estimator (lib/cost.js) learns two per-model unknowns — effective
// agentic TURNS and OUTPUT tokens — by least-squares fitting real (input base,
// billed USD) pairs that crm-daily records from actual merges. crm-daily refits
// automatically after every run that saw a real cost; run this to refit on demand
// or just to see the current coefficients and how many samples back them.
//   node scripts/crm-fit-cost.js
const { fitCostModel } = require('../lib/cost');

const fit = fitCostModel();
const models = Object.keys(fit);
if (!models.length) {
  console.log('cost model: not enough real merge samples yet (need >= 5 per paid model).');
  console.log('until then, estimates use evals/estimate.js midpoints (3 turns / 5,000 out).');
  process.exit(0);
}
console.log('fitted cost coefficients (learned from real merges):');
for (const [m, f] of Object.entries(fit)) {
  console.log(`  ${m.padEnd(30)} turns=${String(f.turns).padStart(5)}  out=${String(f.out).padStart(6)} tok   (n=${f.n})`);
}
