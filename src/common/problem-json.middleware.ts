import type { NextFunction, Request, Response } from 'express';
import { writeProblem } from './problem';

interface OpenApiValidatorError {
  status?: number;
  message?: string;
  errors?: unknown;
}

// express-openapi-validator валідує запит/відповідь ДО того, як керування
// дійде до Nest-роутера, тож його помилки — це помилка звичайного
// express-мідлвара (next(err)), а не Nest-винятку. Nest ExceptionFilter їх
// не бачить, тому переклад у problem+json робимо тут, як звичайний
// error-handling middleware express (4 аргументи).
export function openApiErrorHandler(
  err: OpenApiValidatorError,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.status ?? 500;
  writeProblem(res, req, status, err.message ?? 'Сталося щось непередбачене', err.errors ? { errors: err.errors } : {});
}
