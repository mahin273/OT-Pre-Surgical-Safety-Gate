import React from 'react';
import type { GateStatus } from '../types';

interface ClearanceHeroProps {
  status: GateStatus | null;
  runId?: string;
  isLoading: boolean;
  onRunGate: () => void;
  onOpenOverride: () => void;
  onExportFhir?: () => void;
  onPrintSummary?: () => void;
}

export const ClearanceHero: React.FC<ClearanceHeroProps> = ({
  status,
  runId,
  isLoading,
  onRunGate,
  onOpenOverride,
  onExportFhir,
  onPrintSummary,
}) => {
  const getConfig = () => {
    switch (status) {
      case 'PASS':
        return {
          bannerClass: 'decision-pass',
          badgeClass: 'badge-inline-pass',
          badgeText: '[STATUS: PASS]',
          title: 'PATIENT CLEARED FOR OPERATING THEATER ENTRY',
          desc: 'All pre-surgical safety criteria verified and compliant. Patient is cleared for surgical transport and anesthesia induction.',
        };
      case 'BLOCK':
        return {
          bannerClass: 'decision-block',
          badgeClass: 'badge-inline-fail',
          badgeText: '[STATUS: CONTRAINDICATED]',
          title: 'SURGICAL INTERLOCK ACTIVE - PROCEDURE HALTED',
          desc: 'One or more safety criteria failed. Operating theater entry is strictly blocked by clinical interlock.',
        };
      case 'MANUAL_REVIEW':
        return {
          bannerClass: 'decision-review',
          badgeClass: 'badge-inline-warn',
          badgeText: '[STATUS: ATTENDING OVERRIDE REQUIRED]',
          title: 'CLINICAL DISCREPANCY REQUIRING ATTENDING SIGN-OFF',
          desc: 'Non-critical discrepancy identified. An attending surgeon must review clinical evidence and electronically sign the override.',
        };
      default:
        return {
          bannerClass: 'decision-idle',
          badgeClass: 'badge-inline-standby',
          badgeText: '[STATUS: STANDBY]',
          title: 'PRE-SURGICAL SAFETY GATE ARMED',
          desc: 'Ready to evaluate clinical records. Execute safety verification check to retrieve FHIR data and validate safety rules.',
        };
    }
  };

  const config = getConfig();

  return (
    <section className={`ehr-decision-banner ${config.bannerClass}`} aria-label="Pre-Op Safety Status Banner">
      <div className="decision-headline">
        <span className={`status-badge-chip ${config.badgeClass}`}>{config.badgeText}</span>
        <div>
          <h2 className="decision-title">{config.title}</h2>
          <p className="decision-subtitle">
            {config.desc}
            {runId && <span className="tabular-nums" style={{ marginLeft: '0.75rem', fontWeight: 600 }}>[RUN ID: {runId}]</span>}
          </p>
        </div>
      </div>

      <div className="decision-actions">
        <button
          type="button"
          className="btn-ehr-primary"
          onClick={onRunGate}
          disabled={isLoading}
        >
          {isLoading ? '[RUNNING SAFETY CHECK...]' : '[RUN VERIFICATION CHECK]'}
        </button>

        {status === 'MANUAL_REVIEW' && (
          <button
            type="button"
            className="btn-ehr-override"
            onClick={onOpenOverride}
            disabled={isLoading}
          >
            [CLINICAL OVERRIDE]
          </button>
        )}

        {runId && onExportFhir && (
          <button
            type="button"
            className="btn-ehr-default"
            onClick={onExportFhir}
            title="Export FHIR DocumentReference Bundle"
          >
            [EXPORT FHIR]
          </button>
        )}

        {runId && onPrintSummary && (
          <button
            type="button"
            className="btn-ehr-default"
            onClick={onPrintSummary}
            title="Print Official Surgical Clearance Record"
          >
            [PRINT RECORD]
          </button>
        )}
      </div>
    </section>
  );
};
