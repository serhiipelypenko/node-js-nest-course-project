// hw-31, пункт 9 — `npm run demo:failover`. Ключі: az-before, az-after, failover-seconds, event → evidence/demos.txt.
// Multi-AZ — процедура перемикання, а не бекап і не read replica. Критерій: AZ змінилась.
// Офіційно: «Failover times are typically 60–120 seconds» — міряємо на своєму інстансі.
// 🔴 Поле AvailabilityZone у describe-db-instances відстає на хвилини, тому кінець вправи — подія
//    «failover completed», а зону читаємо з мережевого інтерфейсу, на який уже вказує DNS бази.
import { resolve4 } from 'node:dns/promises';
import { aws, stackOutput, realAwsGate, report, makeChecks, sleep, r1, note } from './aws-lib.mjs';

realAwsGate('demo:failover (reboot-db-instance --force-failover)');
const checks = makeChecks();
const id = stackOutput('demo', 'dbIdentifier');
const describe = () => aws(['rds', 'describe-db-instances', '--db-instance-identifier', id]).DBInstances[0];

// DNS бази веде на приватну IP, а її інтерфейс лежить у конкретній зоні.
async function azByDns(host) {
  try {
    const [ip] = await resolve4(host);
    return aws(['ec2', 'describe-network-interfaces', '--filters', `Name=addresses.private-ip-address,Values=${ip}`])
      .NetworkInterfaces[0]?.AvailabilityZone;
  } catch { return undefined; }
}

const before = describe();
const host = before.Endpoint.Address;
// DNS бази резолвиться лише всередині VPC; ззовні — падаємо на describe (відстає, але чесно позначено в note)
const dnsBefore = await azByDns(host);
const azBefore = dnsBefore ?? before.AvailabilityZone;
note(`${id}: ${before.DBInstanceStatus}, AZ ${azBefore} (${dnsBefore ? 'за DNS' : 'за describe'})`);
// --force-failover не працює, якщо інстанс не available: чекаємо, а не перезапускаємо
if (before.DBInstanceStatus !== 'available') { console.error('✗ інстанс не available — failover не піде'); process.exit(1); }

const t0 = Date.now();
const since = new Date(t0 - 5000).toISOString();
const events = () => aws(['rds', 'describe-events', '--source-type', 'db-instance', '--source-identifier', id, '--start-time', since]).Events;
const find = (re) => events().find((e) => re.test(e.Message));
aws(['rds', 'reboot-db-instance', '--db-instance-identifier', id, '--force-failover']);

let after = describe();
// спершу статус іде з available, потім повертається; кінець — подія про завершення
while (after.DBInstanceStatus === 'available' && Date.now() - t0 < 60_000) { await sleep(2000); after = describe(); }
while ((after.DBInstanceStatus !== 'available' || !find(/failover completed/i)) && Date.now() - t0 < 900_000) {
  await sleep(5000); after = describe();
  note(`${r1((Date.now() - t0) / 1000)} с · ${after.DBInstanceStatus}`);
}
const seconds = (Date.now() - t0) / 1000;

const started = find(/failover started/i);
const completed = find(/failover completed/i);
const awsSeconds = started && completed ? (Date.parse(completed.Date) - Date.parse(started.Date)) / 1000 : -1;
note(completed ? `${completed.Date} · ${completed.Message}` : 'подій немає');

let azAfter = await azByDns(host);
while (dnsBefore && azAfter === azBefore && Date.now() - t0 < seconds * 1000 + 60_000) { await sleep(5000); azAfter = await azByDns(host); }
if (!azAfter) {
  note('DNS бази недоступний звідси: чекаємо describe-db-instances, це може тривати хвилини');
  while (describe().AvailabilityZone === azBefore && Date.now() - t0 < 900_000) await sleep(5000);
  azAfter = describe().AvailabilityZone;
}

checks.check(`AZ змінилась (${azBefore} → ${azAfter})`, azAfter !== azBefore);
checks.check('статус після = available', after.DBInstanceStatus === 'available');
checks.check('є подія «failover completed»', Boolean(completed));
if (seconds > 120) note(`⚠ ${r1(seconds)} с > 120 с «typical» — внести окремим рядком у README`);
report('demos.txt', {
  'az-before': azBefore, 'az-after': azAfter ?? '', 'failover-seconds': r1(seconds),
  'aws-event-seconds': awsSeconds, event: JSON.stringify(completed?.Message ?? ''),
});
checks.finish();
