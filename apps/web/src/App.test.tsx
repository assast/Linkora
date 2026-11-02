import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { AppProvider } from './state';
import { defaults, type Bookmark, type Category, type BookmarkIconConfig } from './types';

const book: Bookmark = { id: 'book-1', title: '测试书签', url: 'https://example.test/one', url2: null, description: '', notes: '',
  categoryId: null, categoryPath: '未分类', tags: [], isPrivate: false, effectivePrivate: false, inheritedPrivate: false,
  isFavorite: false, visitCount: 0, createdAt: '2026-10-31', updatedAt: '2026-10-31' };
let authenticated = false;
let failPreferences = false;
let categories: Category[] = [];
let books = [book];
let iconConfig: BookmarkIconConfig;
let refreshJobState = 'completed';

function renderApp(path = '/bookmarks') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><AppProvider><App /></AppProvider></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear(); authenticated = false; failPreferences = false; categories = []; books = [book];
  iconConfig = { source: 'auto', version: null, dashboardId: null, iconifyId: null, uploaded: false }; refreshJobState = 'completed';
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const path = url.pathname.replace('/api/v1', '');
    const page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 50);
    const detail = books.find(item => path === `/bookmarks/${item.id}`);
    if (detail) {
      if (init?.method === 'PATCH') Object.assign(detail, JSON.parse(init.body as string));
      return Response.json(detail);
    }
    if (path.endsWith('/preview')) return Response.json({ revision: 0, becomingPublicBookmarks: 0, becomingPublicCategories: 0 });
    if (path === '/bookmarks' && init?.method === 'POST') {
      const created = { ...book, ...JSON.parse(init.body as string), id: 'created-book' };
      books.push(created); return Response.json(created);
    }
    if (path === `/bookmarks/${book.id}/icon-config`) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        iconConfig = { source: body.source, dashboardId: body.dashboardId || null, iconifyId: body.iconifyId || null, version: 'next-version', uploaded: false };
      }
      return Response.json(iconConfig);
    }
    if (path === `/bookmarks/${book.id}/icon-upload`) {
      iconConfig = { source: 'upload', dashboardId: null, iconifyId: null, version: 'uploaded-version', uploaded: true };
      return Response.json(iconConfig);
    }
    if (path === '/icon-library') {
      const items = url.searchParams.get('source') === 'iconify'
        ? [{ id: 'mdi:github', name: 'github' }]
        : [{ id: 'github', name: 'GitHub' }, { id: 'github-light', name: 'GitHub Light' }];
      return Response.json({ items, total: 2, page, pageSize: 24 });
    }
    if (path.startsWith('/icon-refresh-jobs')) return Response.json({ id: 'job-one', state: refreshJobState, total: 1, processed: 1, success: 1, failed: 0, skipped: 0,
      totalOrigins: 1, processedOrigins: 1, page: 1, pageSize: 24, results: [{ id: book.id, title: book.title, status: 'success', reason: 'success' }] });
    const data = path === '/auth/me' ? (authenticated ? { authenticated: true, owner: { id: 'owner-1', email: 'owner@example.test' } } : { authenticated: false })
      : path === '/auth/logout' ? (authenticated = false, {})
      : path === '/categories/tree' ? categories : path === '/tags' ? []
      : path === '/home' ? { frequent: books.filter(item => item.isFavorite).slice(0, 10), recent: books.slice(0, 7), counts: { bookmarks: books.length, categories: 0, favorites: 0 } }
      : path === '/preferences' ? { ...defaults, defaultView: 'list', ...(init?.body ? JSON.parse(init.body as string) : {}) }
      : { items: books.slice((page - 1) * pageSize, page * pageSize), total: books.length, page, pageSize };
    return Response.json(data, { status: path === '/preferences' && init?.method === 'PATCH' && failPreferences ? 503 : 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('书签图标管理界面', () => {
  it('未保存书签和未保存 URL 暂停人工配置，不为新书签请求配置', async () => {
    authenticated = true;
    const view = renderApp('/bookmarks/new');
    await screen.findByText('保存书签后可选择或上传图标。');
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/icon-config'))).toBe(false);
    view.unmount(); renderApp(`/bookmarks/${book.id}/edit`);
    const input = await screen.findByLabelText('网站地址', { exact: false });
    await screen.findByRole('button', { name: '从图标库选择' });
    await userEvent.clear(input); await userEvent.type(input, 'https://other.test');
    expect(screen.getByRole('button', { name: '从图标库选择' })).toBeDisabled();
    expect(screen.getByLabelText('上传书签图标')).toBeDisabled();
    expect(screen.getByText('先保存网站地址，再修改图标。')).toBeInTheDocument();
  });

  it('明确应用 Dashboard 图标并保留其他未保存输入', async () => {
    authenticated = true; renderApp(`/bookmarks/${book.id}/edit`);
    const title = await screen.findByLabelText('书签名称', { exact: false });
    await userEvent.clear(title); await userEvent.type(title, '还未保存的名称');
    await userEvent.click(await screen.findByRole('button', { name: '从图标库选择' }));
    await userEvent.type(screen.getByLabelText('搜索图标库'), 'github');
    await userEvent.click(await screen.findByRole('button', { name: '选择图标 github-light' }));
    expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'PATCH' && String(call[0]).endsWith('/icon-config'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '应用图标' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(title).toHaveValue('还未保存的名称');
    expect(screen.getByText('Dashboard Icons', { exact: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '恢复自动' }));
    await screen.findByText('自动 Favicon', { exact: true });
  });

  it('切换图标来源会清除旧选择，Iconify 通过同源接口预览和应用', async () => {
    authenticated = true; renderApp(`/bookmarks/${book.id}/edit`);
    await userEvent.click(await screen.findByRole('button', { name: '从图标库选择' }));
    await userEvent.click(await screen.findByRole('button', { name: '选择图标 github-light' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '图标来源' }), 'iconify');
    expect(screen.getByRole('button', { name: '应用图标' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '选择图标 github-light' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('搜索图标库'), 'github');
    const option = await screen.findByRole('button', { name: '选择图标 mdi:github' });
    expect(option.querySelector('img')).toHaveAttribute('src', '/api/v1/icon-library/mdi%3Agithub/preview?source=iconify');
    await userEvent.click(option);
    await userEvent.click(screen.getByRole('button', { name: '应用图标' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const sent = vi.mocked(fetch).mock.calls.find(call => call[1]?.method === 'PATCH' && String(call[0]).endsWith('/icon-config'))!;
    expect(JSON.parse(sent[1]!.body as string)).toEqual({ source: 'iconify', iconifyId: 'mdi:github', expectedVersion: null });
    expect(screen.getByText('Iconify', { exact: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '从图标库选择' }));
    expect(screen.getByRole('combobox', { name: '图标来源' })).toHaveValue('iconify');
    expect(within(screen.getByRole('dialog')).getByText('mdi:github', { exact: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    await userEvent.click(screen.getByRole('button', { name: '恢复自动' }));
    await screen.findByText('自动 Favicon', { exact: true });
    expect(iconConfig.iconifyId).toBeNull();
  });

  it('切换来源重置分页，迟到的 Iconify 搜索结果不污染 Dashboard 列表', async () => {
    const previous = vi.mocked(fetch).getMockImplementation()!;
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/icon-library') {
        if (url.searchParams.get('source') === 'iconify') return new Promise(resolve => { finish = resolve; });
        return Promise.resolve(Response.json({ items: [{ id: 'github-light', name: 'GitHub Light' }], total: 48, page: Number(url.searchParams.get('page')), pageSize: 24 }));
      }
      return previous(input, init);
    });
    authenticated = true; renderApp(`/bookmarks/${book.id}/edit`);
    await userEvent.click(await screen.findByRole('button', { name: '从图标库选择' }));
    await userEvent.click(await screen.findByRole('button', { name: '下一页' }));
    await screen.findByText('2 / 2');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '图标来源' }), 'iconify');
    expect(screen.getByText('输入关键词，搜索 Iconify 图标。')).toBeInTheDocument();
    expect(finish).toBeUndefined();
    await userEvent.type(screen.getByLabelText('搜索图标库'), 'github');
    await waitFor(() => expect(finish).toBeDefined());
    const sent = vi.mocked(fetch).mock.calls.find(call => String(call[0]).includes('source=iconify'))!;
    expect(new URL(String(sent[0]), 'http://localhost').searchParams.get('page')).toBe('1');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '图标来源' }), 'dashboard');
    finish(Response.json({ items: [{ id: 'mdi:github', name: 'github' }], total: 1, page: 1, pageSize: 24 }));
    await screen.findByRole('button', { name: '选择图标 github-light' });
    expect(screen.queryByRole('button', { name: '选择图标 mdi:github' })).not.toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用图标' })).toBeDisabled();
  });

  it('上传先本地预览，明确应用时发送 FormData', async () => {
    const BrowserURL = URL;
    vi.stubGlobal('URL', class extends BrowserURL { static createObjectURL = vi.fn(() => 'blob:icon-preview'); static revokeObjectURL = vi.fn(); });
    authenticated = true; renderApp(`/bookmarks/${book.id}/edit`);
    const input = await screen.findByLabelText('上传书签图标');
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.upload(input, new File(['test-image'], 'icon.png', { type: 'image/png' }));
    expect(screen.getByAltText('待应用的上传图标')).toHaveAttribute('src', 'blob:icon-preview');
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/icon-upload'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '应用上传图标' }));
    await screen.findByText('自定义上传', { exact: true });
    const sent = vi.mocked(fetch).mock.calls.find(call => String(call[0]).endsWith('/icon-upload'))!;
    expect(sent[1]?.body).toBeInstanceOf(FormData);
    expect(sent[1]?.headers).not.toHaveProperty('Content-Type');
  });

  it('全库范围明确且导航后保留任务结果', async () => {
    authenticated = true; renderApp('/bookmarks?keyword=test');
    await userEvent.click(await screen.findByRole('button', { name: '刷新全库图标' }));
    await screen.findByText('自动图标刷新已完成');
    const request = vi.mocked(fetch).mock.calls.find(call => String(call[0]) === '/api/v1/icon-refresh-jobs')!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ scope: 'all' });
    await userEvent.click(screen.getByRole('button', { name: '导航首页' }));
    expect(screen.getByText('自动图标刷新已完成')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看刷新结果' }));
    await screen.findByRole('dialog', { name: '图标刷新结果' });
    expect(await screen.findByText('已刷新', { exact: true })).toBeInTheDocument();
  });

  it('退出登录停止任务并忽略延迟返回的私密结果', async () => {
    authenticated = true; refreshJobState = 'running';
    const previous = vi.mocked(fetch).getMockImplementation()!;
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('/icon-refresh-jobs/') ? new Promise(resolve => { finish = resolve; }) : previous(input, init));
    renderApp(); await userEvent.click(await screen.findByRole('button', { name: '刷新全库图标' }));
    await screen.findByText('正在刷新自动图标'); await waitFor(() => expect(finish).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: '已登录' }));
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }));
    finish(Response.json({ id: 'job-one', state: 'completed', results: [{ title: '不能泄漏的私密结果' }] }));
    await waitFor(() => expect(screen.queryByLabelText('图标刷新进度')).not.toBeInTheDocument());
    expect(screen.queryByText('不能泄漏的私密结果')).not.toBeInTheDocument();
  });
});

describe('书签视图的浏览器记忆', () => {
  it('首次访问默认卡片，切换列表后刷新仍使用列表', async () => {
    const app = renderApp();
    await screen.findByRole('link', { name: '测试书签' });
    expect(document.querySelector('.bookmark-tile')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '紧凑列表' }));
    expect(document.querySelector('.bookmark-row')).toBeInTheDocument();
    app.unmount(); renderApp();
    await waitFor(() => expect(document.querySelector('.bookmark-row')).toBeInTheDocument());
  });

  it('沿用旧版访客的列表选择', async () => {
    localStorage.setItem('linkora.guest.preferences', JSON.stringify({ defaultView: 'list' }));
    renderApp();
    await waitFor(() => expect(document.querySelector('.bookmark-row')).toBeInTheDocument());
  });

  it.each(['{', '{"defaultView":"unknown"}'])('无效的旧偏好使用默认卡片：%s', async value => {
    localStorage.setItem('linkora.guest.preferences', value);
    renderApp();
    await waitFor(() => expect(document.querySelector('.bookmark-tile')).toBeInTheDocument());
  });

  it('已登录时也默认卡片，并在账号偏好保存失败后记住本机选择', async () => {
    authenticated = true; failPreferences = true;
    const app = renderApp();
    await waitFor(() => expect(document.querySelector('.bookmark-tile')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '紧凑列表' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/preferences', expect.objectContaining({ method: 'PATCH' })));
    app.unmount(); renderApp();
    await waitFor(() => expect(document.querySelector('.bookmark-row')).toBeInTheDocument());
  });

  it('同一浏览器登录、退出后继续使用所选视图', async () => {
    renderApp();
    await screen.findByRole('button', { name: '紧凑列表' });
    await userEvent.click(screen.getByRole('button', { name: '紧凑列表' }));
    authenticated = true; window.dispatchEvent(new Event('focus'));
    await screen.findByRole('button', { name: '已登录' });
    await waitFor(() => expect(document.querySelector('.bookmark-row')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '紧凑卡片' }));
    await userEvent.click(screen.getByRole('button', { name: '已登录' }));
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await userEvent.click(screen.getByRole('button', { name: /^全部书签/ }));
    await waitFor(() => expect(document.querySelector('.bookmark-tile')).toBeInTheDocument());
  });

  it('浏览器禁止写入本地存储时仍然能切换视图', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('禁用存储', 'SecurityError'); });
    renderApp();
    await screen.findByRole('link', { name: '测试书签' });
    await userEvent.click(screen.getByRole('button', { name: '紧凑列表' }));
    expect(document.querySelector('.bookmark-row')).toBeInTheDocument();
  });
});

describe('书签地址2与统一切换', () => {
  beforeEach(() => {
    books = [{ ...book, title: '双地址书签', url2: 'https://alternate.test/path', isFavorite: true },
      { ...book, id: 'single-book', title: '单地址书签' }];
  });

  it('列表和卡片共用模式，单地址书签反复切换都使用原地址', async () => {
    renderApp();
    const mode = await screen.findByRole('combobox', { name: '访问地址' });
    expect(mode).toHaveValue('url');
    await screen.findByRole('link', { name: '双地址书签' });
    for (const view of ['紧凑列表', '紧凑卡片']) {
      await userEvent.click(screen.getByRole('button', { name: view }));
      for (const value of ['url2', 'url', 'url2']) {
        await userEvent.selectOptions(mode, value);
        const double = screen.getByRole('link', { name: '双地址书签' });
        expect(double).toHaveAttribute('href', value === 'url2' ? 'https://alternate.test/path' : book.url);
        expect(double.closest('.bookmark-row, .bookmark-tile')).toHaveTextContent(value === 'url2' ? 'alternate.test' : 'example.test');
        expect(screen.getByRole('link', { name: '单地址书签' })).toHaveAttribute('href', book.url);
      }
    }
    await userEvent.click(screen.getByRole('link', { name: '双地址书签' }));
    expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method !== 'GET')).toBe(false);
  });

  it('切换不改变当前页、筛选、排序、多选或触发写请求', async () => {
    authenticated = true;
    renderApp('/bookmarks?keyword=保留关键词&sort=title&page=2&pageSize=1');
    await userEvent.click(await screen.findByRole('button', { name: '多选' }));
    const selection = await screen.findByRole('checkbox', { name: '选择 单地址书签' });
    await userEvent.click(selection);
    const requests = vi.mocked(fetch).mock.calls.length;
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '访问地址' }), 'url2');
    expect(selection).toBeChecked();
    expect(screen.getByLabelText('搜索书签')).toHaveValue('保留关键词');
    expect(screen.getByLabelText('排序')).toHaveValue('title');
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.slice(requests).some(call => call[1]?.method !== 'GET')).toBe(false);
    expect(localStorage.getItem('linkora.bookmark.addressMode')).toBe('url2');
  });

  it('导航和刷新记住模式，首页链接及域名跟随选择', async () => {
    const app = renderApp();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: '访问地址' }), 'url2');
    await userEvent.click(screen.getByRole('button', { name: '导航首页' }));
    const homeLinks = await screen.findAllByRole('link', { name: /双地址书签/ });
    expect(homeLinks).toHaveLength(2);
    for (const link of homeLinks) {
      expect(link).toHaveAttribute('href', 'https://alternate.test/path');
      expect(link).toHaveTextContent('alternate.test');
    }
    app.unmount(); renderApp();
    expect(await screen.findByRole('combobox', { name: '访问地址' })).toHaveValue('url2');
    expect(await screen.findByRole('link', { name: '双地址书签' })).toHaveAttribute('href', 'https://alternate.test/path');
  });

  it('登录和退出后保留设备的地址选择', async () => {
    renderApp();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: '访问地址' }), 'url2');
    authenticated = true; window.dispatchEvent(new Event('focus'));
    await userEvent.click(await screen.findByRole('button', { name: '已登录' }));
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await userEvent.click(screen.getByRole('button', { name: /^全部书签/ }));
    expect(await screen.findByRole('combobox', { name: '访问地址' })).toHaveValue('url2');
  });

  it('非法的本地模式使用原地址', async () => {
    localStorage.setItem('linkora.bookmark.addressMode', 'unknown'); renderApp();
    expect(await screen.findByRole('combobox', { name: '访问地址' })).toHaveValue('url');
    expect(await screen.findByRole('link', { name: '双地址书签' })).toHaveAttribute('href', book.url);
  });

  it('浏览器禁止读写本地存储时仍可切换', async () => {
    for (const method of ['getItem', 'setItem'] as const) vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('禁用存储', 'SecurityError'); });
    renderApp();
    await screen.findByRole('link', { name: '双地址书签' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '访问地址' }), 'url2');
    expect(screen.getByRole('link', { name: '双地址书签' })).toHaveAttribute('href', 'https://alternate.test/path');
  });

  it.each(['', 'https://new-alternate.test/path'])('新增书签的地址2可选并保存：%s', async url2 => {
    authenticated = true; renderApp('/bookmarks/new');
    await userEvent.type(await screen.findByLabelText('书签名称', { exact: false }), '新建书签');
    await userEvent.type(screen.getByLabelText('网站地址', { exact: false }), 'https://new-primary.test/');
    const input = screen.getByLabelText('地址2（可选）');
    expect(input).not.toBeRequired();
    if (url2) await userEvent.type(input, url2);
    await userEvent.click(screen.getByRole('button', { name: '保存书签' }));
    await screen.findByRole('heading', { name: '书签详情 / 编辑' });
    const request = vi.mocked(fetch).mock.calls.find(call => call[0] === '/api/v1/bookmarks' && call[1]?.method === 'POST')!;
    expect(JSON.parse(request[1]!.body as string)).toMatchObject({ url: 'https://new-primary.test/', url2: url2 || null });
    expect(screen.getByLabelText('地址2（可选）')).toHaveValue(url2);
  });

  it('编辑页使用已保存的地址2，清空保存后自动回退', async () => {
    authenticated = true; localStorage.setItem('linkora.bookmark.addressMode', 'url2');
    renderApp(`/bookmarks/${book.id}/edit`);
    const input = await screen.findByLabelText('地址2（可选）');
    expect(input).toHaveValue('https://alternate.test/path');
    expect(screen.getByRole('link', { name: '访问网站' })).toHaveAttribute('href', 'https://alternate.test/path');
    await userEvent.clear(input);
    expect(screen.getByRole('link', { name: '访问网站' })).toHaveAttribute('href', 'https://alternate.test/path');
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.getByRole('link', { name: '访问网站' })).toHaveAttribute('href', book.url));
    expect(books[0].url2).toBeNull();
    expect(localStorage.getItem('linkora.bookmark.addressMode')).toBe('url2');
    await userEvent.click(screen.getByRole('button', { name: '返回书签库' }));
    expect(await screen.findByRole('link', { name: '双地址书签' })).toHaveAttribute('href', book.url);
  });

  it('保存失败保留两个地址的输入并展示错误', async () => {
    authenticated = true;
    const previous = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => init?.method === 'PATCH' && String(input).endsWith(`/bookmarks/${book.id}`)
      ? Promise.resolve(Response.json({ message: '暂时无法保存' }, { status: 503 })) : previous(input, init));
    const success = vi.spyOn(toast, 'success');
    renderApp(`/bookmarks/${book.id}/edit`);
    const input = await screen.findByLabelText('地址2（可选）');
    await userEvent.clear(input); await userEvent.type(input, 'https://unsaved.test/');
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法保存');
    expect(input).toHaveValue('https://unsaved.test/');
    expect(screen.getByLabelText('网站地址', { exact: false })).toHaveValue(book.url);
    expect(success).not.toHaveBeenCalled();
  });

  it('所有者打开地址2按原书签记录，记录失败不移除链接', async () => {
    authenticated = true; localStorage.setItem('linkora.bookmark.addressMode', 'url2');
    const previous = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/visits')
      ? Promise.resolve(Response.json({ message: '记录失败' }, { status: 503 })) : previous(input, init));
    renderApp();
    const link = await screen.findByRole('link', { name: '双地址书签' });
    await userEvent.click(link);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/v1/bookmarks/${book.id}/visits`, expect.objectContaining({ method: 'POST' })));
    expect(link).toHaveAttribute('href', 'https://alternate.test/path');
    expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('分类打开全部书签', () => {
  beforeEach(() => {
    categories = [{ id: 'category-1', name: '测试分类', parentId: null, isPrivate: false, effectivePrivate: false,
      inheritedPrivate: false, sortOrder: 0, path: '测试分类', count: 101, children: [] }];
    books = Array.from({ length: 101 }, (_, i) => ({ ...book, id: `book-${i}`, title: `书签 ${i}`, url: `https://example.test/${i}`, url2: i % 2 === 0 ? `https://alternate.test/${i}` : null, categoryId: 'category-1' }));
  });

  it.each(['url', 'url2'])('跨分页读取完整分类并使用当前地址模式：%s', async mode => {
    localStorage.setItem('linkora.bookmark.addressMode', mode);
    const open = vi.spyOn(window, 'open').mockImplementation(() => ({ opener: window, location: { replace: vi.fn() } }) as unknown as Window);
    renderApp('/bookmarks?categoryId=category-1&keyword=其他&favorite=true&page=2&pageSize=20');
    const button = await screen.findByRole('button', { name: '打开全部书签' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(open).toHaveBeenCalledTimes(101);
    const calls = vi.mocked(fetch).mock.calls.map(([path]) => new URL(path as string, 'http://localhost').searchParams);
    const fullCategory = calls.filter(params => params.get('includeDescendants') === 'true');
    expect(fullCategory).toHaveLength(2);
    expect(fullCategory.map(params => params.get('page'))).toEqual(['1', '2']);
    for (const params of fullCategory) {
      expect(params.get('categoryId')).toBe('category-1');
      expect(params.has('keyword') || params.has('favorite')).toBe(false);
    }
    expect(open.mock.results[0].value.location.replace).toHaveBeenCalledWith(mode === 'url2' ? 'https://alternate.test/0' : 'https://example.test/0');
    expect(open.mock.results[1].value.location.replace).toHaveBeenCalledWith('https://example.test/1');
    expect(open.mock.results[100].value.location.replace).toHaveBeenCalledWith(mode === 'url2' ? 'https://alternate.test/100' : 'https://example.test/100');
    expect(open.mock.results[100].value.opener).toBeNull();
    open.mockRestore();
  });

  it('空分类不打开空白标签页', async () => {
    books = [];
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderApp('/bookmarks?categoryId=category-1');
    await waitFor(() => expect(screen.getByRole('button', { name: '打开全部书签' })).toBeDisabled());
    await screen.findByText('共 0 条 · 包含子分类');
    expect(open).not.toHaveBeenCalled();
  });

  it('弹窗被拦截时停止打开并提示允许本站弹窗', async () => {
    const error = vi.spyOn(toast, 'error');
    const tab = { opener: window, location: { replace: vi.fn() } } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValueOnce(tab).mockReturnValue(null);
    renderApp('/bookmarks?categoryId=category-1');
    const button = await screen.findByRole('button', { name: '打开全部书签' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(open).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('已打开 1/101'));
  });
});
