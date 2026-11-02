import { useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Icon, Modal } from './components';
import { useApp } from './state';
import { defaults, workspaceLinks } from './types';

export function DisplayPreferencesDialog() {
  const app = useApp();
  const [draft, setDraft] = useState(() => ({ bookmarkFontSize: app.preferences.bookmarkFontSize,
    categoryFontSize: app.preferences.categoryFontSize, showWorkspace: app.preferences.showWorkspace, workspaceItems: app.preferences.workspaceItems }));
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    if (await app.updatePreferences(draft)) { app.closeDialog(); return; }
    setBusy(false);
  };
  return <Modal title="显示设置" description="调整阅读字号与侧栏导航。" onClose={() => app.closeDialog()}>
    <form className="display-preferences" onSubmit={save}>
      <fieldset className="preference-fields" disabled={busy}><legend>字体大小</legend>
        {([{ key: 'bookmarkFontSize', label: '书签字号' }, { key: 'categoryFontSize', label: '分类字号' }] as const).map(({ key, label }) =>
          <div className="preference-font" key={key}><label htmlFor={key}>{label}</label><output htmlFor={key}>{draft[key]} px</output>
            <input id={key} type="range" min="12" max="20" step="1" value={draft[key]} onChange={event => setDraft({ ...draft, [key]: Number(event.target.value) })} />
          </div>)}
        <div className="preference-preview" aria-label="字号预览" style={{ '--bookmark-font-size': `${draft.bookmarkFontSize}px`, '--category-font-size': `${draft.categoryFontSize}px` } as CSSProperties}>
          <span className="preference-preview-category"><Icon name="folder" />分类名称</span><span className="preference-preview-bookmark"><Icon name="bookmark" />值得再次打开的网站</span>
        </div>
      </fieldset>
      <fieldset className="preference-fields preference-workspace" disabled={busy}><legend>工作空间</legend>
        <label className="preference-toggle"><span>显示工作空间<small>控制侧栏中的整个导航分区</small></span><input type="checkbox" role="switch" aria-label="显示工作空间" checked={draft.showWorkspace} onChange={event => setDraft({ ...draft, showWorkspace: event.target.checked })} /></label>
        <fieldset className="preference-items" aria-label="展示的导航项" disabled={!draft.showWorkspace || busy}>
          {workspaceLinks.map(item => <label key={item.id}><input type="checkbox" checked={draft.workspaceItems.includes(item.id)} onChange={event => setDraft({ ...draft,
            workspaceItems: event.target.checked ? [...draft.workspaceItems, item.id] : draft.workspaceItems.filter(id => id !== item.id) })} /><Icon name={item.icon} /><span>{item.name}</span></label>)}
        </fieldset>
        <p className="preference-note">未勾选任何项时，整个分区会隐藏。私密书签仅登录后显示。</p>
      </fieldset>
      <p className="preference-note">{app.identity.authenticated ? '设置随账号保存。' : '设置保存在当前浏览器。'}</p>
      <div className="modal-footer"><Button disabled={busy} onClick={() => setDraft({ bookmarkFontSize: defaults.bookmarkFontSize, categoryFontSize: defaults.categoryFontSize,
        showWorkspace: defaults.showWorkspace, workspaceItems: defaults.workspaceItems })}>恢复默认</Button><span className="flex-spacer" /><Button disabled={busy} onClick={() => app.closeDialog()}>取消</Button><Button type="submit" className="primary" disabled={busy}><Icon name={busy ? 'loading' : 'save'} />{busy ? '保存中' : '保存设置'}</Button></div>
    </form>
  </Modal>;
}
