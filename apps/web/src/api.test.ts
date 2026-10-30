import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, resetRequests, StaleSessionError } from './api';

afterEach(() => { vi.unstubAllGlobals(); resetRequests(); });
describe('身份边界与错误反馈', () => {
  it('退出后拒绝延迟返回的私密响应', async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(done => { resolve = done; }) }));
    const pending = api('/bookmarks'); await Promise.resolve(); resetRequests(); resolve({ items: [{ title: '私密记录' }] });
    await expect(pending).rejects.toBeInstanceOf(StaleSessionError);
  });
  it('请求携带会话与 CSRF，验证错误可读', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: ['标题不能为空', '网址不正确'] }) });
    vi.stubGlobal('fetch', fetch);
    await expect(api('/bookmarks', { method: 'POST', body: {}, csrf: 'csrf-test' })).rejects.toThrow('标题不能为空；网址不正确');
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', headers: { 'X-CSRF-Token': 'csrf-test' } });
  });
  it('认证失败通知清理身份，登录失败保留表单', async () => {
    const listener = vi.fn(); window.addEventListener('session-expired', listener);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: '请先登录' }) }));
    await expect(api('/bookmarks', { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(api('/auth/login', { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1); window.removeEventListener('session-expired', listener);
  });
  it('代理返回非 JSON 错误时仍提供可理解反馈', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    await expect(api('/home')).rejects.toThrow('服务暂时不可用，请稍后重试');
  });
});
