import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { origin, ownerApi, loginPage } from './helpers';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6XcAAAAASUVORK5CYII=', 'base64');

test('图标库、上传、恢复自动与批量进度在桌面和移动端正常使用', async ({ page, request }, info) => {
  const call = await ownerApi(request), suffix = 'icons-' + randomUUID().slice(0, 8);
  const created = await call('POST', '/bookmarks', { title: suffix, url: 'http://localhost/' + suffix });
  expect(created.ok()).toBeTruthy(); const id = (await created.json()).id;
  let config = { source: 'auto', version: null as string | null, dashboardId: null as string | null, iconifyId: null as string | null, uploaded: false };
  let autoReady = false, complete = false, active = false, total = 1, jobId = randomUUID();
  const scopes: unknown[] = [], remoteImages: string[] = [], imageRequests: string[] = [];
  page.on('request', current => { if (current.resourceType() === 'image' && new URL(current.url()).origin !== origin) remoteImages.push(current.url()); });
  const job = () => ({ id: jobId, state: complete ? 'completed' : 'running', total, processed: complete ? total : 0,
    success: complete ? 1 : 0, failed: complete && total > 1 ? 1 : 0, skipped: complete && total > 1 ? 1 : 0,
    totalOrigins: 1, processedOrigins: complete ? 1 : 0, page: 1, pageSize: 24,
    results: !complete ? [] : [{ id, title: suffix, status: 'success', reason: 'success' }, ...(total > 1 ? [
      { id: randomUUID(), title: '保留的人工图标', status: 'skipped', reason: 'manual' },
      { id: randomUUID(), title: '暂不可用站点', status: 'failed', reason: 'failed' },
    ] : [])] });
  await page.route(/\/api\/v1\/bookmarks\/[^/]+\/icon(?:-config|-upload)?(?:\?|$)/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/icon-config')) {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON(); expect(body.expectedVersion).toBe(config.version);
        config = { source: body.source, version: randomUUID(), dashboardId: body.dashboardId || null, iconifyId: body.iconifyId || null, uploaded: false };
      }
      return route.fulfill({ json: config });
    }
    if (path.endsWith('/icon-upload')) {
      expect(route.request().headers()['content-type']).toContain('multipart/form-data; boundary=');
      expect(route.request().postDataBuffer()?.includes(Buffer.from('expectedVersion'))).toBe(true);
      config = { source: 'upload', version: randomUUID(), dashboardId: null, iconifyId: null, uploaded: true };
      return route.fulfill({ status: 201, json: config });
    }
    imageRequests.push(route.request().url());
    return config.source === 'auto' && !autoReady ? route.fulfill({ status: 204 }) : route.fulfill({ contentType: 'image/png', body: image });
  });
  await page.route('**/api/v1/icon-library**', route => {
    const url = new URL(route.request().url());
    return url.pathname.endsWith('/preview') ? route.fulfill({ contentType: 'image/png', body: image })
      : route.fulfill({ json: { items: url.searchParams.get('source') === 'iconify' ? [{ id: 'mdi:github', name: 'github' }] : [{ id: 'github-light', name: 'GitHub Light' }], total: 1, page: 1, pageSize: 24 } });
  });
  await page.route('**/api/v1/icon-refresh-jobs**', route => {
    if (route.request().method() === 'POST') {
      const scope = route.request().postDataJSON(); scopes.push(scope);
      if (active) return route.fulfill({ status: 409, json: { message: '已有任务', jobId } });
      total = scope.scope === 'all' ? 3 : 1; jobId = randomUUID(); active = true; complete = false;
      return route.fulfill({ status: 202, json: job() });
    }
    if (complete) { active = false; autoReady = true; }
    return route.fulfill({ json: job() });
  });
  try {
    await page.goto(`/bookmarks/${id}/edit`); await loginPage(page);
    const panel = page.getByRole('region', { name: '书签图标设置' });
    await expect(panel.getByText('自动 Favicon', { exact: true })).toBeVisible();
    await expect(page.locator('.preview-inline img')).toHaveCount(0);
    await page.getByLabel('书签名称').fill('尚未保存的名称');
    await panel.getByRole('button', { name: '从图标库选择' }).click();
    await page.getByLabel('搜索图标库').fill('github');
    await page.getByRole('button', { name: '选择图标 github-light' }).click();
    await page.screenshot({ path: info.outputPath('icon-library.png') });
    await page.getByRole('button', { name: '应用图标', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(panel.getByText('Dashboard Icons', { exact: true })).toBeVisible();
    await expect(page.locator('.preview-inline img')).toHaveJSProperty('naturalWidth', 1);
    await expect(page.getByLabel('书签名称')).toHaveValue('尚未保存的名称');
    await panel.getByRole('button', { name: '从图标库选择' }).click();
    await page.getByRole('combobox', { name: '图标来源' }).selectOption('iconify');
    await expect(page.getByRole('button', { name: '应用图标', exact: true })).toBeDisabled();
    await expect(page.getByText('输入关键词，搜索 Iconify 图标。')).toBeVisible();
    await page.getByLabel('搜索图标库').fill('github');
    await page.getByRole('button', { name: '选择图标 mdi:github' }).click();
    await expect(page.getByRole('button', { name: '选择图标 mdi:github' }).locator('img')).toHaveJSProperty('naturalWidth', 1);
    await page.screenshot({ path: info.outputPath('iconify-library.png') });
    await page.getByRole('button', { name: '应用图标', exact: true }).click();
    await expect(panel.getByText('Iconify', { exact: true })).toBeVisible();
    await expect(panel.getByText('mdi:github', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '从图标库选择' }).click();
    await expect(page.getByRole('combobox', { name: '图标来源' })).toHaveValue('iconify');
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    await page.getByLabel('上传书签图标').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: image });
    await expect(page.getByAltText('待应用的上传图标')).toBeVisible();
    await page.getByRole('button', { name: '应用上传图标' }).click();
    await expect(panel.getByText('自定义上传', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '恢复自动' }).click();
    await expect(panel.getByText('自动 Favicon', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '刷新自动图标', exact: true }).click();
    await expect(page.getByText('正在刷新自动图标', { exact: true })).toBeVisible();
    expect(scopes[0]).toEqual({ scope: 'selected', bookmarkIds: [id] });
    complete = true;
    await expect(page.getByText('自动图标刷新已完成', { exact: true })).toBeVisible();
    await expect(page.locator('.preview-inline img')).toHaveJSProperty('naturalWidth', 1);
    expect(imageRequests.some(url => url.includes('?v='))).toBe(true);
    await page.goto('/bookmarks?keyword=' + suffix);
    await page.getByRole('button', { name: '刷新全库图标' }).click();
    await expect.poll(() => scopes.at(-1)).toEqual({ scope: 'all' }); complete = true;
    await expect(page.getByText('自动图标刷新已完成', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看刷新结果' }).click();
    await expect(page.getByRole('dialog', { name: '图标刷新结果' })).toBeVisible();
    await expect(page.getByText('保留人工图标', { exact: true })).toBeVisible();
    await expect(page.getByText('抓取失败，保留旧图', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('icon-refresh-results.png') });
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    expect(remoteImages).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (info.project.name.endsWith('mobile')) await page.getByRole('button', { name: '打开分类导航' }).click();
    await page.getByRole('button', { name: '账号菜单', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.locator('.icon-refresh-notice')).toHaveCount(0);
  } finally { await call('DELETE', '/bookmarks/' + id); }
});
