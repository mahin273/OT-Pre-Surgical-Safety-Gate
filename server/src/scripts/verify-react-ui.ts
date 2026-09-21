import http from 'node:http';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createApp } from '../app.js';
import { redis } from '../lib/redis.js';
import { sessionStore } from '../lib/sessionStore.js';
import { prisma, GateStatus, type CheckResult } from '../lib/prisma.js';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] Assertion failed: ${message}`);
    process.exit(1);
  }
  console.log(`[PASS] ${message}`);
}

function startMockEhrServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== 'Bearer test-ui-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const url = new URL(req.url || '', `http://${req.headers.host}`);

      if (url.pathname === '/Patient/patient-ui-test-01') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Patient',
            id: 'patient-ui-test-01',
            name: [{ family: 'Miller', given: ['David'] }],
          })
        );
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
                  id: 'cond-ui-1',
                  code: {
                    coding: [
                      {
                        system: 'http://snomed.info/sct',
                        code: '235919008',
                        display: 'Acute cholecystitis',
                      },
                    ],
                  },
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
                  id: 'proc-ui-1',
                  code: {
                    coding: [
                      {
                        system: 'http://www.ama-assn.org/go/cpt',
                        code: '47562',
                        display: 'Laparoscopic cholecystectomy',
                      },
                    ],
                  },
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
                  id: 'obs-platelets',
                  code: { coding: [{ system: 'http://loinc.org', code: '777-3' }] },
                  valueQuantity: { value: 195, unit: '10*3/uL' },
                  effectiveDateTime: nowIso,
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'obs-inr',
                  code: { coding: [{ system: 'http://loinc.org', code: '6301-6' }] },
                  valueQuantity: { value: 1.1, unit: '{INR}' },
                  effectiveDateTime: nowIso,
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'obs-pt',
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
            entry: [
              {
                resource: {
                  resourceType: 'Consent',
                  id: 'consent-ui-1',
                  status: 'active',
                  dateTime: new Date().toISOString(),
                },
              },
            ],
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
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function runVerification(): Promise<void> {
  console.log('[INFO] Starting Chunk 10 React UI & BFF Integration Verification...');

  let server: http.Server | null = null;
  let mockEhr: http.Server | null = null;

  try {
    // --------------------------------------------------------------------------
    // Suite 1: Client Build and Asset Validation
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 1: Client Build & Asset Validation ---');

    const clientDir = existsSync(path.resolve(process.cwd(), 'client'))
      ? path.resolve(process.cwd(), 'client')
      : path.resolve(process.cwd(), '../client');
    const distDir = path.resolve(clientDir, 'dist');

    console.log('[INFO] Executing Vite client production build...');
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: clientDir,
      encoding: 'utf-8',
    });

    assert(buildResult.status === 0, 'Client TypeScript compilation and Vite build succeeded with exit code 0');

    const indexHtmlPath = path.resolve(distDir, 'index.html');
    assert(existsSync(indexHtmlPath), 'dist/index.html exists');

    const indexHtml = readFileSync(indexHtmlPath, 'utf-8');
    assert(indexHtml.includes('<title>Pre-Surgical Safety Gate</title>'), 'HTML title is "Pre-Surgical Safety Gate"');
    assert(indexHtml.includes('<div id="root"></div>'), 'HTML contains mounting container <div id="root">');

    // --------------------------------------------------------------------------
    // Suite 2: ASCII & Code Integrity Validation
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 2: Client ASCII & Component Integrity ---');

    const clientFiles = [
      path.resolve(clientDir, 'src/App.tsx'),
      path.resolve(clientDir, 'src/main.tsx'),
      path.resolve(clientDir, 'src/types.ts'),
      path.resolve(clientDir, 'src/styles.css'),
      path.resolve(clientDir, 'src/components/PatientHeader.tsx'),
      path.resolve(clientDir, 'src/components/PatientHud.tsx'),
      path.resolve(clientDir, 'src/components/ClearanceHero.tsx'),
      path.resolve(clientDir, 'src/components/ChecklistGrid.tsx'),
      path.resolve(clientDir, 'src/components/OverrideModal.tsx'),
      path.resolve(clientDir, 'src/components/AuditDrawer.tsx'),
      path.resolve(clientDir, 'src/components/ResilienceDrawer.tsx'),
    ];

    for (const file of clientFiles) {
      assert(existsSync(file), `Component file exists: ${path.basename(file)}`);
      const buffer = readFileSync(file);
      let hasNonAscii = false;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] > 127) {
          hasNonAscii = true;
          break;
        }
      }
      assert(!hasNonAscii, `Zero non-ASCII characters in ${path.basename(file)}`);
    }

    // --------------------------------------------------------------------------
    // Suite 3: Express BFF & React UI Endpoints Integration
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 3: Express BFF API Integration for React UI ---');

    // Start mock EHR server
    const ehrInfo = await startMockEhrServer();
    mockEhr = ehrInfo.server;
    const ehrIssuer = `http://localhost:${ehrInfo.port}`;

    // Set up test session in Redis
    const testSessionId = 'ui-test-session-chunk10';
    const testPatientId = 'patient-ui-test-01';
    const testActor = 'Practitioner/dr-surgeon-ui';

    await sessionStore.createSession(testSessionId, {
      patientId: testPatientId,
      fhirUser: testActor,
      iss: ehrIssuer,
      accessToken: 'test-ui-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: 'launch/patient patient/*.read openid fhirUser',
      createdAt: Date.now(),
    });

    const sessionData = await sessionStore.getSession(testSessionId);
    assert(sessionData !== null, 'Test session successfully registered in Redis');
    assert(sessionData?.patientId === testPatientId, 'Session patientId matches test subject');
    assert(sessionData?.iss === ehrIssuer, 'Session issuer matches mock EHR');

    // Boot Express server on ephemeral port
    const app = createApp();
    const testPort = 3099;
    server = app.listen(testPort);
    const baseUrl = `http://localhost:${testPort}`;

    const cookieHeader = `sid=${testSessionId}`;

    // Test 3.1: Run Safety Gate from UI (POST /api/safety-gate/run)
    console.log('[INFO] Testing UI action: Run Safety Gate (POST /api/safety-gate/run)...');
    const runResponse = await fetch(`${baseUrl}/api/safety-gate/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
    });

    assert(runResponse.status === 200, 'POST /api/safety-gate/run returned HTTP 200');
    const runJson = (await runResponse.json()) as any;
    assert(runJson.success === true, 'Safety gate evaluation returned success: true');
    assert(typeof runJson.runId === 'string', 'Returned checklist run has a valid string runId');
    assert(
      [GateStatus.PASS, GateStatus.BLOCK, GateStatus.MANUAL_REVIEW].includes(runJson.status),
      `Returned status is valid GateStatus: ${runJson.status}`
    );
    assert(Array.isArray(runJson.checks), 'Run payload contains checks array');
    assert(runJson.checks.length >= 4, 'Run payload evaluated at least 4 safety gate checks');
    assert(typeof runJson.auditEventId === 'string', 'Run payload contains auditEventId');

    const runId = runJson.runId;

    // Test 3.2: Get Run Details & Audit Trail (GET /api/safety-gate/:runId)
    console.log('[INFO] Testing UI action: Fetch Run Details and Audit Trail...');
    const detailResponse = await fetch(`${baseUrl}/api/safety-gate/${runId}`, {
      headers: { Cookie: cookieHeader },
    });
    assert(detailResponse.status === 200, 'GET /api/safety-gate/:runId returned HTTP 200');
    const detailJson = (await detailResponse.json()) as any;
    assert(detailJson.success === true, 'Detail response success is true');
    assert(detailJson.run.id === runId, 'Detail response matches requested runId');
    assert(Array.isArray(detailJson.run.auditEvents), 'Run detail includes auditEvents array');
    assert(detailJson.run.auditEvents.length >= 1, 'Contains initial SAFETY_GATE_EVALUATION audit event');

    // Test 3.3: Clinical Override Workflow from UI Modal
    console.log('[INFO] Testing UI action: Clinical Override modal submission...');
    const reviewChecks: CheckResult[] = [
      { name: 'diagnosis_procedure_match', passed: false, detail: 'SNOMED code requires manual clinician verification' },
      { name: 'consent', passed: true, detail: 'Consent on file' },
      { name: 'labs', passed: true, detail: 'Labs within limits' },
      { name: 'allergy', passed: true, detail: 'No beta-lactam allergy' },
    ];

    const manualReviewRun = await prisma.checklistRun.create({
      data: {
        patientId: testPatientId,
        procedureCpt: '47562',
        diagnosisSnomed: '999999999',
        status: GateStatus.MANUAL_REVIEW,
        checks: reviewChecks as any,
        createdBy: testActor,
        auditEvents: {
          create: {
            actor: testActor,
            action: 'SAFETY_GATE_EVALUATION',
            outcome: GateStatus.MANUAL_REVIEW,
            detail: { checks: reviewChecks } as any,
          },
        },
      },
    });

    // Test override validation failure (reason < 5 chars)
    const shortReasonResponse = await fetch(`${baseUrl}/api/safety-gate/${manualReviewRun.id}/override`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ reason: 'ok' }),
    });
    assert(shortReasonResponse.status === 400, 'Override with short reason rejected with HTTP 400');

    // Test successful override submission
    const validOverrideResponse = await fetch(`${baseUrl}/api/safety-gate/${manualReviewRun.id}/override`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        reason: 'Emergency laparoscopic cholecystectomy clinically indicated per attending surgeon Dr. UI',
      }),
    });

    assert(validOverrideResponse.status === 200, 'Valid clinical override returned HTTP 200');
    const overrideJson = (await validOverrideResponse.json()) as any;
    assert(overrideJson.success === true, 'Override response success is true');
    assert(overrideJson.status === GateStatus.PASS, 'ChecklistRun status transitioned to PASS');

    // Test 3.4: Export FHIR Document Bundle (USCDI R4)
    console.log('[INFO] Testing UI action: Export FHIR USCDI Document...');
    const fhirResponse = await fetch(`${baseUrl}/api/safety-gate/${runId}/document/fhir`, {
      headers: { Cookie: cookieHeader },
    });
    assert(fhirResponse.status === 200, 'GET document/fhir returned HTTP 200');
    const fhirBundle = (await fhirResponse.json()) as any;
    assert(fhirBundle.resourceType === 'Bundle', 'Returned payload is a FHIR Bundle');
    assert(fhirBundle.type === 'document', 'FHIR Bundle type is "document"');
    assert(fhirBundle.entry[0].resource.resourceType === 'Composition', 'Golden Rule holds: entry[0] is Composition');

    // Test 3.5: Export Printable HTML Summary
    console.log('[INFO] Testing UI action: Print Clinical Summary HTML...');
    const htmlResponse = await fetch(`${baseUrl}/api/safety-gate/${runId}/document/html`, {
      headers: { Cookie: cookieHeader },
    });
    assert(htmlResponse.status === 200, 'GET document/html returned HTTP 200');
    const htmlContent = await htmlResponse.text();
    assert(htmlContent.includes('<!DOCTYPE html>'), 'Returned payload is valid HTML document');
    assert(htmlContent.includes('Pre-Surgical Safety Gate Clearance Summary'), 'HTML contains clinical summary title');

    // Test 3.6: Resilience SRE Telemetry for UI Drawer
    console.log('[INFO] Testing UI action: Fetch SRE Resilience Telemetry...');
    const circuitsResponse = await fetch(`${baseUrl}/api/resilience/circuits`, {
      headers: { Cookie: cookieHeader },
    });
    assert(circuitsResponse.status === 200, 'GET /api/resilience/circuits returned HTTP 200');
    const circuitsJson = (await circuitsResponse.json()) as any;
    assert(circuitsJson.success === true, 'Circuits endpoint returned success: true');
    assert(typeof circuitsJson.circuits === 'object', 'Circuits data is an object map');
    const circuitKeys = Object.keys(circuitsJson.circuits);
    assert(circuitKeys.length >= 1, 'Contains circuit metrics for registered circuit breakers');
    for (const key of circuitKeys) {
      const circuit = circuitsJson.circuits[key];
      assert(typeof circuit.name === 'string', 'Circuit has a valid string name');
      assert(['CLOSED', 'OPEN', 'HALF_OPEN'].includes(circuit.state), `Circuit state is valid: ${circuit.state}`);
      assert(typeof circuit.stats?.failures === 'number', 'Circuit has numeric failures counter');
    }

    // --------------------------------------------------------------------------
    // Cleanup
    // --------------------------------------------------------------------------
    await sessionStore.destroySession(testSessionId);
    await prisma.auditEvent.deleteMany({
      where: { runId: { in: [runId, manualReviewRun.id] } },
    });
    await prisma.checklistRun.deleteMany({
      where: { id: { in: [runId, manualReviewRun.id] } },
    });

    console.log('\n[SUCCESS] All Chunk 10 React UI & BFF Integration tests passed with 100% compliance!');
  } finally {
    if (server) {
      await new Promise<void>((resolve) => (server as http.Server).close(() => resolve()));
    }
    if (mockEhr) {
      await new Promise<void>((resolve) => (mockEhr as http.Server).close(() => resolve()));
    }
    await prisma.$disconnect();
    await redis.quit();
  }
}

runVerification().catch((err) => {
  console.error('[FATAL] Verification failed with uncaught exception:', err);
  process.exit(1);
});
