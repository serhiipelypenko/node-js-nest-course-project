// hw-32: перекладач плану Pulumi (pulumi preview --json) у гроші. Двадцять рядків логіки, жодного зовнішнього
// сервісу (Infracost і подібні тут не потрібні).
//
// Маніфести Kubernetes у локальному kind самі нічого не коштують, тому рахуємо те, що коштувало б у хмарі:
// resources.requests.cpu і memory подів × replicas за ставками «керований контейнерний обчислювальний ресурс»
// (AWS Fargate, Linux/x86, us-east-1 — ставки й джерело в README, розділ «CI/CD»). Перевіряється МЕХАНІКА гейта,
// а не точність прайс-листа.
//
// Гейт реагує на ЗМІНУ, а не на суму: delta = Σ(нова вартість − стара вартість) по кроках плану
// (create: +нова; update/replace: нова − стара; delete: −стара).

const HOURS_PER_MONTH = 730;
export const RATES = {
  // AWS Fargate (us-east-1, Linux/x86): $0.04048 за vCPU-годину, $0.004445 за ГБ-годину.
  cpuUsdPerVcpuMonth: round2(0.04048 * HOURS_PER_MONTH),
  memUsdPerGibMonth: round2(0.004445 * HOURS_PER_MONTH),
  source: 'https://aws.amazon.com/fargate/pricing/',
} as const;

export interface PlanStep {
  op: string;
  urn?: string;
  oldState?: { type?: string; inputs?: unknown };
  newState?: { type?: string; inputs?: unknown };
}
export interface Plan {
  steps?: PlanStep[];
}
export interface CostReport {
  /** вартість у плані: нова вартість усіх ресурсів, яких стосується план (create/update/replace/same) */
  planUsd: number;
  /** зміна місячної вартості, яку приносить план */
  deltaUsd: number;
  /** вартість того, що вже було до плану (update/replace/delete/same) — база для відсотка */
  baselineUsd: number;
  deltaPct: number | null;
  lines: { urn: string; op: string; usd: number }[];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** '50m' -> 0.05 vCPU, '2' -> 2 */
export function parseCpu(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const s = String(v);
  return s.endsWith('m') ? Number(s.slice(0, -1)) / 1000 : Number(s);
}

/** '48Mi' -> 0.046875 GiB; підтримані суфікси Ki/Mi/Gi/Ti і K/M/G/T; без суфікса — байти. */
export function parseMemGib(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const m = /^([0-9.]+)([KMGT]i?)?$/.exec(String(v));
  if (!m) return 0;
  const n = Number(m[1]);
  const pow: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return (n * (pow[m[2] ?? ''] ?? 1)) / 2 ** 30;
}

interface Container {
  resources?: { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } };
}

/** Місячна вартість одного ресурсу плану. Лише навантаження з подами; решта (Namespace, Secret, Service, PDB, HPA) — $0. */
export function monthlyUsd(type: string | undefined, inputs: unknown): number {
  if (!type || !/^kubernetes:apps\/v1:(Deployment|StatefulSet)$/.test(type)) return 0;
  const spec = (inputs as { spec?: { replicas?: number; template?: { spec?: { containers?: Container[] } } } })?.spec;
  const replicas = typeof spec?.replicas === 'number' ? spec.replicas : 1;
  let perPod = 0;
  for (const c of spec?.template?.spec?.containers ?? []) {
    // requests — те, що резервує планувальник; якщо їх нема, беремо limits
    const r = c.resources?.requests ?? c.resources?.limits ?? {};
    perPod += parseCpu(r.cpu) * RATES.cpuUsdPerVcpuMonth + parseMemGib(r.memory) * RATES.memUsdPerGibMonth;
  }
  return perPod * replicas;
}

export function costOfPlan(plan: Plan): CostReport {
  let planUsd = 0;
  let deltaUsd = 0;
  let baselineUsd = 0;
  const lines: CostReport['lines'] = [];
  for (const s of plan.steps ?? []) {
    const next = monthlyUsd(s.newState?.type, s.newState?.inputs);
    const prev = monthlyUsd(s.oldState?.type, s.oldState?.inputs);
    switch (s.op) {
      case 'create':
      case 'create-replacement':
        planUsd += next;
        deltaUsd += next;
        break;
      case 'update':
      case 'replace':
        planUsd += next;
        deltaUsd += next - prev;
        baselineUsd += prev;
        break;
      case 'same':
        planUsd += next;
        baselineUsd += next;
        break;
      case 'delete':
      case 'delete-replaced':
        deltaUsd -= prev;
        baselineUsd += prev;
        break;
      default:
        break;
    }
    if (next || prev) lines.push({ urn: s.urn ?? '', op: s.op, usd: round2(next || prev) });
  }
  return {
    planUsd: round2(planUsd),
    deltaUsd: round2(deltaUsd),
    baselineUsd: round2(baselineUsd),
    deltaPct: baselineUsd > 0 ? round2((deltaUsd / baselineUsd) * 100) : null,
    lines,
  };
}

/**
 * Вердикт: ПОРАХОВАНИЙ з плану. Падаємо, якщо приріст більший за бюджет у доларах АБО (коли є база) за відсоток.
 * Абсолютного ліміту на суму немає: він ламається на першому ж дорогому ресурсі й робить PR червоним назавжди.
 */
export function verdict(r: CostReport, budgetUsd: number, budgetPct: number): { pass: boolean; reason: string } {
  if (r.deltaUsd > budgetUsd) return { pass: false, reason: `приріст $${r.deltaUsd}/міс > бюджету $${budgetUsd}` };
  if (r.deltaPct !== null && r.deltaPct > budgetPct) return { pass: false, reason: `приріст ${r.deltaPct}% > ${budgetPct}%` };
  return { pass: true, reason: 'у межах бюджету' };
}
