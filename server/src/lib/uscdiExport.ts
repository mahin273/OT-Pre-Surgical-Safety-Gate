import { randomUUID } from 'crypto';
import { getSafetyGateRun, type ChecklistRunWithAudit } from './safetyGate.js';
import { fetchClinicalDataWithCircuitBreaker } from './circuitBreaker.js';
import type {
  FhirClient,
  FhirBundle,
  FhirComposition,
  FhirCompositionSection,
  FhirReference,
  AggregatedClinicalData,
  FhirObservation,
  FhirAllergyIntolerance,
  FhirConsent,
  FhirProcedure,
  FhirServiceRequest,
  FhirCondition,
  FhirPatient,
} from './fhirClient.js';
import type { CheckResult } from './prisma.js';

export interface ExportBundleResult {
  bundle: FhirBundle<any>;
  run: ChecklistRunWithAudit;
}

/**
 * Escapes HTML characters for safe XHTML narrative inclusion.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generates an official, USCDI-compliant FHIR R4 Document Bundle (type: "document")
 * for an evaluated Pre-Surgical Safety Gate checklist run.
 */
export async function generatePreSurgicalDocumentBundle(params: {
  runId: string;
  fhirClient?: FhirClient;
  actor?: string;
}): Promise<ExportBundleResult> {
  const run = await getSafetyGateRun(params.runId);

  if (!run) {
    const err: any = new Error(`ChecklistRun with ID "${params.runId}" not found`);
    err.statusCode = 404;
    throw err;
  }

  // Retrieve clinical data via circuit breaker if client is provided, or build placeholder
  let clinicalData: AggregatedClinicalData;
  if (params.fhirClient) {
    clinicalData = await fetchClinicalDataWithCircuitBreaker(params.fhirClient, run.patientId);
  } else {
    clinicalData = {
      patient: {
        resourceType: 'Patient',
        id: run.patientId,
        name: [{ text: `Patient ${run.patientId}` }],
      },
      conditions: [
        {
          resourceType: 'Condition',
          id: `cond-${run.patientId}`,
          code: {
            coding: [
              {
                system: 'http://snomed.info/sct',
                code: run.diagnosisSnomed,
                display: `Surgical Indication (${run.diagnosisSnomed})`,
              },
            ],
          },
        },
      ],
      observations: [],
      allergies: [],
      consents: [],
      procedures: [
        {
          resourceType: 'Procedure',
          id: `proc-${run.patientId}`,
          status: 'completed',
          code: {
            coding: [
              {
                system: 'http://www.ama-assn.org/go/cpt',
                code: run.procedureCpt,
                display: `Procedure (${run.procedureCpt})`,
              },
            ],
          },
        },
      ],
      fetchedAt: Date.now(),
    };
  }

  // Generate UUIDs for all document bundle entries
  const compositionId = randomUUID();
  const compositionUrn = `urn:uuid:${compositionId}`;
  const patientUrn = `urn:uuid:${randomUUID()}`;

  const bundleEntries: Array<{ fullUrl: string; resource: any }> = [];

  // 1. Patient entry
  const patientResource: FhirPatient = clinicalData.patient || {
    resourceType: 'Patient',
    id: run.patientId,
    name: [{ text: `Patient ${run.patientId}` }],
  };
  bundleEntries.push({ fullUrl: patientUrn, resource: patientResource });

  const patientDisplay =
    patientResource.name?.[0]?.text ||
    `${patientResource.name?.[0]?.family || ''}, ${patientResource.name?.[0]?.given?.join(' ') || ''}`.trim() ||
    `Patient ${run.patientId}`;

  // Find override details if present in audit trail
  const overrideEvent = run.auditEvents.find((a) => a.action === 'CLINICAL_OVERRIDE');

  const checks = run.checks as unknown as CheckResult[];

  // --------------------------------------------------------------------------
  // Section 1: Pre-Surgical Safety Gate Clearance (LOINC 81218-0)
  // --------------------------------------------------------------------------
  let safetyNarrative = '<div xmlns="http://www.w3.org/1999/xhtml">';
  safetyNarrative += `<h3>Pre-Surgical Safety Gate Clearance</h3>`;
  safetyNarrative += `<p><strong>Decision:</strong> ${escapeHtml(run.status)}</p>`;
  safetyNarrative += `<p><strong>Evaluated By:</strong> ${escapeHtml(run.createdBy)} on ${escapeHtml(
    run.createdAt.toISOString()
  )}</p>`;

  if (overrideEvent) {
    const detail = (overrideEvent.detail as any) || {};
    safetyNarrative += `<div style="border: 1px solid #d97706; padding: 8px; background-color: #fef3c7;">`;
    safetyNarrative += `<p><strong>[CLINICAL OVERRIDE RECORDED]</strong></p>`;
    safetyNarrative += `<p><strong>Overriding Clinician:</strong> ${escapeHtml(overrideEvent.actor)}</p>`;
    safetyNarrative += `<p><strong>Override Timestamp:</strong> ${escapeHtml(
      overrideEvent.timestamp.toISOString()
    )}</p>`;
    safetyNarrative += `<p><strong>Medical Justification:</strong> ${escapeHtml(
      detail.overrideReason || 'Not specified'
    )}</p>`;
    safetyNarrative += `</div>`;
  }

  safetyNarrative += `<table border="1" cellpadding="4" style="border-collapse: collapse; width: 100%;">`;
  safetyNarrative += `<thead><tr><th>Check</th><th>Status</th><th>Clinical Detail</th></tr></thead><tbody>`;

  for (const check of checks) {
    const statusText = check.passed ? 'PASSED' : 'FAILED';
    safetyNarrative += `<tr>`;
    safetyNarrative += `<td>${escapeHtml(check.name)}</td>`;
    safetyNarrative += `<td>${escapeHtml(statusText)}</td>`;
    safetyNarrative += `<td>${escapeHtml(check.detail)}</td>`;
    safetyNarrative += `</tr>`;
  }
  safetyNarrative += `</tbody></table></div>`;

  const safetySection: FhirCompositionSection = {
    title: 'Pre-Surgical Safety Gate Clearance',
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '81218-0',
          display: 'Preoperative evaluation and management note',
        },
      ],
    },
    text: {
      status: 'generated',
      div: safetyNarrative,
    },
    entry: [{ reference: patientUrn, display: patientDisplay }],
  };

  // --------------------------------------------------------------------------
  // Section 2: Planned Surgical Procedure & Indication (LOINC 81219-8)
  // --------------------------------------------------------------------------
  const procedureUrns: FhirReference[] = [];
  let procedureNarrative = '<div xmlns="http://www.w3.org/1999/xhtml">';
  procedureNarrative += `<h3>Planned Surgical Procedure &amp; Clinical Indication</h3>`;
  procedureNarrative += `<p><strong>Scheduled Procedure (CPT):</strong> ${escapeHtml(
    run.procedureCpt
  )}</p>`;
  procedureNarrative += `<p><strong>Primary Surgical Indication (SNOMED-CT):</strong> ${escapeHtml(
    run.diagnosisSnomed
  )}</p>`;
  procedureNarrative += `</div>`;

  // Add procedures to bundle
  for (const proc of clinicalData.procedures) {
    const pUrn = `urn:uuid:${randomUUID()}`;
    procedureUrns.push({ reference: pUrn, display: `Procedure ${run.procedureCpt}` });
    bundleEntries.push({ fullUrl: pUrn, resource: proc });
  }

  // Add conditions to bundle
  for (const cond of clinicalData.conditions) {
    const cUrn = `urn:uuid:${randomUUID()}`;
    procedureUrns.push({ reference: cUrn, display: `Condition ${run.diagnosisSnomed}` });
    bundleEntries.push({ fullUrl: cUrn, resource: cond });
  }

  const procedureSection: FhirCompositionSection = {
    title: 'Planned Surgical Procedure & Indication',
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '81219-8',
          display: 'Surgical operation note',
        },
      ],
    },
    text: {
      status: 'generated',
      div: procedureNarrative,
    },
    entry: procedureUrns,
  };

  // --------------------------------------------------------------------------
  // Section 3: Informed Surgical Consent (LOINC 59284-0)
  // --------------------------------------------------------------------------
  const consentUrns: FhirReference[] = [];
  let consentNarrative = '<div xmlns="http://www.w3.org/1999/xhtml">';
  consentNarrative += `<h3>Informed Surgical Consent</h3>`;

  if (clinicalData.consents.length > 0) {
    for (const consent of clinicalData.consents) {
      const cUrn = `urn:uuid:${randomUUID()}`;
      consentUrns.push({ reference: cUrn, display: `Consent ${consent.id}` });
      bundleEntries.push({ fullUrl: cUrn, resource: consent });
      consentNarrative += `<p>Consent Status: <strong>${escapeHtml(
        consent.status
      )}</strong>, Signed: ${escapeHtml(consent.dateTime || 'Unknown date')}</p>`;
    }
  } else {
    consentNarrative += `<p>No active electronic surgical consent form retrieved from EHR.</p>`;
  }
  consentNarrative += `</div>`;

  const consentSection: FhirCompositionSection = {
    title: 'Informed Surgical Consent',
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '59284-0',
          display: 'Consent Document',
        },
      ],
    },
    text: {
      status: 'generated',
      div: consentNarrative,
    },
    entry: consentUrns,
  };

  // --------------------------------------------------------------------------
  // Section 4: Pre-Operative Coagulation Labs (LOINC 30954-2)
  // --------------------------------------------------------------------------
  const labUrns: FhirReference[] = [];
  let labsNarrative = '<div xmlns="http://www.w3.org/1999/xhtml">';
  labsNarrative += `<h3>Pre-Operative Coagulation Laboratories</h3>`;

  if (clinicalData.observations.length > 0) {
    labsNarrative += `<table border="1" cellpadding="4" style="border-collapse: collapse; width: 100%;">`;
    labsNarrative += `<thead><tr><th>Test</th><th>LOINC</th><th>Value</th><th>Units</th><th>Date</th></tr></thead><tbody>`;

    for (const obs of clinicalData.observations) {
      const lUrn = `urn:uuid:${randomUUID()}`;
      labUrns.push({ reference: lUrn, display: obs.code.text || 'Coagulation Lab' });
      bundleEntries.push({ fullUrl: lUrn, resource: obs });

      const coding = obs.code.coding?.[0];
      const loincCode = coding?.code || 'N/A';
      const testName = obs.code.text || coding?.display || 'Laboratory Test';
      const val = obs.valueQuantity?.value ?? obs.valueString ?? 'N/A';
      const unit = obs.valueQuantity?.unit ?? '';
      const date = obs.effectiveDateTime || obs.issued || 'N/A';

      labsNarrative += `<tr>`;
      labsNarrative += `<td>${escapeHtml(testName)}</td>`;
      labsNarrative += `<td>${escapeHtml(loincCode)}</td>`;
      labsNarrative += `<td>${escapeHtml(String(val))}</td>`;
      labsNarrative += `<td>${escapeHtml(unit)}</td>`;
      labsNarrative += `<td>${escapeHtml(date)}</td>`;
      labsNarrative += `</tr>`;
    }
    labsNarrative += `</tbody></table>`;
  } else {
    labsNarrative += `<p>No laboratory observations retrieved from EHR.</p>`;
  }
  labsNarrative += `</div>`;

  const labsSection: FhirCompositionSection = {
    title: 'Pre-Operative Coagulation Laboratories',
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '30954-2',
          display: 'Relevant diagnostic tests/laboratory data',
        },
      ],
    },
    text: {
      status: 'generated',
      div: labsNarrative,
    },
    entry: labUrns,
  };

  // --------------------------------------------------------------------------
  // Section 5: Antibiotic Prophylaxis & Drug Allergies (LOINC 48765-2)
  // --------------------------------------------------------------------------
  const allergyUrns: FhirReference[] = [];
  let allergyNarrative = '<div xmlns="http://www.w3.org/1999/xhtml">';
  allergyNarrative += `<h3>Antibiotic Prophylaxis &amp; Drug Allergies</h3>`;

  if (clinicalData.allergies.length > 0) {
    allergyNarrative += `<ul>`;
    for (const allergy of clinicalData.allergies) {
      const aUrn = `urn:uuid:${randomUUID()}`;
      allergyUrns.push({ reference: aUrn, display: allergy.code?.text || 'Allergy' });
      bundleEntries.push({ fullUrl: aUrn, resource: allergy });

      const allergyText = allergy.code?.text || allergy.code?.coding?.[0]?.display || 'Unknown allergen';
      const criticality = allergy.criticality || 'unspecified';
      allergyNarrative += `<li>Substance: <strong>${escapeHtml(
        allergyText
      )}</strong> (Criticality: ${escapeHtml(criticality)})</li>`;
    }
    allergyNarrative += `</ul>`;
  } else {
    allergyNarrative += `<p>No active documented drug allergies in EHR records.</p>`;
  }
  allergyNarrative += `</div>`;

  const allergySection: FhirCompositionSection = {
    title: 'Antibiotic Prophylaxis & Drug Allergies',
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '48765-2',
          display: 'Allergies and adverse reactions',
        },
      ],
    },
    text: {
      status: 'generated',
      div: allergyNarrative,
    },
    entry: allergyUrns,
  };

  // --------------------------------------------------------------------------
  // Root Composition Resource
  // --------------------------------------------------------------------------
  const composition: FhirComposition = {
    resourceType: 'Composition',
    id: compositionId,
    status: 'final',
    type: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '81218-0',
          display: 'Preoperative evaluation and management note',
        },
      ],
      text: 'Preoperative evaluation and management note',
    },
    category: [
      {
        coding: [
          {
            system: 'http://loinc.org',
            code: '11504-8',
            display: 'Surgical operation note',
          },
        ],
      },
    ],
    subject: {
      reference: patientUrn,
      display: patientDisplay,
    },
    date: run.createdAt.toISOString(),
    author: [
      {
        display: run.createdBy || 'Practitioner/unspecified',
      },
    ],
    title: 'Pre-Surgical Safety Gate Clearance Summary',
    section: [safetySection, procedureSection, consentSection, labsSection, allergySection],
  };

  // Build Document Bundle (entry[0] MUST be the Composition)
  const bundle: FhirBundle<any> = {
    resourceType: 'Bundle',
    type: 'document',
    total: bundleEntries.length + 1,
    entry: [
      {
        fullUrl: compositionUrn,
        resource: composition,
      },
      ...bundleEntries,
    ],
  };

  return { bundle, run };
}

/**
 * Generates clean, printable HTML clinical summary for surgeon review or paper chart export.
 */
export function generatePreSurgicalSummaryHtml(bundleResult: ExportBundleResult): string {
  const { bundle, run } = bundleResult;
  const composition = bundle.entry?.[0]?.resource as FhirComposition;
  const overrideEvent = run.auditEvents.find((a: any) => a.action === 'CLINICAL_OVERRIDE');

  let badgeColor = '#10b981'; // green for PASS
  let badgeText = 'CLEARED FOR SURGERY';
  if (run.status === 'BLOCK') {
    badgeColor = '#ef4444'; // red for BLOCK
    badgeText = 'SURGICAL BLOCK: CONTRAINDICATION DETECTED';
  } else if (run.status === 'MANUAL_REVIEW') {
    badgeColor = '#f59e0b'; // amber for MANUAL_REVIEW
    badgeText = 'MANUAL REVIEW REQUIRED';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Pre-Surgical Safety Gate Clearance Summary - ${escapeHtml(run.patientId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.5; color: #1e293b; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    header { border-bottom: 2px solid #cbd5e1; padding-bottom: 1rem; margin-bottom: 1.5rem; }
    .badge { display: inline-block; padding: 0.5rem 1rem; border-radius: 4px; color: #ffffff; font-weight: bold; font-size: 1.1rem; }
    .meta-box { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; background-color: #f8fafc; padding: 1rem; border-radius: 6px; margin-bottom: 1.5rem; border: 1px solid #e2e8f0; }
    .section-card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { border: 1px solid #cbd5e1; padding: 0.5rem; text-align: left; }
    th { background-color: #f1f5f9; }
    .override-box { background-color: #fffbeb; border: 1px solid #fcd34d; padding: 1rem; border-radius: 6px; margin: 1rem 0; }
    @media print { body { max-width: 100%; margin: 0; } .no-print { display: none; } }
  </style>
</head>
<body>
  <header>
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h2>${escapeHtml(composition?.title || 'Pre-Surgical Safety Gate Summary')}</h2>
      <button class="no-print" onclick="window.print()" style="padding: 0.5rem 1rem; cursor: pointer; border-radius: 4px; border: 1px solid #94a3b8; background-color: #f8fafc;">Print Document</button>
    </div>
    <div style="margin-top: 0.5rem;">
      <span class="badge" style="background-color: ${badgeColor};">${escapeHtml(badgeText)}</span>
    </div>
  </header>

  <div class="meta-box">
    <div><strong>Patient ID:</strong> ${escapeHtml(run.patientId)}</div>
    <div><strong>Procedure (CPT):</strong> ${escapeHtml(run.procedureCpt)}</div>
    <div><strong>Diagnosis (SNOMED):</strong> ${escapeHtml(run.diagnosisSnomed)}</div>
    <div><strong>Run ID:</strong> ${escapeHtml(run.id)}</div>
    <div><strong>Evaluated:</strong> ${escapeHtml(run.createdAt.toISOString())}</div>
    <div><strong>Clinician Actor:</strong> ${escapeHtml(run.createdBy)}</div>
  </div>

  ${
    overrideEvent
      ? `<div class="override-box">
          <h4 style="margin-top: 0; color: #b45309;">Clinical Override Recorded</h4>
          <p><strong>Overriding Clinician:</strong> ${escapeHtml(overrideEvent.actor)}</p>
          <p><strong>Override Timestamp:</strong> ${escapeHtml(overrideEvent.timestamp.toISOString())}</p>
          <p><strong>Clinical Reason:</strong> ${escapeHtml(
            (overrideEvent.detail as any)?.overrideReason || 'None recorded'
          )}</p>
        </div>`
      : ''
  }

  ${(composition?.section || [])
    .map(
      (sec) => `
    <div class="section-card">
      <h3 style="margin-top: 0; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.5rem;">${escapeHtml(
        sec.title
      )}</h3>
      ${sec.text?.div || '<p>No narrative text provided.</p>'}
    </div>
  `
    )
    .join('')}

  <footer style="margin-top: 2rem; border-top: 1px solid #cbd5e1; padding-top: 1rem; font-size: 0.85rem; color: #64748b;">
    <p>Generated by Pre-Surgical Safety Gate (FHIR R4 USCDI Export Engine). Immutable Audit Event ID: ${escapeHtml(
      run.auditEvents[0]?.id || 'N/A'
    )}</p>
  </footer>
</body>
</html>`;
}

/**
 * Generates an HL7 CDA XML Document (Legacy format) representing the Pre-Surgical Summary.
 * Follows basic C-CDA structure as referenced by the HL7 CDA Core Repository.
 */
export function generatePreSurgicalCdaXml(bundleResult: ExportBundleResult): string {
  const { run, bundle } = bundleResult;
  const date = new Date(run.createdAt).toISOString().replace(/[-:T\.]/g, '').substring(0, 14);

  const patientEntry = bundle?.entry?.find((e: any) => e.resource?.resourceType === 'Patient');
  const patientRes = patientEntry?.resource;
  const patientFamily = patientRes?.name?.[0]?.family || run.patientId;
  const patientGiven = patientRes?.name?.[0]?.given?.[0] || 'Patient';

  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:hl7-org:v3 CDA.xsd">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5.99999.1" extension="${run.id}"/>
  <code code="81218-0" displayName="Surgical operation note" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Pre-Surgical Safety Gate Summary</title>
  <effectiveTime value="${date}"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.4.1" extension="${escapeHtml(run.patientId)}"/>
      <patient>
        <name>
          <given>${escapeHtml(patientGiven)}</given>
          <family>${escapeHtml(patientFamily)}</family>
        </name>
      </patient>
    </patientRole>
  </recordTarget>
  <author>
    <time value="${date}"/>
    <assignedAuthor>
      <id root="2.16.840.1.113883.4.6" extension="System"/>
      <assignedPerson>
        <name>
          <family>Safety Gate App</family>
        </name>
      </assignedPerson>
    </assignedAuthor>
  </author>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.14"/>
          <code code="10219-4" codeSystem="2.16.840.1.113883.6.1" displayName="Surgical operation note preoperative diagnosis"/>
          <title>Safety Gate Status</title>
          <text>
            <list>
              <item>Status: ${run.status}</item>
              <item>Procedure CPT: ${run.procedureCpt}</item>
              <item>Diagnosis SNOMED: ${run.diagnosisSnomed}</item>
            </list>
          </text>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;
}
