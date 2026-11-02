import { expect, test, type Page } from '@playwright/test';

const books = Array.from({ length: 3 }, (_, index) => ({ id: `book-${index}`, title: `测试书签 ${index}`,
  url: `https://bookmark.example.test/${index}`, url2: index === 0 ? 'https://alternate.example.test/0' : null, description: '', notes: '', categoryId: index ? 'child' : 'category',
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

test('显示设置在卡片、列表和分类树生效，刷新保留，工作空间可全部隐藏再恢复', async ({ page, isMobile }) => {
  await page.goto('/bookmarks');
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '显示设置' });
  await dialog.getByLabel('书签字号').focus();
  await page.keyboard.press('End');
  await dialog.getByLabel('分类字号').focus();
  await page.keyboard.press('Home');
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
  await expect(dialog.locator('.preference-preview-bookmark')).toHaveCSS('font-size', '20px');
  await expect(dialog.locator('.preference-preview-category')).toHaveCSS('font-size', '16px');
  await page.screenshot({ path: test.info().outputPath('display-preferences.png'), fullPage: true });
  await dialog.getByRole('checkbox', { name: '星标收藏', exact: true }).uncheck();
  await dialog.getByRole('button', { name: '保存设置' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.bookmark-tile .tile-name > a').first()).toHaveCSS('font-size', '20px');
  await expect(page.locator('.bookmark-tile .tile-bottom > span').first()).toHaveCSS('font-size', '16px');
  await page.getByRole('button', { name: '紧凑列表' }).click();
  await expect(page.locator('.bookmark-name strong').first()).toHaveCSS('font-size', '20px');
  if (!isMobile) await expect(page.locator('.bookmark-row .bookmark-category').first()).toHaveCSS('font-size', '16px');
  await page.reload();
  await expect(page.locator('.bookmark-name strong').first()).toHaveCSS('font-size', '20px');
  if (isMobile) await page.getByRole('button', { name: '打开分类导航' }).click();
  await expect(page.locator('.tree-main').first()).toHaveCSS('font-size', '16px');
  const workspace = page.getByRole('navigation', { name: '工作空间', exact: true });
  await expect(workspace.getByRole('button', { name: /星标收藏/ })).toHaveCount(0);
  if (isMobile) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await dialog.getByRole('switch', { name: '显示工作空间' }).uncheck();
  await dialog.getByRole('button', { name: '保存设置' }).click();
  await expect(workspace).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '多级分类树' })).toHaveCount(1);
  await page.reload();
  await expect(workspace).toHaveCount(0);
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await dialog.getByRole('switch', { name: '显示工作空间' }).check();
  await expect(dialog.getByRole('checkbox', { name: '星标收藏', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: '恢复默认' }).click();
  await dialog.getByRole('button', { name: '保存设置' }).click();
  await expect(workspace.getByRole('button')).toHaveCount(3);
  await expect(page.locator('.bookmark-name strong').first()).toHaveCSS('font-size', '12px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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

test('统一地址切换保留单地址回退、原生链接和浏览器记忆', async ({ page, context, isMobile }, info) => {
  await context.route('https://{bookmark,alternate}.example.test/**', route => route.fulfill({ body: '<title>地址切换测试</title>' }));
  await page.goto('/bookmarks');
  const mode = page.getByRole('combobox', { name: '访问地址' });
  await expect(mode).toHaveValue('url');
  await expect(page.getByRole('link', { name: books[0].title, exact: true })).toBeVisible();
  if (!isMobile) {
    await page.getByRole('combobox', { name: '排序' }).focus();
    await page.keyboard.press('Tab');
    await expect(mode).toBeFocused();
  }
  await mode.selectOption('url2');
  await expect(mode).toHaveValue('url2');
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  for (const view of ['列表', '卡片']) {
    await page.getByRole('button', { name: `紧凑${view}` }).click();
    for (const value of ['url', 'url2']) {
      await mode.selectOption(value);
      const double = page.getByRole('link', { name: books[0].title, exact: true });
      await expect(double).toHaveAttribute('href', value === 'url2' ? books[0].url2! : books[0].url);
      const surface = double.locator('xpath=ancestor::*[contains(@class,"bookmark-row") or contains(@class,"bookmark-tile")][1]');
      await expect(surface).toContainText(value === 'url2' ? 'alternate.example.test' : 'bookmark.example.test');
      await expect(page.getByRole('link', { name: books[1].title, exact: true })).toHaveAttribute('href', books[1].url);
    }
  }
  expect(writes).toEqual([]);
  await expectBookmarkPopup(page, () => page.getByRole('link', { name: books[0].title, exact: true }).click(), books[0].url2!);
  await page.getByRole('link', { name: books[1].title, exact: true }).focus();
  await expectBookmarkPopup(page, () => page.keyboard.press('Enter'), books[1].url);
  await page.reload();
  await expect(mode).toHaveValue('url2');
  await expect(page.getByRole('link', { name: books[0].title, exact: true })).toHaveAttribute('href', books[0].url2!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('secondary-url-library.png') });
  await context.route('**/api/v1/home', route => route.fulfill({ json: { frequent: [books[0]], recent: books.slice(0, 2), counts: { bookmarks: 3, categories: 1, favorites: 1 } } }));
  await page.goto('/home');
  for (const selector of ['.quick-item', '.recent-row']) {
    const link = page.locator(selector).filter({ hasText: books[0].title });
    await expect(link).toHaveAttribute('href', books[0].url2!);
    await expect(link).toContainText('alternate.example.test');
  }
});

test('地址2模式跨页打开分类及子分类，单地址逐条回退', async ({ page, context }) => {
  const all = Array.from({ length: 101 }, (_, index) => ({ ...books[0], id: `full-${index}`, title: `跨页书签 ${index}`,
    url: `https://bookmark.example.test/${index}`, url2: index % 2 === 0 ? `https://alternate.example.test/${index}` : null, categoryId: index ? 'child' : 'category' }));
  await context.route('**/api/v1/categories/tree', route => route.fulfill({ json: [{ id: 'category', name: '测试分类', path: '测试分类', count: 101, children: [
    { id: 'child', name: '子分类', path: '测试分类 / 子分类', count: 100, children: [] },
  ] }] }));
  const categoryPages: string[] = [];
  await context.route('**/api/v1/bookmarks**', route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/bookmarks')) return route.fallback();
    const page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 50);
    if (url.searchParams.get('includeDescendants') === 'true') categoryPages.push(url.searchParams.get('page')!);
    return route.fulfill({ json: { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize } });
  });
  await page.addInitScript(() => {
    const opened: { url: string; opener: Window | null; location: { replace: (url: string) => void } }[] = [];
    (window as unknown as { openedBookmarks: typeof opened }).openedBookmarks = opened;
    window.open = () => {
      const tab = { url: '', opener: window as Window | null, location: { replace: (url: string) => { tab.url = url; } } };
      opened.push(tab); return tab as unknown as Window;
    };
  });
  await page.goto('/bookmarks?categoryId=category&keyword=当前筛选&page=2&pageSize=20');
  const button = page.getByRole('button', { name: '打开全部书签', exact: true });
  await expect(button).toBeEnabled();
  await page.getByRole('combobox', { name: '访问地址' }).selectOption('url2');
  await button.click();
  const opened = await page.evaluate(() => (window as unknown as { openedBookmarks: { url: string; opener: Window | null }[] }).openedBookmarks.map(tab => ({ url: tab.url, isolated: tab.opener === null })));
  expect(opened).toHaveLength(101);
  expect(opened[0].url).toBe('https://alternate.example.test/0');
  expect(opened[1].url).toBe('https://bookmark.example.test/1');
  expect(opened[100].url).toBe('https://alternate.example.test/100');
  expect(opened.every(tab => tab.isolated)).toBe(true);
  expect(categoryPages).toEqual(['1', '2']);
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
