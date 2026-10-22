import { Body, Controller, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Public, Roles } from '../auth/decorators';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  // Каталог читають усі, навіть анонімно.
  @Public()
  @Get()
  list(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.products.list(limit, cursor);
  }

  @Public()
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.products.getById(id);
  }

  // Рівень РОЛІ: запис у каталог — лише продавцю/адміну. Покупець із валідним
  // токеном отримує 403 від RolesGuard ще до цього методу.
  @Roles('seller', 'admin')
  @Post()
  @HttpCode(201)
  create(@Body() body: { name: string; price_cents: number }) {
    return this.products.create(body.name, body.price_cents);
  }
}
