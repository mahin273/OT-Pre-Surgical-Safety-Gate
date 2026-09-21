import http from 'node:http';
import { createApp } from '../app.js';
import { redis } from '../lib/redis.js';
import { sessionStore } from '../lib/sessionStore.js';
import { prisma, GateStatus, type CheckResult } from '../lib/prisma.js';
import { calculateGateStatus } from '../lib/safetyGate.js';

function startMockEhrServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== 'Bearer test-gate-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const url = new URL(req.url || '', `http://${req.headers.host}`);

      if (url.pathname === '/Patient/pat-gate-001') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(JSON.stringify({ resourceType: 'Patient', id: 'pat-gate-001', name: [{ family: 'Miller', given: ['David'] }] }));
        return;
      }

      if (url.pathname === '/Condition') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            entry: [
              {
                resource: {
                  resourceType: 'Condition',
                  id: 'c1',
                  code: { coding: [{ system: 'http://snomed.info/sct', code: '235919008', display: 'Acute cholecystitis' }] },
                },
              },
            ],
          })
        );
        return;
      }

      if (url.pathname === '/Procedure') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            entry: [
              {
                resource: {
                  resourceType: 'Procedure',
                  id: 'p1',
                  code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '47562', display: 'Laparoscopic cholecystectomy' }] },
                },
              },
            ],
          })
        );
        return;
      }

      if (url.pathname === '/ServiceRequest') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(JSON.stringify({ resourceType: 'Bundle', total: 0, entry: [] }));
        return;
      }

      if (url.pathname === '/Observation') {
        const nowIso = new Date().toISOString();
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            entry: [
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'o1',
                  code: { coding: [{ system: 'http://loinc.org', code: '777-3' }] },
                  valueQuantity: { value: 195, unit: '10*3/uL' },
                  effectiveDateTime: nowIso,
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'o2',
                  code: { coding: [{ system: 'http://loinc.org', code: '6301-6' }] },
                  valueQuantity: { value: 1.1, unit: '{INR}' },
                  effectiveDateTime: nowIso,
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'o3',
                  code: { coding: [{ system: 'http://loinc.org', code: '5902-2' }] },
                  valueQuantity: { value: 12.3, unit: 's' },
                  effectiveDateTime: nowIso,
                },
              },
            ],
          })
        );
        return;
      }

      if (url.pathname === '/Consent') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            entry: [{ resource: { resourceType: 'Consent', id: 'con1', status: 'active', dateTime: new Date().toISOString() } }],
          })
        );
        return;
      }

      if (url.pathname === '/AllergyIntolerance') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(JSON.stringify({ resourceType: 'Bundle', total: 0, entry: [] }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({ server, port });
    });
  });
}

function startAppServer(app: any): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({ server, port });
    });
  });
}

async function runVerification() {
  console.log('[START] Starting Safety Gate State Machine & Immutable Audit Events Verification...');

  // 1. Test calculateGateStatus logic & precedence
  console.log('[TEST 1] Testing 3-state resolution and precedence hierarchy...');
  const passingChecks: CheckResult[] = [
    { name: 'diagnosis_procedure_match', passed: true, detail: 'Match OK' },
    { name: 'consent', passed: true, detail: 'Consent OK' },
    { name: 'labs', passed: true, detail: 'Labs OK' },
    { name: 'allergy', passed: true, detail: 'Allergy OK' },
  ];
  if (calculateGateStatus(passingChecks) !== GateStatus.PASS) {
    throw new Error('[FAIL] Expected all passing checks to resolve to PASS');
  }

  // Unmapped crosswalk -> MANUAL_REVIEW
  const manualReviewChecks: CheckResult[] = [
    { name: 'diagnosis_procedure_match', passed: false, detail: 'Unmapped combination: CPT 47562 with SNOMED 9999' },
    { name: 'consent', passed: true, detail: 'Consent OK' },
    { name: 'labs', passed: true, detail: 'Labs OK' },
    { name: 'allergy', passed: true, detail: 'Allergy OK' },
  ];
  if (calculateGateStatus(manualReviewChecks) !== GateStatus.MANUAL_REVIEW) {
    throw new Error('[FAIL] Expected unmapped check to resolve to MANUAL_REVIEW');
  }

  // Stale labs -> MANUAL_REVIEW
  const staleLabChecks: CheckResult[] = [
    { name: 'diagnosis_procedure_match', passed: true, detail: 'Match OK' },
    { name: 'consent', passed: true, detail: 'Consent OK' },
    { name: 'labs', passed: false, detail: 'Lab results exceed 24-hour recency window: Platelets (28h old)' },
    { name: 'allergy', passed: true, detail: 'Allergy OK' },
  ];
  if (calculateGateStatus(staleLabChecks) !== GateStatus.MANUAL_REVIEW) {
    throw new Error('[FAIL] Expected stale labs to resolve to MANUAL_REVIEW');
  }

  // Critical lab -> BLOCK
  const criticalLabChecks: CheckResult[] = [
    { name: 'diagnosis_procedure_match', passed: true, detail: 'Match OK' },
    { name: 'consent', passed: true, detail: 'Consent OK' },
    { name: 'labs', passed: false, detail: 'Critical low platelets: 35 (minimum safe: 50)' },
    { name: 'allergy', passed: true, detail: 'Allergy OK' },
  ];
  if (calculateGateStatus(criticalLabChecks) !== GateStatus.BLOCK) {
    throw new Error('[FAIL] Expected critical low platelets to resolve to BLOCK');
  }

  // Precedence test: Both unmapped (MANUAL_REVIEW) and critical lab (BLOCK) -> BLOCK
  const collisionChecks: CheckResult[] = [
    { name: 'diagnosis_procedure_match', passed: false, detail: 'Unmapped combination' },
    { name: 'consent', passed: true, detail: 'Consent OK' },
    { name: 'labs', passed: false, detail: 'Critical elevated INR: 2.3 (maximum safe: 1.5)' },
    { name: 'allergy', passed: true, detail: 'Allergy OK' },
  ];
  if (calculateGateStatus(collisionChecks) !== GateStatus.BLOCK) {
    throw new Error('[FAIL] BLOCK must strictly take precedence over MANUAL_REVIEW');
  }

  console.log('[PASS] State machine precedence (BLOCK > MANUAL_REVIEW > PASS) verified');

  // 2. Integration: POST /api/safety-gate/run
  console.log('[TEST 2] Testing POST /api/safety-gate/run (atomic ChecklistRun + AuditEvent)...');
  const { server: mockEhrServer, port: mockEhrPort } = await startMockEhrServer();
  const mockEhrBase = `http://localhost:${mockEhrPort}`;

  const app = createApp();
  const { server: appServer, port: appPort } = await startAppServer(app);
  const appBase = `http://localhost:${appPort}`;

  const sessionId = 'test-session-gate-' + Date.now();
  await sessionStore.createSession(
    sessionId,
    {
      accessToken: 'test-gate-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
      patientId: 'Patient/pat-gate-001',
      fhirUser: 'Practitioner/dr-surgeon-99',
      scope: 'launch patient/Patient.rs',
      iss: mockEhrBase,
      createdAt: Date.now(),
    },
    300
  );

  let createdRunId: string = '';

  try {
    const runRes = await fetch(`${appBase}/api/safety-gate/run`, {
      method: 'POST',
      headers: {
        Cookie: `sid=${sessionId}`,
        'Content-Type': 'application/json',
      },
    });

    if (runRes.status !== 200) {
      const errText = await runRes.text();
      throw new Error(`[FAIL] Expected 200 from /api/safety-gate/run, got: ${runRes.status} body: ${errText}`);
    }

    const runPayload = (await runRes.json()) as any;
    if (!runPayload.success || runPayload.status !== 'PASS' || !runPayload.runId) {
      throw new Error('[FAIL] Safety gate run did not return successful PASS outcome');
    }
    createdRunId = runPayload.runId;

    // Verify Postgres records
    const dbRun = await prisma.checklistRun.findUnique({
      where: { id: createdRunId },
      include: { auditEvents: true },
    });

    if (!dbRun || dbRun.status !== GateStatus.PASS || dbRun.auditEvents.length !== 1) {
      throw new Error('[FAIL] Database records verification failed for ChecklistRun and AuditEvent');
    }

    const initialAudit = dbRun.auditEvents[0];
    if (initialAudit.action !== 'GATE_EVALUATION' || initialAudit.actor !== 'Practitioner/dr-surgeon-99') {
      throw new Error('[FAIL] Initial AuditEvent attributes mismatch');
    }

    console.log(`[PASS] ChecklistRun ${createdRunId} and AuditEvent ${initialAudit.id} created atomically`);

    // 3. Test Clinical Override Flow on MANUAL_REVIEW
    console.log('[TEST 3] Testing clinical override on MANUAL_REVIEW run...');
    const manualRun = await prisma.checklistRun.create({
      data: {
        patientId: 'Patient/pat-manual-002',
        procedureCpt: '47562',
        diagnosisSnomed: '999999',
        status: GateStatus.MANUAL_REVIEW,
        checks: manualReviewChecks as any,
        createdBy: 'Practitioner/dr-surgeon-99',
      },
    });

    // Submitting override with empty reason should fail
    const emptyReasonRes = await fetch(`${appBase}/api/safety-gate/${manualRun.id}/override`, {
      method: 'POST',
      headers: {
        Cookie: `sid=${sessionId}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: '   ' }),
    });
    if (emptyReasonRes.status !== 400) {
      throw new Error('[FAIL] Expected 400 when submitting empty override reason');
    }

    // Submitting valid override
    const overrideRes = await fetch(`${appBase}/api/safety-gate/${manualRun.id}/override`, {
      method: 'POST',
      headers: {
        Cookie: `sid=${sessionId}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason: 'Surgical team reviewed unmapped condition clinically; approved to proceed.',
      }),
    });

    if (overrideRes.status !== 200) {
      const errText = await overrideRes.text();
      throw new Error(`[FAIL] Expected 200 on override, got: ${overrideRes.status} body: ${errText}`);
    }

    const overridePayload = (await overrideRes.json()) as any;
    if (overridePayload.status !== 'PASS') {
      throw new Error('[FAIL] Expected overridden run status to be PASS');
    }

    // Verify Audit Trail has exactly 1 new event for this run
    const updatedManualRun = await prisma.checklistRun.findUnique({
      where: { id: manualRun.id },
      include: { auditEvents: true },
    });

    if (!updatedManualRun || updatedManualRun.status !== GateStatus.PASS || updatedManualRun.auditEvents.length !== 1) {
      throw new Error('[FAIL] Override verification failed in database');
    }
    const overrideAudit = updatedManualRun.auditEvents[0];
    if (overrideAudit.action !== 'CLINICAL_OVERRIDE') {
      throw new Error('[FAIL] AuditEvent action was not CLINICAL_OVERRIDE');
    }

    console.log('[PASS] Manual review run successfully overridden with immutable audit log');

    // 4. Test prohibition of overriding a BLOCK run
    console.log('[TEST 4] Testing prohibition against overriding BLOCK runs...');
    const blockRun = await prisma.checklistRun.create({
      data: {
        patientId: 'Patient/pat-block-003',
        procedureCpt: '47562',
        diagnosisSnomed: '235919008',
        status: GateStatus.BLOCK,
        checks: criticalLabChecks as any,
        createdBy: 'Practitioner/dr-surgeon-99',
      },
    });

    const blockOverrideRes = await fetch(`${appBase}/api/safety-gate/${blockRun.id}/override`, {
      method: 'POST',
      headers: {
        Cookie: `sid=${sessionId}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Attempting unsafe override on low platelets' }),
    });

    if (blockOverrideRes.status !== 400) {
      throw new Error('[FAIL] Expected 400 when attempting to override a BLOCK run');
    }
    console.log('[PASS] Attempts to override a BLOCK status are strictly rejected');

    // 5. Test GET /api/safety-gate/:runId
    console.log('[TEST 5] Testing GET /api/safety-gate/:runId...');
    const getRunRes = await fetch(`${appBase}/api/safety-gate/${createdRunId}`, {
      headers: { Cookie: `sid=${sessionId}` },
    });

    if (getRunRes.status !== 200) {
      throw new Error(`[FAIL] Expected 200 from GET /api/safety-gate/:runId, got: ${getRunRes.status}`);
    }

    const fetchedRun = (await getRunRes.json()) as any;
    if (!fetchedRun.success || fetchedRun.run.id !== createdRunId || fetchedRun.run.auditEvents.length !== 1) {
      throw new Error('[FAIL] GET /api/safety-gate/:runId failed to return run with audit events');
    }
    console.log('[PASS] GET /api/safety-gate/:runId returned complete run with audit trail');

    // Clean up test data
    await prisma.checklistRun.deleteMany({
      where: {
        id: { in: [createdRunId, manualRun.id, blockRun.id] },
      },
    });
    console.log('[PASS] Test database records cleaned up');
    console.log('[SUCCESS] All Safety Gate State Machine & Audit Events assertions passed successfully!');
  } finally {
    await sessionStore.destroySession(sessionId);
    mockEhrServer.close();
    appServer.close();
  }
}

runVerification()
  .catch((err) => {
    console.error('[FAIL] Verification script encountered an error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });
