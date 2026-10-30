import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Modal } from './components';

it('弹层具有可访问标题、说明并支持 Escape', async () => {
  const close = vi.fn();
  render(<Modal title="确认修改" description="部分内容将公开" onClose={close}><input aria-label="备注" /></Modal>);
  expect(screen.getByRole('dialog', { name: '确认修改' })).toHaveAccessibleDescription('部分内容将公开');
  await userEvent.keyboard('{Escape}'); expect(close).toHaveBeenCalledOnce();
});
