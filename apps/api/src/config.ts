import { Injectable } from '@nestjs/common';

@Injectable()
export class AppConfig {
  readonly siteUrl = new URL(process.env.SITE_URL || 'http://127.0.0.1:5173');
  readonly sessionDays = Number(process.env.SESSION_DAYS || 7);
  readonly loginLimit = Number(process.env.LOGIN_LIMIT || 10);
  readonly loginWindowMs = 60_000;
  readonly cookieName = 'linkora_session';
  readonly cookieOptions = { httpOnly: true, secure: this.siteUrl.protocol === 'https:', sameSite: 'lax' as const, path: '/api' };

  constructor() {
    if (!['http:', 'https:'].includes(this.siteUrl.protocol)) throw new Error('SITE_URL 必须为 HTTP/HTTPS 地址');
    if (!Number.isFinite(this.sessionDays) || this.sessionDays <= 0) throw new Error('SESSION_DAYS 必须为正数');
    if (!Number.isInteger(this.loginLimit) || this.loginLimit < 1) throw new Error('LOGIN_LIMIT 必须为正整数');
    if (process.env.NODE_ENV === 'production' && !this.cookieOptions.secure && process.env.ALLOW_INSECURE_HTTP !== 'true') {
      throw new Error('生产环境需要 HTTPS SITE_URL；本机容器测试须显式允许 HTTP');
    }
  }
}
