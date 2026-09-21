import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load root or local .env file
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config(); // fallback to local cwd .env

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CLIENT_URL: z.string().url().default('http://localhost:3002'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  SMART_CLIENT_ID: z.string().default('safety-gate-client'),
  BFF_BASE_URL: z.string().url().default('http://localhost:4000'),
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error('[FATAL] Invalid environment variables:');
  console.error(JSON.stringify(parseResult.error.format(), null, 2));
  process.exit(1);
}

export const env = parseResult.data;
