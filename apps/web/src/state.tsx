import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, resetRequests, StaleSessionError, type RequestOptions } from './api';
import { defaults, flattenCategories, type Category, type Home, type Identity, type Impact, type Preferences } from './types';

export interface ConfirmOptions { title: string; description: string; impact?: Impact; label?: string; danger?: boolean }
export type ActiveDialog = null | { kind: 'login' | 'account' | 'manager' } | { kind: 'category'; category?: Category; parentId?: string | null };

function guestPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem('linkora.guest.preferences') || '{}') as Partial<Preferences>;
    return { theme: value.theme === 'dark' ? 'dark' : 'light', defaultView: value.defaultView === 'list' ? 'list' : 'grid',
      defaultEngine: ['google', 'bing', 'baidu', 'duck', 'github'].includes(value.defaultEngine || '') ? value.defaultEngine! : 'google',
      expandedCategories: Array.isArray(value.expandedCategories) ? value.expandedCategories.filter(id => typeof id === 'string') : [] };
  } catch { return defaults; }
}

function useAppState() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const previousScope = useRef<string | null>(null);
  const identityQuery = useQuery({ queryKey: ['identity'], staleTime: 0, retry: false, queryFn: async ({ signal }) => {
    const next = await api<Identity>('/auth/me', { signal });
    const nextScope = next.owner?.id || 'guest';
    if (previousScope.current !== null && previousScope.current !== nextScope) resetRequests();
    previousScope.current = nextScope;
    return next;
  } });
  const identity = identityQuery.data || { authenticated: false };
  const refetchIdentity = identityQuery.refetch;
  const scope = identity.owner?.id || 'guest';
  const ready = identityQuery.isSuccess;
  const call = useCallback(<T,>(path: string, options: RequestOptions = {}) => api<T>(path, { ...options, csrf: identity.csrfToken }), [identity.csrfToken]);
  const [dialog, setDialog] = useState<ActiveDialog>(null);
  const [confirmation, setConfirmation] = useState<ConfirmOptions | null>(null);
  const pendingConfirmation = useRef<((result: boolean) => void) | null>(null);
  const closeDialog = useCallback((accepted = false) => {
    if (pendingConfirmation.current) {
      pendingConfirmation.current(accepted); pendingConfirmation.current = null; setConfirmation(null);
    } else setDialog(null);
  }, []);
  const closeAllDialogs = useCallback(() => {
    pendingConfirmation.current?.(false); pendingConfirmation.current = null; setConfirmation(null); setDialog(null);
  }, []);
  const confirm = useCallback((options: ConfirmOptions) => {
    pendingConfirmation.current?.(false);
    return new Promise<boolean>(resolve => { pendingConfirmation.current = resolve; setConfirmation(options); });
  }, []);
  const removeOldData = useCallback((currentScope: string) => {
    const filter = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === 'data' && query.queryKey[1] !== currentScope };
    void client.cancelQueries(filter); client.removeQueries(filter);
  }, [client]);

  useEffect(() => { removeOldData(scope); closeAllDialogs(); }, [scope, removeOldData, closeAllDialogs]);
  const expire = useCallback(() => {
    resetRequests(); previousScope.current = 'guest';
    void client.cancelQueries();
    client.setQueryData<Identity>(['identity'], { authenticated: false });
    removeOldData('guest'); closeAllDialogs();
  }, [client, closeAllDialogs, removeOldData]);
  useEffect(() => {
    window.addEventListener('session-expired', expire);
    const focus = () => { void refetchIdentity(); };
    window.addEventListener('focus', focus);
    return () => { window.removeEventListener('session-expired', expire); window.removeEventListener('focus', focus); };
  }, [expire, refetchIdentity]);

  const categoriesQuery = useQuery({ queryKey: ['data', scope, 'categories'], enabled: ready,
    queryFn: ({ signal }) => call<Category[]>('/categories/tree', { signal }) });
  const homeQuery = useQuery({ queryKey: ['data', scope, 'home'], enabled: ready,
    queryFn: ({ signal }) => call<Home>('/home', { signal }) });
  const tagsQuery = useQuery({ queryKey: ['data', scope, 'tags'], enabled: ready,
    queryFn: ({ signal }) => call<{ id: string; name: string; count: number }[]>('/tags', { signal }) });
  const preferencesQuery = useQuery({ queryKey: ['data', scope, 'preferences'], enabled: ready && identity.authenticated,
    queryFn: ({ signal }) => call<Preferences>('/preferences', { signal }) });
  const [guest, setGuest] = useState(guestPreferences);
  const preferences = { ...(identity.authenticated ? preferencesQuery.data || defaults : guest), defaultView: guest.defaultView };
  useEffect(() => { document.documentElement.dataset.theme = preferences.theme; }, [preferences.theme]);
  const updatePreferences = async (patch: Partial<Preferences>) => {
    if (!identity.authenticated || patch.defaultView) {
      const next = { ...guest, ...(identity.authenticated ? { defaultView: patch.defaultView! } : patch) };
      setGuest(next);
      try { localStorage.setItem('linkora.guest.preferences', JSON.stringify(next)); } catch { /* 禁用存储时仍允许切换视图。 */ }
    }
    if (!identity.authenticated) return;
    const key = ['data', scope, 'preferences'];
    const old = preferences;
    client.setQueryData(key, { ...old, ...patch });
    try { client.setQueryData(key, await call<Preferences>('/preferences', { method: 'PATCH', body: patch })); }
    catch (error) { if (!(error instanceof StaleSessionError)) { client.setQueryData(key, old); toast.error(errorMessage(error)); } }
  };
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: ['data', scope] }), [client, scope]);
  const login = async (email: string, password: string) => {
    const next = await call<Identity>('/auth/login', { method: 'POST', body: { email, password } });
    resetRequests(); await client.cancelQueries(); previousScope.current = next.owner!.id;
    removeOldData(next.owner!.id); client.setQueryData(['identity'], next); closeDialog(); toast.success('登录成功，全部收藏已就绪');
  };
  const logout = async () => {
    try { await call('/auth/logout', { method: 'POST' }); expire(); navigate('/home'); toast.success('已退出登录'); }
    catch (error) { if (!(error instanceof StaleSessionError)) toast.error(errorMessage(error)); }
  };
  const openLogin = () => setDialog({ kind: 'login' });
  const openCategory = (category?: Category, parentId?: string | null) => {
    if (!identity.authenticated) return openLogin();
    setDialog({ kind: 'category', category, parentId });
  };
  const openManager = () => identity.authenticated ? setDialog({ kind: 'manager' }) : openLogin();
  const addBookmark = () => identity.authenticated ? navigate('/bookmarks/new') : openLogin();
  const saveWithPreview = async <T,>(resource: 'categories' | 'bookmarks', id: string, payload: unknown) => {
    const impact = await call<Impact>(`/${resource}/${id}/preview`, { method: 'POST', body: payload });
    if ((impact.becomingPublicBookmarks || impact.becomingPublicCategories) && !await confirm({ title: '确认公开这些内容？',
      description: '此修改会让部分内容对访客可见，请核对影响范围。', impact, label: '确认修改并公开', danger: true })) return null;
    return call<T>(`/${resource}/${id}`, { method: 'PATCH', body: { ...(payload as object), expectedRevision: impact.revision, confirmedPublic: true } });
  };
  return { identity, identityQuery, scope, ready, call, categoriesQuery, categories: categoriesQuery.data || [],
    flatCategories: flattenCategories(categoriesQuery.data || []), homeQuery, tagsQuery, preferences,
    updatePreferences, refresh, login, logout, dialog, confirmation, setDialog, closeDialog, confirm, openLogin, openCategory, openManager, addBookmark, saveWithPreview };
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
type AppState = ReturnType<typeof useAppState>;
const Context = createContext<AppState | null>(null);
export function AppProvider({ children }: { children: ReactNode }) { return <Context.Provider value={useAppState()}>{children}</Context.Provider>; }
export function useApp() { const value = useContext(Context); if (!value) throw new Error('缺少 AppProvider'); return value; }
