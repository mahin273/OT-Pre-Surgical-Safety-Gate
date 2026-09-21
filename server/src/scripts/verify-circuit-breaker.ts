import {
  circuitBreakerRegistry,
  createFailClosedClinicalData,
  fetchClinicalDataWithCircuitBreaker,
} from '../lib/circuitBreaker.js';
import { executeSafetyGate, getSafetyGateRun } from '../lib/safetyGate.js';
import { FhirClient } from '../lib/fhirClient.js';
import { GateStatus } from '../lib/prisma.js';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] Assertion failed: ${message}`);
    process.exit(1);
  }
  console.log(`[PASS] ${message}`);
}

async function runVerification(): Promise<void> {
  console.log('[INFO] Starting Chunk 8 Resilience & Circuit Breaker Verification...');

  // --------------------------------------------------------------------------
  // Suite 1: Circuit Breaker Registration & Telemetry Tracking
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 1: Circuit Breaker Registration & Telemetry ---');
  let healthyCalls = 0;
  const healthyAction = async (val: number): Promise<number> => {
    healthyCalls++;
    return val * 2;
  };

  const breaker1 = circuitBreakerRegistry.register<[number], number>(
    'test-healthy-breaker',
    healthyAction,
    { timeout: 1000, errorThresholdPercentage: 50, resetTimeout: 1500, volumeThreshold: 2 }
  );

  const res1 = await breaker1.fire(5);
  const res2 = await breaker1.fire(10);
  assert(res1 === 10 && res2 === 20, 'Successful execution passes through healthy breaker');
  assert(breaker1.closed, 'Breaker remains in CLOSED state during normal operation');
  assert(breaker1.stats.successes === 2, 'Stats accurately record 2 successes');
  assert(breaker1.stats.failures === 0, 'Stats accurately record 0 failures');

  // --------------------------------------------------------------------------
  // Suite 2: Threshold Tripping & State Transition (CLOSED -> OPEN)
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 2: Threshold Tripping (CLOSED -> OPEN) ---');
  let failingCalls = 0;
  const failingAction = async (): Promise<string> => {
    failingCalls++;
    throw new Error('503 Service Unavailable: EHR Gateway Down');
  };

  const breaker2 = circuitBreakerRegistry.register<[], string>(
    'test-failing-breaker',
    failingAction,
    { timeout: 500, errorThresholdPercentage: 50, resetTimeout: 1000, volumeThreshold: 3 }
  );

  breaker2.fallback((err: any) => {
    return `FALLBACK_TRIGGERED: ${err?.message || 'unknown'}`;
  });

  // Execute 3 failing calls to reach volumeThreshold and breach errorThresholdPercentage
  await breaker2.fire();
  await breaker2.fire();
  await breaker2.fire();

  assert(breaker2.opened, 'Circuit breaker trips to OPEN after failure threshold exceeded');
  assert(failingCalls === 3, 'Underlying action was called exactly 3 times before tripping');
  assert(breaker2.stats.failures === 3, 'Breaker recorded 3 failures');

  // --------------------------------------------------------------------------
  // Suite 3: Fail-Fast & Zero Network Overhead when OPEN
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 3: Fail-Fast & Zero Network Overhead when OPEN ---');
  const startFast = performance.now();
  const fastResult = await breaker2.fire();
  const durationFast = performance.now() - startFast;

  assert(breaker2.opened, 'Circuit remains OPEN');
  assert(
    fastResult.includes('FALLBACK_TRIGGERED'),
    'Fallback is immediately returned when circuit is OPEN'
  );
  assert(failingCalls === 3, 'Underlying failing action was NOT called again while OPEN (zero network calls)');
  assert(durationFast < 50, `Fail-fast returned in ${Math.round(durationFast)}ms (< 50ms)`);
  assert(breaker2.stats.rejects >= 1, 'Rejection counter incremented for blocked call');

  // --------------------------------------------------------------------------
  // Suite 4: Fail-Closed Clinical Safety Gate Enforcement
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 4: Fail-Closed Clinical Safety Gate Enforcement ---');
  const mockFailingClient = new FhirClient('http://localhost:9999/fake-fhir', 'invalid-token', 500);

  // Clear existing fhirClient breaker to test fail-closed behavior with small volume threshold
  const testPatientId = 'patient-circuit-fail-test';
  const customBreakerOptions = {
    timeout: 500,
    errorThresholdPercentage: 50,
    resetTimeout: 1000,
    volumeThreshold: 1,
  };

  // Pre-seed breaker with a failure to trip it
  const failBreaker = circuitBreakerRegistry.register<[FhirClient, string], any>(
    'fhirClient',
    (client: FhirClient, pid: string) => client.fetchAllClinicalData(pid),
    customBreakerOptions
  );
  failBreaker.fallback((_client: FhirClient, pid: string, err: any) => {
    return createFailClosedClinicalData(pid, err?.message || 'EHR connection refused');
  });

  // Execute safety gate with failing client
  const gateRunResult = await executeSafetyGate({
    patientId: testPatientId,
    fhirClient: mockFailingClient,
    actor: 'Practitioner/resilience-verifier',
  });

  assert(
    gateRunResult.run.status === GateStatus.BLOCK,
    'Fail-closed principle enforced: Safety Gate status resolved strictly to BLOCK'
  );
  assert(
    gateRunResult.checks.some((c) => c.name === 'ehr_availability' && !c.passed),
    'Checks contain failing ehr_availability item'
  );
  assert(
    gateRunResult.auditEvent.outcome === 'FAIL_CLOSED_BLOCK',
    'AuditEvent outcome recorded as FAIL_CLOSED_BLOCK'
  );
  assert(
    gateRunResult.clinicalData.degraded === true,
    'Clinical data flagged with degraded: true'
  );

  // Verify PostgreSQL persistence
  const persistedRun = await getSafetyGateRun(gateRunResult.run.id);
  assert(persistedRun !== null, 'Fail-closed run successfully persisted in PostgreSQL');
  assert(persistedRun?.status === GateStatus.BLOCK, 'Persisted run reflects BLOCK status');
  assert(persistedRun?.auditEvents.length! >= 1, 'Persisted run contains linked AuditEvent record');

  // --------------------------------------------------------------------------
  // Suite 5: Recovery Cooldown & Half-Open Probe (OPEN -> HALF_OPEN -> CLOSED)
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 5: Recovery Cooldown & Half-Open Probe ---');
  console.log('[INFO] Waiting for resetTimeout cooldown (1200ms)...');
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Change action behavior to healthy
  let recoveryProbeCalled = false;
  const probeAction = async (): Promise<string> => {
    recoveryProbeCalled = true;
    return 'EHR_RECOVERED_SUCCESS';
  };

  const recoveringBreaker = circuitBreakerRegistry.register<[], string>(
    'test-recovery-breaker',
    probeAction,
    { timeout: 500, errorThresholdPercentage: 50, resetTimeout: 1000, volumeThreshold: 1 }
  );

  // Force open
  recoveringBreaker.open();
  assert(recoveringBreaker.opened, 'Breaker manually forced OPEN');

  // Wait for resetTimeout
  await new Promise((resolve) => setTimeout(resolve, 1100));

  // Next call should probe and heal
  const probeResult = await recoveringBreaker.fire();
  assert(probeResult === 'EHR_RECOVERED_SUCCESS', 'Trial probe successfully executed upstream');
  assert(recoveryProbeCalled, 'Underlying action executed during half-open probe');
  assert(recoveringBreaker.closed, 'Circuit breaker successfully healed back to CLOSED state');

  // --------------------------------------------------------------------------
  // Suite 6: SRE Health & Observability Metrics
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 6: SRE Observability Telemetry ---');
  const allStates = circuitBreakerRegistry.getAllCircuitStates();
  assert(typeof allStates === 'object', 'getAllCircuitStates returns valid object');
  assert('test-healthy-breaker' in allStates, 'test-healthy-breaker present in telemetry registry');
  assert('fhirClient' in allStates, 'fhirClient present in telemetry registry');
  assert(allStates['test-healthy-breaker'].state === 'CLOSED', 'Healthy breaker state reported as CLOSED');
  assert(allStates['test-healthy-breaker'].stats.successes >= 2, 'Telemetry captures success count');

  console.log('\n[INFO] All 6 Resilience & Circuit Breaker Verification Suites PASSED successfully!');
  circuitBreakerRegistry.clear();
  process.exit(0);
}

runVerification().catch((err) => {
  console.error('[ERROR] Verification script crashed:', err);
  circuitBreakerRegistry.clear();
  process.exit(1);
});
