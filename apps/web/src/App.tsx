import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { StaleSessionError } from './api';
import { Button, Empty, Icon, Loading, PrivateMark, QueryError, Section, SiteIcon } from './components';
import { APP_NAME, REPOSITORY_URL } from './constants';
import { Dialogs } from './dialogs';
import { IconRefreshNotice } from './icon-refresh';
import { EditorPage } from './editor';
import { LibraryPage, VisitLink } from './library';
import { errorMessage, useApp } from './state';
import { moveItem } from './ordering';
import { domain, engines, engineUrl, resolveBookmarkUrl, workspaceLinks, type Category } from './types';

type DropTarget = { id: string; position: 'before' | 'after' } | null;
type PointerDrag = { category: Category; pointerId: number; startX: number; startY: number; timer: number | null; longPressed: boolean; dragging: boolean };

function moveCategoryInTree(nodes: Category[], id: string, targetId: string, position: 'before' | 'after'): Category[] {
  if (nodes.some(category => category.id === id)) return moveItem(nodes, id, targetId, position);
  return nodes.map(category => ({ ...category, children: moveCategoryInTree(category.children, id, targetId, position) }));
}

function CategoryNodes({ nodes, depth = 0, close, dragEnabled, dragBusy, selectedId, draggingId, dropTarget, onDragHandleDown, onDragHandleClick, clearSelection, announce }: {
  nodes: Category[]; depth?: number; close: () => void; dragEnabled: boolean; dragBusy: boolean; selectedId: string | null; draggingId: string | null;
  dropTarget: DropTarget; onDragHandleDown: (category: Category, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDragHandleClick: (category: Category, event: React.MouseEvent<HTMLButtonElement>) => void; clearSelection: () => void; announce: (message: string) => void;
}) {
  const app = useApp(), navigate = useNavigate(); const [params] = useSearchParams();
  return nodes.map(category => {
    const expanded = app.preferences.expandedCategories.includes(category.id);
    const dropClass = dropTarget?.id === category.id ? `drop-target-${dropTarget.position}` : '';
    return <div className="tree-node" key={category.id}><div className={`tree-line ${params.get('categoryId') === category.id ? 'selected' : ''} ${selectedId === category.id ? 'reorder-selected' : ''} ${draggingId === category.id ? 'reorder-dragging' : ''} ${dropClass}`} style={{ paddingLeft: Math.min(depth, 9) * 12 + 5 }} data-category-id={category.id} data-category-parent-id={category.parentId || ''}>
      <button className={`tree-toggle ${category.children.length ? 'has-children' : ''}`} aria-label={`${expanded ? '折叠' : '展开'}${category.name}`} aria-expanded={expanded} onClick={() => void app.updatePreferences({ expandedCategories: expanded ? app.preferences.expandedCategories.filter(id => id !== category.id) : [...app.preferences.expandedCategories, category.id] })}><Icon name={expanded ? 'down' : 'right'} /></button>
      <button className="tree-main" title={category.path} onClick={() => { clearSelection(); navigate('/bookmarks?categoryId=' + category.id); close(); }}><Icon name="folder" className="folder-icon" /><strong>{category.name}</strong>{category.effectivePrivate && <Icon name="lock" className="tree-lock" />}<span className="count">{category.count || ''}</span></button>
      {dragEnabled && <button type="button" className="tree-drag-handle" title={`长按选中并拖动${category.name}`} aria-label={`长按选中并拖动${category.name}`} aria-pressed={selectedId === category.id} disabled={dragBusy} onPointerDown={event => onDragHandleDown(category, event)} onClick={event => onDragHandleClick(category, event)} onContextMenu={event => event.preventDefault()}><Icon name="drag" /></button>}
    </div>{expanded && <CategoryNodes nodes={category.children} depth={depth + 1} close={close} dragEnabled={dragEnabled} dragBusy={dragBusy} selectedId={selectedId} draggingId={draggingId} dropTarget={dropTarget} onDragHandleDown={onDragHandleDown} onDragHandleClick={onDragHandleClick} clearSelection={clearSelection} announce={announce} />}</div>;
  });
}

function CategoryTree({ nodes, close, announce }: { nodes: Category[]; close: () => void; announce: (message: string) => void }) {
  const app = useApp(), queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const pointer = useRef<PointerDrag | null>(null);
  const suppressClick = useRef(false);

  const persistReorder = useCallback(async (category: Category, targetId: string, position: 'before' | 'after') => {
    const queryKey = ['data', app.scope, 'categories'];
    const previous = queryClient.getQueryData<Category[]>(queryKey);
    if (previous) queryClient.setQueryData<Category[]>(queryKey, moveCategoryInTree(previous, category.id, targetId, position));
    setMovingId(category.id);
    announce(`正在保存${category.name}的分组顺序`);
    try {
      await app.call(`/categories/${category.id}/reorder`, { method: 'POST', body: { targetId, position } });
      await app.refresh();
      announce(`${category.name}已移动，顺序已保存`);
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      if (!(error instanceof StaleSessionError)) toast.error(errorMessage(error));
      announce(`${category.name}的顺序保存失败`);
    } finally { setMovingId(null); setDropTarget(null); }
  }, [app.call, app.refresh, app.scope, announce, queryClient]);

  const onDragHandleDown = (category: Category, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (movingId || event.button !== 0) return;
    event.preventDefault();
    const state: PointerDrag = { category, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, timer: null, longPressed: false, dragging: selectedId === category.id };
    pointer.current = state;
    if (state.dragging) { setDraggingId(category.id); setDropTarget(null); announce(`正在拖动${category.name}`); }
    else state.timer = window.setTimeout(() => {
      if (pointer.current !== state) return;
      state.timer = null;
      state.longPressed = true;
      state.dragging = true;
      suppressClick.current = true;
      setSelectedId(category.id);
      setDraggingId(category.id);
      announce(`已选中${category.name}，拖到同级分组位置后松开`);
    }, 500);
  };

  const onDragHandleClick = (category: Category, event: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressClick.current) {
      event.preventDefault(); event.stopPropagation(); suppressClick.current = false; return;
    }
    if (selectedId) setSelectedId(null);
  };

  useEffect(() => {
    const targetAt = (x: number, y: number, moving: Category): DropTarget => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.tree-line[data-category-id]');
      if (!row || row.dataset.categoryParentId !== (moving.parentId || '') || row.dataset.categoryId === moving.id) return null;
      const bounds = row.getBoundingClientRect();
      return { id: row.dataset.categoryId!, position: y < bounds.top + bounds.height / 2 ? 'before' : 'after' };
    };
    const onMove = (event: PointerEvent) => {
      const state = pointer.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (!state.dragging) {
        if (!state.longPressed && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 8) {
          if (state.timer !== null) window.clearTimeout(state.timer);
          pointer.current = null;
        }
        return;
      }
      event.preventDefault();
      setDropTarget(targetAt(event.clientX, event.clientY, state.category));
    };
    const onUp = (event: PointerEvent) => {
      const state = pointer.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (state.timer !== null) window.clearTimeout(state.timer);
      pointer.current = null;
      if (!state.dragging) return;
      setDraggingId(null);
      const target = targetAt(event.clientX, event.clientY, state.category);
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      if (target) {
        setSelectedId(null);
        void persistReorder(state.category, target.id, target.position);
      } else {
        setSelectedId(state.category.id);
        setDropTarget(null);
      }
    };
    const onCancel = (event: PointerEvent) => {
      const state = pointer.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (state.timer !== null) window.clearTimeout(state.timer);
      pointer.current = null;
      setDraggingId(null);
      setDropTarget(null);
      suppressClick.current = false;
      if (state.longPressed) setSelectedId(state.category.id);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selectedId) {
        setSelectedId(null); setDraggingId(null); setDropTarget(null); announce('已取消分组排序');
      }
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      if (pointer.current?.timer !== null && pointer.current?.timer !== undefined) window.clearTimeout(pointer.current.timer);
    };
  }, [announce, persistReorder, selectedId]);

  const clearSelection = () => { setSelectedId(null); setDraggingId(null); setDropTarget(null); announce(''); };
  return <div className="category-tree-root" aria-busy={movingId !== null}><CategoryNodes nodes={nodes} close={close} dragEnabled={app.identity.authenticated} dragBusy={movingId !== null}
    selectedId={selectedId} draggingId={draggingId} dropTarget={dropTarget} onDragHandleDown={onDragHandleDown} onDragHandleClick={onDragHandleClick} clearSelection={clearSelection} announce={announce} /></div>;
}

function HomePage() {
  const app = useApp(); const [keyword, setKeyword] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault(); const url = engineUrl(app.preferences.defaultEngine, keyword);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };
  const home = app.homeQuery.data;
  return <main className="page"><div className="home-head"><div><div className="hello">✦ {app.identity.authenticated ? '欢迎回来，所有收藏已就绪' : `欢迎体验 ${APP_NAME}`}</div><h1>你的数字空间，<span>一目了然。</span></h1></div><div className="page-ops">{app.identity.authenticated ? <>
    <Button onClick={() => app.openCategory()}><Icon name="folderPlus" />新建分类</Button><Button className="primary" onClick={app.addBookmark}><Icon name="plus" />添加书签</Button>
  </> : <Button onClick={app.openLogin}><Icon name="unlock" />登录查看全部</Button>}</div></div>
    <section className="search-hero"><div className="search-inner"><h2>想找什么？从这里开始搜索。</h2><p>Google、必应、百度、DuckDuckGo 与 GitHub 搜索自由切换。</p><div className="engine-tabs">{engines.map(engine => <button key={engine.id} className={`engine-tab ${engine.id === app.preferences.defaultEngine ? 'selected' : ''}`} onClick={() => void app.updatePreferences({ defaultEngine: engine.id })}><span className="engine-dot" style={{ '--engine-color': engine.color } as CSSProperties} />{engine.name}</button>)}</div>
      <form className="engine-search" onSubmit={submit}><Icon name="search" /><input aria-label="外部搜索关键词" placeholder={app.preferences.defaultEngine === 'github' ? '搜索 GitHub 仓库…' : '输入关键词，开始搜索…'} value={keyword} onChange={event => setKeyword(event.target.value)} required /><button type="submit">搜索 <Icon name="arrow" /></button></form><div className="search-tip">Enter 搜索 · 在新标签页打开结果</div></div></section>
    {app.homeQuery.isPending ? <Loading /> : app.homeQuery.isError ? <QueryError retry={() => void app.homeQuery.refetch()} /> : home && <>
      <section className="home-block"><Section title="常用快捷方式" detail={`${home.frequent.length} 个星标书签`} /><div className="quick-grid">{home.frequent.length ? home.frequent.map(book => <VisitLink book={book} className="quick-item" key={book.id}><SiteIcon title={book.title} url={book.url} bookmarkId={book.id} /><span className="wrap"><strong>{book.title} <PrivateMark value={book.effectivePrivate} /></strong><small>{domain(resolveBookmarkUrl(book, app.addressMode))}</small></span></VisitLink>) : <div className="home-empty"><Icon name="star" /><span>星标收藏会出现在这里，常用网址一步直达。</span></div>}</div></section>
      <div className="home-bottom"><section><Section title="最近收藏" detail="新添加的链接" /><div className="panel recent-list">{home.recent.length ? home.recent.map(book => <VisitLink book={book} className="recent-row" key={book.id}><SiteIcon title={book.title} url={book.url} bookmarkId={book.id} /><span className="recent-name"><strong className="truncate">{book.title} <PrivateMark value={book.effectivePrivate} /></strong><small className="truncate">{domain(resolveBookmarkUrl(book, app.addressMode))}</small></span><span className="recent-cat truncate">{book.categoryPath}</span><Icon name="external" /></VisitLink>) : <Empty title="给你的数字空间添一条收藏" description="让有价值的网站，在需要的时候随手可得。"><Button className="primary" onClick={app.addBookmark}><Icon name="plus" />添加书签</Button></Empty>}</div></section>
        <section><Section title="收藏概览" detail="当前可见的工作空间" /><div className="panel mini-stats"><div className="stat-counters"><div><strong>{home.counts.bookmarks}</strong><small>全部书签</small></div><div><strong>{home.counts.categories}</strong><small>分类与子分类</small></div><div><strong>{home.counts.favorites}</strong><small>星标收藏</small></div><div><strong>{home.counts.private ?? '—'}</strong><small>私密书签</small></div></div><div className="stat-foot"><Icon name="shield" />{app.identity.authenticated ? '全部收藏已随账号登录展示' : '私密收藏仅在登录后可见'}</div></div></section></div>
    </>}
  </main>;
}

export default function App() {
  const app = useApp(); const navigate = useNavigate(), location = useLocation(); const [params] = useSearchParams();
  const [mobile, setMobile] = useState(false);
  const [categoryAnnouncement, setCategoryAnnouncement] = useState('');
  const pendingSearchFocus = useRef(false);
  const home = location.pathname === '/home';
  const editor = location.pathname.includes('/edit') || location.pathname === '/bookmarks/new';
  const pageName = home ? '导航首页' : editor ? '书签编辑' : '书签管理';
  useEffect(() => { document.title = `${pageName} · ${APP_NAME}`; }, [pageName]);
  useEffect(() => { setMobile(false); }, [location.pathname, app.scope]);
  useEffect(() => {
    if (pendingSearchFocus.current && location.pathname === '/bookmarks') {
      document.querySelector<HTMLInputElement>('#library-search')?.focus();
      pendingSearchFocus.current = false;
    }
  }, [location.key, location.pathname]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>('#library-search');
        if (input) input.focus();
        else { pendingSearchFocus.current = true; navigate('/bookmarks'); }
      }
      if (event.key === 'Escape') setMobile(false);
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [navigate]);
  const go = (path: string) => { navigate(path); setMobile(false); };
  const workspace = workspaceLinks.filter(item => app.preferences.workspaceItems.includes(item.id) && (item.id !== 'private' || app.identity.authenticated));
  const activeWorkspace = { home, all: !home && !params.get('categoryId') && !params.get('filter') && !params.get('privacy'),
    starred: params.get('filter') === 'starred', private: params.get('privacy') === 'private' };
  const workspaceCounts = { all: app.homeQuery.data?.counts.bookmarks, starred: app.homeQuery.data?.counts.favorites, private: app.homeQuery.data?.counts.private };
  if (app.identityQuery.isPending) return <Loading />;
  if (app.identityQuery.isError) return <main className="page"><QueryError retry={() => void app.identityQuery.refetch()} /></main>;
  return <><div className="shell" style={{ '--bookmark-font-size': `${app.preferences.bookmarkFontSize}px`, '--category-font-size': `${app.preferences.categoryFontSize}px` } as CSSProperties}><button className={`mobile-overlay ${mobile ? 'show' : ''}`} aria-label="关闭分类导航" onClick={() => setMobile(false)} /><aside className={`sidebar ${mobile ? 'open' : ''}`}>
    <Link className="brand" to="/home" onClick={() => setMobile(false)}><span className="brand-icon"><Icon name="bookmark" /></span><span><div className="brand-name">Link<em>ora</em></div><div className="brand-caption">YOUR DIGITAL LIBRARY</div></span></Link>
    <div className="side-scroll">{app.preferences.showWorkspace && workspace.length > 0 && <><div className="side-caption">工作空间</div><nav aria-label="工作空间">{workspace.map(item => <button key={item.id} className={`side-link ${activeWorkspace[item.id] ? 'active' : ''}`} onClick={() => go(item.path)}><Icon name={item.icon} />{item.name}{item.id !== 'home' && <span className="count">{workspaceCounts[item.id] ?? ''}</span>}</button>)}</nav></>}
      <div className="side-caption"><span>多级分类</span><span><button title="新增分类" aria-label="新增分类" onClick={() => app.openCategory()}><Icon name="plus" /></button><button title="管理分类" aria-label="管理分类" onClick={app.openManager}><Icon name="settings" /></button></span></div>
      {app.identity.authenticated && app.categories.length > 0 && <p className="sidebar-sort-hint">长按分组手柄选中，拖到同级位置排序。按 Esc 取消。</p>}
      <nav aria-label="多级分类树">{app.categoriesQuery.isPending ? <p className="sidebar-hint">正在加载分类…</p> : app.categoriesQuery.isError ? <button className="side-link" onClick={() => void app.categoriesQuery.refetch()}>重新加载分类</button> : app.categories.length ? <CategoryTree nodes={app.categories} close={() => setMobile(false)} announce={setCategoryAnnouncement} /> : <p className="sidebar-hint">还没有公开分类</p>}</nav><span className="sr-only" aria-live="polite">{categoryAnnouncement}</span></div>
    <div className="side-bottom"><div className="account-banner"><Icon name={app.identity.authenticated ? 'shield' : 'lock'} /><span>{app.identity.authenticated ? '已登录 · 私密内容正常显示' : '访客模式 · 私密内容不展示'}</span></div><div className="side-user"><span className="side-avatar">{app.identity.authenticated ? APP_NAME[0] : '访'}</span><span className="account-text"><strong>{app.identity.owner?.email || '访客浏览'}</strong><small>{app.identity.authenticated ? '你的个人收藏空间' : '登录后查看所有书签'}</small></span><button className="icon-btn" aria-label={app.identity.authenticated ? '账号菜单' : '登录'} onClick={() => app.identity.authenticated ? app.setDialog({ kind: 'account' }) : app.openLogin()}><Icon name={app.identity.authenticated ? 'settings' : 'unlock'} /></button></div></div>
  </aside><div className="content"><header className="topbar"><div className="breadcrumb"><button className="icon-btn mobile-menu" aria-label="打开分类导航" onClick={() => setMobile(true)}><Icon name="menu" /></button><span>工作空间</span><Icon name="right" /><strong>{pageName}</strong></div><div className="top-actions"><label className="top-search"><Icon name="search" /><input id="top-search" aria-label="全局搜索书签" placeholder="搜索书签…" value={params.get('keyword') || ''} onChange={event => navigate('/bookmarks?keyword=' + encodeURIComponent(event.target.value))} /><kbd>⌘ K</kbd></label><a className="btn soft" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="项目源码（GitHub）" title={`查看 ${APP_NAME} 源码`}><Icon name="github" /><span>项目源码</span></a><button className="icon-btn" aria-label="显示设置" title="显示设置" onClick={() => app.setDialog({ kind: 'preferences' })}><Icon name="settings" /></button><button className="icon-btn" aria-label="切换主题" onClick={() => void app.updatePreferences({ theme: app.preferences.theme === 'light' ? 'dark' : 'light' })}><Icon name={app.preferences.theme === 'light' ? 'moon' : 'sun'} /></button>{app.identity.authenticated ? <button className="account-pill" onClick={() => app.setDialog({ kind: 'account' })}><Icon name="shield" />已登录</button> : <button className="top-add" onClick={app.openLogin}><Icon name="unlock" />登录</button>}</div></header>
    <IconRefreshNotice /><div key={app.scope}><Routes><Route path="/home" element={<HomePage />} /><Route path="/bookmarks" element={<LibraryPage />} /><Route path="/bookmarks/new" element={<EditorPage />} /><Route path="/bookmarks/:id/edit" element={<EditorPage />} /><Route path="*" element={<Navigate to="/home" replace />} /></Routes></div>
  </div></div><Dialogs /></>;
}
