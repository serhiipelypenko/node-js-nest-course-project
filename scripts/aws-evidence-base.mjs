// hw-31: evidence/base.txt + evidence/base-state.json зі справжнього стеку base.
// Усе читається З AWS (describe-*), а не з коду: «приватна» підмережа — це відсутність рядка в route table.
//   npm run evidence:base      (також викликається наприкінці up:base)
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { aws, stackOutput, stackDir, pulumiEnv, realAwsGate, report, EVIDENCE, note } from '../demo/aws-lib.mjs';

realAwsGate('evidence:base');
const vpc = stackOutput('base', 'vpcId');
note(`vpc ${vpc}`);

const tag = (o, k) => (o.Tags ?? []).find((t) => t.Key === k)?.Value;
const subnets = aws(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc}`]).Subnets;
const priv = subnets.filter((s) => tag(s, 'Tier') === 'private');
const pub = subnets.filter((s) => tag(s, 'Tier') === 'public');

// Маршрути 0.0.0.0/0 у таблицях, до яких привʼязані приватні підмережі. Має бути 0.
const rts = aws(['ec2', 'describe-route-tables', '--filters', `Name=vpc-id,Values=${vpc}`]).RouteTables;
const privIds = new Set(priv.map((s) => s.SubnetId));
const privRts = rts.filter((rt) => (rt.Associations ?? []).some((a) => privIds.has(a.SubnetId)));
const defaultRoutes = privRts.flatMap((rt) => rt.Routes).filter((r) => r.DestinationCidrBlock === '0.0.0.0/0').length;

// default SG є в кожному VPC — не рахуємо його, щоб не завищувати
const sgs = aws(['ec2', 'describe-security-groups', '--filters', `Name=vpc-id,Values=${vpc}`]).SecurityGroups
  .filter((g) => g.GroupName !== 'default').length;

const tagged = aws(['resourcegroupstaggingapi', 'get-resources', '--tag-filters',
  'Key=Project,Values=nodejs-pro-hw31', 'Key=Stack,Values=base']).ResourceTagMappingList.length;

report('base.txt', {
  'vpc-id': vpc,
  'public-subnets': pub.length,
  'private-subnets': priv.length,
  'subnet-azs': new Set(subnets.map((s) => s.AvailabilityZone)).size,
  'private-default-route': defaultRoutes,
  'security-groups': sgs,
  'tagged-resources': tagged,
});

// pulumi stack export — як є, без правок
mkdirSync(EVIDENCE, { recursive: true });
const state = execFileSync('pulumi', ['stack', 'export', '--stack', 'base'],
  { cwd: stackDir('base'), env: pulumiEnv(), encoding: 'utf8', maxBuffer: 64 << 20 });
writeFileSync(join(EVIDENCE, 'base-state.json'), state);
note('evidence/base.txt, evidence/base-state.json записано');
