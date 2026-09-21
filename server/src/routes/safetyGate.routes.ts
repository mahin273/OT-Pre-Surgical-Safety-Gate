import { Router, type Request, type Response } from 'express';
import { authGuard } from '../middleware/auth.js';
import { FhirClient } from '../lib/fhirClient.js';
import { executeSafetyGate, overrideSafetyGate, getSafetyGateRun } from '../lib/safetyGate.js';

export const safetyGateRouter = Router();

/**
 * Runs the Pre-Surgical Safety Gate evaluation and records an immutable ChecklistRun + AuditEvent.
 */
safetyGateRouter.post('/api/safety-gate/run', authGuard, async (req: Request, res: Response): Promise<void> => {
  const session = req.session;

  if (!session?.patientId || !session.accessToken || !session.iss) {
    res.status(400).json({
      error: 'INVALID_SESSION_CONTEXT',
      message: 'Active patient context, access token, and EHR issuer required in session',
    });
    return;
  }

  const actor = session.fhirUser || 'Practitioner/unspecified';

  try {
    const fhirClient = new FhirClient(session.iss, session.accessToken);
    const result = await executeSafetyGate({
      patientId: session.patientId,
      fhirClient,
      actor,
    });

    res.json({
      success: true,
      runId: result.run.id,
      status: result.run.status,
      procedureCpt: result.run.procedureCpt,
      diagnosisSnomed: result.run.diagnosisSnomed,
      checks: result.checks,
      auditEventId: result.auditEvent.id,
      createdAt: result.run.createdAt,
    });
  } catch (err: any) {
    console.error('[ERROR] Failed to execute safety gate run:', err.message);
    res.status(500).json({
      error: 'SAFETY_GATE_EXECUTION_FAILED',
      message: 'An unexpected error occurred while executing the safety gate',
    });
  }
});

/**
 * Submits a clinical override for a run in MANUAL_REVIEW status with a mandatory medical justification.
 */
safetyGateRouter.post('/api/safety-gate/:runId/override', authGuard, async (req: Request, res: Response): Promise<void> => {
  const session = req.session;
  const runId = req.params.runId;
  const reason = req.body?.reason;

  if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
    res.status(400).json({
      error: 'INVALID_OVERRIDE_REASON',
      message: 'A valid clinical justification reason is required (minimum 5 characters)',
    });
    return;
  }

  const actor = session?.fhirUser || 'Practitioner/unspecified';

  try {
    const result = await overrideSafetyGate({
      runId,
      actor,
      reason,
    });

    res.json({
      success: true,
      runId: result.runId,
      status: result.newStatus,
      auditEventId: result.auditEvent.id,
    });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error: statusCode === 404 ? 'NOT_FOUND' : 'OVERRIDE_FAILED',
      message: err.message,
    });
  }
});

/**
 * Retrieves a checklist run along with its complete, immutable audit trail.
 */
safetyGateRouter.get('/api/safety-gate/:runId', authGuard, async (req: Request, res: Response): Promise<void> => {
  const runId = req.params.runId;

  try {
    const run = await getSafetyGateRun(runId);

    if (!run) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Checklist run ${runId} not found`,
      });
      return;
    }

    res.json({
      success: true,
      run,
    });
  } catch (err: any) {
    console.error('[ERROR] Failed to fetch checklist run:', err.message);
    res.status(500).json({
      error: 'FETCH_RUN_FAILED',
      message: 'Failed to retrieve checklist run details',
    });
  }
});
