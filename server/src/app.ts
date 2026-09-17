import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { requestLogger } from './middleware/logger.js';
import { notFoundHandler } from './middleware/notFound.js';
import { healthRouter } from './routes/health.routes.js';

export function createApp(): Express {
  const app = express();

  // Enable CORS with credentials for React SPA
  app.use(
    cors({
      origin: [env.CLIENT_URL],
      credentials: true,
    })
  );

  // Parse JSON payloads
  app.use(express.json());

  // Request logger (PHI-sanitized)
  app.use(requestLogger);

  // Health endpoint
  app.use('/health', healthRouter);

  // 404 handler
  app.use(notFoundHandler);

  // Global error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    });
  });

  return app;
}
