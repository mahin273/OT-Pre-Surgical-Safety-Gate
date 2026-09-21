import { Router, type Request, type Response } from 'express';
import { authGuard } from '../middleware/auth.js';
import { FhirClient } from '../lib/fhirClient.js';
import { evaluateClinicalRules } from '../lib/rules/ruleEngine.js';

export const clinicalRouter = Router();

/**
 * Retrieves normalized pre-surgical clinical data for the active patient session.
 * Protected by authGuard; relies on the server-cached EHR access token and patient context.
 */
clinicalRouter.get('/api/clinical-data', authGuard, async (req: Request, res: Response): Promise<void> => {
  const session = req.session;

  if (!session?.patientId) {
    res.status(400).json({
      error: 'MISSING_PATIENT_CONTEXT',
      message: 'No active patient context found in session',
    });
    return;
  }

  if (!session.accessToken) {
    res.status(401).json({
      error: 'MISSING_ACCESS_TOKEN',
      message: 'No active EHR access token in session',
    });
    return;
  }

  if (!session.iss) {
    res.status(500).json({
      error: 'MISSING_EHR_ISSUER',
      message: 'EHR FHIR base URL not recorded in session',
    });
    return;
  }

  try {
    const fhirClient = new FhirClient(session.iss, session.accessToken);
    const clinicalData = await fhirClient.fetchAllClinicalData(session.patientId);

    res.json({
      success: true,
      patientId: session.patientId,
      data: clinicalData,
    });
  } catch (err: any) {
    console.error('[ERROR] Failed to fetch clinical data from EHR:', err.message);
    res.status(502).json({
      error: 'FHIR_FETCH_FAILED',
      message: 'Failed to retrieve clinical records from EHR',
    });
  }
});

/**
 * Evaluates the 4 pre-surgical safety rules against the patient's active EHR data.
 * Protected by authGuard.
 */
clinicalRouter.post('/api/clinical-data/evaluate', authGuard, async (req: Request, res: Response): Promise<void> => {
  const session = req.session;

  if (!session?.patientId || !session.accessToken || !session.iss) {
    res.status(400).json({
      error: 'INVALID_SESSION_CONTEXT',
      message: 'Active patient, access token, and EHR issuer required in session',
    });
    return;
  }

  try {
    const fhirClient = new FhirClient(session.iss, session.accessToken);
    const clinicalData = await fhirClient.fetchAllClinicalData(session.patientId);

    const evaluation = await evaluateClinicalRules(clinicalData, req.body?.options);

    res.json({
      success: true,
      patientId: session.patientId,
      checks: evaluation.checks,
      allPassed: evaluation.allPassed,
      evaluatedAt: evaluation.evaluatedAt,
    });
  } catch (err: any) {
    console.error('[ERROR] Failed to evaluate clinical rules:', err.message);
    res.status(500).json({
      error: 'RULE_EVALUATION_FAILED',
      message: 'An error occurred while evaluating pre-surgical clinical rules',
    });
  }
});
