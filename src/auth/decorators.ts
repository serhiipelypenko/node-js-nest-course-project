import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthedRequest, AuthUser, Role } from './auth.types';

export const IS_PUBLIC = 'auth:public';
export const ROLES_KEY = 'auth:roles';

/** Маршрут без токена (логін, refresh, публічний каталог). Усе інше за замовчуванням закрите. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Рівень РОЛІ: достатньо однієї з перелічених. Рівень ВЛАСНОСТІ сюди не належить — див. OrdersService. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  // AuthGuard — глобальний, тож до обробника без user не дійти; якщо дійшло —
  // це баг конфігурації гарда, а не клієнтська помилка.
  if (!req.user) throw new Error('CurrentUser використано на @Public() маршруті');
  return req.user;
});
