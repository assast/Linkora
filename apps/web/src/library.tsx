import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Empty, Icon, Loading, PrivateMark, QueryError, SiteIcon } from './components';
import { useApp, errorMessage } from './state';
import { StaleSessionError } from './api';
import { domain, type Bookmark, type Impact, type Operation, type Page } from './types';

export function VisitLink({ book, className = '', children }: { book: Bookmark; className?: string; children: React.ReactNode }) {
  const app = useApp();
  return <a className={className} href={book.url} target="_blank" rel="noopener noreferrer" onClick={() => {
    if (app.identity.authenticated) void app.call(`/bookmarks/${book.id}/visits`, { method: 'POST' }).catch(() => {});
  }}>{children}</a>;
}

const labels: Record<Operation, string> = { MOVE_CATEGORY: '移动分类', ADD_TAGS: '添加标签', REMOVE_TAGS: '移除标签', REPLACE_TAGS: '替换标签', SET_FAVORITE: '设置星标', SET_PRIVACY: '设置私密', DELETE: '永久删除', EXPORT: '导出 JSON' };

export function LibraryPage() {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);
  const [selectedState, setSelectedState] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [targetCategory, setTargetCategory] = useState('');
  const [tagText, setTagText] = useState('');
  const [settingValue, setSettingValue] = useState('true');
  const [busy, setBusy] = useState(false);
  const key = app.scope + ':' + params.toString();
  const selected = selectedState.key === key ? selectedState.ids : [];
  const select = (ids: string[]) => setSelectedState({ key, ids });
  const requestParams = new URLSearchParams(params);
  requestParams.delete('filter');
  if (params.get('filter') === 'starred') requestParams.set('favorite', 'true');
  const query = useQuery({ queryKey: ['data', app.scope, 'bookmarks', requestParams.toString()], enabled: app.ready,
    queryFn: ({ signal }) => app.call<Page>('/bookmarks?' + requestParams.toString(), { signal }) });
  const category = app.flatCategories.find(item => item.id === params.get('categoryId'));
  const categoryBooks = useQuery({ queryKey: ['data', app.scope, 'category-bookmarks', category?.id], enabled: app.ready && !!category,
    queryFn: async ({ signal }) => {
      const books: Bookmark[] = [];
      for (let page = 1; ; page++) {
        const search = new URLSearchParams({ categoryId: category!.id, includeDescendants: 'true', page: String(page), pageSize: '100', sort: 'oldest' });
        const result = await app.call<Page>('/bookmarks?' + search, { signal });
        books.push(...result.items);
        if (!result.items.length || page * result.pageSize >= result.total) return books;
      }
    } });
  const openCategoryBooks = () => {
    const books = categoryBooks.data || [];
    let opened = 0;
    for (const book of books) {
      const tab = window.open('about:blank', '_blank');
      if (!tab) { toast.error(`浏览器拦截了批量打开（已打开 ${opened}/${books.length}），请允许本站弹出窗口后重试`); break; }
      tab.opener = null; tab.location.replace(book.url); opened++;
      if (app.identity.authenticated) void app.call(`/bookmarks/${book.id}/visits`, { method: 'POST' }).catch(() => {});
    }
  };
  const title = category?.name || (params.get('filter') === 'starred' ? '星标收藏' : params.get('privacy') === 'private' ? '私密书签' : '全部书签');
  const changeFilter = (name: string, value: string) => {
    const next = new URLSearchParams(params); if (value) next.set(name, value); else next.delete(name); next.delete('page'); if (name === 'favorite') next.delete('filter'); setParams(next);
  };
  const toggle = (id: string) => select(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);
  const allSelected = !!query.data?.items.length && query.data.items.every(book => selected.includes(book.id));
  const toggleStar = async (book: Bookmark) => {
    try { await app.call(`/bookmarks/${book.id}`, { method: 'PATCH', body: { isFavorite: !book.isFavorite } }); await app.refresh(); }
    catch (error) { if (!(error instanceof StaleSessionError)) toast.error(errorMessage(error)); }
  };
  const submitBatch = async () => {
    if (!operation || !selected.length) return;
    setBusy(true);
    const payload = operation === 'MOVE_CATEGORY' ? { categoryId: targetCategory || null }
      : ['ADD_TAGS', 'REMOVE_TAGS', 'REPLACE_TAGS'].includes(operation) ? { tags: tagText.split(/[,，]/).map(value => value.trim()).filter(Boolean) }
      : ['SET_FAVORITE', 'SET_PRIVACY'].includes(operation) ? { value: settingValue === 'true' } : {};
    const body = { operation, bookmarkIds: selected, payload };
    try {
      const impact = await app.call<Impact>('/bookmarks/batch/preview', { method: 'POST', body });
      const description = operation === 'DELETE' ? '删除后无法恢复，请核对选中的内容。'
        : operation === 'EXPORT' && impact.privateBookmarks ? `文件包含 ${impact.privateBookmarks} 条私密书签，确认后下载。` : `操作将影响本页已选择的 ${selected.length} 条书签，请核对数量与预览。`;
      const accepted = await app.confirm({ title: `${labels[operation]} · ${selected.length} 条书签`, description, impact,
        label: operation === 'DELETE' ? '确认永久删除' : operation === 'EXPORT' ? '确认导出' : '确认应用', danger: operation === 'DELETE' || impact.becomingPublicBookmarks > 0 });
      if (!accepted) return;
      const result = await app.call(operation === 'EXPORT' ? '/bookmarks/export' : '/bookmarks/batch', {
        method: 'POST', body: { ...body, expectedRevision: impact.revision, confirmedPublic: true, confirmedDelete: operation === 'DELETE', confirmedPrivateExport: operation === 'EXPORT' },
      });
      if (operation === 'EXPORT') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'linkora-bookmarks.json'; anchor.click(); URL.revokeObjectURL(url);
      } else await app.refresh();
      select([]); setOperation(null); toast.success(operation === 'EXPORT' ? '书签已导出' : '批量操作已完成');
    } catch (error) { if (!(error instanceof StaleSessionError)) toast.error(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const rowActions = (book: Bookmark) => <span className="row-actions">{app.identity.authenticated ? <>
    <button title={book.isFavorite ? '取消星标' : '添加星标'} aria-label={`${book.isFavorite ? '取消星标' : '添加星标'} ${book.title}`} className={book.isFavorite ? 'starred' : ''} onClick={() => void toggleStar(book)}><Icon name="star" /></button>
    <Link className="row-edit" to={`/bookmarks/${book.id}/edit`} title="编辑" aria-label={`编辑 ${book.title}`}><Icon name="more" /></Link>
  </> : <button title="登录后编辑" onClick={app.openLogin}><Icon name="lock" /></button>}</span>;

  return <main className="page"><div className="page-head"><div><h1>{title}</h1><div className="subline">共 {query.data?.total ?? '—'} 条书签 · {app.identity.authenticated ? '普通与私密收藏，统一整理' : '访客浏览公开内容，登录后查看全部'}</div>{category && <div className="folder-path"><Icon name="folder" /><b>{category.path}</b></div>}</div>
    <div className="page-ops"><Button onClick={() => app.openCategory(undefined, category?.id)}><Icon name="folderPlus" />新建分类</Button><Button className="primary" onClick={app.addBookmark}><Icon name="plus" />添加书签</Button></div></div>
    {category && <div className="category-actions"><Button disabled={!categoryBooks.data?.length} onClick={openCategoryBooks}><Icon name="external" />打开全部书签</Button>
      {categoryBooks.isError ? <Button onClick={() => void categoryBooks.refetch()}>重新加载分类书签</Button>
        : <span>{categoryBooks.isPending ? '正在加载分类书签…' : `共 ${categoryBooks.data?.length ?? 0} 条 · 包含子分类`}</span>}</div>}
    <div className="library-toolbar"><label className="field-search"><Icon name="search" /><input id="library-search" aria-label="搜索书签" placeholder="搜索书签名称、域名、标签或路径…" value={params.get('keyword') || ''} onChange={event => changeFilter('keyword', event.target.value)} /></label>
      <Button className={showFilters ? 'soft' : ''} onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}><Icon name="filter" />筛选</Button>
      <select className="control-select" aria-label="排序" value={params.get('sort') || 'newest'} onChange={event => changeFilter('sort', event.target.value)}><option value="newest">最近添加</option><option value="oldest">最早添加</option><option value="frequent">访问最多</option><option value="title">名称 A–Z</option></select>
      <div className="view-control"><button className={app.preferences.defaultView === 'list' ? 'active' : ''} title="紧凑列表" aria-label="紧凑列表" aria-pressed={app.preferences.defaultView === 'list'} onClick={() => void app.updatePreferences({ defaultView: 'list' })}><Icon name="list" /></button><button className={app.preferences.defaultView === 'grid' ? 'active' : ''} title="紧凑卡片" aria-label="紧凑卡片" aria-pressed={app.preferences.defaultView === 'grid'} onClick={() => void app.updatePreferences({ defaultView: 'grid' })}><Icon name="grid" /></button></div>
    </div>
    {showFilters && <div className="filter-panel panel"><label>星标<select className="control-select" value={params.get('favorite') || ''} onChange={event => changeFilter('favorite', event.target.value)}><option value="">全部</option><option value="true">仅星标</option><option value="false">未星标</option></select></label>
      {app.identity.authenticated && <label>可见性<select className="control-select" value={params.get('privacy') || 'all'} onChange={event => changeFilter('privacy', event.target.value)}><option value="all">全部</option><option value="public">普通</option><option value="private">私密</option></select></label>}
      <div className="filter-tags"><span>标签（全部匹配）</span>{app.tagsQuery.data?.map(tag => <label className="tag-filter" key={tag.id}><input type="checkbox" checked={(params.get('tagIds') || '').split(',').includes(tag.id)} onChange={event => {
        const ids = (params.get('tagIds') || '').split(',').filter(Boolean); changeFilter('tagIds', (event.target.checked ? [...ids, tag.id] : ids.filter(id => id !== tag.id)).join(','));
      }} />{tag.name}</label>)}</div><Button onClick={() => setParams(category ? { categoryId: category.id } : {})}>清除筛选</Button></div>}
    {app.identity.authenticated && selected.length > 0 && <div className="bulk-bar bulk-visible"><span className="bulk-total"><Icon name="check" />已选择 <b>{selected.length}</b> 条（当前页）</span>
      <select className="control-select" aria-label="批量操作" value={operation || ''} onChange={event => setOperation(event.target.value as Operation || null)}><option value="">选择操作</option>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      {operation === 'MOVE_CATEGORY' && <select className="control-select batch-target" aria-label="目标分类" value={targetCategory} onChange={event => setTargetCategory(event.target.value)}><option value="">未分类</option>{app.flatCategories.map(item => <option value={item.id} key={item.id}>{item.path}</option>)}</select>}
      {operation && ['ADD_TAGS', 'REMOVE_TAGS', 'REPLACE_TAGS'].includes(operation) && <input className="batch-tags" aria-label="批量标签" placeholder="用逗号分隔标签" value={tagText} onChange={event => setTagText(event.target.value)} />}
      {operation && ['SET_FAVORITE', 'SET_PRIVACY'].includes(operation) && <select className="control-select" aria-label="设置值" value={settingValue} onChange={event => setSettingValue(event.target.value)}><option value="true">{operation === 'SET_FAVORITE' ? '添加星标' : '设为私密'}</option><option value="false">{operation === 'SET_FAVORITE' ? '取消星标' : '设为普通'}</option></select>}
      <Button className={operation === 'DELETE' ? 'danger' : 'primary'} disabled={!operation || busy} onClick={() => void submitBatch()}>{busy ? '处理中…' : '预览操作'}</Button><Button className="clear-selected" onClick={() => select([])}>取消选择</Button></div>}
    {query.isPending ? <Loading /> : query.isError ? <QueryError retry={() => void query.refetch()} /> : !query.data.items.length ? <Empty title="没有找到符合条件的书签" description="试试其他关键词或分类，也可以添加你的第一条收藏。"><Button onClick={() => setParams({})}>查看全部</Button></Empty> : <>
      {app.preferences.defaultView === 'list' ? <div className={`data-table panel ${app.identity.authenticated ? 'with-selection' : ''}`}>
        <div className="table-header">{app.identity.authenticated && <input type="checkbox" aria-label="全选当前页" checked={allSelected} onChange={event => select(event.target.checked ? query.data.items.map(book => book.id) : [])} />}<span>书签名称</span><span className="table-url">链接</span><span className="bookmark-category">所属分类</span><span className="bookmark-tags">标签</span><span className="bookmark-date">添加日期</span><span>操作</span></div>
        {query.data.items.map(book => <div className={`bookmark-row ${selected.includes(book.id) ? 'row-selected' : ''}`} key={book.id}>
          {app.identity.authenticated && <input className="select-bookmark" type="checkbox" aria-label={`选择 ${book.title}`} checked={selected.includes(book.id)} onChange={() => toggle(book.id)} />}
          <VisitLink book={book} className="bookmark-primary bookmark-surface-link"><SiteIcon title={book.title} url={book.url} /><span className="bookmark-name"><strong title={book.title}>{book.title} <PrivateMark value={book.effectivePrivate} /></strong></span></VisitLink>
          <VisitLink book={book} className="bookmark-url truncate">{domain(book.url)}</VisitLink>
          <span className="bookmark-category truncate" title={book.categoryPath}>{book.categoryPath}</span><span className="bookmark-tags">{book.tags.slice(0, 2).map(tag => <span className="tiny-tag" key={tag}>{tag}</span>)}</span><span className="bookmark-date">{book.createdAt.slice(0, 10)}</span>{rowActions(book)}
        </div>)}</div> : <div className="tile-grid">{query.data.items.map(book => <div className={`bookmark-tile ${selected.includes(book.id) ? 'row-selected' : ''}`} key={book.id}><div className="tile-top">
          {app.identity.authenticated && <input className="select-bookmark" type="checkbox" aria-label={`选择 ${book.title}`} checked={selected.includes(book.id)} onChange={() => toggle(book.id)} />}
          <SiteIcon title={book.title} url={book.url} /><div className="tile-name"><VisitLink book={book} className="bookmark-surface-link"><span className="truncate">{book.title} <PrivateMark value={book.effectivePrivate} /></span></VisitLink><div className="tile-domain truncate">{domain(book.url)}</div></div>{rowActions(book)}</div><div className="tile-bottom"><span title={book.categoryPath}>{book.categoryPath}</span>{book.isFavorite && <Icon name="star" />}</div></div>)}</div>}
      <div className="pagination"><span>共 {query.data.total} 条 · 第 {query.data.page} / {Math.max(1, Math.ceil(query.data.total / query.data.pageSize))} 页</span><select className="control-select" aria-label="每页数量" value={query.data.pageSize} onChange={event => changeFilter('pageSize', event.target.value)}>{[20, 50, 100].map(size => <option value={size} key={size}>{size} 条/页</option>)}</select>
        <Button disabled={query.data.page <= 1} onClick={() => { const next = new URLSearchParams(params); next.set('page', String(query.data.page - 1)); setParams(next); }}>上一页</Button><Button disabled={query.data.page * query.data.pageSize >= query.data.total} onClick={() => { const next = new URLSearchParams(params); next.set('page', String(query.data.page + 1)); setParams(next); }}>下一页</Button></div>
    </>}
  </main>;
}
