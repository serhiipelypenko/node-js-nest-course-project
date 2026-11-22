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

// Keyset-курсор для вибірок із БД: base64url від id останнього елемента
// попередньої сторінки (`WHERE id > $cursor ORDER BY id LIMIT n+1`). На відміну
// від offset, не дублює й не губить рядки, коли між запитами сторінок щось
// вставили. Для клієнта лишається непрозорим — той самий `bad-cursor` на сміття.
export function encodeKeyCursor(lastId: string): string {
  return Buffer.from(lastId, 'utf8').toString('base64url');
}

export function decodeKeyCursor(raw: string): string {
  const id = Buffer.from(raw, 'base64url').toString('utf8');
  if (!/^\d{1,18}$/.test(id)) {
    throw new BadRequestException({
      code: 'bad-cursor',
      detail: 'cursor не розпізнано — він непрозорий і належить серверу',
    });
  }
  return id;
}

// rows — результат запиту з `LIMIT limit + 1`: зайвий рядок = «є наступна сторінка».
export function keysetPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor: rows.length > limit ? encodeKeyCursor(items[items.length - 1]!.id) : null,
  };
}
