import { describe, expect, it } from 'vitest';
import { engineUrl, engines, resolveBookmarkUrl } from './types';

describe('书签有效地址', () => {
  const url = 'https://primary.test/path';
  it.each([undefined, null, '', '  ', 'https://alternate.test/path', url])('原地址模式始终使用原地址：%s', url2 => {
    expect(resolveBookmarkUrl({ url, url2 }, 'url')).toBe(url);
  });
  it.each([undefined, null, '', '  '])('地址2未配置时回退原地址：%s', url2 => {
    expect(resolveBookmarkUrl({ url, url2 }, 'url2')).toBe(url);
  });
  it('地址2模式使用第二地址，允许两个地址相同', () => {
    expect(resolveBookmarkUrl({ url, url2: '  http://internal_service:8080/path  ' }, 'url2')).toBe('http://internal_service:8080/path');
    expect(resolveBookmarkUrl({ url, url2: url }, 'url2')).toBe(url);
  });
});

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
