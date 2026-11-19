// hw-31: evidence/iam.json (trust + permission policy, ДЕКОДОВАНІ) і evidence/iam.txt (sim-allowed / sim-denied).
// 🔴 Негативний тест — на рушії, що ухвалює рішення (справжній IAM), а не на моєму коді чи емуляторі.
//   npm run evidence:iam      (також викликається наприкінці up:base)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { aws, stackOutput, realAwsGate, report, EVIDENCE, note } from '../demo/aws-lib.mjs';

realAwsGate('evidence:iam');
const arn = stackOutput('base', 'ciRoleArn');
const name = arn.split('/').pop();
note(`роль ${arn}`);

// залежно від версії CLI документ приїздить обʼєктом або URL-encoded рядком — на виході завжди обʼєкт
const decode = (d) => (typeof d === 'string' ? JSON.parse(decodeURIComponent(d)) : d);
const role = aws(['iam', 'get-role', '--role-name', name]).Role;
const policies = aws(['iam', 'list-role-policies', '--role-name', name]).PolicyNames;
const permission = policies.map((p) => ({
  name: p, document: decode(aws(['iam', 'get-role-policy', '--role-name', name, '--policy-name', p]).PolicyDocument),
}));
mkdirSync(EVIDENCE, { recursive: true });
writeFileSync(join(EVIDENCE, 'iam.json'), JSON.stringify({
  roleArn: arn,
  trustPolicy: decode(role.AssumeRolePolicyDocument),
  permissionPolicies: permission,
}, null, 2) + '\n');

const sim = (action) => aws(['iam', 'simulate-principal-policy', '--policy-source-arn', arn, '--action-names', action])
  .EvaluationResults[0].EvalDecision;
const allowed = sim('rds:DeleteDBInstance'); // роль це МАЄ вміти (її робота — знести базу)
const denied = sim('s3:DeleteBucket');       // а це — ні: у політиці такої дії немає → implicitDeny
note(`rds:DeleteDBInstance → ${allowed}; s3:DeleteBucket → ${denied}`);
report('iam.txt', { 'sim-allowed': allowed, 'sim-denied': denied });
if (allowed !== 'allowed' || !/^(implicitDeny|explicitDeny)$/.test(denied)) {
  console.error('✗ симуляція не дала очікуваних рішень'); process.exit(1);
}
