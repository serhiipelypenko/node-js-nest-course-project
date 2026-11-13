import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

// ── 0. Конфіг — ПЕРШОЮ дією, до будь-якого звернення до кластера ─────────────
// Секрет рантайму приїжджає зі сховища (hw-11) через scripts/with-secrets.sh у
// змінну оточення. Дефолту немає навмисно (`?? "changeme"` = пароль, зашитий у код):
// без значення розгортання падає й НАЗИВАЄ змінну.
const REQUIRED_FROM_VAULT = ["APP_DB_PASSWORD"] as const;
for (const name of REQUIRED_FROM_VAULT) {
  if (!process.env[name]) {
    throw new Error(
      `Не задано змінну зі сховища: ${name}. ` +
        `Запускайте через scripts/with-secrets.sh або (SKIP_VAULT=1) зробіть export ${name}=...`,
    );
  }
}
const dbPassword = process.env.APP_DB_PASSWORD as string;

const cfg = new pulumi.Config();
const profile = cfg.get("profile") ?? "good"; // good | bad
if (profile !== "good" && profile !== "bad") {
  throw new Error(`profile має бути good або bad, а не "${profile}"`);
}
const hardened = profile === "good";
const rev = cfg.get("rev") ?? "1";
const replicas = cfg.getNumber("replicas") ?? 3;
const image = cfg.get("image") ?? "marketplace-api:hw28";
const kubeContext = cfg.get("kubeContext") ?? "kind-hw28";
const namespaceName = "marketplace";
const appName = "marketplace-api";

const WARMUP_MS = 4000; // прогрів до listen(): як у сервісу з міграціями й пулом БД
const DRAIN_MS = 5000; // скільки сервіс тримає сокет після «я не готовий»

// Явний провайдер із контекстом kind: не залежимо від того, який контекст «поточний».
const provider = new k8s.Provider("kind", { context: kubeContext });
const opts: pulumi.CustomResourceOptions = { provider };

const labels = { app: appName, hw: "28" };

// ── 1. Namespace ──────────────────────────────────────────────────────────────
const ns = new k8s.core.v1.Namespace(
  "ns",
  { metadata: { name: namespaceName, labels } },
  opts,
);

// ── 2. Secret ─────────────────────────────────────────────────────────────────
// 🔴 `data` (base64), НЕ `stringData`: stringData — поле лише для запису, API його
// не віддає, і провайдер бачить різницю на кожному up. З data повторний up = unchanged.
// pulumi.secret шифрує значення й у стані стеку. base64 — не шифрування: у etcd
// локального кластера воно лежить відкритим текстом (див. README).
const dbSecret = new k8s.core.v1.Secret(
  "app-secrets",
  {
    metadata: { name: "marketplace-secrets", namespace: ns.metadata.name, labels },
    type: "Opaque",
    data: { APP_DB_PASSWORD: pulumi.secret(Buffer.from(dbPassword).toString("base64")) },
  },
  opts,
);

// ── 3. Deployment ─────────────────────────────────────────────────────────────
// good  = чотири налаштування, що дають нуль втрат;
// bad   = навмисно зламаний профіль (без проб, без SIGTERM, maxUnavailable: 1) — для
//         порівняння в demo:rollout --compare.
const readinessProbe: k8s.types.input.core.v1.Probe | undefined = hardened
  ? {
      // «чи можна слати трафік»: короткий період, один збій = виводимо з балансування
      httpGet: { path: "/readyz", port: 8080 },
      periodSeconds: 1,
      failureThreshold: 1,
    }
  : undefined;

const livenessProbe: k8s.types.input.core.v1.Probe | undefined = hardened
  ? {
      // «чи треба мене вбити»: ІНШИЙ шлях. Liveness на /readyz = вічний цикл рестартів.
      httpGet: { path: "/healthz", port: 8080 },
      periodSeconds: 10,
      failureThreshold: 3,
    }
  : undefined;

// Бонус: startupProbe замість великого initialDelaySeconds у liveness. Поки вона не
// зелена, liveness і readiness не працюють; після першого успіху вимикається назавжди.
const startupProbe: k8s.types.input.core.v1.Probe | undefined = hardened
  ? {
      httpGet: { path: "/healthz", port: 8080 },
      periodSeconds: 1,
      failureThreshold: 30,
    }
  : undefined;

const deployment = new k8s.apps.v1.Deployment(
  "api",
  {
    metadata: { name: appName, namespace: ns.metadata.name, labels },
    spec: {
      // Лишається в програмі разом із HPA: у кластері з metrics-server це конфлікт
      // володіння полем (README, «replicas проти HPA»).
      replicas,
      selector: { matchLabels: { app: appName } },
      strategy: {
        type: "RollingUpdate",
        rollingUpdate: hardened
          ? { maxUnavailable: 0, maxSurge: 1 }
          : { maxUnavailable: 1, maxSurge: 1 },
      },
      template: {
        metadata: { labels },
        spec: {
          // Більше за дренаж (5 с) із запасом: інакше SIGKILL посеред дренажу (exit 137).
          terminationGracePeriodSeconds: hardened ? 20 : 30,
          containers: [
            {
              name: "api",
              image,
              imagePullPolicy: "IfNotPresent", // образ вантажимо через `kind load`
              ports: [{ containerPort: 8080 }],
              env: [
                { name: "WARMUP_MS", value: String(WARMUP_MS) },
                { name: "DRAIN_MS", value: String(DRAIN_MS) },
                { name: "GRACEFUL", value: hardened ? "1" : "0" },
                // зміна REV міняє pod-шаблон -> rolling update
                { name: "REV", value: rev },
                // значення в маніфесті НЕМАЄ — лише посилання на Secret
                {
                  name: "APP_DB_PASSWORD",
                  valueFrom: {
                    secretKeyRef: { name: dbSecret.metadata.name, key: "APP_DB_PASSWORD" },
                  },
                },
              ],
              readinessProbe,
              livenessProbe,
              startupProbe,
              resources: {
                requests: { cpu: "50m", memory: "48Mi" },
                limits: { memory: "192Mi" },
              },
              securityContext: {
                // 🔴 числом: kubelet не резолвить імена («non-numeric user (nonroot)»)
                runAsNonRoot: true,
                runAsUser: 65532,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                seccompProfile: { type: "RuntimeDefault" },
              },
            },
          ],
        },
      },
    },
  },
  opts,
);

// ── 4. Service (NodePort -> проброс kind на хост :22880) ─────────────────────
const service = new k8s.core.v1.Service(
  "svc",
  {
    metadata: { name: appName, namespace: ns.metadata.name, labels },
    spec: {
      type: "NodePort",
      selector: { app: appName },
      ports: [{ port: 80, targetPort: 8080, nodePort: 30828 }],
    },
  },
  { ...opts, dependsOn: [deployment] },
);

// ── 5. PodDisruptionBudget ────────────────────────────────────────────────────
// minAvailable = replicas - 1: лишає місце для drain. minAvailable == replicas
// блокує будь-яке виселення (disruptionsAllowed=0).
const pdb = new k8s.policy.v1.PodDisruptionBudget(
  "pdb",
  {
    metadata: { name: appName, namespace: ns.metadata.name, labels },
    spec: {
      minAvailable: Math.max(replicas - 1, 1),
      selector: { matchLabels: { app: appName } },
    },
  },
  opts,
);

// ── 6. HorizontalPodAutoscaler (autoscaling/v2, CPU 70 %) ────────────────────
// У kind немає metrics-server: TARGETS = <unknown>/70%, масштабування не відбувається.
const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
  "hpa",
  {
    metadata: { name: appName, namespace: ns.metadata.name, labels },
    spec: {
      scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: deployment.metadata.name },
      minReplicas: 2,
      maxReplicas: 5,
      metrics: [
        {
          type: "Resource",
          resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } },
        },
      ],
    },
  },
  opts,
);

export const namespace = ns.metadata.name;
export const deploymentName = deployment.metadata.name;
export const pdbName = pdb.metadata.name;
export const hpaName = hpa.metadata.name;
export const nodePort = service.spec.ports[0].nodePort;
export const activeProfile = profile;
export const revision = rev;
