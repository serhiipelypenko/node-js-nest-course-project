// Інваріанти стеку demo — без хмари, на моках Pulumi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installMocks, settle, byType, Rec } from "./mocks";

const recs = installMocks("demo");
const { createDemo } = require("../stack") as typeof import("../stack");
const { RDS_CLASS } = require("../../lib/contract") as typeof import("../../lib/contract");

const base = {
  vpcId: "vpc-1", publicSubnetIds: ["subnet-pub-a", "subnet-pub-b"],
  privateSubnetIds: ["subnet-priv-a", "subnet-priv-b"], edgeSgId: "sg-edge", appSgId: "sg-app",
};

// Два прогони в одному процесі: без NAT і з NAT. Записи розділяємо за зрізом масиву.
async function run(withNat: boolean): Promise<Rec[]> {
  const start = recs.length;
  const d = createDemo({ base, dbPassword: "unit-test-only", withNat });
  await settle([d.db.id, d.alb.id, d.tg.id, d.fn.id, ...(d.nat ? [d.nat.id] : [])]);
  return recs.slice(start);
}
const noNat = run(false);
const withNat = noNat.then(() => run(true));

test("RDS: Multi-AZ instance, db.t4g.micro, gp3 20 ГіБ", async () => {
  const [db] = byType(await noNat, "aws:rds/instance:Instance");
  assert.equal(db.inputs.multiAz, true);
  assert.equal(db.inputs.instanceClass, RDS_CLASS);
  assert.equal(db.inputs.instanceClass, "db.t4g.micro");
  assert.equal(db.inputs.storageType, "gp3");
  assert.equal(db.inputs.allocatedStorage, 20);
  assert.equal(db.inputs.engine, "postgres");
  assert.equal(db.inputs.storageEncrypted, true);
  assert.equal(db.inputs.backupRetentionPeriod, 1);
  assert.equal(db.inputs.performanceInsightsEnabled, undefined);
  assert.equal(db.inputs.monitoringInterval, undefined);
});

test("RDS не Multi-AZ DB cluster і не публічний, destroy не застрягне", async () => {
  const r = await noNat;
  assert.equal(byType(r, "aws:rds/cluster:Cluster").length, 0);
  const [db] = byType(r, "aws:rds/instance:Instance");
  assert.equal(db.inputs.publiclyAccessible, false);
  assert.equal(db.inputs.deletionProtection, false);
  assert.equal(db.inputs.skipFinalSnapshot, true);
  const [sg] = byType(r, "aws:rds/subnetGroup:SubnetGroup");
  assert.deepEqual(sg.inputs.subnetIds, base.privateSubnetIds);
});

test("NAT: без прапорця hw31:withNat його немає — ні NAT, ні EIP", async () => {
  const r = await noNat;
  assert.equal(byType(r, "aws:ec2/natGateway:NatGateway").length, 0);
  assert.equal(byType(r, "aws:ec2/eip:Eip").length, 0);
});

test("NAT: із прапорцем — рівно один NAT в публічній підмережі і один EIP", async () => {
  const r = await withNat;
  const nats = byType(r, "aws:ec2/natGateway:NatGateway");
  assert.equal(nats.length, 1);
  assert.equal(nats[0].inputs.subnetId, "subnet-pub-a");
  assert.equal(byType(r, "aws:ec2/eip:Eip").length, 1);
  // маршруту з приватної мережі на NAT немає і з прапорцем
  assert.equal(byType(r, "aws:ec2/route:Route").length, 0);
});

test("ALB: internet-facing у двох публічних підмережах, ціль із health check", async () => {
  const r = await noNat;
  const [alb] = byType(r, "aws:lb/loadBalancer:LoadBalancer");
  assert.equal(alb.inputs.internal, false);
  assert.deepEqual(alb.inputs.subnets, base.publicSubnetIds);
  const [tg] = byType(r, "aws:lb/targetGroup:TargetGroup");
  assert.equal(tg.inputs.healthCheck.enabled, true);
  assert.equal(tg.inputs.healthCheck.path, "/health");
  assert.equal(byType(r, "aws:lb/targetGroupAttachment:TargetGroupAttachment").length, 1);
});
