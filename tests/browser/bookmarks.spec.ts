import { test, expect } from '@playwright/test';
import { origin, ownerApi, loginPage } from './helpers';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('地址2真实表单保存、统一访问、星标分类与清空回退', async ({ page, request, context }, info) => {
  const call = await ownerApi(request);
  const suffix = 'dual-' + randomUUID().slice(0, 8);
  const ids: string[] = [];
  let categoryId: string | undefined;
  const primary = 'https://primary.example.test/' + suffix, alternate = 'http://internal_service:8080/' + suffix;
  await context.route('**/api/v1/bookmarks/*/icon', route => route.fulfill({ status: 204 }));
  try {
    const category = await call('POST', '/categories', { name: suffix });
    expect(category.ok()).toBeTruthy(); categoryId = (await category.json()).id;
    const single = await call('POST', '/bookmarks', { title: '单地址 ' + suffix, url: primary, categoryId });
    expect(single.ok()).toBeTruthy(); ids.push((await single.json()).id);
    await page.goto('/bookmarks'); await loginPage(page);
    await page.goto('/bookmarks/new');
    await page.getByLabel('书签名称').fill('双地址 ' + suffix);
    await page.getByLabel('网站地址').fill(primary);
    await page.getByLabel('地址2（可选）').fill(alternate);
    await page.getByLabel('所在分类').selectOption(categoryId!);
    await page.getByRole('checkbox', { name: /设为星标书签/ }).check();
    await page.getByRole('button', { name: '保存书签', exact: true }).click();
    await expect(page).toHaveURL(/\/bookmarks\/[a-f0-9-]+\/edit$/);
    const doubleId = page.url().split('/').at(-2)!; ids.push(doubleId);
    await expect(page.getByRole('link', { name: '访问网站' })).toHaveAttribute('href', primary);
    await page.goto('/bookmarks?keyword=' + suffix);
    const mode = page.getByRole('combobox', { name: '访问地址' });
    await mode.selectOption('url2');
    await expect(page.getByRole('link', { name: '双地址 ' + suffix, exact: true })).toHaveAttribute('href', alternate);
    await expect(page.getByRole('link', { name: '单地址 ' + suffix, exact: true })).toHaveAttribute('href', primary);
    const saved = await (await call('GET', '/bookmarks/' + doubleId)).json();
    expect(saved.url).toBe(primary); expect(saved.url2).toBe(alternate); expect(saved.visitCount).toBe(0);
    await page.reload(); await expect(mode).toHaveValue('url2');
    await page.goto('/bookmarks?filter=starred&keyword=' + suffix);
    await expect(page.getByRole('link', { name: '双地址 ' + suffix, exact: true })).toHaveAttribute('href', alternate);
    await expect(page.getByRole('link', { name: '单地址 ' + suffix, exact: true })).toHaveCount(0);
    await page.goto('/bookmarks?categoryId=' + categoryId);
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await expect(mode).toHaveValue('url2');
    await page.goto('/home');
    await expect(page.locator('.quick-item').filter({ hasText: '双地址 ' + suffix })).toHaveAttribute('href', alternate);
    await page.goto(`/bookmarks/${doubleId}/edit`);
    await expect(page.getByRole('link', { name: '访问网站' })).toHaveAttribute('href', alternate);
    await expect(page.getByLabel('地址2（可选）')).toHaveValue(alternate);
    await page.screenshot({ path: info.outputPath('secondary-url-editor.png') });
    const update = page.waitForResponse(response => response.url().endsWith('/bookmarks/' + doubleId) && response.request().method() === 'PATCH');
    await page.getByLabel('地址2（可选）').fill('');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    expect((await update).ok()).toBe(true);
    await expect(page.getByRole('link', { name: '访问网站' })).toHaveAttribute('href', primary);
    await page.reload(); await expect(page.getByLabel('地址2（可选）')).toHaveValue('');
    await page.goto('/bookmarks?keyword=' + suffix);
    await expect(mode).toHaveValue('url2');
    await expect(page.getByRole('link', { name: '双地址 ' + suffix, exact: true })).toHaveAttribute('href', primary);
    await expect(page.getByRole('link', { name: '单地址 ' + suffix, exact: true })).toHaveAttribute('href', primary);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    for (const id of ids) await call('DELETE', '/bookmarks/' + id);
    if (categoryId) await call('DELETE', '/categories/' + categoryId);
  }
});

test('访客搜索、登录融合、退出清理与响应式', async ({ page, request, context }, info) => {
  const call = await ownerApi(request);
  const suffix = 'e2e-' + randomUUID().slice(0, 8);
  const ids: string[] = [];
  const iconRequests: string[] = [], remoteImages: string[] = [];
  page.on('request', current => {
    if (current.resourceType() === 'image' && new URL(current.url()).origin !== origin) remoteImages.push(current.url());
  });
  try {
    for (const isPrivate of [false, true]) {
      const response = await call('POST', '/bookmarks', { title: `${isPrivate ? '私密' : '公开'} ${suffix}`, url: 'https://example.com/' + suffix, isPrivate });
      expect(response.ok()).toBeTruthy(); ids.push((await response.json()).id);
    }
    await context.route('**/api/v1/bookmarks/*/icon', route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
      iconRequests.push(id);
      return id === ids[0]
        ? route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6XcAAAAASUVORK5CYII=', 'base64') })
        : route.fulfill({ status: 204 });
    });
    await page.goto('/bookmarks?keyword=' + suffix);
    await expect(page.getByText(`公开 ${suffix}`, { exact: true })).toBeVisible();
    const publicIcon = page.locator(`img[src="/api/v1/bookmarks/${ids[0]}/icon"]`);
    await expect(publicIcon).toHaveJSProperty('naturalWidth', 1);
    expect(iconRequests).toContain(ids[0]);
    expect(iconRequests).not.toContain(ids[1]);
    expect(remoteImages).toEqual([]);
    await expect(page.getByRole('link').filter({ hasText: `私密 ${suffix}` })).toHaveCount(0);
    await context.route('https://example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Bookmark open test</title>' }));
    const openedPage = page.waitForEvent('popup');
    await page.getByRole('link').filter({ hasText: `公开 ${suffix}` }).first().click();
    const openedBookmark = await openedPage;
    await openedBookmark.waitForLoadState();
    expect(new URL(openedBookmark.url()).hostname).toBe('example.com');
    await openedBookmark.close();
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
    await expect.poll(() => iconRequests.includes(ids[1])).toBe(true);
    const privateIcon = page.locator('.bookmark-row, .bookmark-tile').filter({ hasText: `私密 ${suffix}` }).first().locator('.fav-ico');
    await expect(privateIcon).toContainText('私');
    await expect(privateIcon.locator('img')).toHaveCount(0);
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
  const iconRequests: string[] = [];
  await page.context().route('**/api/v1/bookmarks/*/icon', route => {
    iconRequests.push(new URL(route.request().url()).pathname.split('/').at(-2)!);
    return route.fulfill({ status: 204 });
  });
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
    const beforeUnsavedUrl = iconRequests.length;
    await page.getByLabel('网站地址').fill('https://other.example.com/unsaved/' + suffix);
    await expect(page.locator('.preview-inline img')).toHaveCount(0);
    expect(iconRequests).toHaveLength(beforeUnsavedUrl);
    await page.getByLabel('网站地址').fill('https://example.com/private/' + suffix);
    await page.getByLabel('所在分类').selectOption(categoryId!);
    await expect(page.getByRole('checkbox', { name: /设为私密书签/ })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: /设为私密书签/ })).toBeChecked();
    await page.getByRole('button', { name: '保存书签', exact: true }).click();
    await expect(page).toHaveURL(/\/bookmarks\/[a-f0-9-]+\/edit$/);
    const privateId = page.url().split('/').at(-2)!; ids.push(privateId);
    await expect.poll(() => iconRequests.includes(privateId)).toBe(true);
    const beforeSavedUrlChange = iconRequests.length;
    await page.getByLabel('网站地址').fill('https://changed.example.com/saved/' + suffix);
    await expect(page.locator('.preview-inline img')).toHaveCount(0);
    expect(iconRequests).toHaveLength(beforeSavedUrlChange);
    await page.getByLabel('个人笔记').fill('继承状态保存验证');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
    await expect(page.getByText('书签已保存', { exact: true }).last()).toBeVisible();
    await expect.poll(() => iconRequests.length > beforeSavedUrlChange).toBe(true);
    const saved = await (await call('GET', '/bookmarks/' + privateId)).json();
    expect(saved.isPrivate).toBe(false); expect(saved.effectivePrivate).toBe(true);
    expect(saved.url).toBe('https://changed.example.com/saved/' + suffix);
    await page.screenshot({ path: info.outputPath('owner-editor.png') });
    await page.goto('/bookmarks?keyword=' + suffix);
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await page.getByRole('button', { name: '紧凑列表', exact: true }).click();
    await expect(page.locator('.bookmark-row')).toHaveCount(2);
    await page.getByRole('button', { name: '紧凑卡片', exact: true }).click();
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await expect.poll(async () => (await (await call('GET', '/preferences')).json()).defaultView).toBe('grid');
    await page.reload();
    await expect(page.locator('.bookmark-tile')).toHaveCount(2);
    await page.getByRole('button', { name: '紧凑列表', exact: true }).click();
    await expect.poll(async () => (await (await call('GET', '/preferences')).json()).defaultView).toBe('list');
    await expect(page.locator('.bookmark-row')).toHaveCount(2);
    await page.getByRole('button', { name: '多选', exact: true }).click();
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
