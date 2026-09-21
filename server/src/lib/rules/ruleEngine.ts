import type { AggregatedClinicalData } from '../fhirClient.js';
import { prisma, type CheckResult } from '../prisma.js';
import { evaluateDiagnosisProcedureMatch } from './crosswalk.js';
import { evaluateConsent } from './consentMatcher.js';
import { evaluateLabs, DEFAULT_LAB_CONFIG, type LabSafetyConfig } from './labThresholds.js';
import { evaluateAllergies, DEFAULT_PLANNED_ANTIBIOTIC, type PlannedMedication } from './allergyMatcher.js';

export interface RuleEngineOptions {
  plannedAntibiotic?: PlannedMedication;
  labConfig?: LabSafetyConfig;
  currentTime?: number;
  persistTerminologyCache?: boolean;
}

export interface RuleEvaluationResult {
  checks: CheckResult[];
  allPassed: boolean;
  evaluatedAt: number;
}

/**
 * Orchestrates all 4 pre-surgical safety rules:
 * 1. Diagnosis ↔ Procedure Crosswalk (SNOMED to CPT)
 * 2. Informed Consent Verification
 * 3. Pre-Op Coagulation Labs (LOINC Platelets, INR, PT)
 * 4. Perioperative Antibiotic Allergy Screening (RxNorm Cefazolin)
 */
export async function evaluateClinicalRules(
  data: AggregatedClinicalData,
  options: RuleEngineOptions = {}
): Promise<RuleEvaluationResult> {
  const labConfig = options.labConfig || DEFAULT_LAB_CONFIG;
  const plannedAntibiotic = options.plannedAntibiotic || DEFAULT_PLANNED_ANTIBIOTIC;
  const currentTime = options.currentTime || Date.now();
  const shouldPersist = options.persistTerminologyCache !== false;

  // Run all 4 deterministic safety checks
  const check1 = evaluateDiagnosisProcedureMatch(data.conditions, data.procedures);
  const check2 = evaluateConsent(data.consents);
  const check3 = evaluateLabs(data.observations, labConfig, currentTime);
  const check4 = evaluateAllergies(data.allergies, plannedAntibiotic);

  const checks: CheckResult[] = [check1, check2, check3, check4];
  const allPassed = checks.every((c) => c.passed);

  // Cache encountered SNOMED and CPT clinical terms into TerminologyCache
  if (shouldPersist) {
    try {
      // 1. Cache Condition SNOMED codes
      for (const cond of data.conditions) {
        for (const coding of cond.code?.coding || []) {
          if (coding.system?.includes('snomed.info/sct') && coding.code) {
            await prisma.terminologyCache.upsert({
              where: {
                codeSystem_code: {
                  codeSystem: 'http://snomed.info/sct',
                  code: coding.code,
                },
              },
              create: {
                codeSystem: 'http://snomed.info/sct',
                code: coding.code,
                display: coding.display || cond.code?.text || 'Clinical Condition',
              },
              update: {
                cachedAt: new Date(),
              },
            });
          }
        }
      }

      // 2. Cache Procedure CPT codes
      for (const proc of data.procedures) {
        for (const coding of proc.code?.coding || []) {
          if (coding.code && (coding.system?.includes('cpt') || !coding.system)) {
            await prisma.terminologyCache.upsert({
              where: {
                codeSystem_code: {
                  codeSystem: 'http://www.ama-assn.org/go/cpt',
                  code: coding.code,
                },
              },
              create: {
                codeSystem: 'http://www.ama-assn.org/go/cpt',
                code: coding.code,
                display: coding.display || proc.code?.text || 'Surgical Procedure',
              },
              update: {
                cachedAt: new Date(),
              },
            });
          }
        }
      }
    } catch (err: any) {
      // Cache failure should not block clinical evaluation
      console.warn('[WARN] Failed to upsert into TerminologyCache:', err.message);
    }
  }

  return {
    checks,
    allPassed,
    evaluatedAt: Date.now(),
  };
}
