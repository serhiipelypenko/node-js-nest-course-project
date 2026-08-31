import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeProblem } from './problem';

// Ловить винятки, кинуті всередині Nest-пайплайну (контролери, guard-и,
// pipe-и) — і тільки їх. Помилки express-openapi-validator трапляються
// РАНІШЕ, у звичайному express-мідлварі, і до цього фільтра не доходять:
// їх перекладає окремий openApiErrorHandler (problem-json.middleware.ts).
@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const body = exception instanceof HttpException ? exception.getResponse() : null;

    let detail = 'Сталося щось непередбачене';
    const extra: Record<string, unknown> = {};
    if (typeof body === 'string') {
      detail = body;
    } else if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      if (typeof b.detail === 'string') detail = b.detail;
      else if (typeof b.message === 'string') detail = b.message;
      else if (Array.isArray(b.message)) detail = b.message.join('; ');
      if (b.code) extra.code = b.code;
    }

    writeProblem(res, req, status, detail, extra);
  }
}
