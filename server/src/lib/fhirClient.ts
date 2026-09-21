export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
  version?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirIdentifier {
  system?: string;
  value?: string;
  type?: FhirCodeableConcept;
}

export interface FhirReference {
  reference?: string;
  display?: string;
  type?: string;
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirQuantity {
  value?: number;
  comparator?: string;
  unit?: string;
  system?: string;
  code?: string;
}

export interface FhirPatient {
  resourceType: 'Patient';
  id: string;
  identifier?: FhirIdentifier[];
  name?: Array<{
    use?: string;
    family?: string;
    given?: string[];
    text?: string;
  }>;
  gender?: 'male' | 'female' | 'other' | 'unknown';
  birthDate?: string;
  telecom?: any[];
  address?: any[];
}

export interface FhirCondition {
  resourceType: 'Condition';
  id: string;
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  severity?: FhirCodeableConcept;
  code?: FhirCodeableConcept;
  subject?: FhirReference;
  recordedDate?: string;
  onsetDateTime?: string;
}

export interface FhirObservation {
  resourceType: 'Observation';
  id: string;
  status: string;
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  valueQuantity?: FhirQuantity;
  valueString?: string;
  referenceRange?: Array<{
    low?: FhirQuantity;
    high?: FhirQuantity;
    text?: string;
  }>;
}

export interface FhirAllergyIntolerance {
  resourceType: 'AllergyIntolerance';
  id: string;
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  type?: 'allergy' | 'intolerance';
  category?: string[];
  criticality?: 'low' | 'high' | 'unable-to-assess';
  code?: FhirCodeableConcept;
  patient?: FhirReference;
  recordedDate?: string;
}

export interface FhirConsent {
  resourceType: 'Consent';
  id: string;
  status: 'draft' | 'proposed' | 'active' | 'rejected' | 'inactive' | 'entered-in-error';
  scope?: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  patient?: FhirReference;
  dateTime?: string;
  provision?: any;
}

export interface FhirServiceRequest {
  resourceType: 'ServiceRequest';
  id: string;
  status: string;
  intent: string;
  code?: FhirCodeableConcept;
  subject?: FhirReference;
  authoredOn?: string;
  occurrenceDateTime?: string;
}

export interface FhirProcedure {
  resourceType: 'Procedure';
  id: string;
  status: string;
  code?: FhirCodeableConcept;
  subject?: FhirReference;
  performedDateTime?: string;
  performedPeriod?: FhirPeriod;
}

export interface FhirNarrative {
  status: 'generated' | 'extensions' | 'additional' | 'empty';
  div: string;
}

export interface FhirCompositionSection {
  title: string;
  code?: FhirCodeableConcept;
  text?: FhirNarrative;
  mode?: string;
  entry?: FhirReference[];
  section?: FhirCompositionSection[];
}

export interface FhirComposition {
  resourceType: 'Composition';
  id: string;
  status: 'preliminary' | 'final' | 'amended' | 'entered-in-error';
  type: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  subject: FhirReference;
  date: string;
  author: FhirReference[];
  title: string;
  section: FhirCompositionSection[];
}

export interface FhirBundle<T> {
  resourceType: 'Bundle';
  type?: string;
  total?: number;
  entry?: Array<{
    fullUrl?: string;
    resource?: T;
  }>;
}

export interface AggregatedClinicalData {
  patient: FhirPatient | null;
  conditions: FhirCondition[];
  observations: FhirObservation[];
  allergies: FhirAllergyIntolerance[];
  consents: FhirConsent[];
  procedures: (FhirServiceRequest | FhirProcedure)[];
  fetchedAt: number;
  degraded?: boolean;
  degradedReason?: string;
}

/**
 * Robust FHIR R4 client that interfaces with hospital EHR systems.
 * Provides Bearer token injection, bundle unwrapping, request timeouts,
 * and fault-tolerant parallel clinical data querying via Promise.allSettled.
 */
export class FhirClient {
  private baseUrl: string;
  private accessToken: string;
  private timeoutMs: number;

  constructor(baseUrl: string, accessToken: string, timeoutMs: number = 10000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Fetches resources from a FHIR query path. If the EHR returns a searchset Bundle,
   * unwraps the entries and returns an array of resource objects.
   * If 404 is encountered, returns an empty array to allow partial clinical evaluation.
   */
  async getResource<T>(pathAndQuery: string): Promise<T[]> {
    const cleanPath = pathAndQuery.replace(/^\/+/, '');
    const url = `${this.baseUrl}/${cleanPath}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/fhir+json, application/json',
        },
        signal: controller.signal,
      });

      if (res.status === 404) {
        return [];
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(
          `FHIR request to ${cleanPath} failed with status ${res.status}: ${errText}`
        );
      }

      const json = (await res.json()) as any;

      if (json && json.resourceType === 'Bundle') {
        const entries = json.entry || [];
        return entries
          .map((e: any) => e.resource)
          .filter((r: any) => r && typeof r === 'object') as T[];
      }

      if (json && typeof json === 'object') {
        return [json as T];
      }

      return [];
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`FHIR request to ${cleanPath} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetches a single resource instance by relative path (e.g. "Patient/123").
   */
  async getSingleResource<T>(path: string): Promise<T | null> {
    const results = await this.getResource<T>(path);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Concurrently queries all 6 clinical resource categories needed for the Pre-Surgical Safety Gate:
   * Patient, Condition, Observation, AllergyIntolerance, Consent, and Procedure/ServiceRequest.
   * Uses Promise.allSettled to ensure that failure in one non-critical endpoint (e.g. Consent)
   * does not abort the entire safety gate evaluation.
   */
  async fetchAllClinicalData(rawPatientId: string): Promise<AggregatedClinicalData> {
    const cleanId = rawPatientId.replace(/^Patient\//i, '').trim();

    const [
      patientResult,
      conditionsResult,
      observationsResult,
      allergiesResult,
      consentsResult,
      proceduresResult,
      serviceRequestsResult,
    ] = await Promise.allSettled([
      this.getSingleResource<FhirPatient>(`Patient/${cleanId}`),
      this.getResource<FhirCondition>(`Condition?patient=${cleanId}&clinical-status=active`),
      this.getResource<FhirObservation>(`Observation?patient=${cleanId}&category=laboratory`),
      this.getResource<FhirAllergyIntolerance>(`AllergyIntolerance?patient=${cleanId}&clinical-status=active`),
      this.getResource<FhirConsent>(`Consent?patient=${cleanId}`),
      this.getResource<FhirProcedure>(`Procedure?patient=${cleanId}`),
      this.getResource<FhirServiceRequest>(`ServiceRequest?patient=${cleanId}&status=active`),
    ]);

    const patient = patientResult.status === 'fulfilled' ? patientResult.value : null;
    const conditions = conditionsResult.status === 'fulfilled' ? conditionsResult.value : [];
    const observations = observationsResult.status === 'fulfilled' ? observationsResult.value : [];
    const allergies = allergiesResult.status === 'fulfilled' ? allergiesResult.value : [];
    const consents = consentsResult.status === 'fulfilled' ? consentsResult.value : [];

    const procedures: (FhirProcedure | FhirServiceRequest)[] = [];
    if (proceduresResult.status === 'fulfilled') {
      procedures.push(...proceduresResult.value);
    }
    if (serviceRequestsResult.status === 'fulfilled') {
      procedures.push(...serviceRequestsResult.value);
    }

    const checks = [
      { name: 'Patient', res: patientResult },
      { name: 'Condition', res: conditionsResult },
      { name: 'Observation', res: observationsResult },
      { name: 'AllergyIntolerance', res: allergiesResult },
      { name: 'Consent', res: consentsResult },
      { name: 'Procedure', res: proceduresResult },
      { name: 'ServiceRequest', res: serviceRequestsResult },
    ];

    for (const check of checks) {
      if (check.res.status === 'rejected') {
        console.warn(
          `[WARN] Failed to fetch ${check.name} for patient ${cleanId}:`,
          check.res.reason?.message || check.res.reason
        );
      }
    }

    if (patientResult.status === 'rejected') {
      throw new Error(
        `Failed to reach FHIR EHR for patient ${cleanId}: ${patientResult.reason?.message || 'EHR connection failed'}`
      );
    }

    return {
      patient,
      conditions,
      observations,
      allergies,
      consents,
      procedures,
      fetchedAt: Date.now(),
    };
  }
}
