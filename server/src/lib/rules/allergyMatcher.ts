import type { FhirAllergyIntolerance } from '../fhirClient.js';
import type { CheckResult } from '../prisma.js';

export interface PlannedMedication {
  rxNormCode: string;
  name: string;
  drugClass: string;
}

export const DEFAULT_PLANNED_ANTIBIOTIC: PlannedMedication = {
  rxNormCode: '2231',
  name: 'Cefazolin',
  drugClass: 'First-generation cephalosporin',
};

// Known cross-reactivity and conflict codes for Cefazolin
const CONFLICT_CODES = {
  // Direct Cefazolin
  CEFAZOLIN_RXNORM: '2231',
  // Cephalosporin class allergy (SNOMED)
  CEPHALOSPORIN_SNOMED: '293586001',
  // Penicillin class (RxNorm and SNOMED)
  PENICILLIN_RXNORM: '70618',
  PENICILLIN_SNOMED: '91936005',
};

/**
 * Checks for drug allergy conflicts between documented patient allergies
 * and the planned perioperative prophylactic antibiotic (e.g. Cefazolin).
 */
export function evaluateAllergies(
  allergies: FhirAllergyIntolerance[],
  plannedMed: PlannedMedication = DEFAULT_PLANNED_ANTIBIOTIC
): CheckResult {
  if (!allergies || allergies.length === 0) {
    return {
      name: 'allergy',
      passed: true,
      detail: `No documented drug allergies; safe to administer planned ${plannedMed.name} prophylaxis`,
    };
  }

  for (const allergy of allergies) {
    const vCode = allergy.verificationStatus?.coding?.[0]?.code?.toLowerCase() ||
      allergy.verificationStatus?.text?.toLowerCase();
    if (vCode === 'refuted' || vCode === 'entered-in-error') {
      continue;
    }

    const cCode = allergy.clinicalStatus?.coding?.[0]?.code?.toLowerCase() ||
      allergy.clinicalStatus?.text?.toLowerCase();
    if (cCode === 'inactive' || cCode === 'resolved') {
      continue;
    }

    const codings = allergy.code?.coding || [];
    const allergyText = (allergy.code?.text || '').toLowerCase();
    const criticality = allergy.criticality;

    // Check 1: Direct Cefazolin allergy
    const isDirectCefazolin =
      codings.some((c) => c.code === CONFLICT_CODES.CEFAZOLIN_RXNORM) ||
      allergyText.includes('cefazolin');

    if (isDirectCefazolin) {
      return {
        name: 'allergy',
        passed: false,
        detail: `Direct allergy conflict: Patient has documented allergy to planned antibiotic ${plannedMed.name}`,
      };
    }

    // Check 2: Cephalosporin class allergy
    const isCephalosporinClass =
      codings.some((c) => c.code === CONFLICT_CODES.CEPHALOSPORIN_SNOMED) ||
      allergyText.includes('cephalosporin');

    if (isCephalosporinClass) {
      return {
        name: 'allergy',
        passed: false,
        detail: `Drug class allergy conflict: Patient has documented allergy to Cephalosporins (contraindicates ${plannedMed.name})`,
      };
    }

    // Check 3: Severe Penicillin anaphylaxis (cross-reactivity hazard)
    const isPenicillin =
      codings.some(
        (c) =>
          c.code === CONFLICT_CODES.PENICILLIN_RXNORM ||
          c.code === CONFLICT_CODES.PENICILLIN_SNOMED
      ) || allergyText.includes('penicillin');

    if (isPenicillin) {
      const isSevere =
        criticality === 'high' ||
        allergyText.includes('anaphylaxis') ||
        allergyText.includes('severe');

      if (isSevere) {
        return {
          name: 'allergy',
          passed: false,
          detail: `Severe beta-lactam cross-reactivity alert: Documented high-criticality Penicillin allergy contraindicates ${plannedMed.name}`,
        };
      }
    }
  }

  return {
    name: 'allergy',
    passed: true,
    detail: `Allergy screen clear: No conflicts detected with planned ${plannedMed.name} prophylaxis`,
  };
}
