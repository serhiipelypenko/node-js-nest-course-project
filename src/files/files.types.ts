// hw-26: allowlist типів. Розширення ключа береться ЗВІДСИ за contentType,
// а не з filename клієнта: так у ключ не може потрапити ні `../`, ні `.php`.
export const CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  // дампи з ДЗ #15 і довільні великі файли: розширення фіксоване, не від клієнта
  'application/octet-stream': 'bin',
} as const;

export type AllowedContentType = keyof typeof CONTENT_TYPES;

export interface PartInfo {
  part_number: number;
  length: number;
  url: string;
}

export interface UploadDescriptor {
  id: string;
  key: string;
  status: 'PENDING' | 'COMPLETED';
  /** Скільки секунд живуть URL у відповіді (для частин — свій строк). */
  expires_in: number;
  // одиночний PUT
  method?: 'PUT';
  url?: string;
  headers?: Record<string, string>;
  // multipart
  multipart?: {
    upload_id: string;
    part_size: number;
    part_count: number;
    parts: PartInfo[];
  };
}

export interface FileRow {
  id: string;
  key: string;
  owner_id: string;
  status: 'PENDING' | 'COMPLETED';
  content_type: string;
  size: string; // bigint -> string у pg
  upload_id: string | null;
  etag: string | null;
}
