import { Router, type Request, type Response } from 'express';
import { circuitBreakerRegistry } from '../lib/circuitBreaker.js';
import { authGuard } from '../middleware/auth.js';

export const resilienceRouter = Router();

/**
 * Returns real-time health, state, and telemetry metrics for all registered circuit breakers.
 */
resilienceRouter.get('/api/resilience/circuits', authGuard, (_req: Request, res: Response): void => {
  const circuits = circuitBreakerRegistry.getAllCircuitStates();

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    circuits,
  });
});

/**
 * Resets a specific circuit breaker back to CLOSED state (for maintenance/testing).
 */
resilienceRouter.post('/api/resilience/circuits/:name/reset', authGuard, (req: Request, res: Response): void => {
  const name = req.params.name;
  const breaker = circuitBreakerRegistry.getBreaker(name);

  if (!breaker) {
    res.status(404).json({
      error: 'CIRCUIT_BREAKER_NOT_FOUND',
      message: `No circuit breaker registered with name "${name}"`,
    });
    return;
  }

  breaker.close();

  res.json({
    success: true,
    message: `Circuit breaker "${name}" has been manually closed`,
    state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
  });
});
