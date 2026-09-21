import Redis from 'ioredis';
import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 2000);
    return delay;
  },
  lazyConnect: false,
});

redis.on('connect', () => {
  console.log('[INFO] Redis client connected successfully');
});

redis.on('error', (err) => {
  console.error('[ERROR] Redis client connection error:', err.message);
});

export interface HealthCheckResult {
  status: 'UP' | 'DOWN';
  latencyMs?: number;
  error?: string;
}

export async function checkRedisHealth(): Promise<HealthCheckResult> {
  const start = performance.now();
  try {
    const pong = await redis.ping();
    const latencyMs = Math.round(performance.now() - start);
    if (pong === 'PONG') {
      return { status: 'UP', latencyMs };
    }
    return { status: 'DOWN', error: `Unexpected ping response: ${pong}` };
  } catch (err: any) {
    return { status: 'DOWN', error: err?.message || 'Connection failed' };
  }
}
