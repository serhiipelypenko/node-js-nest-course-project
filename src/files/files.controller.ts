import { Body, Controller, Get, Headers, HttpCode, Param, Post, Redirect } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { FilesService } from './files.service';

// Усі маршрути ЗАКРИТІ глобальним AuthGuard (401); @Roles — рівень ролі (403);
// власність файла перевіряє сервіс (гард ресурсу не знає). Тіло intent валідує
// zod у сервісі: ці маршрути поза openapi.yaml (як /auth/*, ignoreUndocumented).
@Controller()
@Roles('customer', 'seller', 'admin')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('uploads/intent')
  @HttpCode(200)
  intent(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.files.intent(user, body, idempotencyKey);
  }

  @Get('uploads/:id/parts')
  parts(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.files.parts(user, id);
  }

  @Post('uploads/commit')
  @HttpCode(200)
  commit(@CurrentUser() user: AuthUser, @Body() body: { id?: string }) {
    return this.files.commit(user, String(body?.id ?? ''));
  }

  @Get('files/:id')
  @Redirect()
  async download(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return { url: await this.files.downloadUrl(user, id), statusCode: 302 };
  }
}
