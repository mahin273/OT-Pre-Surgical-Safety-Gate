import type { FhirConsent } from '../fhirClient.js';
import type { CheckResult } from '../prisma.js';

/**
 * Validates that an active signed informed consent is on file for the surgical procedure.
 */
export function evaluateConsent(consents: FhirConsent[]): CheckResult {
  if (!consents || consents.length === 0) {
    return {
      name: 'consent',
      passed: false,
      detail: 'No informed surgical consent record found on file',
    };
  }

  const activeConsent = consents.find((c) => c.status === 'active');

  if (activeConsent) {
    const consentDate = activeConsent.dateTime
      ? ` dated ${new Date(activeConsent.dateTime).toLocaleDateString()}`
      : '';
    return {
      name: 'consent',
      passed: true,
      detail: `Active informed surgical consent verified${consentDate}`,
    };
  }

  const firstConsent = consents[0];
  return {
    name: 'consent',
    passed: false,
    detail: `Consent form found but status is ${firstConsent.status} (active status required)`,
  };
}
