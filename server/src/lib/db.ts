import pg from 'pg';
import { env } from '../config/env.js';
import type { HealthCheckResult } from './redis.js';

const { Pool } = pg;

export const dbPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

dbPool.on('error', (err) => {
  console.error('❌ Unexpected error on idle PostgreSQL client:', err.message);
});

export async function checkDbHealth(): Promise<HealthCheckResult> {
  const start = performance.now();
  try {
    const result = await dbPool.query('SELECT 1 AS alive;');
    const latencyMs = Math.round(performance.now() - start);
    if (result.rows && result.rows[0]?.alive === 1) {
      return { status: 'UP', latencyMs };
    }
    return { status: 'DOWN', error: 'Unexpected query response from database' };
  } catch (err: any) {
    return { status: 'DOWN', error: err?.message || 'Database query failed' };
  }
}
