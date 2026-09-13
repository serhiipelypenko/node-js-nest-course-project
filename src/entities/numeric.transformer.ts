import type { ValueTransformer } from 'typeorm';

// pg повертає numeric(12,2) РЯДКОМ ('123.45'), бо не довіряє точності number
// для довільної точності (те саме, що bigint -> рядок для id). Суми в цьому
// домені — грошові величини з max 12 цифр і 2 знаками після коми, тобто
// сильно всередині Number.isSafeInteger-діапазону навіть у копійках, тож
// перетворення в number тут безпечне і зручніше для seed/demo/report.
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) =>
    value === null || value === undefined ? value : Number(value),
};
