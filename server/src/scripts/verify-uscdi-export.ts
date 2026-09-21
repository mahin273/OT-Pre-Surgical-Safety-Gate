import { prisma, GateStatus, type CheckResult } from '../lib/prisma.js';
import {
  generatePreSurgicalDocumentBundle,
  generatePreSurgicalSummaryHtml,
} from '../lib/uscdiExport.js';
import { createApp } from '../app.js';
import { redis } from '../lib/redis.js';
import { sessionStore } from '../lib/sessionStore.js';
import type { Server } from 'http';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] Assertion failed: ${message}`);
    process.exit(1);
  }
  console.log(`[PASS] ${message}`);
}

async function runVerification(): Promise<void> {
  console.log('[INFO] Starting Chunk 9 USCDI Document Export Verification...');

  let server: Server | null = null;

  try {
    // --------------------------------------------------------------------------
    // Test Data Setup
    // --------------------------------------------------------------------------
    const testPatientId = 'patient-uscdi-test-01';

    const passingChecks: CheckResult[] = [
      { name: 'diagnosis_procedure_match', passed: true, detail: 'SNOMED 235919008 maps to CPT 47562' },
      { name: 'consent', passed: true, detail: 'Active informed surgical consent on file' },
      { name: 'labs', passed: true, detail: 'Platelets: 220 k/uL, INR: 1.0, PT: 12.0s' },
      { name: 'allergy', passed: true, detail: 'No documented beta-lactam or Cefazolin allergy' },
    ];

    const passRun = await prisma.checklistRun.create({
      data: {
        patientId: testPatientId,
        procedureCpt: '47562',
        diagnosisSnomed: '235919008',
        status: GateStatus.PASS,
        checks: passingChecks as any,
        createdBy: 'Practitioner/dr-surgeon-smith',
        auditEvents: {
          create: {
            actor: 'Practitioner/dr-surgeon-smith',
            action: 'SAFETY_GATE_EVALUATION',
            outcome: GateStatus.PASS,
            detail: { checks: passingChecks } as any,
          },
        },
      },
      include: { auditEvents: true },
    });

    // --------------------------------------------------------------------------
    // Suite 1: Document Bundle & The Golden Rule (entry[0] === Composition)
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 1: FHIR R4 Document Bundle Structure ---');
    const result1 = await generatePreSurgicalDocumentBundle({
      runId: passRun.id,
      actor: 'Practitioner/dr-surgeon-smith',
    });

    assert(result1.bundle.resourceType === 'Bundle', 'Bundle resourceType is "Bundle"');
    assert(result1.bundle.type === 'document', 'Bundle type is strictly "document"');
    assert(result1.bundle.entry !== undefined && result1.bundle.entry.length > 1, 'Bundle contains multiple entries');

    // The Golden Rule of FHIR Documents: entry[0] must be Composition
    const entry0 = result1.bundle.entry![0];
    assert(entry0.resource.resourceType === 'Composition', 'The Golden Rule: entry[0] is strictly a Composition');
    assert(entry0.resource.status === 'final', 'Composition status is "final"');
    assert(entry0.resource.type.coding[0].code === '81218-0', 'Composition type code is LOINC 81218-0');
    assert(entry0.resource.type.coding[0].system === 'http://loinc.org', 'Composition coding system is http://loinc.org');
    assert(
      entry0.resource.title === 'Pre-Surgical Safety Gate Clearance Summary',
      'Composition title is "Pre-Surgical Safety Gate Clearance Summary"'
    );

    // --------------------------------------------------------------------------
    // Suite 2: Section Structure & Dual Representation
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 2: Section Structure & Dual Representation ---');
    const composition = entry0.resource;
    assert(composition.section.length === 5, 'Composition contains all 5 standard USCDI sections');

    const expectedSectionCodes = ['81218-0', '81219-8', '59284-0', '30954-2', '48765-2'];
    for (let i = 0; i < 5; i++) {
      const section = composition.section[i];
      assert(
        section.code?.coding?.[0]?.code === expectedSectionCodes[i],
        `Section ${i + 1} has LOINC code ${expectedSectionCodes[i]}`
      );
      assert(
        section.text?.div.startsWith('<div xmlns="http://www.w3.org/1999/xhtml">'),
        `Section ${i + 1} narrative has mandatory XHTML xmlns namespace`
      );
    }

    // Verify all referenced URNs exist in the bundle
    const allFullUrls = new Set(result1.bundle.entry!.map((e: any) => e.fullUrl));
    let referencedCount = 0;
    for (const sec of composition.section) {
      for (const ref of sec.entry || []) {
        if (ref.reference && ref.reference.startsWith('urn:uuid:')) {
          referencedCount++;
          assert(allFullUrls.has(ref.reference), `Referenced entry ${ref.reference} exists in Bundle`);
        }
      }
    }
    assert(referencedCount > 0, `All ${referencedCount} section reference entries verified in bundle`);

    // --------------------------------------------------------------------------
    // Suite 3: Clinical Override Representation in Document
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 3: Clinical Override Representation ---');
    const overrideRun = await prisma.checklistRun.create({
      data: {
        patientId: 'patient-override-test',
        procedureCpt: '47562',
        diagnosisSnomed: '99999999',
        status: GateStatus.PASS,
        checks: [
          { name: 'diagnosis_procedure_match', passed: false, detail: 'Unmapped combination' },
          { name: 'consent', passed: true, detail: 'Active consent' },
        ] as any,
        createdBy: 'Practitioner/dr-resident',
        auditEvents: {
          createMany: {
            data: [
              {
                actor: 'Practitioner/dr-resident',
                action: 'SAFETY_GATE_EVALUATION',
                outcome: GateStatus.MANUAL_REVIEW,
                detail: {},
              },
              {
                actor: 'Practitioner/dr-chief-surgeon',
                action: 'CLINICAL_OVERRIDE',
                outcome: GateStatus.PASS,
                detail: {
                  overrideReason: 'Surgeon verified non-standard indication is medically indicated for emergency lap chole',
                },
              },
            ],
          },
        },
      },
      include: { auditEvents: true },
    });

    const resultOverride = await generatePreSurgicalDocumentBundle({
      runId: overrideRun.id,
      actor: 'Practitioner/dr-chief-surgeon',
    });

    const overrideNarrative = resultOverride.bundle.entry![0].resource.section[0].text.div;
    assert(
      overrideNarrative.includes('[CLINICAL OVERRIDE RECORDED]'),
      'Document narrative displays clinical override banner'
    );
    assert(
      overrideNarrative.includes('Practitioner/dr-chief-surgeon'),
      'Document narrative records overriding clinician'
    );
    assert(
      overrideNarrative.includes('emergency lap chole'),
      'Document narrative records signed clinical override rationale'
    );

    // --------------------------------------------------------------------------
    // Suite 4: Blocked Contraindicated Surgery Document
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 4: Blocked Surgery Document ---');
    const blockRun = await prisma.checklistRun.create({
      data: {
        patientId: 'patient-block-test',
        procedureCpt: '47562',
        diagnosisSnomed: '235919008',
        status: GateStatus.BLOCK,
        checks: [
          { name: 'allergy', passed: false, detail: 'Severe Cefazolin anaphylaxis documented' },
          { name: 'consent', passed: false, detail: 'No signed consent' },
        ] as any,
        createdBy: 'Practitioner/dr-nurse',
        auditEvents: {
          create: {
            actor: 'Practitioner/dr-nurse',
            action: 'SAFETY_GATE_EVALUATION',
            outcome: GateStatus.BLOCK,
            detail: {},
          },
        },
      },
      include: { auditEvents: true },
    });

    const resultBlock = await generatePreSurgicalDocumentBundle({
      runId: blockRun.id,
      actor: 'Practitioner/dr-nurse',
    });

    assert(
      resultBlock.bundle.entry![0].resource.section[0].text.div.includes('BLOCK'),
      'Block status clearly indicated in safety section narrative'
    );

    // --------------------------------------------------------------------------
    // Suite 5: Printable HTML Summary Rendering
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 5: Printable HTML Summary Rendering ---');
    const htmlSummary = generatePreSurgicalSummaryHtml(result1);
    assert(htmlSummary.startsWith('<!DOCTYPE html>'), 'Generated HTML has valid DOCTYPE declaration');
    assert(htmlSummary.includes('CLEARED FOR SURGERY'), 'Passing run displays CLEARED FOR SURGERY badge');
    assert(htmlSummary.includes('47562'), 'HTML displays procedure CPT');
    assert(htmlSummary.includes('235919008'), 'HTML displays diagnosis SNOMED');

    const htmlBlockSummary = generatePreSurgicalSummaryHtml(resultBlock);
    assert(
      htmlBlockSummary.includes('SURGICAL BLOCK: CONTRAINDICATION DETECTED'),
      'Blocked run displays SURGICAL BLOCK badge'
    );

    // --------------------------------------------------------------------------
    // Suite 6: HTTP Endpoints
    // --------------------------------------------------------------------------
    console.log('\n--- Suite 6: HTTP Document Export Endpoints ---');
    const app = createApp();
    const port = 8089;
    server = app.listen(port);

    // Seed active session in Redis for authGuard
    const testSessionId = 'test-uscdi-session-id';
    await sessionStore.createSession(
      testSessionId,
      {
        patientId: testPatientId,
        accessToken: 'mock-token',
        tokenType: 'Bearer',
        expiresIn: 300,
        scope: 'launch/patient patient/*.read openid fhirUser',
        iss: 'https://fhir.example.org',
        fhirUser: 'Practitioner/dr-surgeon-smith',
        createdAt: Date.now(),
      },
      300
    );

    // Test FHIR export
    const fhirRes = await fetch(`http://localhost:${port}/api/safety-gate/${passRun.id}/document/fhir`, {
      headers: { Cookie: `sid=${testSessionId}` },
    });
    assert(fhirRes.status === 200, 'GET /api/safety-gate/:runId/document/fhir returns HTTP 200');
    const contentType = fhirRes.headers.get('content-type') || '';
    assert(
      contentType.includes('application/fhir+json') || contentType.includes('application/json'),
      `FHIR endpoint returns valid FHIR content type: ${contentType}`
    );
    const fhirJson = (await fhirRes.json()) as any;
    assert(fhirJson.resourceType === 'Bundle', 'FHIR endpoint body has resourceType Bundle');
    assert(fhirJson.entry[0].resource.resourceType === 'Composition', 'FHIR endpoint entry[0] is Composition');

    // Test HTML export
    const htmlRes = await fetch(`http://localhost:${port}/api/safety-gate/${passRun.id}/document/html`, {
      headers: { Cookie: `sid=${testSessionId}` },
    });
    assert(htmlRes.status === 200, 'GET /api/safety-gate/:runId/document/html returns HTTP 200');
    const htmlContentType = htmlRes.headers.get('content-type') || '';
    assert(htmlContentType.includes('text/html'), `HTML endpoint returns text/html content type: ${htmlContentType}`);
    const htmlText = await htmlRes.text();
    assert(htmlText.includes('<!DOCTYPE html>'), 'HTML endpoint body contains DOCTYPE');
    assert(htmlText.includes('CLEARED FOR SURGERY'), 'HTML endpoint body contains clearance badge');

    // Test 404 for non-existent run
    const notFoundRes = await fetch(`http://localhost:${port}/api/safety-gate/non-existent-run-id/document/fhir`, {
      headers: { Cookie: `sid=${testSessionId}` },
    });
    assert(notFoundRes.status === 404, 'Non-existent runId returns HTTP 404');

    // Cleanup test data
    await prisma.auditEvent.deleteMany({
      where: { runId: { in: [passRun.id, overrideRun.id, blockRun.id] } },
    });
    await prisma.checklistRun.deleteMany({
      where: { id: { in: [passRun.id, overrideRun.id, blockRun.id] } },
    });
    await sessionStore.destroySession(testSessionId);

    console.log('\n[INFO] All 6 USCDI Document Export Verification Suites PASSED successfully!');
    process.exit(0);
  } catch (err) {
    console.error('[ERROR] Verification failed:', err);
    process.exit(1);
  } finally {
    if (server) {
      server.close();
    }
  }
}

runVerification().catch((err) => {
  console.error('[ERROR] Fatal verification crash:', err);
  process.exit(1);
});
