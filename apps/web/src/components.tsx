import { useId, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ArrowRight, Bookmark as BookmarkIcon, Check, ChevronDown, ChevronRight, Download, ExternalLink, Filter, Folder, FolderPlus, Github, Grid2X2, Link as LinkIcon, List, LoaderCircle, Lock, LogOut, Menu, Moon, MoreHorizontal, Plus, Save, Search, Settings, ShieldCheck, Star, Sun, Tag, Trash2, Unlock, X } from 'lucide-react';
import { domain } from './types';
import { APP_NAME } from './constants';

const icons = { back: ArrowLeft, arrow: ArrowRight, bookmark: BookmarkIcon, check: Check, down: ChevronDown, right: ChevronRight, download: Download, external: ExternalLink, filter: Filter, folder: Folder, folderPlus: FolderPlus, github: Github, grid: Grid2X2, link: LinkIcon, list: List, loading: LoaderCircle, lock: Lock, logout: LogOut, menu: Menu, moon: Moon, more: MoreHorizontal, plus: Plus, save: Save, search: Search, settings: Settings, shield: ShieldCheck, star: Star, sun: Sun, tag: Tag, trash: Trash2, unlock: Unlock, x: X };
export function Icon({ name, className = '' }: { name: keyof typeof icons; className?: string }) {
  const Component = icons[name];
  return <Component className={`icon ${className}`} aria-hidden="true" />;
}
export function Button({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`btn ${className}`} {...props}>{children}</button>;
}
export function SiteIcon({ title, url }: { title: string; url: string }) {
  const host = domain(url);
  const colors = ['#8976db', '#56a6cf', '#429f91', '#cf9874', '#b47eb0', '#b39b63'];
  const color = colors[[...host].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length];
  return <span className={`fav-ico ${host === 'github.com' ? 'github' : ''}`} style={{ '--favicon-bg': color } as CSSProperties}>
    {host === 'github.com' ? <Github size={17} aria-hidden="true" /> : title.slice(0, 1).toUpperCase() || APP_NAME[0]}
  </span>;
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
