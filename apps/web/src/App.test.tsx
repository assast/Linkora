import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { AppProvider } from './state';
import { defaults, type Bookmark, type Category } from './types';

const book: Bookmark = { id: 'book-1', title: '测试书签', url: 'https://example.test/one', description: '', notes: '',
  categoryId: null, categoryPath: '未分类', tags: [], isPrivate: false, effectivePrivate: false, inheritedPrivate: false,
  isFavorite: false, visitCount: 0, createdAt: '2026-10-31', updatedAt: '2026-10-31' };
let authenticated = false;
let failPreferences = false;
let categories: Category[] = [];
let books = [book];

function renderApp(path = '/bookmarks') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><AppProvider><App /></AppProvider></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear(); authenticated = false; failPreferences = false; categories = []; books = [book];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const path = url.pathname.replace('/api/v1', '');
    const page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 50);
    const data = path === '/auth/me' ? (authenticated ? { authenticated: true, owner: { id: 'owner-1', email: 'owner@example.test' } } : { authenticated: false })
      : path === '/auth/logout' ? (authenticated = false, {})
      : path === '/categories/tree' ? categories : path === '/tags' ? []
      : path === '/home' ? { frequent: [], recent: [], counts: { bookmarks: 1, categories: 0, favorites: 0 } }
      : path === '/preferences' ? { ...defaults, defaultView: 'list', ...(init?.body ? JSON.parse(init.body as string) : {}) }
      : { items: books.slice((page - 1) * pageSize, page * pageSize), total: books.length, page, pageSize };
    return Response.json(data, { status: path === '/preferences' && init?.method === 'PATCH' && failPreferences ? 503 : 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

describe('分类打开全部书签', () => {
  beforeEach(() => {
    categories = [{ id: 'category-1', name: '测试分类', parentId: null, isPrivate: false, effectivePrivate: false,
      inheritedPrivate: false, sortOrder: 0, path: '测试分类', count: 101, children: [] }];
    books = Array.from({ length: 101 }, (_, i) => ({ ...book, id: `book-${i}`, title: `书签 ${i}`, url: `https://example.test/${i}`, categoryId: 'category-1' }));
  });

  it('跨分页读取完整分类，不沿用当前列表的搜索、页码和星标筛选', async () => {
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
    expect(open.mock.results[100].value.location.replace).toHaveBeenCalledWith('https://example.test/100');
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
