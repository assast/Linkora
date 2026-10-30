import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:5173';
const email = 'owner@example.test', password = 'Test-only-password-2026!';

async function ownerApi(request: APIRequestContext) {
  const health = await request.get('/api/v1/health');
  expect((await health.json()).verification, '浏览器写入测试只能运行于隔离验证服务').toBe(true);
  const login = await request.post('/api/v1/auth/login', { headers: { Origin: origin }, data: { email, password } });
  expect(login.ok()).toBeTruthy();
  const csrf = (await login.json()).csrfToken;
  return async (method: string, path: string, data?: unknown) => request.fetch('/api/v1' + path, { method, data, headers: { Origin: origin, 'X-CSRF-Token': csrf } });
}

async function loginPage(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.account-banner')).toContainText('已登录');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('访客搜索、登录融合、退出清理与响应式', async ({ page, request, context }, info) => {
  const call = await ownerApi(request);
  const suffix = 'e2e-' + randomUUID().slice(0, 8);
  const ids: string[] = [];
  try {
    for (const isPrivate of [false, true]) {
      const response = await call('POST', '/bookmarks', { title: `${isPrivate ? '私密' : '公开'} ${suffix}`, url: 'https://example.com/' + suffix, isPrivate });
      expect(response.ok()).toBeTruthy(); ids.push((await response.json()).id);
    }
    await page.goto('/bookmarks?keyword=' + suffix);
    await expect(page.getByText(`公开 ${suffix}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('link').filter({ hasText: `私密 ${suffix}` })).toHaveCount(0);
    expect((await page.request.get('/api/v1/bookmarks/' + ids[1])).status()).toBe(404);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (info.project.name.endsWith('mobile')) {
      await page.getByRole('button', { name: '打开分类导航' }).click();
      await expect(page.locator('.sidebar')).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(page.locator('.sidebar')).not.toBeInViewport();
    }
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: '想找什么？从这里开始搜索。' })).toBeVisible();
    await expect(page.locator('.quick-grid')).toBeVisible();
    await page.screenshot({ path: info.outputPath('home-light.png') });
    await page.getByRole('button', { name: '切换主题' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await context.route('https://github.com/search?**', route => route.fulfill({ contentType: 'text/html', body: '<title>Search test</title>' }));
    await page.getByRole('button', { name: 'GitHub', exact: true }).click();
    await page.getByLabel('外部搜索关键词').fill('NestJS & pg/中文');
    const popupPromise = page.waitForEvent('popup');
    await page.locator('.engine-search').getByRole('button', { name: '搜索', exact: true }).click();
    const popup = await popupPromise; await popup.waitForURL('https://github.com/search?**');
    const search = new URL(popup.url()); expect(search.searchParams.get('q')).toBe('NestJS & pg/中文'); expect(search.searchParams.get('type')).toBe('repositories'); await popup.close();
    await page.keyboard.press('ControlOrMeta+k'); await expect(page.locator('#library-search')).toBeFocused();
    await page.locator('#library-search').fill(suffix);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('#library-search')).toHaveValue(suffix);
    await loginPage(page);
    await page.goto('/bookmarks?keyword=' + suffix);
    await expect(page.getByRole('link').filter({ hasText: `私密 ${suffix}` })).toBeVisible();
    await page.reload(); await expect(page.getByRole('link').filter({ hasText: `私密 ${suffix}` })).toBeVisible();
    await page.screenshot({ path: info.outputPath('owner-library.png') });
    if (info.project.name.endsWith('mobile')) {
      await page.getByRole('button', { name: '打开分类导航' }).click();
      await page.getByRole('button', { name: '账号菜单', exact: true }).click();
    } else await page.getByRole('button', { name: '已登录', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('banner').getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await page.goto('/bookmarks?keyword=' + suffix);
    await expect(page.getByText(`公开 ${suffix}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('link').filter({ hasText: `私密 ${suffix}` })).toHaveCount(0);
  } finally { for (const id of ids) await call('DELETE', '/bookmarks/' + id); }
});

test('分类、继承私密表单、批量预览与导出删除', async ({ page, request }, info) => {
  const call = await ownerApi(request);
  const suffix = 'e2e-' + randomUUID().slice(0, 8);
  const ids: string[] = [];
  let categoryId: string | undefined;
  try {
    const publicBook = await call('POST', '/bookmarks', { title: '公开 ' + suffix, url: 'https://example.com/' + suffix });
    ids.push((await publicBook.json()).id);
    await page.goto('/bookmarks'); await loginPage(page);
    await page.locator('.page-ops').getByRole('button', { name: '新建分类', exact: true }).click();
    await page.getByLabel('分类名称').fill(suffix);
    await page.getByRole('checkbox', { name: /私密分类/ }).check();
    await page.getByRole('button', { name: '保存分类', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const tree = await (await call('GET', '/categories/tree')).json();
    categoryId = tree.find((item: { name: string }) => item.name === suffix).id;
    await page.locator('.page-ops').getByRole('button', { name: '添加书签', exact: true }).click();
    await page.getByLabel('书签名称').fill('私密 ' + suffix);
    await page.getByLabel('网站地址').fill('https://example.com/private/' + suffix);
    await page.getByLabel('所在分类').selectOption(categoryId!);
    await expect(page.getByRole('checkbox', { name: /设为私密书签/ })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: /设为私密书签/ })).toBeChecked();
    await page.getByRole('button', { name: '保存书签', exact: true }).click();
    await expect(page).toHaveURL(/\/bookmarks\/[a-f0-9-]+\/edit$/);
    const privateId = page.url().split('/').at(-2)!; ids.push(privateId);
    await page.getByLabel('个人笔记').fill('继承状态保存验证');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
    await expect(page.getByText('书签已保存', { exact: true }).last()).toBeVisible();
    const saved = await (await call('GET', '/bookmarks/' + privateId)).json();
    expect(saved.isPrivate).toBe(false); expect(saved.effectivePrivate).toBe(true);
    await page.screenshot({ path: info.outputPath('owner-editor.png') });
    await page.goto('/bookmarks?keyword=' + suffix);
    await expect(page.locator('.bookmark-row')).toHaveCount(2);
    await page.getByRole('button', { name: '紧凑卡片', exact: true }).click();
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await expect.poll(async () => (await (await call('GET', '/preferences')).json()).defaultView).toBe('grid');
    await page.reload();
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await page.getByRole('button', { name: '紧凑列表', exact: true }).click();
    await expect.poll(async () => (await (await call('GET', '/preferences')).json()).defaultView).toBe('list');
    await expect(page.locator('.bookmark-row')).toHaveCount(2);
    await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check();
    await page.getByLabel('批量操作', { exact: true }).selectOption('ADD_TAGS');
    await page.getByLabel('批量标签').fill('界面验证');
    await page.getByRole('button', { name: '预览操作', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '确认应用', exact: true }).click();
    await expect(page.locator('.bulk-bar')).toHaveCount(0);
    for (const id of ids) expect((await (await call('GET', '/bookmarks/' + id)).json()).tags).toContain('界面验证');
    await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check();
    await page.getByLabel('批量操作', { exact: true }).selectOption('EXPORT');
    await page.getByRole('button', { name: '预览操作', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('文件包含 1 条私密书签');
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '确认导出', exact: true }).click();
    const download = await downloading; const path = info.outputPath('selected.json'); await download.saveAs(path);
    const data = JSON.parse(await readFile(path, 'utf8')); expect(data.bookmarks).toHaveLength(2); expect(data.categories).toHaveLength(1);
    await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check();
    await page.getByLabel('批量操作', { exact: true }).selectOption('DELETE');
    await page.getByRole('button', { name: '预览操作', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.bookmark-row')).toHaveCount(2);
    await page.getByRole('button', { name: '预览操作', exact: true }).click();
    await page.getByRole('button', { name: '确认永久删除', exact: true }).click();
    await expect(page.getByRole('heading', { name: '没有找到符合条件的书签' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  } finally {
    for (const id of ids) await call('DELETE', '/bookmarks/' + id);
    if (categoryId) await call('DELETE', '/categories/' + categoryId);
  }
});
