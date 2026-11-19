// Стек base — усе, що коштує рівно $0 і може стояти тиждень.
// 🔴 Порядок має значення: бюджет — ПЕРШИЙ ресурс. До VPC, до всього.
// 🔴 Жодного ресурсу з погодинною ставкою (перелік — infra/lib/contract.ts, HOURLY_TYPES).
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface BaseArgs {
  budgetEmail: string;
  stateBucket: string;         // S3-бекенд стану Pulumi: CI-роль має право читати/писати в нього
  githubRepo: string;          // "owner/repo" — під нього звужується sub у trust policy
  azs: [string, string];       // з конфігу, а НЕ з getAvailabilityZones: preview тоді не ходить у хмару
  vpcCidr?: string;
}

export function createBase(a: BaseArgs) {
  // ── 1. Бюджет. Лист, а не гальмо: дані оновлюються раз на 8–12 годин ────────
  const budget = new aws.budgets.Budget("hw31-budget", {
    budgetType: "COST",
    timeUnit: "MONTHLY",
    limitAmount: "5",                     // limitAmount: 5 (USD) — на весь акаунт, без фільтра по тегу
    limitUnit: "USD",
    notifications: [{
      // ACTUAL — єдиний тип, що працює на свіжому акаунті: прогнозному типу потрібно ~5 тижнів історії.
      notificationType: "ACTUAL",
      comparisonOperator: "GREATER_THAN",
      threshold: 20,
      thresholdType: "PERCENTAGE",
      subscriberEmailAddresses: [a.budgetEmail],
    }],
  });
  const after = { dependsOn: [budget] };

  // ── 2. VPC і підмережі: 2 публічні + 2 приватні у двох AZ ────────────────────
  const cidr = a.vpcCidr ?? "10.31.0.0/16";   // непересічний із дефолтним 172.31.0.0/16
  const vpc = new aws.ec2.Vpc("hw31-vpc", {
    cidrBlock: cidr, enableDnsHostnames: true, enableDnsSupport: true,
  }, after);
  const igw = new aws.ec2.InternetGateway("hw31-igw", { vpcId: vpc.id }, after);

  const publicSubnets = a.azs.map((az, i) => new aws.ec2.Subnet(`hw31-public-${i}`, {
    vpcId: vpc.id, availabilityZone: az, cidrBlock: `10.31.${i}.0/24`,
    mapPublicIpOnLaunch: false,               // публічна IPv4 коштує $0.005/год — лише свідомо
    tags: { Tier: "public" },
  }, after));
  const privateSubnets = a.azs.map((az, i) => new aws.ec2.Subnet(`hw31-private-${i}`, {
    vpcId: vpc.id, availabilityZone: az, cidrBlock: `10.31.${10 + i}.0/24`,
    tags: { Tier: "private" },
  }, after));

  // ── 3. Route tables. Публічна: 0.0.0.0/0 → IGW. Приватна: ТІЛЬКИ local ──────
  const publicRt = new aws.ec2.RouteTable("hw31-rt-public", {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
    tags: { Tier: "public" },
  }, after);
  // Без маршрутів узагалі: у приватній підмережі живе тільки база, їй інтернет не потрібен.
  // NAT у постійному стеку не заводимо ($0,052/год).
  const privateRt = new aws.ec2.RouteTable("hw31-rt-private", {
    vpcId: vpc.id, routes: [], tags: { Tier: "private" },
  }, after);
  publicSubnets.forEach((s, i) => new aws.ec2.RouteTableAssociation(`hw31-rta-public-${i}`,
    { subnetId: s.id, routeTableId: publicRt.id }, after));
  privateSubnets.forEach((s, i) => new aws.ec2.RouteTableAssociation(`hw31-rta-private-${i}`,
    { subnetId: s.id, routeTableId: privateRt.id }, after));

  // ── 4. Security groups: edge (ALB) і app (RDS). Кожен порт — з поясненням ──
  const edgeSg = new aws.ec2.SecurityGroup("hw31-sg-edge", {
    vpcId: vpc.id, description: "ALB: HTTP from internet",
    ingress: [
      // 80/tcp з інтернету: це публічний вхід балансувальника. HTTPS не заводимо — нема домену і сертифіката.
      { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"], description: "HTTP to ALB" },
    ],
    egress: [
      // ALB має достукатись до цілі (Lambda/EC2) усередині VPC — вихід лише в CIDR VPC.
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: [cidr], description: "to targets inside VPC" },
    ],
  }, after);
  const appSg = new aws.ec2.SecurityGroup("hw31-sg-app", {
    vpcId: vpc.id, description: "RDS: Postgres only from edge SG",
    ingress: [
      // 5432/tcp лише від edge SG: база не приймає нічого з інтернету і нічого з решти VPC.
      { protocol: "tcp", fromPort: 5432, toPort: 5432, securityGroups: [edgeSg.id], description: "Postgres from edge" },
    ],
    egress: [],                                 // базі нікуди ходити не треба
  }, after);

  // ── 5. OIDC-провайдер GitHub і роль для teardown-джоби ─────────────────────
  const oidc = new aws.iam.OpenIdConnectProvider("hw31-gh-oidc", {
    url: "https://token.actions.githubusercontent.com",
    clientIdLists: ["sts.amazonaws.com"],
  }, after);
  // GitHub дає новим репо незмінний sub: repo:owner@<id>/name@<id>:…, старим лишає repo:owner/name:…
  const [owner, name] = a.githubRepo.split("/");
  const subjects = [`repo:${a.githubRepo}:*`, `repo:${owner}@*/${name}@*:*`];
  const trust = pulumi.all([oidc.arn]).apply(([arn]) => JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: arn },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        // Звужено до одного репозиторію. Порядкове читання — на #32.
        StringLike: { "token.actions.githubusercontent.com:sub": subjects },
      },
    }],
  }));
  const ciRole = new aws.iam.Role("hw31-ci-teardown", { assumeRolePolicy: trust }, after);
  new aws.iam.RolePolicy("hw31-ci-teardown-policy", {
    role: ciRole.id,
    policy: JSON.stringify(teardownPolicy(a.stateBucket)),
  }, after);

  return { budget, vpc, igw, publicSubnets, privateSubnets, publicRt, privateRt, edgeSg, appSg, oidc, ciRole };
}

// Політика teardown-ролі. 🔴 Жодного "*" в Action — кожна дія названа і пояснена (README, ## AWS).
// Resource: "*" для сервісів demo свідомо: ARN їхніх ресурсів невідомі на момент створення base.
// Бакет стану — навпаки, обмежений своїм ARN.
export function teardownPolicy(stateBucket: string) {
  const allow = (sid: string, actions: string[], resource: string | string[] = "*") =>
    ({ Sid: sid, Effect: "Allow", Action: actions, Resource: resource });
  const bucketArn = `arn:aws:s3:::${stateBucket}`;
  return {
    Version: "2012-10-17",
    Statement: [
      // Стан Pulumi (S3-бекенд): список ключів і локи — на бакеті, читання/запис/видалення — на обʼєктах.
      allow("StateBucket", ["s3:ListBucket", "s3:GetBucketLocation"], bucketArn),
      allow("StateObjects", ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], `${bucketArn}/*`),
      // Знести RDS і його subnet group; describe — щоб pulumi і перевірка «rds-left» бачили стан.
      allow("Rds", ["rds:DeleteDBInstance", "rds:DescribeDBInstances", "rds:DeleteDBSubnetGroup",
        "rds:DescribeDBSubnetGroups", "rds:ListTagsForResource"]),
      // Знести ALB, listener, target group; describe — для «alb-left».
      allow("Elb", ["elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:DeregisterTargets",
        "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth",
        "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeTargetGroupAttributes",
        "elasticloadbalancing:DescribeTags"]),
      // NAT і EIP: знести й перевірити «nat-left» / «eip-left» (idle IPv4 теж $0.005/год).
      allow("Ec2", ["ec2:DeleteNatGateway", "ec2:DescribeNatGateways", "ec2:ReleaseAddress",
        "ec2:DisassociateAddress", "ec2:DescribeAddresses"]),
      // Lambda-ціль ALB і її дозвіл на виклик від elasticloadbalancing.
      allow("Lambda", ["lambda:DeleteFunction", "lambda:GetFunction", "lambda:RemovePermission", "lambda:GetPolicy"]),
      // Роль виконання Lambda живе в demo — її теж треба знести.
      allow("IamDemoRole", ["iam:DeleteRole", "iam:GetRole", "iam:DetachRolePolicy",
        "iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:DeleteRolePolicy", "iam:ListInstanceProfilesForRole"]),
      // «tagged-resources-left»: один запит по тегу Project знаходить усе забуте.
      allow("Audit", ["tag:GetResources", "sts:GetCallerIdentity"]),
    ],
  };
}
