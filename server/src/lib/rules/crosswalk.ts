import type { FhirCondition, FhirProcedure, FhirServiceRequest } from '../fhirClient.js';
import type { CheckResult } from '../prisma.js';

export interface CrosswalkEntry {
  cptCode: string;
  cptDisplay: string;
  snomedCodes: string[];
  snomedDisplays: string[];
}

/**
 * Curated clinical crosswalk mapping scheduled surgical procedures (CPT)
 * to recognized surgical indications and diagnoses (SNOMED CT).
 */
export const CURATED_CROSSWALK: Record<string, CrosswalkEntry> = {
  // Laparoscopic cholecystectomy
  '47562': {
    cptCode: '47562',
    cptDisplay: 'Laparoscopic cholecystectomy',
    snomedCodes: ['235919008', '282711000119106'],
    snomedDisplays: [
      'Acute cholecystitis',
      'Calculus of gallbladder with acute cholecystitis',
    ],
  },
  // Laparoscopic appendectomy
  '44970': {
    cptCode: '44970',
    cptDisplay: 'Laparoscopic appendectomy',
    snomedCodes: ['47693006'],
    snomedDisplays: ['Acute appendicitis'],
  },
  // Open appendectomy
  '44950': {
    cptCode: '44950',
    cptDisplay: 'Appendectomy',
    snomedCodes: ['47693006'],
    snomedDisplays: ['Acute appendicitis'],
  },
  // Total knee arthroplasty
  '27447': {
    cptCode: '27447',
    cptDisplay: 'Total knee arthroplasty',
    snomedCodes: ['239873007'],
    snomedDisplays: ['Primary osteoarthritis of knee'],
  },
  // Inguinal hernia repair
  '49505': {
    cptCode: '49505',
    cptDisplay: 'Inguinal hernia repair',
    snomedCodes: ['396232000'],
    snomedDisplays: ['Inguinal hernia'],
  },
};

/**
 * Validates whether the patient's documented diagnoses match the scheduled surgical procedure.
 */
export function evaluateDiagnosisProcedureMatch(
  conditions: FhirCondition[],
  procedures: (FhirProcedure | FhirServiceRequest)[]
): CheckResult {
  // 1. Extract all CPT codes from scheduled procedures
  const procedureCodes: Array<{ code: string; display?: string }> = [];
  for (const proc of procedures) {
    const codings = proc.code?.coding || [];
    for (const coding of codings) {
      if (coding.code) {
        procedureCodes.push({
          code: coding.code,
          display: coding.display || proc.code?.text,
        });
      }
    }
  }

  if (procedureCodes.length === 0) {
    return {
      name: 'diagnosis_procedure_match',
      passed: false,
      detail: 'No scheduled surgical procedure found in clinical records',
    };
  }

  // 2. Extract all SNOMED codes from active conditions
  const diagnosisCodes: Array<{ code: string; display?: string }> = [];
  for (const condition of conditions) {
    const codings = condition.code?.coding || [];
    for (const coding of codings) {
      if (coding.code) {
        diagnosisCodes.push({
          code: coding.code,
          display: coding.display || condition.code?.text,
        });
      }
    }
  }

  if (diagnosisCodes.length === 0) {
    return {
      name: 'diagnosis_procedure_match',
      passed: false,
      detail: 'No active clinical diagnoses found in patient record',
    };
  }

  // 3. Evaluate crosswalk mapping
  for (const proc of procedureCodes) {
    const mapping = CURATED_CROSSWALK[proc.code];
    if (!mapping) {
      continue;
    }

    for (const diag of diagnosisCodes) {
      if (mapping.snomedCodes.includes(diag.code)) {
        const diagDisplay = diag.display || diag.code;
        const procDisplay = mapping.cptDisplay || proc.code;
        return {
          name: 'diagnosis_procedure_match',
          passed: true,
          detail: `Diagnosis ${diagDisplay} (SNOMED ${diag.code}) matches scheduled procedure ${procDisplay} (CPT ${proc.code})`,
        };
      }
    }
  }

  // If no mapped match found, flag for manual clinical review
  const firstProc = procedureCodes[0].code;
  const firstDiag = diagnosisCodes[0].code;
  return {
    name: 'diagnosis_procedure_match',
    passed: false,
    detail: `Unmapped combination: Procedure CPT ${firstProc} does not match documented diagnosis SNOMED ${firstDiag}`,
  };
}
