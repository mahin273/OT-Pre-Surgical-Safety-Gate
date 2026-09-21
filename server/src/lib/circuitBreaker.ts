import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import type { FhirClient, AggregatedClinicalData } from './fhirClient.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerStats {
  failures: number;
  fallbacks: number;
  successes: number;
  rejects: number;
  timeouts: number;
  fires: number;
}

export interface CircuitBreakerInfo {
  name: string;
  state: CircuitState;
  stats: CircuitBreakerStats;
  options: {
    timeout: number;
    errorThresholdPercentage: number;
    resetTimeout: number;
    volumeThreshold: number;
  };
}

export function createFailClosedClinicalData(patientId: string, reason: string): AggregatedClinicalData {
  return {
    patient: null,
    conditions: [],
    observations: [],
    allergies: [],
    consents: [],
    procedures: [],
    fetchedAt: Date.now(),
    degraded: true,
    degradedReason: reason,
  };
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreaker.Options = {
  timeout: Number(process.env.CB_TIMEOUT_MS) || 10000,
  errorThresholdPercentage: Number(process.env.CB_ERROR_THRESHOLD_PERCENTAGE) || 50,
  resetTimeout: Number(process.env.CB_RESET_TIMEOUT_MS) || 10000,
  volumeThreshold: Number(process.env.CB_VOLUME_THRESHOLD) || 3,
  rollingCountTimeout: 10000,
  rollingCountBuckets: 10,
};

export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /**
   * Registers or returns an existing circuit breaker by unique name.
   */
  register<TI extends any[], TR>(
    name: string,
    action: (...args: TI) => Promise<TR>,
    options?: Partial<CircuitBreaker.Options>
  ): CircuitBreaker<TI, TR> {
    if (this.breakers.has(name)) {
      return this.breakers.get(name) as CircuitBreaker<TI, TR>;
    }

    const mergedOptions: CircuitBreaker.Options = {
      ...DEFAULT_CIRCUIT_BREAKER_OPTIONS,
      ...options,
      name,
    };

    const breaker = new CircuitBreaker<TI, TR>(action, mergedOptions);

    breaker.on('open', () => {
      logger.warn(`[CIRCUIT_BREAKER] Circuit opened for "${name}". Upstream calls will fail fast.`);
    });

    breaker.on('close', () => {
      logger.info(`[CIRCUIT_BREAKER] Circuit closed for "${name}". Normal traffic restored.`);
    });

    breaker.on('halfOpen', () => {
      logger.info(`[CIRCUIT_BREAKER] Circuit half-open for "${name}". Probing upstream service.`);
    });

    breaker.on('fallback', (_result: any, err: any) => {
      logger.warn(
        `[CIRCUIT_BREAKER] Fallback executed for "${name}": ${err?.message || 'unknown'}`
      );
    });

    breaker.on('timeout', () => {
      logger.warn(`[CIRCUIT_BREAKER] Upstream call timed out for "${name}".`);
    });

    breaker.on('reject', () => {
      logger.warn(`[CIRCUIT_BREAKER] Call rejected for "${name}" because circuit is OPEN.`);
    });

    this.breakers.set(name, breaker as CircuitBreaker);
    return breaker;
  }

  /**
   * Retrieves an existing circuit breaker by name.
   */
  getBreaker<TI extends any[], TR>(name: string): CircuitBreaker<TI, TR> | undefined {
    return this.breakers.get(name) as CircuitBreaker<TI, TR> | undefined;
  }

  /**
   * Returns current telemetry and health status of all registered circuit breakers.
   */
  getAllCircuitStates(): Record<string, CircuitBreakerInfo> {
    const result: Record<string, CircuitBreakerInfo> = {};

    for (const [name, breaker] of this.breakers.entries()) {
      let state: CircuitState = 'CLOSED';
      if (breaker.opened) {
        state = 'OPEN';
      } else if (breaker.halfOpen) {
        state = 'HALF_OPEN';
      }

      const stats = breaker.stats;
      const opts = (breaker as any).options || {};

      result[name] = {
        name,
        state,
        stats: {
          failures: stats.failures || 0,
          fallbacks: stats.fallbacks || 0,
          successes: stats.successes || 0,
          rejects: stats.rejects || 0,
          timeouts: stats.timeouts || 0,
          fires: stats.fires || 0,
        },
        options: {
          timeout: opts.timeout ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.timeout,
          errorThresholdPercentage:
            opts.errorThresholdPercentage ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.errorThresholdPercentage,
          resetTimeout: opts.resetTimeout ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.resetTimeout,
          volumeThreshold: opts.volumeThreshold ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.volumeThreshold,
        },
      };
    }

    return result;
  }

  /**
   * Cleans up and shuts down all registered circuit breakers.
   */
  clear(): void {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
    this.breakers.clear();
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();

/**
 * Executes EHR FHIR queries through the managed fhirClient circuit breaker with fail-closed fallback.
 */
export async function fetchClinicalDataWithCircuitBreaker(
  fhirClient: FhirClient,
  patientId: string,
  customOptions?: Partial<CircuitBreaker.Options>
): Promise<AggregatedClinicalData> {
  const breaker = circuitBreakerRegistry.register<[FhirClient, string], AggregatedClinicalData>(
    'fhirClient',
    (client: FhirClient, pid: string) => client.fetchAllClinicalData(pid),
    customOptions
  );

  breaker.fallback((_client: FhirClient, pid: string, err: any) => {
    const errorMsg = err?.message || 'Upstream EHR FHIR service unavailable';
    return createFailClosedClinicalData(pid, errorMsg);
  });

  return breaker.fire(fhirClient, patientId);
}
