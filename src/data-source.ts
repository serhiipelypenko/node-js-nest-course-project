// DataSource для CLI (migration:*) і для CLI-скриптів hw-13 (seed/demo/report).
//
// synchronize: false — схема змінюється ТІЛЬКИ міграціями (src/migrations),
// ніякого автопідлаштування під entities на старті.
//
// Підключення — ЛИШЕ з process.env, без .env-файла і без зашитих значень:
// у dev-режимі DB_HOST/PORT/USER/PASSWORD/NAME інжектить
// scripts/with-secrets.sh (infisical run або SKIP_VAULT=1 — грейдер сам
// експортує ці змінні напряму). Це окремий набір змінних від DB_URL /
// DB_PASSWORD_FILE застосунку (hw-11/12): той обслуговує процес Nest-сервера
// й ротацію пароля-файлу, цей — одноразові CLI-інструменти дата-шару.
import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { JobQueue } from './entities/job-queue.entity';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from './entities/product.entity';
import { User } from './entities/user.entity';

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, Product, Order, OrderItem, JobQueue],
  migrations: ['dist/migrations/*.js'],
  synchronize: false,
};

const AppDataSource = new DataSource(dataSourceOptions);

export default AppDataSource;
