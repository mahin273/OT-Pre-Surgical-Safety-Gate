import http from 'node:http';
import { createApp } from '../app.js';
import { redis } from '../lib/redis.js';
import { sessionStore } from '../lib/sessionStore.js';
import { FhirClient } from '../lib/fhirClient.js';

function startMockEhrServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== 'Bearer valid-test-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid or missing Bearer token' }));
        return;
      }

      const url = new URL(req.url || '', `http://${req.headers.host}`);

      // 1. Patient Demographics
      if (url.pathname === '/Patient/test-pat-101') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Patient',
            id: 'test-pat-101',
            name: [{ family: 'Smith', given: ['Jane'], text: 'Jane Smith' }],
            gender: 'female',
            birthDate: '1985-04-12',
          })
        );
        return;
      }

      // 2. Active Conditions (Acute Cholecystitis - SNOMED 235919008)
      if (url.pathname === '/Condition') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            type: 'searchset',
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

      // 3. Laboratory Observations (Platelets, INR, PT)
      if (url.pathname === '/Observation') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            type: 'searchset',
            total: 3,
            entry: [
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'obs-platelets',
                  status: 'final',
                  code: {
                    coding: [{ system: 'http://loinc.org', code: '777-3', display: 'Platelets [#/volume] in Blood' }],
                  },
                  valueQuantity: { value: 180, unit: '10*3/uL', system: 'http://unitsofmeasure.org', code: '10*3/uL' },
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'obs-inr',
                  status: 'final',
                  code: {
                    coding: [{ system: 'http://loinc.org', code: '6301-6', display: 'INR in Blood by Coagulation assay' }],
                  },
                  valueQuantity: { value: 1.1, unit: '{INR}', system: 'http://unitsofmeasure.org', code: '{INR}' },
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'obs-pt',
                  status: 'final',
                  code: {
                    coding: [{ system: 'http://loinc.org', code: '5902-2', display: 'Prothrombin time (PT)' }],
                  },
                  valueQuantity: { value: 12.5, unit: 's', system: 'http://unitsofmeasure.org', code: 's' },
                },
              },
            ],
          })
        );
        return;
      }

      // 4. Allergies (Empty bundle test)
      if (url.pathname === '/AllergyIntolerance') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            type: 'searchset',
            total: 0,
            entry: [],
          })
        );
        return;
      }

      // 5. Consent (404 Not Found test to verify graceful degradation)
      if (url.pathname === '/Consent') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }));
        return;
      }

      // 6. Procedures / ServiceRequests (Laparoscopic Cholecystectomy - CPT 47562)
      if (url.pathname === '/Procedure') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(JSON.stringify({ resourceType: 'Bundle', total: 0 }));
        return;
      }

      if (url.pathname === '/ServiceRequest') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(
          JSON.stringify({
            resourceType: 'Bundle',
            type: 'searchset',
            total: 1,
            entry: [
              {
                resource: {
                  resourceType: 'ServiceRequest',
                  id: 'sr-47562',
                  status: 'active',
                  intent: 'order',
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
  console.log('[START] Starting FHIR Resource Client & Clinical Data Fetcher Verification...');

  const { server: mockEhrServer, port: mockEhrPort } = await startMockEhrServer();
  const mockEhrBase = `http://localhost:${mockEhrPort}`;

  const app = createApp();
  const { server: appServer, port: appPort } = await startAppServer(app);
  const appBase = `http://localhost:${appPort}`;

  const testSessionId = 'test-session-chunk5-' + Date.now();

  try {
    // 1. Test direct FhirClient class querying
    console.log('[TEST 1] Testing direct FhirClient parallel query and bundle unwrapping...');
    const client = new FhirClient(mockEhrBase, 'valid-test-token');
    const directData = await client.fetchAllClinicalData('Patient/test-pat-101');

    if (!directData.patient || directData.patient.id !== 'test-pat-101') {
      throw new Error('[FAIL] Patient demographics missing or ID mismatch');
    }
    if (directData.conditions.length !== 1 || directData.conditions[0].code?.coding?.[0]?.code !== '235919008') {
      throw new Error('[FAIL] Condition resource missing or SNOMED code mismatch');
    }
    if (directData.observations.length !== 3) {
      throw new Error(`[FAIL] Expected 3 lab observations, got: ${directData.observations.length}`);
    }
    if (!Array.isArray(directData.allergies) || directData.allergies.length !== 0) {
      throw new Error('[FAIL] Allergies should be an empty array for zero entries');
    }
    if (!Array.isArray(directData.consents) || directData.consents.length !== 0) {
      throw new Error('[FAIL] Consents should gracefully degrade to empty array on 404');
    }
    if (directData.procedures.length !== 1 || directData.procedures[0].code?.coding?.[0]?.code !== '47562') {
      throw new Error('[FAIL] Scheduled procedure missing or CPT code mismatch');
    }

    console.log('[PASS] FhirClient successfully fetched and normalized all 6 clinical resources');

    // 2. Test authGuard rejection on protected API endpoint
    console.log('[TEST 2] Testing /api/clinical-data rejection without session cookie...');
    const unauthRes = await fetch(`${appBase}/api/clinical-data`);
    if (unauthRes.status !== 401) {
      throw new Error(`[FAIL] Expected 401 for unauthenticated request, got: ${unauthRes.status}`);
    }
    console.log('[PASS] Unauthenticated request correctly rejected with HTTP 401');

    // 3. Setup active Redis session
    console.log('[TEST 3] Testing /api/clinical-data with valid session cookie...');
    await sessionStore.createSession(
      testSessionId,
      {
        accessToken: 'valid-test-token',
        tokenType: 'Bearer',
        expiresIn: 3600,
        patientId: 'Patient/test-pat-101',
        scope: 'launch patient/Patient.rs',
        iss: mockEhrBase,
        createdAt: Date.now(),
      },
      300
    );

    const apiRes = await fetch(`${appBase}/api/clinical-data`, {
      headers: { Cookie: `sid=${testSessionId}` },
    });

    if (apiRes.status !== 200) {
      const errBody = await apiRes.text();
      throw new Error(`[FAIL] Expected 200 OK from /api/clinical-data, got: ${apiRes.status} body: ${errBody}`);
    }

    const payload = (await apiRes.json()) as any;
    if (!payload.success || payload.patientId !== 'Patient/test-pat-101') {
      throw new Error('[FAIL] Response payload success or patientId mismatch');
    }

    const data = payload.data;
    if (data.patient.name[0].text !== 'Jane Smith') {
      throw new Error('[FAIL] Patient name text mismatch in API response');
    }
    if (data.conditions[0].code.coding[0].display !== 'Acute cholecystitis') {
      throw new Error('[FAIL] Condition display mismatch in API response');
    }
    if (data.observations.length !== 3 || data.procedures.length !== 1) {
      throw new Error('[FAIL] Observation count or procedure count mismatch in API response');
    }

    console.log('[PASS] /api/clinical-data returned complete aggregated clinical dataset');

    // 4. Test error handling when EHR rejects token (401 from upstream)
    console.log('[TEST 4] Testing FhirClient rejection handling with invalid token...');
    const badClient = new FhirClient(mockEhrBase, 'invalid-expired-token');
    let badTokenRejected = false;
    try {
      await badClient.getResource('Patient/test-pat-101');
    } catch (err: any) {
      if (err.message.includes('401')) {
        badTokenRejected = true;
      }
    }

    if (!badTokenRejected) {
      throw new Error('[FAIL] Expected FhirClient to throw error on 401 from upstream EHR');
    }

    console.log('[PASS] Upstream EHR 401 correctly trapped and handled');
    console.log('[SUCCESS] All FHIR Resource Client assertions passed successfully!');
  } finally {
    await sessionStore.destroySession(testSessionId);
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
  });
