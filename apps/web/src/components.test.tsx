import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Modal, SiteIcon } from './components';
import { IconGeneration } from './icon-generation';

it('弹层具有可访问标题、说明并支持 Escape', async () => {
  const close = vi.fn();
  render(<Modal title="确认修改" description="部分内容将公开" onClose={close}><input aria-label="备注" /></Modal>);
  expect(screen.getByRole('dialog', { name: '确认修改' })).toHaveAccessibleDescription('部分内容将公开');
  await userEvent.keyboard('{Escape}'); expect(close).toHaveBeenCalledOnce();
});

it('SiteIcon 仅用已保存 ID 请求同源图片，并在图片失败时显示 Unicode 首字符', () => {
  const { container, rerender } = render(<SiteIcon title="  🐦 收藏  " url="https://example.com/page" bookmarkId="bookmark-one" />);
  const first = container.querySelector('img')!;
  expect(first.getAttribute('src')).toBe('/api/v1/bookmarks/bookmark-one/icon');
  expect(first.getAttribute('alt')).toBe('');
  expect(screen.getByText('🐦')).toBeInTheDocument();
  fireEvent.error(first);
  expect(screen.getByText('🐦')).toBeInTheDocument();

  rerender(<SiteIcon title="第二站点" url="https://other.example/" bookmarkId="bookmark-two" />);
  const second = container.querySelector('img')!;
  expect(second).not.toBe(first);
  expect(second.getAttribute('src')).toBe('/api/v1/bookmarks/bookmark-two/icon');
  expect(screen.getByText('第')).toBeInTheDocument();
  fireEvent.error(second);
  rerender(<SiteIcon title="第三站点" url="https://third.example/" bookmarkId="bookmark-two" />);
  const third = container.querySelector('img')!;
  expect(third).not.toBe(second);
  expect(screen.getByText('第')).toBeInTheDocument();
});

it('SiteIcon 对未保存书签只显示首字母，不创建图片请求', () => {
  const { container } = render(<SiteIcon title="   " url="https://example.com/" />);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('E')).toBeInTheDocument();
});

it('SiteIcon 标题和地址均为空时回退到应用名称首字母', () => {
  render(<SiteIcon title="  " url="" />);
  expect(screen.getByText('L')).toBeInTheDocument();
});

it('图标刷新代次改变时，同一 ID/URL 的失败状态和旧图片都重新加载', () => {
  const renderIcon = (generation: number) => <IconGeneration.Provider value={generation}><SiteIcon title="同一书签" url="https://example.com" bookmarkId="saved-id" /></IconGeneration.Provider>;
  const { container, rerender } = render(renderIcon(1));
  const first = container.querySelector('img')!; fireEvent.error(first);
  expect(container.querySelector('img')).toBeNull();
  rerender(renderIcon(2));
  const second = container.querySelector('img'); expect(second).not.toBeNull();
  fireEvent.load(second!); rerender(renderIcon(3));
  expect(container.querySelector('img')).not.toBe(second);
});
