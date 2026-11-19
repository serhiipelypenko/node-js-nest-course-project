// hw-31, пункт 7 — `npm run demo:alb`. Ключі: alb-dns, http-code, target-state → evidence/demos.txt.
// target-state головніший за код відповіді: нездорова ціль дає 503 — той самий механізм, що readiness на #28.
import { aws, stackOutput, realAwsGate, report, makeChecks, sleep, r1, note } from './aws-lib.mjs';

realAwsGate('demo:alb (curl до ALB + describe-target-health)');
const checks = makeChecks();
const dns = stackOutput('demo', 'albDns');
const tg = stackOutput('demo', 'targetGroupArn');
const fn = stackOutput('demo', 'targetFunction');
const state = () => aws(['elbv2', 'describe-target-health', '--target-group-arn', tg]).TargetHealthDescriptions[0]?.TargetHealth?.State ?? 'none';
const code = async (p) => { try { return (await fetch(`http://${dns}${p}`)).status; } catch { return 0; } };

// ціль реєструється й проходить health check не миттєво (healthyThreshold × interval) — чекаємо до 5 хв
let st = state(); const t0 = Date.now();
while (st !== 'healthy' && Date.now() - t0 < 300_000) { await sleep(5000); st = state(); note(`${r1((Date.now() - t0) / 1000)} с · ${st}`); }
const http = await code('/');
note(`http://${dns}/ → ${http} · target ${st}`);
checks.check('http-code = 200', http === 200);
checks.check('target-state = healthy', st === 'healthy');

// Public IPv4 під ALB: їх немає на схемі, але вони білляться ($0,005 × 2 × 730 = $7,30/міс)
const albName = dns.split('.')[0].replace(/-\d+$/, '');
const enis = aws(['ec2', 'describe-network-interfaces', '--filters', `Name=description,Values=ELB app/${albName}/*`]).NetworkInterfaces;
const ipv4 = enis.filter((e) => e.Association?.PublicIp).length;
note(`ENI балансувальника: ${enis.length}, з публічною IPv4: ${ipv4}`);

// HEALTHY=false → /health віддає 503 → ціль виходить із ротації. Вимкнути: HW31_ALB_DRAIN=0
let drain = -1;
if (process.env.HW31_ALB_DRAIN !== '0') {
  aws(['lambda', 'update-function-configuration', '--function-name', fn, '--environment', 'Variables={HEALTHY=false}']);
  const d0 = Date.now(); let s = state();
  while (s === 'healthy' && Date.now() - d0 < 300_000) { await sleep(5000); s = state(); note(`${r1((Date.now() - d0) / 1000)} с · ${s}`); }
  drain = (Date.now() - d0) / 1000;
  checks.check('ціль вийшла з ротації', s === 'unhealthy');
  aws(['lambda', 'update-function-configuration', '--function-name', fn, '--environment', 'Variables={HEALTHY=true}']);
  note('HEALTHY=true повернуто');
}
// ключі контракту пишемо ДО drain-проби: target-state = стан до виведення з ротації
report('demos.txt', { 'alb-dns': dns, 'http-code': http, 'target-state': st, 'alb-public-ipv4': ipv4, 'drain-seconds': r1(drain) });
checks.finish();
