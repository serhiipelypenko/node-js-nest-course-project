import type { Request, Response } from 'express';

export const PROBLEM_BASE = 'https://api.marketplace.example/problems';

export const PROBLEM_TITLES: Record<number, string> = {
  400: 'Некоректний запит',
  404: 'Ресурс не знайдено',
  409: 'Конфлікт зі станом ресурсу',
  422: 'Тіло не пройшло перевірку',
  500: 'Внутрішня помилка сервера',
};

export function writeProblem(
  res: Response,
  req: Request,
  status: number,
  detail: string,
  extra: Record<string, unknown> = {},
): void {
  res
    .status(status)
    .type('application/problem+json')
    .json({
      type: `${PROBLEM_BASE}/${(extra.code as string) ?? status}`,
      title: PROBLEM_TITLES[status] ?? 'Помилка',
      status,
      detail,
      instance: req.originalUrl,
      ...extra,
    });
}
