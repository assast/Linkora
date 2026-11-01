import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, StaleSessionError } from './api';
import { Button, Icon, Loading, Modal, QueryError, SiteIcon } from './components';
import { errorMessage, useApp } from './state';
import type { Bookmark, BookmarkIconConfig, IconLibraryPage } from './types';

function LibraryPreview({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  return <span className="library-icon-preview">{failed ? <span>预览暂不可用</span> : <img src={`/api/v1/icon-library/${encodeURIComponent(id)}/preview`} alt="" loading="lazy" onError={() => setFailed(true)} />}</span>;
}

export function BookmarkIconEditor({ bookmark, url }: { bookmark?: Bookmark; url: string }) {
  const app = useApp(), client = useQueryClient();
  const [open, setOpen] = useState(false), [keyword, setKeyword] = useState(''), [page, setPage] = useState(1), [selected, setSelected] = useState('');
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = ['data', app.scope, 'icon-config', bookmark?.id];
  const query = useQuery({ queryKey: key, enabled: !!bookmark && app.identity.authenticated,
    queryFn: ({ signal }) => app.call<BookmarkIconConfig>(`/bookmarks/${bookmark!.id}/icon-config`, { signal }) });
  const library = useQuery({ queryKey: ['data', app.scope, 'icon-library', keyword, page], enabled: open && app.identity.authenticated,
    queryFn: ({ signal }) => app.call<IconLibraryPage>('/icon-library?' + new URLSearchParams({ keyword, page: String(page), pageSize: '24' }), { signal }) });
  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const objectUrl = URL.createObjectURL(file); setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const paused = !bookmark || url !== bookmark.url;
  const config = query.data;
  const apply = async (body: object | FormData) => {
    if (!bookmark || paused || !config) return;
    setBusy(true); setError('');
    try {
      const multipart = body instanceof FormData;
      const next = await app.call<BookmarkIconConfig>(`/bookmarks/${bookmark.id}/${multipart ? 'icon-upload' : 'icon-config'}`, { method: multipart ? 'POST' : 'PATCH', body });
      client.setQueryData(key, next); app.reloadIcons(); setOpen(false); setFile(null);
      await app.refresh(); toast.success('书签图标已更新');
    } catch (error) {
      if (!(error instanceof StaleSessionError)) {
        setError(errorMessage(error));
        if (error instanceof ApiError && error.status === 409) await query.refetch();
      }
    } finally { setBusy(false); }
  };
  const applyUpload = () => {
    if (!file || !config) return;
    const body = new FormData(); body.append('expectedVersion', config.version || 'null'); body.append('file', file);
    void apply(body);
  };
  const source = config?.source || 'auto';
  const labels = { auto: '自动 Favicon', dashboard: 'Dashboard Icons', upload: '自定义上传' };
  return <section className="panel bookmark-icon-editor" aria-label="书签图标设置"><h3>书签图标</h3>
    {!bookmark ? <p className="subline">保存书签后可选择或上传图标。</p> : <>
      <div className="icon-current"><SiteIcon bookmarkId={paused ? undefined : bookmark.id} title={bookmark.title} url={url} /><div><strong>{labels[source]}</strong>{config?.dashboardId && <small>{config.dashboardId}</small>}</div></div>
      {paused && <p className="subline">先保存网站地址，再修改图标。</p>}
      {query.isPending && <Loading />}{query.isError && <QueryError retry={() => void query.refetch()} />}
      <fieldset disabled={paused || busy || !config} className="icon-settings-fields">
        <div className="icon-source-actions"><Button onClick={() => { setSelected(config?.dashboardId || ''); setError(''); setOpen(true); }}>从图标库选择</Button>
          <Button disabled={source === 'auto'} onClick={() => void apply({ source: 'auto', expectedVersion: config?.version })}>恢复自动</Button></div>
        <label className="field icon-upload-field"><span>上传图片</span><input aria-label="上传书签图标" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
          const next = event.target.files?.[0]; event.target.value = ''; setError('');
          if (!next) return;
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(next.type) || next.size > 2 * 1024 * 1024) {
            setFile(null); setError('请选择不超过 2 MiB 的 PNG、JPEG 或 WebP 图片'); return;
          }
          setFile(next);
        }} /><small>PNG、JPEG、WebP 静态图片，最多 2 MiB。</small></label>
        {file && <div className="upload-icon-preview">{preview && <img src={preview} alt="待应用的上传图标" />}<Button className="primary" onClick={applyUpload}>{busy ? '应用中…' : '应用上传图标'}</Button><Button onClick={() => setFile(null)}>取消上传</Button></div>}
        <Button disabled={source !== 'auto' || app.startingIcons} onClick={() => void app.startIconRefresh([bookmark.id])}>刷新自动图标</Button>
      </fieldset>
    </>}
    {error && <p className="modal-error" role="alert">{error}</p>}
    {open && <Modal title="选择 Dashboard 图标" description="按名称搜索并选择图标，浅色或深色版本由你决定。" wide onClose={() => { if (!busy) setOpen(false); }}>
      <label className="field-search"><Icon name="search" /><input aria-label="搜索图标库" value={keyword} maxLength={100} placeholder="搜索名称，例如 github、docker…" onChange={event => { setKeyword(event.target.value); setPage(1); }} /></label>
      {library.isPending ? <Loading /> : library.isError ? <QueryError retry={() => void library.refetch()} /> : <>
        <div className="icon-library-grid">{library.data.items.map(item => <button type="button" className={`icon-library-option ${selected === item.id ? 'selected' : ''}`} key={item.id} aria-label={`选择图标 ${item.id}`} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
          <LibraryPreview id={item.id} /><strong>{item.id}</strong></button>)}</div>
        {!library.data.total && <p className="subline">没有匹配的图标，试试其他名称。</p>}
        <div className="icon-library-pagination"><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span>{page} / {Math.max(1, Math.ceil(library.data.total / 24))}</span><Button disabled={page * 24 >= library.data.total} onClick={() => setPage(page + 1)}>下一页</Button></div>
      </>}
      {error && <p className="modal-error" role="alert">{error}</p>}
      <div className="editor-actions"><span className="subline">{selected || '请选择一个图标'}</span><span className="push" /><Button className="primary" disabled={!selected || busy} onClick={() => void apply({ source: 'dashboard', dashboardId: selected, expectedVersion: config?.version })}>{busy ? '应用中…' : '应用图标'}</Button></div>
    </Modal>}
  </section>;
}
