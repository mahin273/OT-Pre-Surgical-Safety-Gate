import React from 'react';
import type { SessionContext, CircuitBreakerInfo } from '../types';

interface PatientHeaderProps {
  session: SessionContext | null;
  procedureCpt?: string;
  diagnosisSnomed?: string;
  circuits: Record<string, CircuitBreakerInfo>;
  auditCount: number;
  onToggleAudit: () => void;
  onToggleResilience: () => void;
  onRefresh: () => void;
  isLoading: boolean;
  patient?: {
    name?: string;
    dob?: string;
    gender?: string;
  };
}

export const PatientHeader: React.FC<PatientHeaderProps> = ({
  session,
  procedureCpt,
  diagnosisSnomed,
  circuits,
  auditCount,
  onToggleAudit,
  onToggleResilience,
  onRefresh,
  isLoading,
  patient,
}) => {
  const isDegraded = Object.values(circuits).some((c) => c.state === 'OPEN');

  return (
    <>
      {/* 1. Institutional Top System Banner */}
      <div className="ehr-system-banner">
        <div className="system-title-group">
          <span className="system-facility-tag">METROPOLITAN SURGICAL CENTER</span>
          <span className="system-app-name">OR SUITE 04 - PRE-SURGICAL SAFETY GATE (SMART ON FHIR)</span>
        </div>

        <div className="system-telemetry-group">
          <span className="system-user-info">
            LOGGED IN: {session?.fhirUser ? session.fhirUser.toUpperCase() : 'DR. SMITH, JOHN MD (ATTENDING SURGEON)'}
          </span>
          <button
            type="button"
            className="btn-ehr-subtle"
            onClick={onToggleResilience}
            title="Inspect upstream EHR circuit breakers"
          >
            {isDegraded ? '[CIRCUIT: DEGRADED]' : '[EHR: CONNECTED (37ms)]'}
          </button>
          <button
            type="button"
            className="btn-ehr-subtle"
            onClick={onToggleAudit}
            title="Inspect immutable audit events"
          >
            [AUDIT TRAIL ({auditCount})]
          </button>
          <button
            type="button"
            className="btn-ehr-subtle"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh session and clinical context"
          >
            {isLoading ? '[RELOADING...]' : '[REFRESH]'}
          </button>
        </div>
      </div>

      {/* 2. The Classic Epic Patient Ribbon */}
      <div className="ehr-patient-ribbon" aria-label="Patient Demographic Banner">
        <div className="patient-primary-row">
          <span className="patient-name">
            {patient?.name || (session?.patientId ? `PATIENT ${session.patientId.toUpperCase()}` : 'PATIENT UNKNOWN')}
          </span>
          <span className="patient-meta-pill">MRN: {session?.patientId || 'UNKNOWN'}</span>
          <span className="patient-meta-pill">
            DOB: {patient?.dob ? `${patient.dob} (${patient.gender ? patient.gender.toUpperCase() : 'UNKNOWN'})` : 'NOT DOCUMENTED'}
          </span>
          <span className="patient-meta-pill">LOC: PREOP-BAY-03</span>
          <span className="patient-meta-pill">
            ATTENDING: {session?.fhirUser ? session.fhirUser.toUpperCase() : 'DR. SMITH, J. MD'}
          </span>
          <span className="patient-allergy-alert">[ALLERGIES: REVIEWED ON CHART]</span>
        </div>

        <div className="patient-secondary-row">
          <span className="secondary-item">
            SCHEDULED PROCEDURE: <strong>{procedureCpt ? `CPT ${procedureCpt}` : 'NOT SCHEDULED ON EHR'}</strong>
          </span>
          <span className="secondary-item">
            PRE-OP DIAGNOSIS: <strong>{diagnosisSnomed ? `SNOMED ${diagnosisSnomed}` : 'NOT DOCUMENTED ON EHR'}</strong>
          </span>
          <span className="secondary-item">
            CODE STATUS: <strong>FULL CODE</strong>
          </span>
          <span className="secondary-item">
            EHR GATEWAY: <strong>{session?.iss || 'NOT CONNECTED'}</strong>
          </span>
        </div>
      </div>
    </>
  );
};
