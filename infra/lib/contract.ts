// Константи контракту hw-31. Їх читають і стеки, і юніт-тести, і скрипти.
// Змінюєш тут — змінюєш те, що перевіряє грейдер.
export const PROJECT_TAG = "nodejs-pro-hw31";
export const RDS_CLASS = "db.t4g.micro"; // Free plan пускає лише db.t3.micro / db.t4g.micro
export const RDS_STORAGE_GIB = 20;
export const RDS_STORAGE_TYPE = "gp3";
export const BUDGET_LIMIT_USD = "5";
export const BUDGET_THRESHOLD_PCT = 20;
// Типи ресурсів із погодинною ставкою. У стеку base НЕ має бути жодного з них.
export const HOURLY_TYPES = [
  "aws:ec2/natGateway:NatGateway",
  "aws:ec2/eip:Eip",
  "aws:rds/instance:Instance",
  "aws:rds/cluster:Cluster",
  "aws:lb/loadBalancer:LoadBalancer",
  "aws:alb/loadBalancer:LoadBalancer",
  "aws:ec2/instance:Instance",
  "aws:elasticache/cluster:Cluster",
];
