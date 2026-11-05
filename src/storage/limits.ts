// hw-26: межі multipart — ПОРАХОВАНІ, а не вписані числом.
//
// S3: частин максимум 10 000; кожна, крім останньої, ≥ 5 МіБ; частина ≤ 5 ГіБ.
// Отже partSize >= ceil(size / 10 000). Жорсткі 5 МіБ у бібліотеці падають на
// файлі понад ~48,8 ГіБ (10 000 × 5 МіБ).
export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
export const MIN_PART = 5 * MIB;
export const MAX_PART = 5 * GIB;
export const MAX_PARTS = 10_000;
/** Стеля розміру файла, який ми взагалі приймаємо (5 ТіБ — межа S3). */
export const MAX_OBJECT = 5 * 1024 * GIB;

/**
 * Розмір частини для файла `size`: не менше 5 МіБ і не менше size/10 000,
 * округлений угору до цілих МіБ (круглі частини — легше дебажити, ListParts читається).
 */
export function computePartSize(size: number): number {
  const needed = Math.ceil(size / MAX_PARTS);
  const rounded = Math.ceil(needed / MIB) * MIB;
  const part = Math.max(MIN_PART, rounded);
  if (part > MAX_PART) throw new RangeError(`файл ${size} Б завеликий для multipart`);
  return part;
}

export const partCount = (size: number, partSize: number): number => Math.ceil(size / partSize);

/** Розмір n-ї (з 1) частини: усі однакові, остання — залишок. */
export function partLength(size: number, partSize: number, n: number): number {
  return Math.min(partSize, size - (n - 1) * partSize);
}
