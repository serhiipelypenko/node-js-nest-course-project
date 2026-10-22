import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard, RolesGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

// Global: AuthService потрібен WS-gateway з OrdersModule, а гарди — всьому застосунку.
// Порядок APP_GUARD важливий: спершу автентифікація (401), потім роль (403).
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    TokenService,
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
