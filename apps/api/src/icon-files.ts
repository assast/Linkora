import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const iconHash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export async function writeIconFile(directory: string, name: string, bytes: Buffer | string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
