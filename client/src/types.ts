export type GateStatus = 'PASS' | 'BLOCK' | 'MANUAL_REVIEW';

export type CheckName =
  | 'diagnosis_procedure_match'
  | 'consent'
  | 'labs'
  | 'allergy'
  | 'ehr_availability';

export interface CheckResult {
  name: CheckName;
  passed: boolean;
  detail: string;
}

export interface SafetyGateRun {
  runId: string;
  status: GateStatus;
  procedureCpt: string;
  diagnosisSnomed: string;
  checks: CheckResult[];
  patient?: {
    id: string;
    name: string;
    dob: string;
    gender: string;
  };
  auditEventId: string;
  createdAt: string;
}

export interface AuditEventItem {
  id: string;
  runId: string;
  actor: string;
  action: string;
  outcome: string;
  detail: any;
  timestamp: string;
}

export interface CircuitBreakerInfo {
  name: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  stats: {
    failures: number;
    fallbacks: number;
    successes: number;
    rejects: number;
    timeouts: number;
    fires: number;
  };
  options: {
    timeout: number;
    errorThresholdPercentage: number;
    resetTimeout: number;
    volumeThreshold: number;
  };
}

export interface SessionContext {
  patientId: string;
  fhirUser: string;
  iss: string;
}
