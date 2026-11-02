import { useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ArrowRight, Bookmark as BookmarkIcon, Check, ChevronDown, ChevronRight, Download, ExternalLink, Filter, Folder, FolderPlus, Github, GripVertical, Grid2X2, Link as LinkIcon, List, LoaderCircle, Lock, LogOut, Menu, Moon, MoreHorizontal, Plus, Save, Search, Settings, ShieldCheck, Star, Sun, Tag, Trash2, Unlock, X } from 'lucide-react';
import { domain } from './types';
import { APP_NAME } from './constants';
import { IconGeneration } from './icon-generation';

const icons = { back: ArrowLeft, arrow: ArrowRight, bookmark: BookmarkIcon, check: Check, down: ChevronDown, right: ChevronRight, download: Download, external: ExternalLink, filter: Filter, folder: Folder, folderPlus: FolderPlus, github: Github, drag: GripVertical, grid: Grid2X2, link: LinkIcon, list: List, loading: LoaderCircle, lock: Lock, logout: LogOut, menu: Menu, moon: Moon, more: MoreHorizontal, plus: Plus, save: Save, search: Search, settings: Settings, shield: ShieldCheck, star: Star, sun: Sun, tag: Tag, trash: Trash2, unlock: Unlock, x: X };
export function Icon({ name, className = '' }: { name: keyof typeof icons; className?: string }) {
  const Component = icons[name];
  return <Component className={`icon ${className}`} aria-hidden="true" />;
}
export function Button({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`btn ${className}`} {...props}>{children}</button>;
}
export function SearchInput({ value, onValueChange, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'> & {
  value: string; onValueChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composing = useRef(false);
  useEffect(() => { if (!composing.current) setDraft(value); }, [value]);
  const update = (next: string) => {
    setDraft(next);
    if (!composing.current && next !== value) onValueChange(next);
  };
  return <input {...props} value={draft} onChange={event => update(event.currentTarget.value)}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={event => { composing.current = false; update(event.currentTarget.value); }} />;
}
function SiteIconBody({ title, url, bookmarkId, generation }: { title: string; url: string; bookmarkId?: string; generation: number }) {
  const [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false);
  const host = domain(url);
  let fallbackHost = '';
  try { fallbackHost = new URL(url).hostname.replace(/^www\./, ''); } catch { /* Invalid or empty URLs use the application initial. */ }
  const colors = ['#8976db', '#56a6cf', '#429f91', '#cf9874', '#b47eb0', '#b39b63'];
  const color = colors[[...host].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length];
  const fallback = Array.from(title.trim())[0]?.toLocaleUpperCase() || Array.from(fallbackHost)[0]?.toLocaleUpperCase() || APP_NAME[0];
  return <span className={`fav-ico${loaded ? ' image-loaded' : ''}`} style={{ '--favicon-bg': color } as CSSProperties} aria-hidden="true">
    {!loaded && fallback}
    {bookmarkId && !failed && <img src={`/api/v1/bookmarks/${encodeURIComponent(bookmarkId)}/icon${generation ? `?v=${generation}` : ''}`} alt="" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
  </span>;
}
export function SiteIcon({ title, url, bookmarkId }: { title: string; url: string; bookmarkId?: string }) {
  const generation = useContext(IconGeneration);
  return <SiteIconBody key={`${bookmarkId || ''}:${url}:${generation}`} title={title} url={url} bookmarkId={bookmarkId} generation={generation} />;
}
export function Modal({ open = true, title, description, children, onClose, wide = false }: { open?: boolean; title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const descriptionId = useId();
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="modal-overlay" />
    <Dialog.Content className={`modal-content ${wide ? 'modal-wide' : ''}`} aria-describedby={description ? descriptionId : undefined} onCloseAutoFocus={event => {
      event.preventDefault(); document.querySelector<HTMLInputElement>('#library-search, #top-search')?.focus();
    }}>
      <div className="modal-body"><div className="modal-header"><div>
        <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
        {description && <Dialog.Description id={descriptionId} asChild><p>{description}</p></Dialog.Description>}
      </div><Dialog.Close className="icon-btn" aria-label="关闭弹窗"><Icon name="x" /></Dialog.Close></div>{children}</div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
export function Empty({ title = '这里还没有书签', description = '收藏值得再次打开的网站，让下一次查找更轻松。', children }: { title?: string; description?: string; children?: ReactNode }) {
  return <div className="empty-state"><Icon name="bookmark" /><h3>{title}</h3><p>{description}</p>{children}</div>;
}
export function Loading() { return <div className="loading-state" role="status"><Icon name="loading" className="spinning" /> 正在加载…</div>; }
export function QueryError({ retry }: { retry: () => void }) { return <Empty title="暂时无法加载" description="请检查连接后重试。"><Button onClick={retry}>重新加载</Button></Empty>; }
export function Section({ title, detail }: { title: string; detail?: string }) { return <div className="section-title"><h2>{title}</h2><span>{detail}</span></div>; }
export function PrivateMark({ value }: { value: boolean }) { return value ? <span className="private-chip"><Icon name="lock" />私密</span> : null; }
