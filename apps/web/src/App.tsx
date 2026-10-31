import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Empty, Icon, Loading, PrivateMark, QueryError, Section, SiteIcon } from './components';
import { APP_NAME, REPOSITORY_URL } from './constants';
import { Dialogs } from './dialogs';
import { EditorPage } from './editor';
import { LibraryPage, VisitLink } from './library';
import { useApp } from './state';
import { domain, engines, engineUrl, type Category } from './types';

function CategoryTree({ nodes, depth = 0, close }: { nodes: Category[]; depth?: number; close: () => void }) {
  const app = useApp(), navigate = useNavigate(); const [params] = useSearchParams();
  return nodes.map(category => {
    const expanded = app.preferences.expandedCategories.includes(category.id);
    return <div className="tree-node" key={category.id}><div className={`tree-line ${params.get('categoryId') === category.id ? 'selected' : ''}`} style={{ paddingLeft: Math.min(depth, 9) * 12 + 5 }}>
      <button className={`tree-toggle ${category.children.length ? 'has-children' : ''}`} aria-label={`${expanded ? '折叠' : '展开'}${category.name}`} aria-expanded={expanded} onClick={() => void app.updatePreferences({ expandedCategories: expanded ? app.preferences.expandedCategories.filter(id => id !== category.id) : [...app.preferences.expandedCategories, category.id] })}><Icon name={expanded ? 'down' : 'right'} /></button>
      <button className="tree-main" title={category.path} onClick={() => { navigate('/bookmarks?categoryId=' + category.id); close(); }}><Icon name="folder" className="folder-icon" /><strong>{category.name}</strong>{category.effectivePrivate && <Icon name="lock" className="tree-lock" />}<span className="count">{category.count || ''}</span></button>
    </div>{expanded && <CategoryTree nodes={category.children} depth={depth + 1} close={close} />}</div>;
  });
}

function HomePage() {
  const app = useApp(); const [keyword, setKeyword] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault(); const url = engineUrl(app.preferences.defaultEngine, keyword);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };
  const home = app.homeQuery.data;
  return <main className="page"><div className="home-head"><div><div className="hello">✦ {app.identity.authenticated ? '欢迎回来，所有收藏已就绪' : `欢迎体验 ${APP_NAME}`}</div><h1>你的数字空间，<span>一目了然。</span></h1></div><Button onClick={() => app.identity.authenticated ? app.openCategory() : app.openLogin()}><Icon name={app.identity.authenticated ? 'folderPlus' : 'unlock'} />{app.identity.authenticated ? '新建分类' : '登录查看全部'}</Button></div>
    <section className="search-hero"><div className="search-inner"><h2>想找什么？从这里开始搜索。</h2><p>Google、必应、百度、DuckDuckGo 与 GitHub 搜索自由切换。</p><div className="engine-tabs">{engines.map(engine => <button key={engine.id} className={`engine-tab ${engine.id === app.preferences.defaultEngine ? 'selected' : ''}`} onClick={() => void app.updatePreferences({ defaultEngine: engine.id })}><span className="engine-dot" style={{ '--engine-color': engine.color } as CSSProperties} />{engine.name}</button>)}</div>
      <form className="engine-search" onSubmit={submit}><Icon name="search" /><input aria-label="外部搜索关键词" placeholder={app.preferences.defaultEngine === 'github' ? '搜索 GitHub 仓库…' : '输入关键词，开始搜索…'} value={keyword} onChange={event => setKeyword(event.target.value)} required /><button type="submit">搜索 <Icon name="arrow" /></button></form><div className="search-tip">Enter 搜索 · 在新标签页打开结果</div></div></section>
    {app.homeQuery.isPending ? <Loading /> : app.homeQuery.isError ? <QueryError retry={() => void app.homeQuery.refetch()} /> : home && <>
      <section className="home-block"><Section title="常用快捷方式" detail={`${home.frequent.length} 个星标书签`} /><div className="quick-grid">{home.frequent.length ? home.frequent.map(book => <VisitLink book={book} className="quick-item" key={book.id}><SiteIcon title={book.title} url={book.url} /><span className="wrap"><strong>{book.title} <PrivateMark value={book.effectivePrivate} /></strong><small>{domain(book.url)}</small></span></VisitLink>) : <div className="home-empty"><Icon name="star" /><span>星标收藏会出现在这里，常用网址一步直达。</span></div>}</div></section>
      <div className="home-bottom"><section><Section title="最近收藏" detail="新添加的链接" /><div className="panel recent-list">{home.recent.length ? home.recent.map(book => <VisitLink book={book} className="recent-row" key={book.id}><SiteIcon title={book.title} url={book.url} /><span className="recent-name"><strong className="truncate">{book.title} <PrivateMark value={book.effectivePrivate} /></strong><small className="truncate">{domain(book.url)}</small></span><span className="recent-cat truncate">{book.categoryPath}</span><Icon name="external" /></VisitLink>) : <Empty title="给你的数字空间添一条收藏" description="让有价值的网站，在需要的时候随手可得。"><Button className="primary" onClick={app.addBookmark}><Icon name="plus" />添加书签</Button></Empty>}</div></section>
        <section><Section title="收藏概览" detail="当前可见的工作空间" /><div className="panel mini-stats"><div className="stat-counters"><div><strong>{home.counts.bookmarks}</strong><small>全部书签</small></div><div><strong>{home.counts.categories}</strong><small>分类与子分类</small></div><div><strong>{home.counts.favorites}</strong><small>星标收藏</small></div><div><strong>{home.counts.private ?? '—'}</strong><small>私密书签</small></div></div><div className="stat-foot"><Icon name="shield" />{app.identity.authenticated ? '全部收藏已随账号登录展示' : '私密收藏仅在登录后可见'}</div></div></section></div>
    </>}
  </main>;
}

export default function App() {
  const app = useApp(); const navigate = useNavigate(), location = useLocation(); const [params] = useSearchParams();
  const [mobile, setMobile] = useState(false);
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
  if (app.identityQuery.isPending) return <Loading />;
  if (app.identityQuery.isError) return <main className="page"><QueryError retry={() => void app.identityQuery.refetch()} /></main>;
  return <><div className="shell"><button className={`mobile-overlay ${mobile ? 'show' : ''}`} aria-label="关闭分类导航" onClick={() => setMobile(false)} /><aside className={`sidebar ${mobile ? 'open' : ''}`}>
    <Link className="brand" to="/home" onClick={() => setMobile(false)}><span className="brand-icon"><Icon name="bookmark" /></span><span><div className="brand-name">Link<em>ora</em></div><div className="brand-caption">YOUR DIGITAL LIBRARY</div></span></Link>
    <div className="side-scroll"><div className="side-caption">工作空间</div><nav aria-label="工作空间"><button className={`side-link ${home ? 'active' : ''}`} onClick={() => go('/home')}><Icon name="grid" />导航首页</button><button className={`side-link ${!home && !params.get('categoryId') && !params.get('filter') && !params.get('privacy') ? 'active' : ''}`} onClick={() => go('/bookmarks')}><Icon name="bookmark" />全部书签<span className="count">{app.homeQuery.data?.counts.bookmarks ?? ''}</span></button><button className={`side-link ${params.get('filter') === 'starred' ? 'active' : ''}`} onClick={() => go('/bookmarks?filter=starred')}><Icon name="star" />星标收藏<span className="count">{app.homeQuery.data?.counts.favorites ?? ''}</span></button>{app.identity.authenticated && <button className={`side-link ${params.get('privacy') === 'private' ? 'active' : ''}`} onClick={() => go('/bookmarks?privacy=private')}><Icon name="lock" />私密书签<span className="count">{app.homeQuery.data?.counts.private ?? ''}</span></button>}</nav>
      <div className="side-caption"><span>多级分类</span><span><button title="新增分类" aria-label="新增分类" onClick={() => app.openCategory()}><Icon name="plus" /></button><button title="管理分类" aria-label="管理分类" onClick={app.openManager}><Icon name="settings" /></button></span></div>
      <nav aria-label="多级分类树">{app.categoriesQuery.isPending ? <p className="sidebar-hint">正在加载分类…</p> : app.categoriesQuery.isError ? <button className="side-link" onClick={() => void app.categoriesQuery.refetch()}>重新加载分类</button> : app.categories.length ? <CategoryTree nodes={app.categories} close={() => setMobile(false)} /> : <p className="sidebar-hint">还没有公开分类</p>}</nav></div>
    <div className="side-bottom"><div className="account-banner"><Icon name={app.identity.authenticated ? 'shield' : 'lock'} /><span>{app.identity.authenticated ? '已登录 · 私密内容正常显示' : '访客模式 · 私密内容不展示'}</span></div><div className="side-user"><span className="side-avatar">{app.identity.authenticated ? APP_NAME[0] : '访'}</span><span className="account-text"><strong>{app.identity.owner?.email || '访客浏览'}</strong><small>{app.identity.authenticated ? '你的个人收藏空间' : '登录后查看所有书签'}</small></span><button className="icon-btn" aria-label={app.identity.authenticated ? '账号菜单' : '登录'} onClick={() => app.identity.authenticated ? app.setDialog({ kind: 'account' }) : app.openLogin()}><Icon name={app.identity.authenticated ? 'settings' : 'unlock'} /></button></div></div>
  </aside><div className="content"><header className="topbar"><div className="breadcrumb"><button className="icon-btn mobile-menu" aria-label="打开分类导航" onClick={() => setMobile(true)}><Icon name="menu" /></button><span>工作空间</span><Icon name="right" /><strong>{pageName}</strong></div><div className="top-actions"><label className="top-search"><Icon name="search" /><input id="top-search" aria-label="全局搜索书签" placeholder="搜索书签…" value={params.get('keyword') || ''} onChange={event => navigate('/bookmarks?keyword=' + encodeURIComponent(event.target.value))} /><kbd>⌘ K</kbd></label><a className="btn soft" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="项目源码（GitHub）" title={`查看 ${APP_NAME} 源码`}><Icon name="github" /><span>项目源码</span></a><button className="icon-btn" aria-label="切换主题" onClick={() => void app.updatePreferences({ theme: app.preferences.theme === 'light' ? 'dark' : 'light' })}><Icon name={app.preferences.theme === 'light' ? 'moon' : 'sun'} /></button>{app.identity.authenticated ? <><button className="top-add" onClick={app.addBookmark}><Icon name="plus" />添加书签</button><button className="account-pill" onClick={() => app.setDialog({ kind: 'account' })}><Icon name="shield" />已登录</button></> : <button className="top-add" onClick={app.openLogin}><Icon name="unlock" />登录</button>}</div></header>
    <div key={app.scope}><Routes><Route path="/home" element={<HomePage />} /><Route path="/bookmarks" element={<LibraryPage />} /><Route path="/bookmarks/new" element={<EditorPage />} /><Route path="/bookmarks/:id/edit" element={<EditorPage />} /><Route path="*" element={<Navigate to="/home" replace />} /></Routes></div>
  </div></div><Dialogs /></>;
}
