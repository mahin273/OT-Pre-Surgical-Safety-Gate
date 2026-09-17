import { Router, type Request, type Response } from 'express';
import { checkDbHealth } from '../lib/db.js';
import { checkRedisHealth } from '../lib/redis.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  const [postgres, redis] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
  ]);

  const isHealthy = postgres.status === 'UP' && redis.status === 'UP';
  const statusCode = isHealthy ? 200 : 503;

  res.status(statusCode).json({
    status: isHealthy ? 'UP' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    services: {
      postgres,
      redis,
    },
  });
});
