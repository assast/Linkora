import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Empty, Icon, Loading, QueryError, SiteIcon } from './components';
import { errorMessage, useApp } from './state';
import { StaleSessionError } from './api';
import { domain, type Bookmark } from './types';

function BookmarkForm({ initial }: { initial?: Bookmark }) {
  const app = useApp(); const navigate = useNavigate();
  const [form, setForm] = useState({ title: initial?.title || '', url: initial?.url || '', description: initial?.description || '', notes: initial?.notes || '', categoryId: initial?.categoryId || '', tags: initial?.tags.join(', ') || '', isFavorite: initial?.isFavorite || false, isPrivate: initial?.isPrivate || false });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const category = app.flatCategories.find(item => item.id === form.categoryId);
  const inherited = category?.effectivePrivate || false;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const body = { ...form, categoryId: form.categoryId || null, tags: form.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) };
    try {
      const result = initial ? await app.saveWithPreview<Bookmark>('bookmarks', initial.id, body) : await app.call<Bookmark>('/bookmarks', { method: 'POST', body });
      if (!result) return;
      await app.refresh(); navigate(`/bookmarks/${result.id}/edit`, { replace: !initial }); toast.success('书签已保存');
    } catch (error) { if (!(error instanceof StaleSessionError)) setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!initial || !await app.confirm({ title: `删除「${initial.title}」？`, description: '删除后无法恢复。', label: '确认永久删除', danger: true })) return;
    try { await app.call(`/bookmarks/${initial.id}`, { method: 'DELETE' }); await app.refresh(); navigate('/bookmarks'); toast.success('书签已删除'); }
    catch (error) { if (!(error instanceof StaleSessionError)) setError(errorMessage(error)); }
  };
  return <><div className="page-head"><div><h1>{initial ? '书签详情 / 编辑' : '添加新书签'}</h1><div className="subline">为值得再次打开的网站，留一个清楚的位置。</div></div>{initial && <a className="btn" href={initial.url} target="_blank" rel="noopener noreferrer"><Icon name="external" />访问网站</a>}</div>
    <div className="editor-layout"><form className="panel editor-form" onSubmit={submit}><div className="form-head"><Icon name="link" />基本信息</div><div className="form-grid">
      <div className="field"><label htmlFor="bookmark-title">书签名称 <span className="req">*</span></label><input id="bookmark-title" value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} required maxLength={200} placeholder="例如：GitHub" /></div>
      <div className="field"><label htmlFor="bookmark-url">网站地址 <span className="req">*</span></label><input id="bookmark-url" type="url" value={form.url} onChange={event => setForm({ ...form, url: event.target.value })} required maxLength={4096} placeholder="https://example.com" /></div></div>
      <div className="field"><label htmlFor="bookmark-description">简要说明</label><input id="bookmark-description" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} maxLength={1000} placeholder="这个网站可以帮你做什么？" /></div>
      <div className="form-grid"><div className="field"><label htmlFor="bookmark-category">所在分类</label><select id="bookmark-category" value={form.categoryId} onChange={event => setForm({ ...form, categoryId: event.target.value })}><option value="">未分类</option>{app.flatCategories.map(item => <option value={item.id} key={item.id}>{item.path}{item.effectivePrivate ? ' · 私密' : ''}</option>)}</select><small>私密分类会自动保护其中的书签</small></div>
        <div className="field"><label htmlFor="bookmark-tags">标签</label><input id="bookmark-tags" value={form.tags} onChange={event => setForm({ ...form, tags: event.target.value })} placeholder="代码, 常用, 工具" /><small>以逗号分隔，最多 20 个标签</small></div></div>
      <div className="field"><label htmlFor="bookmark-notes">个人笔记</label><textarea id="bookmark-notes" value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} maxLength={10000} placeholder="记录使用方法或收藏原因…" /></div>
      <div className="check-area"><label className="check-card"><input type="checkbox" checked={form.isFavorite} onChange={event => setForm({ ...form, isFavorite: event.target.checked })} /><span><strong>设为星标书签</strong><small>显示在首页常用快捷方式</small></span></label>
        <label className="check-card"><input type="checkbox" checked={inherited || form.isPrivate} disabled={inherited} onChange={event => setForm({ ...form, isPrivate: event.target.checked })} /><span><strong>设为私密书签</strong><small>{inherited ? '继承私密分类属性，无法取消' : form.isPrivate ? '仅登录后可见' : '普通书签对访客可见'}</small></span></label></div>
      {error && <p className="modal-error" role="alert">{error}</p>}<div className="editor-actions"><Button type="submit" className="primary" disabled={busy}><Icon name="save" />{busy ? '保存中…' : initial ? '保存修改' : '保存书签'}</Button><Button onClick={() => navigate('/bookmarks')}>取消</Button><span className="push" />{initial && <Button className="danger" onClick={() => void remove()}><Icon name="trash" />删除</Button>}</div>
    </form><aside className="editor-side"><div className="panel preview-box"><h3>实时预览</h3><div className="preview-inline"><SiteIcon title={form.title || '网站名称'} url={form.url} /><span className="wrap"><strong className="truncate">{form.title || '网站名称'}</strong><small>{domain(form.url)}</small></span></div><p className="preview-desc">{form.description || '网站说明将展示在这里'}</p><div className="summary-line"><span>所属分类</span><strong>{category?.path || '未分类'}</strong></div><div className="summary-line"><span>隐私设置</span><strong>{inherited || form.isPrivate ? '私密 · 仅登录后可见' : '普通 · 访客可见'}</strong></div><div className="security-note"><Icon name="shield" />私密内容与普通收藏统一管理。退出登录后，私密内容自动隐藏。</div></div></aside></div>
  </>;
}

export function EditorPage() {
  const app = useApp(), navigate = useNavigate(); const { id } = useParams();
  const query = useQuery({ queryKey: ['data', app.scope, 'bookmark', id], enabled: app.ready && app.identity.authenticated && !!id,
    queryFn: ({ signal }) => app.call<Bookmark>(`/bookmarks/${id}`, { signal }) });
  if (!app.identity.authenticated) return <main className="page"><Empty title="登录后管理书签" description="登录你的账号，继续整理全部收藏。"><Button className="primary" onClick={app.openLogin}>登录</Button></Empty></main>;
  return <main className="page"><button className="back" onClick={() => navigate('/bookmarks')}><Icon name="back" />返回书签库</button>
    {id && query.isPending ? <Loading /> : id && query.isError ? <QueryError retry={() => void query.refetch()} /> : <BookmarkForm key={id || 'new'} initial={query.data} />}
  </main>;
}
