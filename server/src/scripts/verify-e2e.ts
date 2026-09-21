import http from 'node:http';
import assert from 'node:assert';
import { createApp } from '../app.js';
import { redis } from '../lib/redis.js';
import { sessionStore } from '../lib/sessionStore.js';
import { prisma, GateStatus } from '../lib/prisma.js';
import { circuitBreakerRegistry } from '../lib/circuitBreaker.js';

interface UpstreamMockOptions {
  includePenicillinAllergy?: boolean;
  missingLabs?: boolean;
  staleLabs?: boolean;
}

/**
 * Creates an ephemeral in-process FHIR R4 and OAuth2 authorization server
 * to deterministic simulate upstream hospital EHR behavior.
 */
function startUpstreamFhirServer(initialOptions: UpstreamMockOptions = {}): Promise<{
  server: http.Server;
  baseUrl: string;
  setOptions: (newOpts: UpstreamMockOptions) => void;
}> {
  let opts = { ...initialOptions };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);

      // 1. SMART on FHIR Discovery (.well-known/smart-configuration)
      if (url.pathname === '/.well-known/smart-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: `http://${req.headers.host}`,
            authorization_endpoint: `http://${req.headers.host}/authorize`,
            token_endpoint: `http://${req.headers.host}/token`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          })
        );
        return;
      }

      // 2. OAuth2 Authorization Screen (auto-redirect with code)
      if (url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') || '';
        const state = url.searchParams.get('state') || '';
        const cbUrl = new URL(redirectUri);
        cbUrl.searchParams.set('code', 'test-e2e-auth-code');
        cbUrl.searchParams.set('state', state);
        res.writeHead(302, { Location: cbUrl.toString() });
        res.end();
        return;
      }

      // 3. OAuth2 Token Exchange Endpoint
      if (url.pathname === '/token' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'test-e2e-fhir-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            patient: 'pat-e2e-001',
            fhirUser: 'Practitioner/dr-surgeon-e2e',
            scope: 'launch openid patient/Patient.read patient/Condition.read',
          })
        );
        return;
      }

      // FHIR Resource Endpoints (Require Bearer Token)
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', message: 'Bearer token required' }));
        return;
      }

      // 4. Patient Demographics
      if (url.pathname === '/Patient/pat-e2e-001') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Patient',
            id: 'pat-e2e-001',
            name: [{ family: 'Montgomery', given: ['Eleanor'] }],
            gender: 'female',
            birthDate: '1978-03-24',
          })
        );
        return;
      }

      // 5. Active Diagnoses (Condition: Acute Cholecystitis SNOMED 235919008)
      if (url.pathname === '/Condition') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            total: 1,
            entry: [
              {
                resource: {
                  resourceType: 'Condition',
                  id: 'cond-01',
                  clinicalStatus: {
                    coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }],
                  },
                  code: {
                    coding: [{ system: 'http://snomed.info/sct', code: '235919008', display: 'Acute cholecystitis' }],
                  },
                },
              },
            ],
          })
        );
        return;
      }

      // 6. Scheduled Surgery (Procedure: Laparoscopic Cholecystectomy CPT 47562)
      if (url.pathname === '/Procedure') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            total: 1,
            entry: [
              {
                resource: {
                  resourceType: 'Procedure',
                  id: 'proc-01',
                  status: 'completed',
                  code: {
                    coding: [
                      { system: 'http://www.ama-assn.org/go/cpt', code: '47562', display: 'Laparoscopic cholecystectomy' },
                    ],
                  },
                },
              },
            ],
          })
        );
        return;
      }

      // 7. Informed Surgical Consent (Consent: active, surgical)
      if (url.pathname === '/Consent') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            total: 1,
            entry: [
              {
                resource: {
                  resourceType: 'Consent',
                  id: 'consent-01',
                  status: 'active',
                  scope: {
                    coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'treatment' }],
                  },
                  dateTime: new Date().toISOString(),
                },
              },
            ],
          })
        );
        return;
      }

      // 8. Pre-Op Coagulation Labs (Observation)
      if (url.pathname === '/Observation') {
        if (opts.missingLabs) {
          res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
          res.end(JSON.stringify({ resourceType: 'Bundle', total: 0, entry: [] }));
          return;
        }

        const labDate = opts.staleLabs
          ? new Date(Date.now() - 36 * 3600 * 1000).toISOString()
          : new Date().toISOString();

        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            total: 3,
            entry: [
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'obs-plt',
                  code: { coding: [{ system: 'http://loinc.org', code: '777-3', display: 'Platelets' }] },
                  valueQuantity: { value: 240, unit: '10*3/uL', system: 'http://unitsofmeasure.org' },
                  effectiveDateTime: labDate,
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'obs-inr',
                  code: { coding: [{ system: 'http://loinc.org', code: '6301-6', display: 'INR' }] },
                  valueQuantity: { value: 1.05, unit: '{INR}' },
                  effectiveDateTime: labDate,
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'obs-pt',
                  code: { coding: [{ system: 'http://loinc.org', code: '5902-2', display: 'PT' }] },
                  valueQuantity: { value: 11.8, unit: 's', system: 'http://unitsofmeasure.org' },
                  effectiveDateTime: labDate,
                },
              },
            ],
          })
        );
        return;
      }

      // 9. Allergy Intolerance Screen
      if (url.pathname === '/AllergyIntolerance') {
        if (opts.includePenicillinAllergy) {
          res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
          res.end(
            JSON.stringify({
              resourceType: 'Bundle',
              total: 1,
              entry: [
                {
                  resource: {
                    resourceType: 'AllergyIntolerance',
                    id: 'all-01',
                    clinicalStatus: {
                      coding: [
                        { system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' },
                      ],
                    },
                    criticality: 'high',
                    code: {
                      coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '70618', display: 'Penicillin' }],
                      text: 'Severe Penicillin Anaphylaxis',
                    },
                  },
                },
              ],
            })
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(JSON.stringify({ resourceType: 'Bundle', total: 0, entry: [] }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;
      resolve({
        server,
        baseUrl,
        setOptions: (newOpts: UpstreamMockOptions) => {
          opts = { ...opts, ...newOpts };
        },
      });
    });
  });
}

/**
 * Executes the full end-to-end test suite verifying all 10 preceding chunks.
 */
async function runE2ETests(): Promise<void> {
  console.log('================================================================');
  console.log('STARTING PRE-SURGICAL SAFETY GATE END-TO-END INTEGRATION SUITE');
  console.log('================================================================');

  // 1. Initialize App Server on an ephemeral test port
  const app = createApp();
  const appServer = http.createServer(app);
  await new Promise<void>((resolve) => appServer.listen(0, resolve));
  const appAddr = appServer.address();
  const appPort = typeof appAddr === 'object' && appAddr ? appAddr.port : 0;
  const appBase = `http://localhost:${appPort}`;

  // 2. Start Upstream Test EHR Server
  const upstream = await startUpstreamFhirServer();

  try {
    // --------------------------------------------------------------------------
    // TEST 1: SMART ON FHIR OAUTH LAUNCH SEQUENCE & SESSION BINDING
    // --------------------------------------------------------------------------
    console.log('\n[TEST 1] Testing SMART on FHIR OAuth Handshake & Session Creation...');

    // A. Initiate /launch
    const launchRes = await fetch(`${appBase}/launch?iss=${encodeURIComponent(upstream.baseUrl)}&launch=test-launch-ctx`, {
      redirect: 'manual',
    });
    assert.strictEqual(launchRes.status, 302, 'Expected 302 redirect from /launch');

    const authRedirectUrl = launchRes.headers.get('location') || '';
    assert.ok(authRedirectUrl.includes('/authorize'), 'Launch must redirect to upstream authorization endpoint');

    // Extract state query parameter
    const authUrlObj = new URL(authRedirectUrl);
    const stateParam = authUrlObj.searchParams.get('state');
    assert.ok(stateParam, 'Launch must include state parameter in redirect');

    // B. Trigger upstream authorize (simulating user clicking approve)
    const authorizeRes = await fetch(authRedirectUrl, { redirect: 'manual' });
    assert.strictEqual(authorizeRes.status, 302, 'Upstream authorize must redirect to callback');

    const callbackRedirectUrl = authorizeRes.headers.get('location') || '';
    const callbackUrlObj = new URL(callbackRedirectUrl);
    const authCode = callbackUrlObj.searchParams.get('code');
    const returnedState = callbackUrlObj.searchParams.get('state');

    // C. Execute /callback to exchange code for token
    const callbackRes = await fetch(`${appBase}/callback?code=${authCode}&state=${returnedState}`, {
      redirect: 'manual',
    });
    assert.strictEqual(callbackRes.status, 302, 'Expected 302 redirect from /callback to client');

    const clientRedirectUrl = callbackRes.headers.get('location') || '';
    const clientUrlObj = new URL(clientRedirectUrl);
    const sessionId = clientUrlObj.searchParams.get('sid');
    assert.ok(sessionId, 'Callback redirect URL must contain sid parameter for iframe resilience');

    // D. Verify session context via /api/auth/me
    const meRes = await fetch(`${appBase}/api/auth/me`, {
      headers: { 'x-session-id': sessionId },
    });
    assert.strictEqual(meRes.status, 200, 'Expected 200 from /api/auth/me');
    const meData = await meRes.json();
    assert.strictEqual(meData.authenticated, true, 'User session must report authenticated: true');
    assert.strictEqual(meData.patientId, 'pat-e2e-001', 'Session must hold correct patientId');
    console.log('-> [PASS] SMART on FHIR OAuth handshake verified (session created and authenticated).');

    // --------------------------------------------------------------------------
    // TEST 2: HAPPY PATH SAFETY GATE EXECUTION (ALL 4 RULES PASS)
    // --------------------------------------------------------------------------
    console.log('\n[TEST 2] Executing Pre-Surgical Safety Gate (Happy Path - Clean Surgery)...');

    const runRes = await fetch(`${appBase}/api/safety-gate/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
    });
    assert.strictEqual(runRes.status, 200, 'Expected 200 OK from /api/safety-gate/run');
    const runData = await runRes.json();

    assert.strictEqual(runData.success, true, 'Safety gate run must report success');
    assert.strictEqual(runData.status, 'PASS', 'Expected terminal GateStatus to be PASS');
    assert.strictEqual(runData.procedureCpt, '47562', 'Procedure CPT must be 47562');
    assert.strictEqual(runData.diagnosisSnomed, '235919008', 'Diagnosis SNOMED must be 235919008');
    assert.strictEqual(runData.patient.name, 'MONTGOMERY, ELEANOR', 'Extracted patient name must match');

    // Assert all 4 rules passed
    const checks = runData.checks as any[];
    assert.strictEqual(checks.length, 4, 'Expected exactly 4 deterministic clinical checks');
    assert.ok(checks.every((c) => c.passed), 'All checks must pass on happy path');

    // Verify PostgreSQL persistence
    const savedRun = await prisma.checklistRun.findUnique({
      where: { id: runData.runId },
      include: { auditEvents: true },
    });
    assert.ok(savedRun, 'ChecklistRun must be stored in PostgreSQL');
    assert.strictEqual(savedRun.status, GateStatus.PASS, 'Stored status must be PASS');
    assert.strictEqual(savedRun.auditEvents.length, 1, 'Initial run must have exactly 1 AuditEvent');
    assert.strictEqual(savedRun.auditEvents[0].action, 'GATE_EVALUATION', 'Audit action must be correct');
    console.log('-> [PASS] Pre-surgical safety gate executed, calculated PASS, and committed to PostgreSQL.');

    // --------------------------------------------------------------------------
    // TEST 3: STANDARDIZED CLINICAL DOCUMENT EXPORTS (USCDI & CDA XML)
    // --------------------------------------------------------------------------
    console.log('\n[TEST 3] Verifying USCDI FHIR Composition & Legacy HL7 CDA XML Document Exports...');

    // A. Modern FHIR R4 Composition Document Bundle
    const fhirDocRes = await fetch(`${appBase}/api/safety-gate/${runData.runId}/document/fhir`, {
      headers: { 'x-session-id': sessionId },
    });
    assert.strictEqual(fhirDocRes.status, 200, 'Expected 200 from FHIR document export');
    const fhirBundle = await fhirDocRes.json();
    assert.strictEqual(fhirBundle.resourceType, 'Bundle', 'Root export must be a FHIR Bundle');
    assert.strictEqual(fhirBundle.type, 'document', 'Bundle type must be document');
    assert.strictEqual(fhirBundle.entry[0].resource.resourceType, 'Composition', 'Entry[0] must be Composition');
    assert.strictEqual(fhirBundle.entry[0].resource.type.coding[0].code, '81218-0', 'LOINC must be 81218-0 (pre-op note)');

    // B. Legacy HL7 CDA XML Document
    const cdaDocRes = await fetch(`${appBase}/api/safety-gate/${runData.runId}/document/cda`, {
      headers: { 'x-session-id': sessionId },
    });
    assert.strictEqual(cdaDocRes.status, 200, 'Expected 200 from CDA XML document export');
    const cdaXml = await cdaDocRes.text();
    assert.ok(cdaXml.includes('<ClinicalDocument'), 'CDA export must contain root <ClinicalDocument> tag');
    assert.ok(cdaXml.includes('Montgomery'), 'CDA export must contain patient family name');
    assert.ok(cdaXml.includes('81218-0'), 'CDA export must contain pre-op evaluation LOINC code');

    // C. Printable HTML Summary
    const htmlDocRes = await fetch(`${appBase}/api/safety-gate/${runData.runId}/document/html`, {
      headers: { 'x-session-id': sessionId },
    });
    assert.strictEqual(htmlDocRes.status, 200, 'Expected 200 from HTML document export');
    const htmlBody = await htmlDocRes.text();
    assert.ok(htmlBody.includes('Pre-Surgical Safety Gate Clearance Summary'), 'HTML export must render document title');
    console.log('-> [PASS] USCDI FHIR Composition, HL7 CDA XML, and HTML summaries generated and validated.');

    // --------------------------------------------------------------------------
    // TEST 4: ANAPHYLAXIS DRUG ALLERGY CONFLICT (BLOCK INTERLOCK)
    // --------------------------------------------------------------------------
    console.log('\n[TEST 4] Testing Antibiotic Allergy Screen (Penicillin Anaphylaxis Hazard)...');
    upstream.setOptions({ includePenicillinAllergy: true, missingLabs: false });

    const allergyRunRes = await fetch(`${appBase}/api/safety-gate/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
    });
    assert.strictEqual(allergyRunRes.status, 200, 'Expected 200 OK from /api/safety-gate/run');
    const allergyRunData = await allergyRunRes.json();

    assert.strictEqual(allergyRunData.status, 'BLOCK', 'Expected terminal GateStatus to be BLOCK');
    const allergyCheck = allergyRunData.checks.find((c: any) => c.name === 'allergy');
    assert.ok(allergyCheck, 'Must contain allergy check');
    assert.strictEqual(allergyCheck.passed, false, 'Allergy check must fail');
    assert.ok(
      allergyCheck.detail.includes('cross-reactivity'),
      'Detail must describe beta-lactam cross-reactivity alert'
    );
    console.log('-> [PASS] Anaphylaxis hazard correctly triggered BLOCK interlock.');

    // --------------------------------------------------------------------------
    // TEST 5: STALE LABS (MANUAL_REVIEW) AND ATTENDING SURGEON OVERRIDE
    // --------------------------------------------------------------------------
    console.log('\n[TEST 5] Testing Stale Coagulation Labs (>24h) & Attending Surgeon Override...');
    upstream.setOptions({ includePenicillinAllergy: false, missingLabs: false, staleLabs: true });

    // A. Run Safety Gate with stale labs (> 24 hours old)
    const reviewRunRes = await fetch(`${appBase}/api/safety-gate/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
    });
    const reviewRunData = await reviewRunRes.json();
    assert.strictEqual(reviewRunData.status, 'MANUAL_REVIEW', 'Stale labs (>24h) must yield MANUAL_REVIEW');

    // B. Attempt override with blank reason (Must be rejected)
    const badOverrideRes = await fetch(`${appBase}/api/safety-gate/${reviewRunData.runId}/override`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
      body: JSON.stringify({ reason: '   ' }),
    });
    assert.strictEqual(badOverrideRes.status, 400, 'Override with blank reason must return HTTP 400 Bad Request');

    // C. Submit valid clinical override
    const overrideReason = 'Patient monitored via intraoperative ROTEM bedside viscoelastic assay; attending surgeon authorized';
    const overrideRes = await fetch(`${appBase}/api/safety-gate/${reviewRunData.runId}/override`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
      body: JSON.stringify({ reason: overrideReason }),
    });
    assert.strictEqual(overrideRes.status, 200, 'Expected 200 OK from override');
    const overrideData = await overrideRes.json();
    assert.strictEqual(overrideData.status, 'PASS', 'Status must transition to PASS upon override');

    // Verify audit log has 2 events (Initial evaluation + Override)
    const overriddenRun = await prisma.checklistRun.findUnique({
      where: { id: reviewRunData.runId },
      include: { auditEvents: { orderBy: { timestamp: 'asc' } } },
    });
    assert.ok(overriddenRun, 'ChecklistRun must exist');
    assert.strictEqual(overriddenRun.auditEvents.length, 2, 'Must record 2 audit events');
    assert.strictEqual(overriddenRun.auditEvents[1].action, 'CLINICAL_OVERRIDE', 'Second audit action must be CLINICAL_OVERRIDE');
    assert.strictEqual(overriddenRun.auditEvents[1].detail.reason, overrideReason, 'Audit detail must preserve exact reason');
    console.log('-> [PASS] Manual review triggered, blank override rejected, valid override audited.');

    // --------------------------------------------------------------------------
    // TEST 6: FAIL-CLOSED RESILIENCE UNDER UPSTREAM NETWORK OUTAGE
    // --------------------------------------------------------------------------
    console.log('\n[TEST 6] Testing Fail-Closed Resilience During Upstream Network Partition...');

    // Close upstream server to simulate network crash
    await new Promise<void>((res) => upstream.server.close(() => res()));

    // Execute safety gate while upstream is down
    const outageRunRes = await fetch(`${appBase}/api/safety-gate/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
    });
    const outageRunData = await outageRunRes.json();

    assert.strictEqual(outageRunData.status, 'BLOCK', 'Must fail-closed to BLOCK during network outage');
    const ehrCheck = outageRunData.checks.find((c: any) => c.name === 'ehr_availability');
    assert.ok(ehrCheck, 'Must contain ehr_availability check');
    assert.ok(ehrCheck.detail.includes('[FAIL-CLOSED]'), 'Must explicitly indicate fail-closed policy');
    console.log('-> [PASS] System successfully failed-closed to BLOCK during upstream outage.');

    // --------------------------------------------------------------------------
    // TEST 7: AUTHENTICATION BOUNDARY ENFORCEMENT
    // --------------------------------------------------------------------------
    console.log('\n[TEST 7] Testing Security Boundary (Reject Unauthenticated Requests)...');

    const unauthRes = await fetch(`${appBase}/api/safety-gate/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.strictEqual(unauthRes.status, 401, 'Requests without session credentials must return 401 Unauthorized');
    console.log('-> [PASS] Unauthenticated access blocked.');

    console.log('\n================================================================');
    console.log('ALL END-TO-END INTEGRATION TESTS PASSED SUCCESSFULLY (7/7)');
    console.log('================================================================');
  } finally {
    // Teardown
    await new Promise<void>((res) => appServer.close(() => res()));
    await redis.quit();
    await prisma.$disconnect();
  }
}

runE2ETests().catch((err) => {
  console.error('\n[FATAL ERROR] End-to-end integration test suite failed:', err);
  process.exit(1);
});
