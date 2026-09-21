import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

// Domain model interfaces
export interface CheckResult {
  name: 'diagnosis_procedure_match' | 'consent' | 'labs' | 'allergy' | 'ehr_availability';
  passed: boolean;
  detail: string; // human-readable, PHI-minimized
}

// Global declaration for singleton pattern in development
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}

export * from '@prisma/client';
