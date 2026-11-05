import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.schema';
import { makeS3 } from '../storage/s3';

// Тонка обгортка над S3: клієнт + підпис. URL тут лише ПІДПИСУЮТЬСЯ (локальна
// математика, у мережу SDK не ходить) — байти через цей сервіс не течуть.
@Injectable()
export class StorageService implements OnModuleDestroy {
  readonly s3: S3Client;
  readonly bucket: string;
  readonly putExpires: number;
  readonly partExpires: number;
  readonly getExpires: number;
  readonly multipartThreshold: number;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('STORAGE_BUCKET', { infer: true });
    this.putExpires = config.get('STORAGE_PUT_EXPIRES_SEC', { infer: true });
    this.partExpires = config.get('STORAGE_PART_EXPIRES_SEC', { infer: true });
    this.getExpires = config.get('STORAGE_GET_EXPIRES_SEC', { infer: true });
    this.multipartThreshold = config.get('STORAGE_MULTIPART_THRESHOLD', { infer: true });
    this.s3 = makeS3({
      endpoint: config.get('STORAGE_ENDPOINT', { infer: true }),
      region: config.get('STORAGE_REGION', { infer: true }),
      accessKey: config.get('STORAGE_ACCESS_KEY', { infer: true }),
      secretKey: config.get('STORAGE_SECRET_KEY', { infer: true }),
      bucket: this.bucket,
    });
  }

  /** Content-Type входить у підпис: клієнт мусить надіслати саме його. */
  presignPut(key: string, contentType: string, expiresIn = this.putExpires): Promise<string> {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn },
    );
  }

  presignPart(key: string, uploadId: string, partNumber: number, expiresIn = this.partExpires): Promise<string> {
    return getSignedUrl(
      this.s3,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn },
    );
  }

  presignGet(key: string, expiresIn = this.getExpires): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }
}
