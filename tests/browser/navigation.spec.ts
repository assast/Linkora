import { expect, test } from '@playwright/test';

const books = Array.from({ length: 3 }, (_, index) => ({ id: `book-${index}`, title: `测试书签 ${index}`,
  url: `https://bookmark.example.test/${index}`, description: '', notes: '', categoryId: index ? 'child' : 'category',
  categoryPath: index ? '测试分类 / 子分类' : '测试分类', tags: [], isPrivate: false, effectivePrivate: false,
  inheritedPrivate: false, isFavorite: false, visitCount: 0, createdAt: '2026-10-31', updatedAt: '2026-10-31' }));

test.beforeEach(async ({ context }) => {
  await context.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/auth/me') ? { authenticated: false }
      : path.endsWith('/home') ? { frequent: [], recent: [], counts: { bookmarks: 3, categories: 1, favorites: 0 } }
      : path.endsWith('/categories/tree') ? [{ id: 'category', name: '测试分类', path: '测试分类', count: 3, children: [] }]
      : path.endsWith('/bookmarks') ? { items: books, total: 3, page: 1, pageSize: 50 } : [];
    return route.fulfill({ json: data });
  });
});

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
