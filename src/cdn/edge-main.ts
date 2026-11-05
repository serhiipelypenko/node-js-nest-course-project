// Окремий запуск edge: `bash scripts/with-secrets.sh dev node dist/cdn/edge-main.js`.
// Порт — EDGE_PORT (за замовчуванням ефемерний), адреса друкується.
import { makeS3, storageFromEnv } from '../storage/s3';
import { startEdge } from './edge';

const cfg = storageFromEnv();
void startEdge(makeS3(cfg), cfg.bucket).then(({ port }) => console.log(`edge: http://127.0.0.1:${port}/assets/<ключ>`));
