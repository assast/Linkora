let epoch = 0;
export const resetRequests = () => { epoch++; };
export class StaleSessionError extends Error { constructor() { super('身份已变化，请重试'); this.name = 'StaleSessionError'; } }
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export interface RequestOptions { method?: string; body?: unknown; signal?: AbortSignal; csrf?: string }
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const version = epoch;
  const response = await fetch('/api/v1' + path, {
    method: options.method || 'GET', credentials: 'same-origin', signal: options.signal,
    headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => {
    if (version !== epoch) throw new StaleSessionError();
    throw new ApiError(response.status || 500, '服务暂时不可用，请稍后重试');
  });
  if (version !== epoch) throw new StaleSessionError();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(response.status, Array.isArray(data.message) ? data.message.join('；') : data.message || '请求失败，请重试', data.code);
  }
  return data as T;
}
