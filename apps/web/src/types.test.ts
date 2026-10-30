import { describe, expect, it } from 'vitest';
import { engineUrl, engines } from './types';

describe('可信外部搜索', () => {
  it('五种引擎保留中文与特殊字符，不注入查询参数', () => {
    const input = 'NestJS & pg/中文?type=users';
    for (const engine of engines) {
      const url = new URL(engineUrl(engine.id, input)!);
      expect(url.protocol).toBe('https:');
      expect(url.searchParams.get(engine.id === 'baidu' ? 'wd' : 'q')).toBe(input);
      if (engine.id === 'github') expect(url.searchParams.get('type')).toBe('repositories');
    }
  });
  it('空关键词不打开窗口，未知引擎回落到可信模板', () => {
    expect(engineUrl('github', '   ')).toBeNull();
    expect(new URL(engineUrl('https://untrusted.test/', 'hello')!).hostname).toBe('www.google.com');
  });
});
