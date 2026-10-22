import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, unauthorized } from './auth.service';
import type { AuthedRequest, Role } from './auth.types';
import { IS_PUBLIC, ROLES_KEY } from './decorators';

// Глобальний гард №1 — АВТЕНТИФІКАЦІЯ: «хто це?». Немає / протух / зіпсований /
// відкликаний токен -> 401. Рішень про права тут немає.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // WS-gateway автентифікує сокет сам (handleConnection); тут лише HTTP.
    if (ctx.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
    if (!match) throw unauthorized('missing-token', 'потрібен заголовок Authorization: Bearer <access-токен>');

    req.user = await this.auth.authenticate(match[1]);
    return true;
  }
}

// Глобальний гард №2 — РІВЕНЬ РОЛІ: «чи можна цій ролі сюди?». Токен уже
// валідний, тож відмова — 403, а не 401. Власність ресурсу тут НЕ перевіряється:
// гард стоїть до завантаження ресурсу й не знає його власника.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles) return true;

    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw unauthorized('missing-token', 'потрібна автентифікація');
    if (!roles.includes(user.role)) {
      throw new ForbiddenException({
        code: 'insufficient-role',
        detail: `для цієї дії потрібна роль: ${roles.join(' | ')}`,
      });
    }
    return true;
  }
}
