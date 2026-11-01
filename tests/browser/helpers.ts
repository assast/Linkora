import { expect, type Page, type APIRequestContext } from '@playwright/test';

export const origin = process.env.E2E_ORIGIN || 'http://127.0.0.1:5173';
const email = 'owner@example.test', password = 'Test-only-password-2026!';

export async function ownerApi(request: APIRequestContext) {
  const health = await request.get('/api/v1/health');
  expect((await health.json()).verification, '浏览器写入测试只能运行于隔离验证服务').toBe(true);
  const login = await request.post('/api/v1/auth/login', { headers: { Origin: origin }, data: { email, password } });
  expect(login.ok()).toBeTruthy();
  const csrf = (await login.json()).csrfToken;
  return async (method: string, path: string, data?: unknown) => request.fetch('/api/v1' + path, { method, data, headers: { Origin: origin, 'X-CSRF-Token': csrf } });
}

export async function loginPage(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.account-banner')).toContainText('已登录');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

