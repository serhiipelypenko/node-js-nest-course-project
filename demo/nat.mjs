// hw-31, пункт 8 — `npm run demo:nat`. Ключі: nat-minutes, nat-billed-hours → evidence/demos.txt.
// «Each partial NAT Gateway-hour consumed is billed as a full hour.» NAT піднімається за прапорцем
// hw31:withNat і одразу зноситься. Час життя — з CreateTime/DeleteTime самого AWS, а не з годинника ноутбука.
// Ціна вправи ≈ $0,057: одна білена година NAT ($0,052) + його Public IPv4 ($0,005).
import { aws, pulumi, stackOutput, realAwsGate, report, makeChecks, r1, note } from './aws-lib.mjs';

realAwsGate('demo:nat (pulumi up з hw31:withNat=true → одразу false)');
const checks = makeChecks();

pulumi('demo', ['config', 'set', 'hw31:withNat', 'true']);
const up = pulumi('demo', ['up', '--yes', '--skip-preview', '--non-interactive']);
const natId = stackOutput('demo', 'natGatewayId');
note(`nat ${natId} · up ${r1(up.seconds)} с`);

// одразу вниз — навіть якщо щось пішло не так, прапорець НЕ лишаємо true
pulumi('demo', ['config', 'set', 'hw31:withNat', 'false']);
const down = pulumi('demo', ['up', '--yes', '--skip-preview', '--non-interactive']);

const g = aws(['ec2', 'describe-nat-gateways', '--nat-gateway-ids', natId]).NatGateways[0];
const minutes = (Date.parse(g.DeleteTime) - Date.parse(g.CreateTime)) / 60000;
// Оплачені години — за правилом прайс-листа (стеля). Фактичний рядок рахунку (`aws ce get-cost-and-usage`) зʼявиться за добу.
const billed = Math.ceil(minutes / 60);
note(`CreateTime ${g.CreateTime} · DeleteTime ${g.DeleteTime} · state ${g.State}`);
checks.check('NAT знесено (state=deleted)', g.State === 'deleted');
checks.check('жив менше години', minutes < 60);
checks.check('білиться як повна година', billed === 1);
report('demos.txt', { 'nat-minutes': r1(minutes), 'nat-billed-hours': billed, 'nat-up-seconds': r1(up.seconds), 'nat-down-seconds': r1(down.seconds) });
checks.finish();
