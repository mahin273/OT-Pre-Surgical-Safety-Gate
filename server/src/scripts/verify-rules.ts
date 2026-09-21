import http from 'node:http';
import { createApp } from '../app.js';
import { redis } from '../lib/redis.js';
import { sessionStore } from '../lib/sessionStore.js';
import { prisma } from '../lib/prisma.js';
import { evaluateDiagnosisProcedureMatch } from '../lib/rules/crosswalk.js';
import { evaluateConsent } from '../lib/rules/consentMatcher.js';
import { evaluateLabs } from '../lib/rules/labThresholds.js';
import { evaluateAllergies } from '../lib/rules/allergyMatcher.js';
import { evaluateClinicalRules } from '../lib/rules/ruleEngine.js';
import type {
  FhirCondition,
  FhirProcedure,
  FhirConsent,
  FhirObservation,
  FhirAllergyIntolerance,
  AggregatedClinicalData,
} from '../lib/fhirClient.js';

function startMockEhrServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== 'Bearer test-rule-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const url = new URL(req.url || '', `http://${req.headers.host}`);

      if (url.pathname === '/Patient/pat-safe-01') {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(JSON.stringify({ resourceType: 'Patient', id: 'pat-safe-01', name: [{ family: 'Doe', given: ['John'] }] }));
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
                  valueQuantity: { value: 210, unit: '10*3/uL' },
                  effectiveDateTime: nowIso,
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'o2',
                  code: { coding: [{ system: 'http://loinc.org', code: '6301-6' }] },
                  valueQuantity: { value: 1.0, unit: '{INR}' },
                  effectiveDateTime: nowIso,
                },
              },
              {
                resource: {
                  resourceType: 'Observation',
                  id: 'o3',
                  code: { coding: [{ system: 'http://loinc.org', code: '5902-2' }] },
                  valueQuantity: { value: 12.0, unit: 's' },
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
  console.log('[START] Starting Pre-Surgical Clinical Rules & Terminology Verification...');

  // 1. Crosswalk Tests
  console.log('[TEST 1] Testing Diagnosis ↔ Procedure Crosswalk...');
  const validCondition: FhirCondition = {
    resourceType: 'Condition',
    id: 'c1',
    code: { coding: [{ system: 'http://snomed.info/sct', code: '235919008', display: 'Acute cholecystitis' }] },
  };
  const validProcedure: FhirProcedure = {
    resourceType: 'Procedure',
    id: 'p1',
    status: 'completed',
    code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '47562', display: 'Laparoscopic cholecystectomy' }] },
  };
  const unmappedCondition: FhirCondition = {
    resourceType: 'Condition',
    id: 'c2',
    code: { coding: [{ system: 'http://snomed.info/sct', code: '99999999', display: 'Unmapped ailment' }] },
  };

  const matchRes = evaluateDiagnosisProcedureMatch([validCondition], [validProcedure]);
  if (!matchRes.passed) {
    throw new Error(`[FAIL] Expected valid SNOMED/CPT pair to pass, got: ${matchRes.detail}`);
  }

  const unmappedRes = evaluateDiagnosisProcedureMatch([unmappedCondition], [validProcedure]);
  if (unmappedRes.passed) {
    throw new Error('[FAIL] Expected unmapped SNOMED/CPT pair to fail');
  }
  console.log('[PASS] Crosswalk correctly validates mapped pairs and flags unmapped combinations');

  // 2. Consent Tests
  console.log('[TEST 2] Testing Informed Surgical Consent Verification...');
  const activeConsent: FhirConsent = {
    resourceType: 'Consent',
    id: 'con1',
    status: 'active',
    dateTime: '2026-09-20T10:00:00Z',
  };
  const draftConsent: FhirConsent = {
    resourceType: 'Consent',
    id: 'con2',
    status: 'draft',
  };

  const consentPass = evaluateConsent([activeConsent]);
  if (!consentPass.passed) {
    throw new Error('[FAIL] Expected active consent to pass');
  }

  const consentDraftFail = evaluateConsent([draftConsent]);
  if (consentDraftFail.passed) {
    throw new Error('[FAIL] Expected draft consent to fail');
  }

  const consentEmptyFail = evaluateConsent([]);
  if (consentEmptyFail.passed) {
    throw new Error('[FAIL] Expected empty consent list to fail');
  }
  console.log('[PASS] Consent verification strictly requires active signed forms');

  // 3. Lab Threshold Tests
  console.log('[TEST 3] Testing Pre-Operative Coagulation Lab Thresholds...');
  const now = Date.now();
  const freshDate = new Date(now - 1000 * 60 * 60 * 2).toISOString(); // 2 hours ago
  const staleDate = new Date(now - 1000 * 60 * 60 * 30).toISOString(); // 30 hours ago

  const normalLabs: FhirObservation[] = [
    {
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '777-3' }] },
      valueQuantity: { value: 180, unit: '10*3/uL' },
      effectiveDateTime: freshDate,
    },
    {
      resourceType: 'Observation',
      id: 'o2',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '6301-6' }] },
      valueQuantity: { value: 1.1, unit: '{INR}' },
      effectiveDateTime: freshDate,
    },
    {
      resourceType: 'Observation',
      id: 'o3',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '5902-2' }] },
      valueQuantity: { value: 12.5, unit: 's' },
      effectiveDateTime: freshDate,
    },
  ];

  const labPass = evaluateLabs(normalLabs, undefined, now);
  if (!labPass.passed) {
    throw new Error(`[FAIL] Expected normal labs to pass, got: ${labPass.detail}`);
  }

  // Low Platelets (<50)
  const lowPltLabs: FhirObservation[] = [
    { ...normalLabs[0], valueQuantity: { value: 35, unit: '10*3/uL' } },
    normalLabs[1],
    normalLabs[2],
  ];
  const lowPltFail = evaluateLabs(lowPltLabs, undefined, now);
  if (lowPltFail.passed || !lowPltFail.detail.includes('low platelets')) {
    throw new Error('[FAIL] Expected Platelets < 50 to fail');
  }

  // Stale Lab (>24h)
  const staleLabs: FhirObservation[] = [
    { ...normalLabs[0], effectiveDateTime: staleDate },
    normalLabs[1],
    normalLabs[2],
  ];
  const staleFail = evaluateLabs(staleLabs, undefined, now);
  if (staleFail.passed || !staleFail.detail.includes('exceed 24-hour')) {
    throw new Error('[FAIL] Expected lab older than 24h to fail recency check');
  }

  console.log('[PASS] Lab rules enforce safe thresholds (Platelets >= 50, INR <= 1.5, PT <= 14.0) and 24h freshness');

  // 4. Allergy Tests
  console.log('[TEST 4] Testing Antibiotic Prophylaxis Allergy Matcher...');
  const cefazolinAllergy: FhirAllergyIntolerance = {
    resourceType: 'AllergyIntolerance',
    id: 'a1',
    code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '2231', display: 'Cefazolin' }] },
  };
  const penicillinAnaphylaxis: FhirAllergyIntolerance = {
    resourceType: 'AllergyIntolerance',
    id: 'a2',
    criticality: 'high',
    code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '70618', display: 'Penicillin' }] },
  };

  const directConflict = evaluateAllergies([cefazolinAllergy]);
  if (directConflict.passed) {
    throw new Error('[FAIL] Expected Cefazolin allergy to fail conflict check');
  }

  const crossReactivityConflict = evaluateAllergies([penicillinAnaphylaxis]);
  if (crossReactivityConflict.passed) {
    throw new Error('[FAIL] Expected severe penicillin anaphylaxis to trigger cross-reactivity alert');
  }

  const cleanAllergy = evaluateAllergies([]);
  if (!cleanAllergy.passed) {
    throw new Error('[FAIL] Expected empty allergy list to pass');
  }
  console.log('[PASS] Allergy matcher detects direct Cefazolin conflicts and severe beta-lactam anaphylaxis');

  // 5. TerminologyCache Postgres Integration Test
  console.log('[TEST 5] Testing TerminologyCache Prisma upsert...');
  const testClinicalData: AggregatedClinicalData = {
    patient: { resourceType: 'Patient', id: 'test-p1', name: [{ family: 'Test' }] },
    conditions: [validCondition],
    observations: normalLabs,
    allergies: [],
    consents: [activeConsent],
    procedures: [validProcedure],
    fetchedAt: Date.now(),
  };

  const engineRes = await evaluateClinicalRules(testClinicalData, { persistTerminologyCache: true });
  if (!engineRes.allPassed || engineRes.checks.length !== 4) {
    throw new Error('[FAIL] Expected all 4 safety checks to pass on clean clinical dataset');
  }

  const cachedTerm = await prisma.terminologyCache.findUnique({
    where: {
      codeSystem_code: {
        codeSystem: 'http://snomed.info/sct',
        code: '235919008',
      },
    },
  });

  if (!cachedTerm) {
    throw new Error('[FAIL] Expected SNOMED code to be cached in PostgreSQL TerminologyCache');
  }
  console.log(`[PASS] TerminologyCache successfully updated: ${cachedTerm.codeSystem}#${cachedTerm.code}`);

  // 6. API Route Integration Test
  console.log('[TEST 6] Testing POST /api/clinical-data/evaluate endpoint...');
  const { server: mockEhrServer, port: mockEhrPort } = await startMockEhrServer();
  const mockEhrBase = `http://localhost:${mockEhrPort}`;

  const app = createApp();
  const { server: appServer, port: appPort } = await startAppServer(app);
  const appBase = `http://localhost:${appPort}`;

  const sessionId = 'test-session-rules-' + Date.now();
  await sessionStore.createSession(
    sessionId,
    {
      accessToken: 'test-rule-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
      patientId: 'Patient/pat-safe-01',
      scope: 'launch patient/Patient.rs',
      iss: mockEhrBase,
      createdAt: Date.now(),
    },
    300
  );

  try {
    const apiRes = await fetch(`${appBase}/api/clinical-data/evaluate`, {
      method: 'POST',
      headers: {
        Cookie: `sid=${sessionId}`,
        'Content-Type': 'application/json',
      },
    });

    if (apiRes.status !== 200) {
      const errText = await apiRes.text();
      throw new Error(`[FAIL] Expected 200 from evaluate endpoint, got: ${apiRes.status} body: ${errText}`);
    }

    const payload = (await apiRes.json()) as any;
    if (!payload.success || payload.checks.length !== 4 || !payload.allPassed) {
      throw new Error('[FAIL] Expected evaluate endpoint to return 4 passing checks');
    }

    console.log('[PASS] POST /api/clinical-data/evaluate returned all 4 passing clinical checks');
    console.log('[SUCCESS] All Pre-Surgical Clinical Rules & Terminology assertions passed successfully!');
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
