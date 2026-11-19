// Точка входу Pulumi для стеку demo. Вихідні дані base — через StackReference.
import * as pulumi from "@pulumi/pulumi";
import { createDemo, BaseOutputs } from "./stack";

// 🔴 Реєструється ДО створення ресурсів: забутий deletionProtection або фінальний снапшот
// перетворюють знесення на рахунок, що переживає destroy.
pulumi.runtime.registerResourceTransform((args) =>
  args.type === "aws:rds/instance:Instance"
    ? { props: { ...args.props, deletionProtection: false, skipFinalSnapshot: true }, opts: args.opts }
    : undefined);

const cfg = new pulumi.Config("hw31");
// Повне імʼя стеку base у тому ж бекенді: <org>/<project>/<stack>. На S3-бекенді org завжди «organization».
const ref = new pulumi.StackReference(cfg.get("baseStackRef") ?? `${pulumi.getOrganization()}/hw31-base/base`);
const pick = (key: string, i: number) => ref.requireOutput(key).apply((x: any) => x[i] as string);
const base: BaseOutputs = {
  vpcId: ref.requireOutput("vpcId") as pulumi.Output<string>,
  publicSubnetIds: [pick("publicSubnetIds", 0), pick("publicSubnetIds", 1)],
  privateSubnetIds: [pick("privateSubnetIds", 0), pick("privateSubnetIds", 1)],
  edgeSgId: ref.requireOutput("edgeSgId") as pulumi.Output<string>,
  appSgId: ref.requireOutput("appSgId") as pulumi.Output<string>,
};

const d = createDemo({
  base,
  dbPassword: cfg.requireSecret("dbPassword"),
  withNat: cfg.getBoolean("withNat") ?? false,
});

export const dbIdentifier = d.db.identifier;
export const dbAz = d.db.availabilityZone;
export const albDns = d.alb.dnsName;
export const targetGroupArn = d.tg.arn;
export const targetFunction = d.fn.name;
export const natGatewayId = d.nat?.id;
