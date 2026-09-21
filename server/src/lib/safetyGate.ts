import { prisma, GateStatus, type CheckResult } from './prisma.js';
import { FhirClient, type AggregatedClinicalData } from './fhirClient.js';
import { evaluateClinicalRules } from './rules/ruleEngine.js';
import { fetchClinicalDataWithCircuitBreaker } from './circuitBreaker.js';

export interface SafetyGateRunResult {
  run: {
    id: string;
    patientId: string;
    procedureCpt: string;
    diagnosisSnomed: string;
    status: GateStatus;
    checks: CheckResult[];
    createdBy: string;
    createdAt: Date;
  };
  auditEvent: {
    id: string;
    runId: string;
    actor: string;
    action: string;
    outcome: string;
    detail: any;
    timestamp: Date;
  };
  checks: CheckResult[];
  clinicalData: AggregatedClinicalData;
}

export interface SafetyGateOverrideResult {
  success: boolean;
  runId: string;
  newStatus: GateStatus;
  auditEvent: {
    id: string;
    runId: string;
    actor: string;
    action: string;
    outcome: string;
    detail: any;
    timestamp: Date;
  };
}

/**
 * Deterministic state machine resolving 4 clinical check results into
 * a terminal GateStatus (PASS, BLOCK, or MANUAL_REVIEW).
 *
 * Precedence: BLOCK > MANUAL_REVIEW > PASS
 */
export function calculateGateStatus(checks: CheckResult[]): GateStatus {
  let hasBlock = false;
  let hasManualReview = false;

  for (const check of checks) {
    if (check.passed) {
      continue;
    }

    const detail = check.detail.toLowerCase();

    // 0. Fail-Closed Circuit Breaker / EHR unavailability -> Hard BLOCK
    if (check.name === 'ehr_availability') {
      hasBlock = true;
      continue;
    }

    // 1. Consent missing or inactive -> Hard BLOCK
    if (check.name === 'consent') {
      hasBlock = true;
      continue;
    }

    // 2. Allergy conflict (direct or severe cross-reactivity) -> Hard BLOCK
    if (check.name === 'allergy') {
      hasBlock = true;
      continue;
    }

    // 3. Labs checks:
    // Critical out of range or missing labs -> Hard BLOCK
    // Stale labs (> 24h old) -> MANUAL_REVIEW
    if (check.name === 'labs') {
      if (detail.includes('critical') || detail.includes('missing')) {
        hasBlock = true;
      } else if (detail.includes('exceed 24-hour') || detail.includes('recency')) {
        hasManualReview = true;
      } else {
        hasBlock = true;
      }
      continue;
    }

    // 4. Diagnosis-Procedure match:
    // Unmapped combination -> MANUAL_REVIEW (requires surgeon review)
    if (check.name === 'diagnosis_procedure_match') {
      if (detail.includes('unmapped') || detail.includes('no scheduled')) {
        hasManualReview = true;
      } else {
        hasManualReview = true;
      }
      continue;
    }

    // Default unhandled failure fallback to MANUAL_REVIEW
    hasManualReview = true;
  }

  if (hasBlock) {
    return GateStatus.BLOCK;
  }
  if (hasManualReview) {
    return GateStatus.MANUAL_REVIEW;
  }
  return GateStatus.PASS;
}

/**
 * Extracts primary procedure CPT code from clinical data.
 */
function extractPrimaryCpt(data: AggregatedClinicalData): string {
  for (const proc of data.procedures) {
    for (const coding of proc.code?.coding || []) {
      if (coding.code) {
        return coding.code;
      }
    }
  }
  return 'UNKNOWN_CPT';
}

/**
 * Extracts primary diagnosis SNOMED code from clinical data.
 */
function extractPrimarySnomed(data: AggregatedClinicalData): string {
  for (const cond of data.conditions) {
    for (const coding of cond.code?.coding || []) {
      if (coding.code && coding.system?.includes('snomed.info/sct')) {
        return coding.code;
      }
    }
  }
  return 'UNKNOWN_SNOMED';
}

/**
 * Executes the full safety gate pipeline:
 * 1. Fetches EHR clinical data
 * 2. Runs the 4 deterministic rules
 * 3. Calculates 3-state gate decision
 * 4. Atomically persists ChecklistRun and AuditEvent in PostgreSQL
 */
export async function executeSafetyGate(params: {
  patientId: string;
  fhirClient: FhirClient;
  actor: string;
}): Promise<SafetyGateRunResult> {
  const clinicalData = await fetchClinicalDataWithCircuitBreaker(
    params.fhirClient,
    params.patientId
  );

  let checks: CheckResult[];
  let gateStatus: GateStatus;
  let allPassed = false;

  if (clinicalData.degraded) {
    const degradedCheck: CheckResult = {
      name: 'ehr_availability',
      passed: false,
      detail: `[FAIL-CLOSED] Upstream EHR FHIR service unavailable or circuit breaker is OPEN: ${clinicalData.degradedReason || 'Network outage'}`,
    };
    checks = [degradedCheck];
    gateStatus = GateStatus.BLOCK;
  } else {
    const evaluation = await evaluateClinicalRules(clinicalData);
    checks = evaluation.checks;
    allPassed = evaluation.allPassed;
    gateStatus = calculateGateStatus(checks);
  }

  const procedureCpt = extractPrimaryCpt(clinicalData);
  const diagnosisSnomed = extractPrimarySnomed(clinicalData);

  // Atomic transaction: ChecklistRun and AuditEvent must always be committed together
  const [run, auditEvent] = await prisma.$transaction(async (tx) => {
    const createdRun = await tx.checklistRun.create({
      data: {
        patientId: params.patientId,
        procedureCpt,
        diagnosisSnomed,
        status: gateStatus,
        checks: checks as any,
        createdBy: params.actor,
      },
    });

    const createdAudit = await tx.auditEvent.create({
      data: {
        runId: createdRun.id,
        actor: params.actor,
        action: 'GATE_EVALUATION',
        outcome: clinicalData.degraded ? 'FAIL_CLOSED_BLOCK' : gateStatus,
        detail: {
          checks,
          allPassed,
          procedureCpt,
          diagnosisSnomed,
          degraded: !!clinicalData.degraded,
          degradedReason: clinicalData.degradedReason,
        } as any,
      },
    });

    return [createdRun, createdAudit] as const;
  });

  return {
    run: {
      ...run,
      checks: run.checks as unknown as CheckResult[],
    },
    auditEvent,
    checks,
    clinicalData,
  };
}

/**
 * Executes a clinical override on a ChecklistRun in MANUAL_REVIEW status.
 * Overriding a BLOCK status is strictly prohibited for patient safety.
 */
export async function overrideSafetyGate(params: {
  runId: string;
  actor: string;
  reason: string;
  patientId?: string;
}): Promise<SafetyGateOverrideResult> {
  const cleanReason = (params.reason || '').trim();
  if (cleanReason.length < 5) {
    throw new Error('Clinical override requires a detailed medical justification reason (minimum 5 characters)');
  }

  const existingRun = await prisma.checklistRun.findUnique({
    where: { id: params.runId },
  });

  if (!existingRun) {
    const notFoundError: any = new Error(`Checklist run ${params.runId} not found`);
    notFoundError.statusCode = 404;
    throw notFoundError;
  }

  if (params.patientId && existingRun.patientId !== params.patientId) {
    const forbiddenError: any = new Error(
      'Access denied: Checklist run does not belong to active patient context'
    );
    forbiddenError.statusCode = 403;
    throw forbiddenError;
  }

  if (existingRun.status === GateStatus.BLOCK) {
    const blockError: any = new Error('Safety violation: Cannot override a run in BLOCK status. Surgical contraindication must be resolved clinically.');
    blockError.statusCode = 400;
    throw blockError;
  }

  if (existingRun.status === GateStatus.PASS) {
    const passError: any = new Error('Invalid action: Checklist run is already in PASS status.');
    passError.statusCode = 400;
    throw passError;
  }

  // Atomic override transaction: update run status to PASS and append CLINICAL_OVERRIDE audit event
  const [updatedRun, auditEvent] = await prisma.$transaction(async (tx) => {
    const current = await tx.checklistRun.findUnique({
      where: { id: params.runId },
    });

    if (!current || current.status !== GateStatus.MANUAL_REVIEW) {
      const conflictError: any = new Error(
        'Safety violation: Checklist run is not in MANUAL_REVIEW status or was already modified.'
      );
      conflictError.statusCode = 400;
      throw conflictError;
    }

    const run = await tx.checklistRun.update({
      where: { id: params.runId },
      data: {
        status: GateStatus.PASS,
      },
    });

    const audit = await tx.auditEvent.create({
      data: {
        runId: run.id,
        actor: params.actor,
        action: 'CLINICAL_OVERRIDE',
        outcome: GateStatus.PASS,
        detail: {
          previousStatus: GateStatus.MANUAL_REVIEW,
          reason: cleanReason,
          overriddenAt: new Date().toISOString(),
        },
      },
    });

    return [run, audit] as const;
  });

  return {
    success: true,
    runId: updatedRun.id,
    newStatus: updatedRun.status,
    auditEvent,
  };
}

/**
 * Retrieves a ChecklistRun along with its complete, immutable audit event trail.
 * Validates patient context when expectedPatientId is provided to enforce tenant boundary.
 */
export async function getSafetyGateRun(runId: string, expectedPatientId?: string) {
  const run = await prisma.checklistRun.findUnique({
    where: { id: runId },
    include: {
      auditEvents: {
        orderBy: { timestamp: 'asc' },
      },
    },
  });

  if (run && expectedPatientId && run.patientId !== expectedPatientId) {
    const err: any = new Error('Access denied: Checklist run does not belong to active patient context');
    err.statusCode = 403;
    throw err;
  }

  return run;
}

export type ChecklistRunWithAudit = NonNullable<Awaited<ReturnType<typeof getSafetyGateRun>>>;

