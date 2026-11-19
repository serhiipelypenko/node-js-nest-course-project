// hw-32: гейт вартості для PR. Читає plan.json (pulumi preview --json), рахує гроші через mapping.ts,
// друкує plan-usd / delta-usd / budget-usd / gate=pass|fail і виходить з кодом 0 / 1.
//
//   PLAN_JSON=plan.json COST_BUDGET_USD=10 npm run gate:cost
//
// COST_BUDGET_USD — найбільший дозволений ПРИРІСТ місячної вартості в $ (за замовчуванням 10);
// COST_BUDGET_PCT — найбільший дозволений приріст у % від бази (за замовчуванням 20; діє, коли база > 0).
// Обхід — іменний лейбл PR (cost-approved): робить воркфлоу, не цей скрипт, і лише ПІСЛЯ того, як вердикт надруковано.
import { readFileSync } from 'node:fs';
import { costOfPlan, Plan, RATES, verdict } from './mapping';

const file = process.env.PLAN_JSON ?? 'plan.json';
const num = (name: string, dflt: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`${name} має бути числом, а не "${raw}"`);
    process.exit(2);
  }
  return n;
};
const budget = num('COST_BUDGET_USD', 10);
const budgetPct = num('COST_BUDGET_PCT', 20);

let plan: Plan;
try {
  plan = JSON.parse(readFileSync(file, 'utf8')) as Plan;
} catch (e) {
  console.error(`не вдалося прочитати ${file}: ${(e as Error).message}`);
  process.exit(2);
}

const r = costOfPlan(plan);
const v = verdict(r, budget, budgetPct);
for (const l of r.lines) console.error(`  ${l.op.padEnd(8)} $${l.usd}/міс  ${l.urn.split('::').slice(-2).join('::')}`);
console.error(`ставки: $${RATES.cpuUsdPerVcpuMonth}/vCPU-міс, $${RATES.memUsdPerGibMonth}/ГіБ-міс (${RATES.source})`);
console.log(`plan-usd=${r.planUsd}`);
console.log(`delta-usd=${r.deltaUsd}`);
console.log(`budget-usd=${budget}`);
console.log(`reason=${v.reason}`);
console.log(`gate=${v.pass ? 'pass' : 'fail'}`);
process.exit(v.pass ? 0 : 1);
