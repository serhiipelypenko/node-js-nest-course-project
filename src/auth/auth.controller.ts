import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AuthUser, TokenPair } from './auth.types';
import { CurrentUser, Public } from './decorators';

// Форму тіл (email/password, refresh_token) перевіряє спека через
// express-openapi-validator — ручних `if` тут немає, як і в решті контролерів.
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { email: string; password: string }): Promise<TokenPair> {
    return this.auth.login(body.email, body.password);
  }

  // Публічний: access-токен на момент refresh зазвичай уже протух.
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: { refresh_token: string }): Promise<TokenPair> {
    return this.auth.refresh(body.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.logout(user);
  }
}
