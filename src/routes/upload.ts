import type { FastifyInstance } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const UPLOAD_DIR = join(process.cwd(), 'public', 'uploads');

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  app.post('/api/upload', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ ok: false, error: 'No file uploaded' });

    const ext = extname(file.filename) || '.bin';
    const filename = `${randomUUID()}${ext}`;
    const filepath = join(UPLOAD_DIR, filename);

    await pipeline(file.file, createWriteStream(filepath));

    return { ok: true, url: `/uploads/${filename}`, filename: file.filename };
  });
}