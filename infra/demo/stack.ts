// Стек demo — усе, що тарифікується погодинно. Піднімається на час роботи, зноситься того ж вечора.
// RDS Multi-AZ instance (НЕ Multi-AZ DB cluster!), ALB з Lambda-ціллю, NAT — лише за прапорцем.
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { RDS_CLASS, RDS_STORAGE_GIB, RDS_STORAGE_TYPE } from "../lib/contract";

export interface BaseOutputs {
  vpcId: pulumi.Input<string>;
  publicSubnetIds: pulumi.Input<string>[];
  privateSubnetIds: pulumi.Input<string>[];
  edgeSgId: pulumi.Input<string>;
  appSgId: pulumi.Input<string>;
}
export interface DemoArgs {
  base: BaseOutputs;
  dbPassword: pulumi.Input<string>;
  withNat: boolean;            // hw31:withNat — вимір пункту 8 ДЗ, живе хвилини, не години
}

// Ціль ALB. /health віддає 503, коли HEALTHY=false — так demo:alb виводить ціль із ротації.
const HANDLER = `
exports.handler = async (event) => {
  const sick = process.env.HEALTHY === "false";
  const code = event.path === "/health" && sick ? 503 : 200;
  return { statusCode: code, statusDescription: code + " X", isBase64Encoded: false,
    headers: { "content-type": "text/plain" }, body: code === 200 ? "ok\\n" : "draining\\n" };
};`;

export function createDemo(a: DemoArgs) {
  // ── RDS: Multi-AZ instance deployment, db.t4g.micro, gp3 20 ГіБ ──────────────
  const subnetGroup = new aws.rds.SubnetGroup("hw31-db-subnets", {
    subnetIds: a.base.privateSubnetIds,          // 🔴 лише приватні: з інтернету база недосяжна
  });
  const db = new aws.rds.Instance("hw31-db", {
    engine: "postgres",
    engineVersion: "16",
    instanceClass: RDS_CLASS,                    // db.t4g.micro (db.t3.micro — те саме за ціною)
    allocatedStorage: RDS_STORAGE_GIB,
    storageType: RDS_STORAGE_TYPE,
    storageEncrypted: true,                      // керований ключ aws/rds — НЕ власний CMK (він лишив би рядок рахунку)
    multiAz: true,                               // синхронний standby в іншій AZ, його НЕ можна читати
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [a.base.appSgId],
    publiclyAccessible: false,
    dbName: "app",
    username: "app",
    password: a.dbPassword,
    backupRetentionPeriod: 1,                    // до 100% обсягу сховища бекапи безкоштовні
    deletionProtection: false,                   // дубль трансформації з index.ts: destroy не має застрягти
    skipFinalSnapshot: true,                     // снапшот $0.103/ГіБ-міс пережив би destroy
    applyImmediately: true,
    // Performance Insights і Enhanced Monitoring НЕ вмикаємо: не оцінюються, коштують.
  });

  // ── ALB: internet-facing у двох публічних підмережах, Lambda-ціль ───────────
  const lambdaRole = new aws.iam.Role("hw31-target-role", {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    }),
  });
  new aws.iam.RolePolicyAttachment("hw31-target-logs", {
    role: lambdaRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });
  const fn = new aws.lambda.Function("hw31-target", {
    runtime: "nodejs22.x",
    handler: "index.handler",
    role: lambdaRole.arn,
    code: new pulumi.asset.AssetArchive({ "index.js": new pulumi.asset.StringAsset(HANDLER) }),
    environment: { variables: { HEALTHY: "true" } },
    timeout: 5,
    memorySize: 128,
  });
  const alb = new aws.lb.LoadBalancer("hw31-alb", {
    loadBalancerType: "application",
    internal: false,
    subnets: a.base.publicSubnetIds,
    securityGroups: [a.base.edgeSgId],
  });
  const tg = new aws.lb.TargetGroup("hw31-tg", {
    targetType: "lambda",
    healthCheck: { enabled: true, path: "/health", matcher: "200", interval: 35, timeout: 30,
      healthyThreshold: 2, unhealthyThreshold: 2 },
  });
  const perm = new aws.lambda.Permission("hw31-alb-invoke", {
    action: "lambda:InvokeFunction",
    function: fn.name,
    principal: "elasticloadbalancing.amazonaws.com",
    sourceArn: tg.arn,
  });
  new aws.lb.TargetGroupAttachment("hw31-tg-fn", { targetGroupArn: tg.arn, targetId: fn.arn }, { dependsOn: [perm] });
  new aws.lb.Listener("hw31-http", {
    loadBalancerArn: alb.arn, port: 80, protocol: "HTTP",
    defaultActions: [{ type: "forward", targetGroupArn: tg.arn }],
  });

  // ── NAT: лише за прапорцем. Партіальна година білиться як повна ─────────────
  let nat: aws.ec2.NatGateway | undefined;
  let natEip: aws.ec2.Eip | undefined;
  if (a.withNat) {
    natEip = new aws.ec2.Eip("hw31-nat-eip", { domain: "vpc" });
    nat = new aws.ec2.NatGateway("hw31-nat", {
      allocationId: natEip.id,
      subnetId: a.base.publicSubnetIds[0],
    });
    // Маршруту з приватної підмережі на NAT НЕМАЄ і не буде: вимір — ціна, а не маршрутизація.
  }

  return { subnetGroup, db, fn, alb, tg, nat, natEip };
}
