export interface Identity { authenticated: boolean; owner?: { id: string; email: string }; csrfToken?: string; defaultSessionDays?: number }
export interface Category {
  id: string; parentId: string | null; name: string; isPrivate: boolean; effectivePrivate: boolean;
  inheritedPrivate: boolean; sortOrder: number; path: string; count: number; children: Category[];
}
export interface Bookmark {
  id: string; title: string; url: string; url2: string | null; description: string; notes: string; categoryId: string | null;
  categoryPath: string; tags: string[]; isPrivate: boolean; effectivePrivate: boolean; inheritedPrivate: boolean;
  isFavorite: boolean; visitCount: number; createdAt: string; updatedAt: string;
}
export interface Page { items: Bookmark[]; total: number; page: number; pageSize: number }
export type IconLibrarySource = 'dashboard' | 'iconify';
export interface BookmarkIconConfig { source: 'auto' | IconLibrarySource | 'upload'; version: string | null; dashboardId: string | null; iconifyId: string | null; uploaded: boolean }
export interface IconLibraryPage { items: { id: string; name: string }[]; total: number; page: number; pageSize: number }
export interface IconRefreshJob {
  id: string; state: 'queued' | 'running' | 'completed'; total: number; processed: number; success: number; failed: number; skipped: number;
  totalOrigins: number; processedOrigins: number; page: number; pageSize: number;
  results: { id: string; title: string; status: 'success' | 'failed' | 'skipped'; reason: 'success' | 'failed' | 'manual' | 'blocked' | 'changed' }[];
}
export interface Home { frequent: Bookmark[]; recent: Bookmark[]; counts: { bookmarks: number; categories: number; favorites: number; private?: number } }
export const workspaceLinks = [
  { id: 'home', name: '导航首页', path: '/home', icon: 'grid' },
  { id: 'all', name: '全部书签', path: '/bookmarks', icon: 'bookmark' },
  { id: 'starred', name: '星标收藏', path: '/bookmarks?filter=starred', icon: 'star' },
  { id: 'private', name: '私密书签', path: '/bookmarks?privacy=private', icon: 'lock' },
] as const;
export type WorkspaceItem = typeof workspaceLinks[number]['id'];
export interface Preferences {
  theme: 'light' | 'dark'; defaultEngine: string; defaultView: 'list' | 'grid'; expandedCategories: string[];
  bookmarkFontSize: number; categoryFontSize: number; showWorkspace: boolean; workspaceItems: WorkspaceItem[];
}
export interface Impact {
  revision: number; affectedBookmarks: number; affectedCategories: number; privateBookmarks: number;
  becomingPublicBookmarks: number; becomingPublicCategories: number; stillInheritedPrivate: number;
  summary: { id: string; title: string; isPrivate: boolean; willBePrivate: boolean }[];
}
export type Operation = 'MOVE_CATEGORY' | 'ADD_TAGS' | 'REMOVE_TAGS' | 'REPLACE_TAGS' | 'SET_FAVORITE' | 'SET_PRIVACY' | 'DELETE' | 'EXPORT';
export type AddressMode = 'url' | 'url2';
export function resolveBookmarkUrl(book: { url: string; url2?: string | null }, mode: AddressMode) {
  const alternative = book.url2?.trim();
  return mode === 'url2' && alternative ? alternative : book.url;
}
export const flattenCategories = (nodes: Category[]): Category[] => nodes.flatMap(node => [node, ...flattenCategories(node.children)]);
export const domain = (value: string) => { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return 'example.com'; } };
export const defaults: Preferences = { theme: 'light', defaultEngine: 'google', defaultView: 'grid', expandedCategories: [],
  bookmarkFontSize: 12, categoryFontSize: 12, showWorkspace: true, workspaceItems: workspaceLinks.map(item => item.id) };
export function normalizePreferences(value: Partial<Preferences> | null): Preferences {
  const input = value && typeof value === 'object' ? value : {};
  const fontSize = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 12 && value <= 20 ? value : 12;
  return {
    theme: input.theme === 'dark' ? 'dark' : 'light', defaultView: input.defaultView === 'list' ? 'list' : 'grid',
    defaultEngine: engines.some(engine => engine.id === input.defaultEngine) ? input.defaultEngine! : defaults.defaultEngine,
    expandedCategories: Array.isArray(input.expandedCategories) ? input.expandedCategories.filter(id => typeof id === 'string') : [],
    bookmarkFontSize: fontSize(input.bookmarkFontSize), categoryFontSize: fontSize(input.categoryFontSize), showWorkspace: input.showWorkspace !== false,
    workspaceItems: Array.isArray(input.workspaceItems) ? workspaceLinks.filter(item => input.workspaceItems!.includes(item.id)).map(item => item.id) : defaults.workspaceItems,
  };
}
export const engines = [
  { id: 'google', name: 'Google', color: '#4285f4', template: 'https://www.google.com/search?q=' },
  { id: 'bing', name: 'Bing', color: '#12a9b6', template: 'https://www.bing.com/search?q=' },
  { id: 'baidu', name: '百度', color: '#5267ee', template: 'https://www.baidu.com/s?wd=' },
  { id: 'duck', name: 'DuckDuckGo', color: '#dc7c46', template: 'https://duckduckgo.com/?q=' },
  { id: 'github', name: 'GitHub', color: '#252938', template: 'https://github.com/search?q=' },
];
export function engineUrl(id: string, keyword: string) {
  const query = keyword.trim();
  if (!query) return null;
  const engine = engines.find(item => item.id === id) || engines[0];
  return engine.template + encodeURIComponent(query) + (engine.id === 'github' ? '&type=repositories' : '');
}
