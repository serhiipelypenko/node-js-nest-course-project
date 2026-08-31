import { BadRequestException } from '@nestjs/common';

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// Курсор — непрозорий для клієнта base64url від зсуву (offset) в
// уже відсортованому масиві. Клієнту заборонено його розбирати чи
// формувати самому — лише передавати назад те, що прийшло в next_cursor.
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): number {
  const offset = Number(Buffer.from(raw, 'base64url').toString('utf8'));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new BadRequestException({
      code: 'bad-cursor',
      detail: 'cursor не розпізнано — він непрозорий і належить серверу',
    });
  }
  return offset;
}

export function paginate<T>(all: T[], limit: number, cursor?: string): Page<T> {
  const offset = cursor ? decodeCursor(cursor) : 0;
  const items = all.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    next_cursor: nextOffset < all.length ? encodeCursor(nextOffset) : null,
  };
}
