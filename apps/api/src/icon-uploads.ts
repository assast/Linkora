import { BadRequestException, Global, Module, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { AppConfig } from './config';
import { AuthModule } from './auth';
import { ICON_MAX_BYTES, validateIcon, type CachedIcon } from './site-icons';
import { writeIconFile } from './icon-files';

export const ICON_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export interface IconUpload { buffer: Buffer; mimetype: string }
export interface UploadReference { bookmarkId: string; uploadKey: string | null }

function animatedPng(bytes: Buffer) {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}

export async function normalizeIconUpload(file: IconUpload): Promise<Buffer> {
  if (file.buffer.length > ICON_UPLOAD_MAX_BYTES) throw new PayloadTooLargeException('图标文件不能超过 2 MiB');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype) || !validateIcon(file.buffer.subarray(0, 16), file.mimetype)) {
    throw new BadRequestException('请上传 PNG、JPEG 或 WebP 静态图片');
  }
  try {
    const decoder = sharp(file.buffer, { limitInputPixels: 4096 * 4096, animated: true, failOn: 'warning' });
    const info = await decoder.metadata();
    if (!info.width || !info.height || info.width > 4096 || info.height > 4096 || (info.pages || 1) > 1
      || info.format === 'png' && animatedPng(file.buffer)) throw new Error('尺寸或动画不支持');
    const bytes = await decoder.rotate().resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
    if (bytes.length > ICON_MAX_BYTES) throw new Error('归一化图片过大');
    return bytes;
  } catch { throw new BadRequestException('图片损坏、包含动画或尺寸超过 4096 像素'); }
}

export class IconUploads {
  constructor(readonly directory: string) {}

  async prepare(bookmarkId: string, file: IconUpload) {
    const bytes = await normalizeIconUpload(file);
    const uploadKey = randomUUID();
    await writeIconFile(join(this.directory, bookmarkId), `${uploadKey}.webp`, bytes);
    return uploadKey;
  }

  async read(bookmarkId: string, uploadKey: string | null): Promise<CachedIcon | null> {
    if (!uploadKey || !/^[a-f0-9-]{36}$/.test(bookmarkId) || !/^[a-f0-9-]{36}$/.test(uploadKey)) return null;
    try {
      const bytes = await readFile(join(this.directory, bookmarkId, `${uploadKey}.webp`));
      return validateIcon(bytes, 'image/webp') ? { bytes, mediaType: 'image/webp' } : null;
    } catch { return null; }
  }

  async removeMany(references: UploadReference[]) {
    await Promise.all(references.filter(item => item.uploadKey).map(item =>
      rm(join(this.directory, item.bookmarkId, `${item.uploadKey}.webp`), { force: true }).catch(() => undefined)));
  }
}

@Global()
@Module({ imports: [AuthModule], providers: [{ provide: IconUploads, useFactory: (config: AppConfig) => new IconUploads(config.iconUploadDir), inject: [AppConfig] }], exports: [IconUploads] })
export class IconUploadsModule {}
