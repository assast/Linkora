import { ArgumentsHost, Catch, ExceptionFilter, HttpException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

@Catch()
class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const body = error.getResponse();
      response.status(error.getStatus()).json(typeof body === 'string' ? { statusCode: error.getStatus(), message: body } : body);
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const status = error.code === 'P2025' ? 404 : ['P2002', 'P2003'].includes(error.code) ? 409 : 500;
      response.status(status).json({ statusCode: status, message: status === 404 ? '内容不存在' : status === 409 ? '名称重复或仍有引用，请刷新后重试' : '数据库操作失败' });
      return;
    }
    console.error('请求处理失败', error instanceof Error ? error.name : 'UnknownError');
    response.status(500).json({ statusCode: 500, message: '服务暂时不可用，请稍后重试' });
  }
}

export function configureHttp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());
  app.use((_req: unknown, res: Response, next: () => void) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ApiErrorFilter());
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Linkora API').setVersion('1.0').addCookieAuth('linkora_session').build());
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ['get', 'post', 'patch', 'delete'] as const) {
      const operation = item[method];
      if (!operation) continue;
      for (const status of [400, 401, 403, 404, 409, 429, 500]) {
        if (operation.responses[status]) continue;
        operation.responses[status] = {
        description: '请求校验、访问控制或服务错误；409 时需重新预览确认',
        content: { 'application/json': { schema: { type: 'object', properties: {
          statusCode: { type: 'integer' }, message: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, code: { type: 'string' },
        } } } },
        };
      }
      if (method !== 'get' && !path.endsWith('/auth/login')) {
        operation.parameters = [...operation.parameters || [], { in: 'header', name: 'X-CSRF-Token', required: true, description: '登录或身份检查响应中的 csrfToken', schema: { type: 'string' } }];
      }
    }
  }
  SwaggerModule.setup('api/docs', app, document);
}
