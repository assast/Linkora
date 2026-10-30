import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function testDatabaseUrl() {
  const value = process.env.TEST_DATABASE_URL;
  if (!value || !decodeURIComponent(new URL(value).pathname).endsWith('_test')) {
    throw new Error('测试必须指定以 _test 结尾的独立 TEST_DATABASE_URL');
  }
  return value;
}
