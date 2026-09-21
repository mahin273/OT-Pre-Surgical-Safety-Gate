import type { FhirObservation } from '../fhirClient.js';
import type { CheckResult } from '../prisma.js';

export interface LabSafetyConfig {
  platelets: { loinc: string; minSafe: number };
  inr: { loinc: string; maxSafe: number };
  pt: { loinc: string; maxSafe: number };
  maxResultAgeHours: number;
}

export const DEFAULT_LAB_CONFIG: LabSafetyConfig = {
  platelets: { loinc: '777-3', minSafe: 50 },
  inr: { loinc: '6301-6', maxSafe: 1.5 },
  pt: { loinc: '5902-2', maxSafe: 14.0 },
  maxResultAgeHours: 24,
};

interface ExtractedLab {
  loinc: string;
  name: string;
  value: number;
  unit: string;
  ageHours: number;
}

function findObservationByLoinc(
  observations: FhirObservation[],
  targetLoinc: string
): FhirObservation | undefined {
  const matches = observations.filter((obs) => {
    const codings = obs.code?.coding || [];
    return codings.some(
      (c) => c.code === targetLoinc || (c.system?.includes('loinc.org') && c.code === targetLoinc)
    );
  });

  if (matches.length === 0) {
    return undefined;
  }

  // Sort descending by effective date / issued date so latest lab is evaluated
  matches.sort((a, b) => {
    const timeA = Date.parse(a.effectiveDateTime || a.issued || '') || 0;
    const timeB = Date.parse(b.effectiveDateTime || b.issued || '') || 0;
    return timeB - timeA;
  });

  return matches[0];
}

function getObservationAgeHours(obs: FhirObservation, now: number): number {
  const dateStr = obs.effectiveDateTime || obs.issued;
  if (!dateStr) {
    return Number.POSITIVE_INFINITY;
  }
  const timestamp = Date.parse(dateStr);
  if (isNaN(timestamp)) {
    return Number.POSITIVE_INFINITY;
  }
  const diffMs = Math.max(0, now - timestamp);
  return diffMs / (1000 * 60 * 60);
}

/**
 * Validates pre-operative coagulation panel results (Platelets, INR, PT)
 * against safety thresholds and recency windows.
 */
export function evaluateLabs(
  observations: FhirObservation[],
  config: LabSafetyConfig = DEFAULT_LAB_CONFIG,
  currentTime: number = Date.now()
): CheckResult {
  const missingLabs: string[] = [];

  // 1. Platelets
  const pltObs = findObservationByLoinc(observations, config.platelets.loinc);
  const inrObs = findObservationByLoinc(observations, config.inr.loinc);
  const ptObs = findObservationByLoinc(observations, config.pt.loinc);

  if (!pltObs) missingLabs.push('Platelets (LOINC 777-3)');
  if (!inrObs) missingLabs.push('INR (LOINC 6301-6)');
  if (!ptObs) missingLabs.push('PT (LOINC 5902-2)');

  if (missingLabs.length > 0) {
    return {
      name: 'labs',
      passed: false,
      detail: `Missing required pre-op lab tests: ${missingLabs.join(', ')}`,
    };
  }

  const pltVal = pltObs?.valueQuantity?.value;
  const inrVal = inrObs?.valueQuantity?.value;
  const ptVal = ptObs?.valueQuantity?.value;

  if (pltVal === undefined || inrVal === undefined || ptVal === undefined) {
    return {
      name: 'labs',
      passed: false,
      detail: 'Lab observations missing numerical valueQuantity readings',
    };
  }

  // 2. Check Recency (< maxResultAgeHours)
  const pltAge = getObservationAgeHours(pltObs!, currentTime);
  const inrAge = getObservationAgeHours(inrObs!, currentTime);
  const ptAge = getObservationAgeHours(ptObs!, currentTime);

  const staleLabs: string[] = [];
  if (pltAge > config.maxResultAgeHours) {
    staleLabs.push(`Platelets (${Math.round(pltAge)}h old)`);
  }
  if (inrAge > config.maxResultAgeHours) {
    staleLabs.push(`INR (${Math.round(inrAge)}h old)`);
  }
  if (ptAge > config.maxResultAgeHours) {
    staleLabs.push(`PT (${Math.round(ptAge)}h old)`);
  }

  if (staleLabs.length > 0) {
    return {
      name: 'labs',
      passed: false,
      detail: `Lab results exceed 24-hour recency window: ${staleLabs.join(', ')}`,
    };
  }

  // 3. Threshold Checks
  const failureDetails: string[] = [];

  // Platelets >= 50
  if (pltVal < config.platelets.minSafe) {
    failureDetails.push(
      `Critical low platelets: ${pltVal} ${pltObs?.valueQuantity?.unit || '10*3/uL'} (minimum safe: ${config.platelets.minSafe})`
    );
  }

  // INR <= 1.5
  if (inrVal > config.inr.maxSafe) {
    failureDetails.push(
      `Critical elevated INR: ${inrVal} (maximum safe: ${config.inr.maxSafe})`
    );
  }

  // PT <= 14.0
  if (ptVal > config.pt.maxSafe) {
    failureDetails.push(
      `Critical prolonged PT: ${ptVal}s (maximum safe: ${config.pt.maxSafe}s)`
    );
  }

  if (failureDetails.length > 0) {
    return {
      name: 'labs',
      passed: false,
      detail: failureDetails.join('; '),
    };
  }

  return {
    name: 'labs',
    passed: true,
    detail: `Coagulation panel within safe limits: Platelets: ${pltVal}, INR: ${inrVal}, PT: ${ptVal}s`,
  };
}
