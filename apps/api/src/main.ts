import { createApplication } from './app';

async function main() {
  const app = await createApplication();
  await app.listen(Number(process.env.PORT || 3000), process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'));
}
main().catch(() => { console.error('应用启动失败，请检查数据库与站点配置'); process.exitCode = 1; });
