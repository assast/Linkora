import { expect, test, type Page } from '@playwright/test';

const books = Array.from({ length: 3 }, (_, index) => ({ id: `book-${index}`, title: `测试书签 ${index}`,
  url: `https://bookmark.example.test/${index}`, description: '', notes: '', categoryId: index ? 'child' : 'category',
  categoryPath: index ? '测试分类 / 子分类' : '测试分类', tags: ['测试标签'], isPrivate: false, effectivePrivate: false,
  inheritedPrivate: false, isFavorite: false, visitCount: 0, createdAt: '2026-10-31', updatedAt: '2026-10-31' }));

test.beforeEach(async ({ context }) => {
  const bookmarks = structuredClone(books);
  await context.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    const book = bookmarks.find(book => path.endsWith('/bookmarks/' + book.id));
    if (book && route.request().method() === 'PATCH') Object.assign(book, route.request().postDataJSON());
    const data = path.endsWith('/auth/me') ? { authenticated: false }
      : path.endsWith('/home') ? { frequent: [], recent: [], counts: { bookmarks: 3, categories: 1, favorites: 0 } }
      : path.endsWith('/categories/tree') ? [{ id: 'category', name: '测试分类', path: '测试分类', count: 3, children: [] }]
      : path.endsWith('/bookmarks') ? { items: bookmarks, total: 3, page: 1, pageSize: 50 } : book || [];
    return route.fulfill({ json: data });
  });
});

async function expectBookmarkPopup(page: Page, click: () => Promise<unknown>, expectedUrl = books[0].url) {
  const popupPromise = page.context().waitForEvent('page', { timeout: 4_000 });
  await click();
  const popup = await popupPromise;
  await popup.waitForURL(expectedUrl, { timeout: 5_000 });
  expect(page.context().pages()).toHaveLength(2);
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
}

for (const view of ['卡片', '列表']) {
  const selector = view === '卡片' ? '.bookmark-tile' : '.bookmark-row';
  test(`${view}的空白、图标和内容区域均可访问书签，登录按钮独立操作`, async ({ page, context, isMobile }) => {
    await context.route('https://bookmark.example.test/**', route => route.fulfill({ body: '<title>测试书签</title>' }));
    await page.goto('/bookmarks');
    await page.getByRole('button', { name: `紧凑${view}` }).click();
    const item = page.locator(selector).first();
    await expect(item).toBeVisible();
    await expectBookmarkPopup(page, () => item.click({ position: { x: 3, y: 3 } }));
    for (const selector of ['.fav-ico', '.tile-domain', '.tile-bottom>span', '.bookmark-category', '.bookmark-tags', '.bookmark-date']) {
      const content = item.locator(selector);
      if (await content.isVisible()) await expectBookmarkPopup(page, () => content.click({ force: true }));
    }
    const link = item.locator('a.bookmark-surface-link');
    await expect(link).toHaveAttribute('href', books[0].url);
    await link.focus();
    await expectBookmarkPopup(page, () => page.keyboard.press('Enter'));
    if (!isMobile) {
      // Chrome 中键新标签页的首次请求可能绕过路由拦截，使用本地页面验证。
      const localUrl = new URL('/home', page.url()).href;
      await link.evaluate((anchor, url) => anchor.setAttribute('href', url), localUrl);
      await expectBookmarkPopup(page, () => item.click({ position: { x: 3, y: 3 }, button: 'middle' }), localUrl);
    }
    await item.getByRole('button', { name: '登录后编辑' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(context.pages()).toHaveLength(1);
  });

  test(`${view}的选择、星标和编辑不触发书签访问，访问次数只记录一次`, async ({ page, context }) => {
    await context.route('**/api/v1/auth/me', route => route.fulfill({ json: { authenticated: true, owner: { id: 'owner', email: 'owner@example.test' } } }));
    await context.route('**/api/v1/preferences', route => route.fulfill({ json: { theme: 'light', defaultEngine: 'google', defaultView: 'grid', expandedCategories: [] } }));
    await context.route('https://bookmark.example.test/**', route => route.fulfill({ body: '<title>测试书签</title>' }));
    const visits: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/bookmarks/book-0/visits')) visits.push(request.url()); });
    await page.goto('/bookmarks');
    await page.getByRole('button', { name: `紧凑${view}` }).click();
    const item = page.locator(selector).first();
    await expectBookmarkPopup(page, () => item.click({ position: { x: 3, y: 3 } }));
    await expect.poll(() => visits.length).toBe(1);
    await expectBookmarkPopup(page, () => item.locator('a.bookmark-surface-link').click());
    await expect.poll(() => visits.length).toBe(2);
    await page.getByRole('button', { name: '多选', exact: true }).click();
    await item.getByRole('checkbox', { name: '选择 测试书签 0' }).check();
    await expect(page.locator('.bulk-bar')).toBeVisible();
    await item.getByRole('button', { name: '添加星标 测试书签 0' }).click();
    await expect(item.getByRole('button', { name: '取消星标 测试书签 0' })).toBeVisible();
    await item.getByRole('link', { name: '编辑 测试书签 0' }).click();
    await expect(page).toHaveURL(/\/bookmarks\/book-0\/edit$/);
    await expect(page.getByLabel('书签名称')).toHaveValue('测试书签 0');
    expect(context.pages()).toHaveLength(1);
    expect(visits).toHaveLength(2);
  });
}

test('卡片作为默认视图，切换后刷新和新标签页记住选择', async ({ page, context }) => {
  await page.goto('/bookmarks');
  await expect(page.locator('.bookmark-tile')).toHaveCount(3);
  await page.getByRole('button', { name: '紧凑列表' }).click();
  await page.reload();
  await expect(page.locator('.bookmark-row')).toHaveCount(3);
  const next = await context.newPage();
  await next.goto('/bookmarks');
  await expect(next.locator('.bookmark-row')).toHaveCount(3);
  await next.close();
  await page.getByRole('button', { name: '紧凑卡片' }).click();
  await page.reload();
  await expect(page.locator('.bookmark-tile')).toHaveCount(3);
});

test('打开分类全部书签使用独立标签页并解除 opener', async ({ page, context }) => {
  await context.route('https://bookmark.example.test/**', route => route.fulfill({ body: '<title>测试书签</title>' }));
  await page.goto('/bookmarks?categoryId=category');
  const button = page.getByRole('button', { name: '打开全部书签', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => context.pages().length).toBe(4);
  const opened = context.pages().filter(tab => tab !== page);
  for (let i = 0; i < opened.length; i++) {
    await opened[i].waitForURL(books[i].url);
    expect(await opened[i].evaluate(() => window.opener)).toBeNull();
  }
  await expect(page).toHaveURL(/\/bookmarks\?categoryId=category$/);
});

test('首页搜索按钮的文字和箭头在同一行居中', async ({ page }, info) => {
  await page.goto('/home');
  const button = page.locator('.engine-search button');
  await expect(button).toBeVisible();
  const layout = await button.evaluate(element => {
    const range = document.createRange(); range.selectNode(element.firstChild!);
    const text = range.getBoundingClientRect(), icon = element.querySelector('svg')!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { centerOffset: Math.abs(text.y + text.height / 2 - icon.y - icon.height / 2),
      sameLine: text.right <= icon.left, inside: icon.right <= box.right && icon.bottom <= box.bottom };
  });
  expect(layout.centerOffset).toBeLessThan(4);
  expect(layout.sameLine).toBe(true);
  expect(layout.inside).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('search-button.png') });
});
