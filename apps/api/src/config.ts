import { Injectable } from '@nestjs/common';
import { relative, resolve, sep } from 'node:path';

@Injectable()
export class AppConfig {
  readonly siteUrl = new URL(process.env.SITE_URL || 'http://127.0.0.1:5173');
  readonly sessionDays = Number(process.env.SESSION_DAYS || 7);
  readonly loginLimit = Number(process.env.LOGIN_LIMIT || 10);
  readonly loginWindowMs = 60_000;
  readonly iconCacheDir = process.env.ICON_CACHE_DIR || resolve(process.cwd(), '.cache/site-icons');
  readonly iconUploadDir = process.env.ICON_UPLOAD_DIR || resolve(process.cwd(), '.data/icon-uploads');
  readonly cookieName = 'linkora_session';
  readonly cookieOptions = { httpOnly: true, secure: this.siteUrl.protocol === 'https:', sameSite: 'lax' as const, path: '/api' };

  constructor() {
    const cache = resolve(this.iconCacheDir), uploads = resolve(this.iconUploadDir);
    const nested = (parent: string, child: string) => { const path = relative(parent, child); return !path || !path.startsWith(`..${sep}`) && path !== '..'; };
    if (nested(cache, uploads) || nested(uploads, cache)) throw new Error('上传目录必须与图标缓存目录分开且不能嵌套');
    if (!['http:', 'https:'].includes(this.siteUrl.protocol)) throw new Error('SITE_URL 必须为 HTTP/HTTPS 地址');
    if (!Number.isFinite(this.sessionDays) || this.sessionDays <= 0) throw new Error('SESSION_DAYS 必须为正数');
    if (!Number.isInteger(this.loginLimit) || this.loginLimit < 1) throw new Error('LOGIN_LIMIT 必须为正整数');
    if (process.env.NODE_ENV === 'production' && !this.cookieOptions.secure && process.env.ALLOW_INSECURE_HTTP !== 'true') {
      throw new Error('生产环境需要 HTTPS SITE_URL；本机容器测试须显式允许 HTTP');
    }
  }
}
