import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

// Операційні маршрути. У openapi/openapi.yaml їх НЕМАЄ навмисно —
// express-openapi-validator пропускає їх завдяки ignoreUndocumented: true,
// а scripts/check-spec.cjs і далі рахує рівно 5 операцій / 2 ресурси.
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // Liveness. uptime_seconds + pid — доказ, що між ротацією пароля і
  // наступним запитом процес НЕ перезапускався.
  @Get()
  liveness() {
    return {
      status: 'ok',
      uptime_seconds: Math.floor(process.uptime()),
      pid: process.pid,
    };
  }

  // Readiness. Бере СВІЖЕ зʼєднання з пулу і робить SELECT 1 — тобто
  // реально ходить у БД тим самим паролем-з-файла.
  @Get('db')
  async readiness() {
    try {
      const { rows } = await this.pool.query('SELECT 1 AS ok');
      return { db: rows[0]?.ok === 1 ? 'ok' : 'unknown' };
    } catch (err) {
      throw new ServiceUnavailableException({
        code: 'db-unavailable',
        detail: `БД недоступна: ${(err as Error).message}`,
      });
    }
  }
}
