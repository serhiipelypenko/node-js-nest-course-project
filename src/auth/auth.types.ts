import type { Request } from 'express';

export const ROLES = ['customer', 'seller', 'admin'] as const;
export type Role = (typeof ROLES)[number];

// Що гард кладе в req.user після перевірки підпису, exp і денилиста.
// role тут — КЕШ із токена, а не джерело правди (див. README «Auth»).
export interface AuthUser {
  id: string; // users.id (sub)
  role: Role;
  jti: string; // для денилиста при логауті
  exp: number; // unix-секунди — TTL запису в денилисті = exp - now
  fid: string; // family_id refresh-токенів цієї сесії
}

export type AuthedRequest = Request & { user?: AuthUser };

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}
