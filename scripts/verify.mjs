import { testDatabaseUrl } from './db-env.mjs';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.LOGIN_LIMIT = '1000';
process.argv.push('--no-watch');
await import('./dev.mjs');
