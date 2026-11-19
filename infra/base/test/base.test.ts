// Інваріанти стеку base — без хмари, на моках Pulumi.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installMocks, settle, byType } from "./mocks";

const recs = installMocks("base");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createBase, teardownPolicy } = require("../stack") as typeof import("../stack");
const { HOURLY_TYPES, PROJECT_TAG } = require("../../lib/contract") as typeof import("../../lib/contract");

const b = createBase({ budgetEmail: "x@example.com", stateBucket: "state-bkt", githubRepo: "acme/shop", azs: ["eu-central-1a", "eu-central-1b"] });
const ready = settle([b.ciRole.id, b.privateRt.id, b.publicRt.id, b.appSg.id, b.budget.id]);

test("бюджет — ПЕРШИЙ ресурс стеку", async () => {
  await ready;
  assert.equal(recs[0].type, "aws:budgets/budget:Budget");
});

test("бюджет: COST, MONTHLY, $5, ACTUAL > 20 %", async () => {
  await ready;
  const [bud] = byType(recs, "aws:budgets/budget:Budget");
  assert.equal(bud.inputs.budgetType, "COST");
  assert.equal(bud.inputs.timeUnit, "MONTHLY");
  assert.equal(bud.inputs.limitAmount, "5");
  const n = bud.inputs.notifications[0];
  assert.deepEqual([n.notificationType, n.comparisonOperator, n.threshold, n.thresholdType],
    ["ACTUAL", "GREATER_THAN", 20, "PERCENTAGE"]);
});

test("у route table приватних підмереж немає 0.0.0.0/0 на IGW", async () => {
  await ready;
  const rts = byType(recs, "aws:ec2/routeTable:RouteTable");
  const priv = rts.filter((r) => r.inputs.tags?.Tier === "private");
  const pub = rts.filter((r) => r.inputs.tags?.Tier === "public");
  assert.equal(priv.length, 1);
  for (const rt of priv) {
    const bad = (rt.inputs.routes ?? []).filter((x: any) => x.cidrBlock === "0.0.0.0/0");
    assert.equal(bad.length, 0, "приватна RT має маршрут у світ");
  }
  // окремих aws.ec2.Route на приватну таблицю теж немає
  assert.equal(byType(recs, "aws:ec2/route:Route").filter((r) => r.inputs.routeTableId === "hw31-rt-private-id").length, 0);
  // контроль: публічна таблиця маршрут у світ МАЄ — інакше тест вище нічого не доводить
  assert.ok(pub[0].inputs.routes.some((x: any) => x.cidrBlock === "0.0.0.0/0" && x.gatewayId === "hw31-igw-id"));
});

test("приватні підмережі привʼязані лише до приватної RT", async () => {
  await ready;
  const assoc = byType(recs, "aws:ec2/routeTableAssociation:RouteTableAssociation");
  const priv = assoc.filter((a) => a.name.startsWith("hw31-rta-private"));
  assert.equal(priv.length, 2);
  for (const a of priv) assert.equal(a.inputs.routeTableId, "hw31-rt-private-id");
});

test("2 публічні + 2 приватні підмережі у двох різних AZ", async () => {
  await ready;
  const subs = byType(recs, "aws:ec2/subnet:Subnet");
  for (const tier of ["public", "private"]) {
    const t = subs.filter((s) => s.inputs.tags?.Tier === tier);
    assert.equal(t.length, 2);
    assert.equal(new Set(t.map((s) => s.inputs.availabilityZone)).size, 2);
  }
});

test("у base немає жодного погодинного ресурсу", async () => {
  await ready;
  const hourly = recs.filter((r) => HOURLY_TYPES.includes(r.type));
  assert.deepEqual(hourly.map((r) => r.type), []);
});

test("кожне правило SG має опис (обґрунтування порту)", async () => {
  await ready;
  for (const sg of byType(recs, "aws:ec2/securityGroup:SecurityGroup"))
    for (const rule of [...(sg.inputs.ingress ?? []), ...(sg.inputs.egress ?? [])])
      assert.ok(rule.description && rule.description.length > 3, `${sg.name}: правило без опису`);
});

test("IAM: жодного '*' в Action, trust звужений до репозиторію", async () => {
  await ready;
  const actions = teardownPolicy("state-bkt").Statement.flatMap((s) => s.Action);
  assert.ok(actions.length > 0);
  assert.deepEqual(actions.filter((a) => a.includes("*")), []);
  const [role] = byType(recs, "aws:iam/role:Role");
  const trust = JSON.parse(role.inputs.assumeRolePolicy);
  const cond = trust.Statement[0].Condition;
  assert.equal(cond.StringEquals["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com");
  // Обидва формати GitHub: старі репо і створені після 15.07.2026 (незмінний sub з ID).
  assert.deepEqual(cond.StringLike["token.actions.githubusercontent.com:sub"], ["repo:acme/shop:*", "repo:acme@*/shop@*:*"]);
});

test("defaultTags Project=nodejs-pro-hw31 у Pulumi.base.yaml", () => {
  const y = fs.readFileSync(path.join(__dirname, "..", "Pulumi.base.yaml"), "utf8");
  assert.match(y, /aws:region: eu-central-1/);
  assert.match(y, /aws:defaultTags:\s*\n\s+tags:/);
  assert.match(y, new RegExp(`Project:\\s*${PROJECT_TAG}\\s*$`, "m"));
  assert.match(y, /Stack:\s*base\s*$/m);
  assert.match(y, /ManagedBy:\s*pulumi\s*$/m);
});

test("політика: стан Pulumi — лише свій бакет, а не Resource:*", async () => {
  const st = teardownPolicy("state-bkt").Statement.filter((s) => s.Action.some((a) => a.startsWith("s3:")));
  assert.ok(st.length >= 2);
  for (const s of st) assert.ok(JSON.stringify(s.Resource).includes("state-bkt") && s.Resource !== "*");
});

test("бюджет: ліміт у файлі — літерал 5 (його читає грейдер), без слова про прогнозний тип", () => {
  const f = fs.readFileSync(path.join(__dirname, "..", "stack.ts"), "utf8");
  assert.match(f, /limitAmount: *"5"/);
  assert.equal(f.includes("FORECASTED"), false);
});
