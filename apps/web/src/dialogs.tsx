import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button, Icon, Loading, Modal, QueryError } from './components';
import { DisplayPreferencesDialog } from './display-preferences';
import { APP_NAME } from './constants';
import { errorMessage, useApp, type ConfirmOptions } from './state';
import { flattenCategories, type Category } from './types';
import { StaleSessionError } from './api';

function LoginDialog() {
  const app = useApp();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [sessionDays, setSessionDays] = useState(String(app.identity.defaultSessionDays ?? 7)), [permanent, setPermanent] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget); setBusy(true); setError('');
    try { await app.login(String(fields.get('email')), String(fields.get('password')), permanent ? null : Number(sessionDays)); }
    catch (error) { if (!(error instanceof StaleSessionError)) setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <Modal title={`登录 ${APP_NAME}`} description="登录后查看与管理全部收藏，私密内容无需再次解锁。" onClose={() => app.closeDialog()}>
    <form onSubmit={submit}><div className="field"><label htmlFor="login-email">邮箱</label><input id="login-email" name="email" type="email" required autoComplete="username" autoFocus /></div>
      <div className="field"><label htmlFor="login-password">密码</label><input id="login-password" name="password" type="password" required minLength={8} maxLength={1024} autoComplete="current-password" /></div>
      <div className="field"><label htmlFor="login-session-days">免登录天数</label><input id="login-session-days" name="sessionDays" type="number" min="1" max="3650" step="1" required={!permanent} disabled={permanent} value={sessionDays} onChange={event => setSessionDays(event.target.value)} /><small>可设置 1 至 3650 天</small></div>
      <label className="check-card"><input type="checkbox" checked={permanent} onChange={event => setPermanent(event.target.checked)} /><span><strong>永久有效</strong><small>直到你主动退出登录</small></span></label>
      {error && <p className="modal-error" role="alert">{error}</p>}<div className="modal-footer"><Button onClick={() => app.closeDialog()}>取消</Button><Button className="primary" type="submit" disabled={busy}><Icon name={busy ? 'loading' : 'unlock'} />{busy ? '正在登录' : '登录'}</Button></div>
    </form>
  </Modal>;
}

function CategoryDialog({ category, parentId }: { category?: Category; parentId?: string | null }) {
  const app = useApp();
  const [name, setName] = useState(category?.name || '');
  const [parent, setParent] = useState(category?.parentId || parentId || '');
  const [privateFlag, setPrivateFlag] = useState(category?.isPrivate || false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const excluded = new Set(category ? flattenCategories([category]).map(item => item.id) : []);
  const inherited = app.flatCategories.find(item => item.id === parent)?.effectivePrivate || false;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const payload = { name, parentId: parent || null, isPrivate: privateFlag };
    try {
      const result = category ? await app.saveWithPreview('categories', category.id, payload) : await app.call('/categories', { method: 'POST', body: payload });
      if (!result) return;
      await app.refresh(); app.closeDialog(); toast.success('分类已保存');
    } catch (error) { if (!(error instanceof StaleSessionError)) setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!category || !await app.confirm({ title: `删除分类「${category.name}」？`, description: '只允许删除空分类，已有书签与子分类需要先移出。', danger: true, label: '删除分类' })) return;
    try { await app.call(`/categories/${category.id}`, { method: 'DELETE' }); await app.refresh(); app.closeDialog(); toast.success('分类已删除'); }
    catch (error) { toast.error(errorMessage(error)); }
  };
  return <Modal title={category ? '编辑分类' : '新建分类'} description="按自己的方式整理网址，支持多级分类。" onClose={() => app.closeDialog()}>
    <form onSubmit={submit}><div className="field"><label htmlFor="category-name">分类名称 <span className="req">*</span></label><input id="category-name" value={name} onChange={event => setName(event.target.value)} required maxLength={40} autoFocus /></div>
      <div className="field"><label htmlFor="category-parent">上级分类</label><select id="category-parent" value={parent} onChange={event => setParent(event.target.value)}><option value="">顶级分类</option>{app.flatCategories.filter(item => !excluded.has(item.id)).map(item => <option key={item.id} value={item.id}>{item.path}</option>)}</select></div>
      <label className="check-card"><input type="checkbox" checked={inherited || privateFlag} disabled={inherited} onChange={event => setPrivateFlag(event.target.checked)} /><span><strong>私密分类</strong><small>{inherited ? '继承上级私密，仅登录后可见' : privateFlag ? '此分类及后代仅登录后可见' : '普通分类对访客可见'}</small></span></label>
      {error && <p className="modal-error" role="alert">{error}</p>}<div className="modal-footer">{category && <Button className="danger" onClick={() => void remove()}><Icon name="trash" />删除</Button>}<span className="flex-spacer" /><Button onClick={() => app.closeDialog()}>取消</Button><Button type="submit" className="primary" disabled={busy}><Icon name="save" />{busy ? '保存中' : '保存分类'}</Button></div>
    </form>
  </Modal>;
}

function ActiveDialog() {
  const app = useApp();
  const dialog = app.dialog;
  if (!dialog) return null;
  if (dialog.kind === 'preferences') {
    if (app.identity.authenticated && !app.preferencesQuery.isSuccess) return <Modal title="显示设置" onClose={() => app.closeDialog()}>
      {app.preferencesQuery.isError ? <QueryError retry={() => void app.preferencesQuery.refetch()} /> : <Loading />}
    </Modal>;
    return <DisplayPreferencesDialog />;
  }
  if (dialog.kind === 'login') return <LoginDialog />;
  if (dialog.kind === 'category') return <CategoryDialog key={dialog.category?.id || `new-${dialog.parentId || ''}`} category={dialog.category} parentId={dialog.parentId} />;
  if (dialog.kind === 'account') return <Modal title="我的账号" description={app.identity.owner?.email} onClose={() => app.closeDialog()}>
    <div className="account-panel"><Icon name="shield" />普通与私密收藏已统一展示，你可以直接搜索和整理。</div><div className="modal-footer"><Button onClick={() => app.closeDialog()}>关闭</Button><Button className="danger" onClick={() => void app.logout()}><Icon name="logout" />退出登录</Button></div>
  </Modal>;
  if (dialog.kind === 'manager') return <Modal title="管理分类" description="调整父级、私密属性，或继续创建子分类。" onClose={() => app.closeDialog()} wide>
    <div className="manager-list">{app.flatCategories.length ? app.flatCategories.map(category => <div className="manager-item" key={category.id}><Icon name={category.effectivePrivate ? 'lock' : 'folder'} /><span className="manager-info"><strong>{category.name}</strong><span className="path truncate">{category.path}</span></span><button className="icon-btn" aria-label={`为${category.name}新增子分类`} onClick={() => app.openCategory(undefined, category.id)}><Icon name="plus" /></button><button className="icon-btn" aria-label={`编辑分类${category.name}`} onClick={() => app.openCategory(category)}><Icon name="settings" /></button></div>) : <p className="padded-muted">还没有分类，创建一个开始整理。</p>}</div>
    <div className="modal-footer"><Button onClick={() => app.closeDialog()}>关闭</Button><Button className="primary" onClick={() => app.openCategory()}><Icon name="plus" />新建分类</Button></div>
  </Modal>;
  return null;
}

function ConfirmationDialog({ options }: { options: ConfirmOptions }) {
  const app = useApp();
  const impact = options.impact;
  return <Modal title={options.title} description={options.description} onClose={() => app.closeDialog(false)}>
    {impact && <><div className="impact-counts"><span>书签 <strong>{impact.affectedBookmarks}</strong></span>{impact.affectedCategories > 0 && <span>分类 <strong>{impact.affectedCategories}</strong></span>}<span>私密书签 <strong>{impact.privateBookmarks}</strong></span></div>
      {(impact.becomingPublicBookmarks > 0 || impact.becomingPublicCategories > 0) && <p className="visibility-warning">将公开 {impact.becomingPublicBookmarks} 条书签、{impact.becomingPublicCategories} 个分类。</p>}
      {impact.stillInheritedPrivate > 0 && <p className="hint">其中 {impact.stillInheritedPrivate} 条书签仍受私密分类保护。</p>}
      {impact.summary.length > 0 && <ul className="impact-list">{impact.summary.map(book => <li key={book.id}><span className="truncate">{book.title}</span>{book.willBePrivate && <Icon name="lock" />}</li>)}</ul>}</>}
    {impact && impact.affectedBookmarks > impact.summary.length && <p className="hint">仅展示前 {impact.summary.length} 条，操作共影响 {impact.affectedBookmarks} 条书签。</p>}
    <div className="modal-footer"><Button onClick={() => app.closeDialog(false)}>取消</Button><Button className={options.danger ? 'danger' : 'primary'} onClick={() => app.closeDialog(true)}>{options.label || '确认操作'}</Button></div>
  </Modal>;
}

export function Dialogs() {
  const app = useApp();
  return <><ActiveDialog />{app.confirmation && <ConfirmationDialog options={app.confirmation} />}</>;
}
