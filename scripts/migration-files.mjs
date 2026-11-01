import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export async function prepareMigrationSchema(schemaPath) {
  const migrations = join(dirname(schemaPath), 'migrations');
  const entries = await readdir(migrations, { withFileTypes: true });
  const ignored = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || existsSync(join(migrations, entry.name, 'migration.sql'))) continue;
    if ((await readdir(join(migrations, entry.name))).length) throw new Error(`迁移目录缺少 migration.sql：${entry.name}`);
    ignored.push(entry.name);
  }
  if (!ignored.length) return { schemaPath, ignored, cleanup: async () => {} };
  const temporary = await mkdtemp(join(tmpdir(), 'linkora-migrations-'));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    const prepared = join(temporary, basename(schemaPath));
    await cp(schemaPath, prepared);
    await mkdir(join(temporary, 'migrations'));
    for (const entry of entries) {
      if (!ignored.includes(entry.name)) await cp(join(migrations, entry.name), join(temporary, 'migrations', entry.name), { recursive: true });
    }
    return { schemaPath: prepared, ignored, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
