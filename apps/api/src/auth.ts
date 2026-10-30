import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpException, HttpStatus, Injectable, Module, Post, Req, Res, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import { Database } from './database';
import { AppConfig } from './config';
import { LoginDto } from './dto';

export interface Viewer { ownerId: string | null; email?: string; csrfToken?: string; tokenHash?: string }
export interface AuthRequest extends Request { viewer: Viewer }
export const Public = () => SetMetadata('public', true);
export const Identity = createParamDecorator((_: unknown, ctx: ExecutionContext): Viewer => ctx.switchToHttp().getRequest<AuthRequest>().viewer);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

@Injectable()
export class AuthService {
  private readonly attempts = new Map<string, { hits: number; until: number }>();
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  origin(request: Request) {
    if (request.get('origin') !== this.config.siteUrl.origin) throw new ForbiddenException('请求来源不允许');
  }

  async resolve(request: Request): Promise<Viewer> {
    const token: unknown = request.cookies?.[this.config.cookieName];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { ownerId: null };
    const tokenHash = hash(token);
    const session = await this.db.session.findUnique({ where: { tokenHash }, include: { user: { select: { id: true, email: true } } } });
    if (!session || session.expiresAt.getTime() <= Date.now()) return { ownerId: null };
    return { ownerId: session.userId, email: session.user.email, csrfToken: session.csrfToken, tokenHash };
  }

  async login(dto: LoginDto, request: Request, response: Response) {
    this.origin(request);
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const key = request.ip || 'unknown';
    const attempt = this.attempts.get(key) || { hits: 0, until: now + this.config.loginWindowMs };
    attempt.hits++;
    this.attempts.set(key, attempt);
    if (attempt.hits > this.config.loginLimit) throw new HttpException('登录尝试过多，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    const user = await this.db.user.findUnique({ where: { email: dto.email } });
    if (!user || !await argon2.verify(user.passwordHash, dto.password)) throw new UnauthorizedException('账号或密码错误');
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const duration = this.config.sessionDays * 86_400_000;
    await this.db.session.create({ data: { tokenHash: hash(token), csrfToken, userId: user.id, expiresAt: new Date(now + duration) } });
    response.cookie(this.config.cookieName, token, { ...this.config.cookieOptions, maxAge: duration });
    return { authenticated: true, owner: { id: user.id, email: user.email }, csrfToken };
  }

  async logout(viewer: Viewer, response: Response) {
    if (viewer.tokenHash) await this.db.session.deleteMany({ where: { tokenHash: viewer.tokenHash } });
    response.clearCookie(this.config.cookieName, this.config.cookieOptions);
    return { authenticated: false };
  }
}

@Injectable()
class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.viewer = await this.auth.resolve(request);
    if (this.reflector.getAllAndOverride<boolean>('public', [context.getHandler(), context.getClass()])) return true;
    if (!request.viewer.ownerId) throw new UnauthorizedException('请先登录');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      this.auth.origin(request);
      const token = request.get('x-csrf-token');
      if (!token || !equal(token, request.viewer.csrfToken || '')) throw new ForbiddenException('CSRF 校验失败，请刷新后重试');
    }
    return true;
  }
}

@Controller('auth')
class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Get('me') me(@Identity() viewer: Viewer) {
    return viewer.ownerId ? { authenticated: true, owner: { id: viewer.ownerId, email: viewer.email }, csrfToken: viewer.csrfToken } : { authenticated: false };
  }
  @Public() @Post('login') login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.auth.login(dto, req, res); }
  @Post('logout') logout(@Identity() viewer: Viewer, @Res({ passthrough: true }) res: Response) { return this.auth.logout(viewer, res); }
}

@Module({ controllers: [AuthController], providers: [AppConfig, AuthService, { provide: APP_GUARD, useClass: AuthGuard }], exports: [AppConfig, AuthService] })
export class AuthModule {}
