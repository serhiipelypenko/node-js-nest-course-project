// Точка входу Pulumi для стеку base. Уся логіка — у stack.ts (її тестують моки).
import * as pulumi from "@pulumi/pulumi";
import { createBase } from "./stack";

const cfg = new pulumi.Config("hw31");
// Пошта й імʼя бакета стану — не в git: беремо з конфігу або з оточення (його наповнює сховище #11).
const need = (key: string, env: string): string => {
  const v = cfg.get(key) ?? process.env[env];
  if (!v) throw new Error(`hw31:${key} не задано: поставте ${env} (сховище → scripts/with-secrets.sh) або pulumi config set hw31:${key}`);
  return v;
};

const b = createBase({
  budgetEmail: need("budgetEmail", "HW31_BUDGET_EMAIL"),
  stateBucket: need("stateBucket", "HW31_STATE_BUCKET"),
  githubRepo: cfg.require("githubRepo"),
  azs: cfg.requireObject<[string, string]>("azs"),
});

export const vpcId = b.vpc.id;
export const publicSubnetIds = b.publicSubnets.map((s) => s.id);
export const privateSubnetIds = b.privateSubnets.map((s) => s.id);
export const edgeSgId = b.edgeSg.id;
export const appSgId = b.appSg.id;
export const privateRouteTableId = b.privateRt.id;
export const ciRoleArn = b.ciRole.arn;
export const budgetName = b.budget.name;
