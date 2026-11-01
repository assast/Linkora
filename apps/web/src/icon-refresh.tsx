import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, Loading, Modal, QueryError } from './components';
import { useApp } from './state';
import type { IconRefreshJob } from './types';

const reasons = { success: '已刷新', failed: '抓取失败，保留旧图', manual: '保留人工图标', blocked: '无法自动抓取', changed: '书签已变化' };

export function IconRefreshNotice() {
  const app = useApp();
  const [details, setDetails] = useState(false), [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['data', app.scope, 'icon-refresh-results', app.iconJobId, page], enabled: details && !!app.iconJobId && app.identity.authenticated,
    queryFn: ({ signal }) => app.call<IconRefreshJob>(`/icon-refresh-jobs/${app.iconJobId}?page=${page}`, { signal }),
    refetchInterval: app.iconJob?.state === 'completed' ? false : 1500, retry: false });
  const job = app.iconJob;
  if (!job) return null;
  return <section className="panel icon-refresh-notice" aria-label="图标刷新进度"><div role="status"><strong>{job.state === 'completed' ? '自动图标刷新已完成' : '正在刷新自动图标'}</strong>
    <span>{job.processed} / {job.total} 条 · 成功 {job.success} · 失败 {job.failed} · 跳过 {job.skipped}</span></div>
    <progress aria-label="自动图标刷新进度" value={job.total ? job.processed : job.state === 'completed' ? 1 : 0} max={Math.max(1, job.total)} />
    <small>同一站点的自动图标会同步更新，上传和手动选择的图标会保留。</small>
    <div className="icon-source-actions"><Button onClick={() => { setPage(1); setDetails(true); }}>查看刷新结果</Button>{job.state === 'completed' && <Button onClick={app.dismissIconJob}>关闭进度</Button>}</div>
    {details && <Modal title="图标刷新结果" description={`已处理 ${job.processed} / ${job.total} 条书签`} onClose={() => setDetails(false)}>
      {query.isPending ? <Loading /> : query.isError ? <QueryError retry={() => void query.refetch()} /> : <>
        <ul className="icon-refresh-results">{query.data.results.map(result => <li key={result.id}><Link to={`/bookmarks/${result.id}/edit`} onClick={() => setDetails(false)}>{result.title}</Link><span>{reasons[result.reason]}</span></li>)}</ul>
        <div className="icon-library-pagination"><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span>第 {page} 页</span><Button disabled={page * query.data.pageSize >= query.data.processed} onClick={() => setPage(page + 1)}>下一页</Button></div>
      </>}
    </Modal>}
  </section>;
}
