import { prisma } from './prisma.js';
import type { HealthCheckResult } from './redis.js';

export async function checkDbHealth(): Promise<HealthCheckResult> {
  const start = performance.now();
  try {
    await prisma.$queryRaw`SELECT 1;`;
    const latencyMs = Math.round(performance.now() - start);
    return { status: 'UP', latencyMs };
  } catch (err: any) {
    return { status: 'DOWN', error: err?.message || 'Database query failed' };
  }
}

