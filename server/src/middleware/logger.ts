import type { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();
  // Strip query parameters to avoid logging patient identifiers or PHI in query string
  const sanitizedPath = req.baseUrl + req.path;

  res.on('finish', () => {
    const durationMs = Math.round(performance.now() - start);
    console.log(
      `[HTTP] ${req.method} ${sanitizedPath} -> ${res.statusCode} (${durationMs}ms)`
    );
  });

  next();
}
