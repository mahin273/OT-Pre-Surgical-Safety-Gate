import { createApp } from './app.js';
import { env } from './config/env.js';
import { dbPool } from './lib/db.js';
import { redis } from './lib/redis.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Pre-Surgical Safety Gate BFF listening on port ${env.PORT} [${env.NODE_ENV}]`);
  console.log(`Health check available at: http://localhost:${env.PORT}/health`);
});

async function gracefulShutdown(signal: string) {
  console.log(`\n Received ${signal}. Starting graceful shutdown...`);

  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await dbPool.end();
      console.log('PostgreSQL pool drained.');
      await redis.quit();
      console.log('Redis connection closed.');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  });

  // Force shutdown if taking longer than 10 seconds
  setTimeout(() => {
    console.error('Forcefully terminating after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
