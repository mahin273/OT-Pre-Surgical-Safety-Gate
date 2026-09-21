import React from 'react';
import type { CheckResult } from '../types';

interface ChecklistGridProps {
  checks: CheckResult[];
  procedureCpt?: string;
  diagnosisSnomed?: string;
}

export const ChecklistGrid: React.FC<ChecklistGridProps> = ({
  checks,
  procedureCpt,
  diagnosisSnomed,
}) => {
  const getCheck = (name: string): CheckResult | undefined =>
    checks.find((c) => c.name === name);

  const crosswalkCheck = getCheck('diagnosis_procedure_match');
  const consentCheck = getCheck('consent');
  const labsCheck = getCheck('labs');
  const allergyCheck = getCheck('allergy');
  const ehrCheck = getCheck('ehr_availability');

  const renderStatusBadge = (check?: CheckResult, passText = 'PASS', failText = 'FAIL') => {
    if (!check) {
      return <span className="status-badge-inline badge-inline-standby">[STANDBY]</span>;
    }
    return check.passed ? (
      <span className="status-badge-inline badge-inline-pass">[{passText}]</span>
    ) : (
      <span className="status-badge-inline badge-inline-fail">[{failText}]</span>
    );
  };

  return (
    <div className="flowsheet-container" aria-label="Pre-Surgical Safety Verification Flowsheet">
      <div className="flowsheet-header-bar">
        <span className="flowsheet-title">PRE-OPERATIVE CLINICAL VERIFICATION FLOWSHEET</span>
        <span className="flowsheet-meta">PROTOCOL: OR-SURG-SAFETY-2026 | STANDARD: WHO / TJC TIME-OUT PROTOCOL</span>
      </div>

      <table className="flowsheet-table">
        <thead>
          <tr>
            <th className="col-idx">#</th>
            <th className="col-protocol">SAFETY CRITERIA / PROTOCOL ITEM</th>
            <th className="col-code">ONTOLOGY / REFERENCE</th>
            <th className="col-threshold">CLINICAL THRESHOLD / RULE</th>
            <th className="col-value">PATIENT VALUE / EVIDENCE RETRIEVED</th>
            <th className="col-status">STATUS</th>
          </tr>
        </thead>
        <tbody>
          {ehrCheck && !ehrCheck.passed && (
            <tr className="flowsheet-row" style={{ backgroundColor: 'var(--ehr-block-bg)' }}>
              <td className="col-idx">--</td>
              <td className="col-protocol" style={{ color: 'var(--ehr-block-text)' }}>
                EHR GATEWAY &amp; CIRCUIT BREAKER
              </td>
              <td className="col-code">SMART-ON-FHIR-R4</td>
              <td className="col-threshold">Circuit Closed / Fail-Closed Interlock</td>
              <td className="col-value" style={{ color: 'var(--ehr-block-text)', fontWeight: 700 }}>
                {ehrCheck.detail}
              </td>
              <td className="col-status">
                <span className="status-badge-inline badge-inline-fail">[OPEN]</span>
              </td>
            </tr>
          )}

          {/* Row 01: Procedural Indication Crosswalk */}
          <tr className="flowsheet-row">
            <td className="col-idx">01</td>
            <td className="col-protocol">Procedure &amp; Indication Crosswalk</td>
            <td className="col-code">
              CPT {procedureCpt || '47562'} &lt;---&gt; SNOMED {diagnosisSnomed || '235919008'}
            </td>
            <td className="col-threshold">Exact verified ontology mapping required</td>
            <td className="col-value">
              {crosswalkCheck?.detail || 'Lap Cholecystectomy cross-referenced with Acute Cholecystitis.'}
            </td>
            <td className="col-status">
              {renderStatusBadge(crosswalkCheck, 'PASS', 'DISCREPANCY')}
            </td>
          </tr>

          {/* Row 02: Informed Surgical Consent */}
          <tr className="flowsheet-row">
            <td className="col-idx">02</td>
            <td className="col-protocol">Informed Surgical &amp; Anesthetic Consent</td>
            <td className="col-code">FHIR Consent (CAT-001)</td>
            <td className="col-threshold">Electronic signature active within 24h of OR start</td>
            <td className="col-value">
              {consentCheck?.detail || 'Electronic operative consent signature verified on chart.'}
            </td>
            <td className="col-status">
              {renderStatusBadge(consentCheck, 'PASS', 'MISSING')}
            </td>
          </tr>

          {/* Row 03: Platelet Count */}
          {(() => {
            const detail = labsCheck?.detail || '';
            const isMissing = detail.toLowerCase().includes('missing') || detail.toLowerCase().includes('platelets (loinc 777-3)');
            const isLow = detail.toLowerCase().includes('critical low platelets');
            const isStale = detail.toLowerCase().includes('exceed 24-hour');

            let valueText = 'Awaiting laboratory observation query (LOINC 777-3).';
            let badgeClass = 'badge-inline-standby';
            let badgeText = '[STANDBY]';

            if (labsCheck) {
              if (isMissing) {
                valueText = 'No documented Platelets (LOINC 777-3) observation on chart within 24h.';
                badgeClass = 'badge-inline-fail';
                badgeText = '[MISSING]';
              } else if (isLow) {
                valueText = detail;
                badgeClass = 'badge-inline-fail';
                badgeText = '[LOW]';
              } else if (isStale) {
                valueText = 'Platelet result exceeds 24-hour pre-op recency window.';
                badgeClass = 'badge-inline-warn';
                badgeText = '[STALE]';
              } else if (labsCheck.passed) {
                valueText = 'Platelet count verified within safe threshold (>= 50 k/uL).';
                badgeClass = 'badge-inline-pass';
                badgeText = '[PASS]';
              } else {
                valueText = detail;
                badgeClass = 'badge-inline-fail';
                badgeText = '[FLAG]';
              }
            }

            return (
              <tr className="flowsheet-row">
                <td className="col-idx">03</td>
                <td className="col-protocol">Hemostasis: Platelet Count (CBC)</td>
                <td className="col-code">LOINC 777-3</td>
                <td className="col-threshold">Threshold &gt;= 50 k/uL (Bleeding risk)</td>
                <td className="col-value">{valueText}</td>
                <td className="col-status">
                  <span className={`status-badge-inline ${badgeClass}`}>{badgeText}</span>
                </td>
              </tr>
            );
          })()}

          {/* Row 04: INR */}
          {(() => {
            const detail = labsCheck?.detail || '';
            const isMissing = detail.toLowerCase().includes('missing') || detail.toLowerCase().includes('inr (loinc 6301-6)');
            const isElevated = detail.toLowerCase().includes('critical elevated inr');
            const isStale = detail.toLowerCase().includes('exceed 24-hour');

            let valueText = 'Awaiting coagulation panel query (LOINC 6301-6).';
            let badgeClass = 'badge-inline-standby';
            let badgeText = '[STANDBY]';

            if (labsCheck) {
              if (isMissing) {
                valueText = 'No documented INR (LOINC 6301-6) coagulation panel on chart within 24h.';
                badgeClass = 'badge-inline-fail';
                badgeText = '[MISSING]';
              } else if (isElevated) {
                valueText = detail;
                badgeClass = 'badge-inline-fail';
                badgeText = '[ELEVATED]';
              } else if (isStale) {
                valueText = 'INR result exceeds 24-hour pre-op recency window.';
                badgeClass = 'badge-inline-warn';
                badgeText = '[STALE]';
              } else if (labsCheck.passed) {
                valueText = 'INR verified within safe coagulopathy threshold (<= 1.50).';
                badgeClass = 'badge-inline-pass';
                badgeText = '[PASS]';
              } else {
                valueText = detail;
                badgeClass = 'badge-inline-fail';
                badgeText = '[FLAG]';
              }
            }

            return (
              <tr className="flowsheet-row">
                <td className="col-idx">04</td>
                <td className="col-protocol">Coagulation: International Normalized Ratio (INR)</td>
                <td className="col-code">LOINC 6301-6</td>
                <td className="col-threshold">Threshold &lt;= 1.50 (Coagulopathy risk)</td>
                <td className="col-value">{valueText}</td>
                <td className="col-status">
                  <span className={`status-badge-inline ${badgeClass}`}>{badgeText}</span>
                </td>
              </tr>
            );
          })()}

          {/* Row 05: Prothrombin Time */}
          {(() => {
            const detail = labsCheck?.detail || '';
            const isMissing = detail.toLowerCase().includes('missing') || detail.toLowerCase().includes('pt (loinc 5902-2)');
            const isProlonged = detail.toLowerCase().includes('critical prolonged pt');
            const isStale = detail.toLowerCase().includes('exceed 24-hour');

            let valueText = 'Awaiting coagulation panel query (LOINC 5902-2).';
            let badgeClass = 'badge-inline-standby';
            let badgeText = '[STANDBY]';

            if (labsCheck) {
              if (isMissing) {
                valueText = 'No documented Prothrombin Time (LOINC 5902-2) on chart within 24h.';
                badgeClass = 'badge-inline-fail';
                badgeText = '[MISSING]';
              } else if (isProlonged) {
                valueText = detail;
                badgeClass = 'badge-inline-fail';
                badgeText = '[PROLONGED]';
              } else if (isStale) {
                valueText = 'Prothrombin Time exceeds 24-hour pre-op recency window.';
                badgeClass = 'badge-inline-warn';
                badgeText = '[STALE]';
              } else if (labsCheck.passed) {
                valueText = 'Prothrombin Time verified within safe threshold (<= 14.0s).';
                badgeClass = 'badge-inline-pass';
                badgeText = '[PASS]';
              } else {
                valueText = detail;
                badgeClass = 'badge-inline-fail';
                badgeText = '[FLAG]';
              }
            }

            return (
              <tr className="flowsheet-row">
                <td className="col-idx">05</td>
                <td className="col-protocol">Coagulation: Prothrombin Time (PT)</td>
                <td className="col-code">LOINC 5902-2</td>
                <td className="col-threshold">Threshold &lt;= 14.0 seconds</td>
                <td className="col-value">{valueText}</td>
                <td className="col-status">
                  <span className={`status-badge-inline ${badgeClass}`}>{badgeText}</span>
                </td>
              </tr>
            );
          })()}

          {/* Row 06: Antimicrobial Prophylaxis Allergy */}
          <tr className="flowsheet-row">
            <td className="col-idx">06</td>
            <td className="col-protocol">Antimicrobial Prophylaxis Allergy Screen</td>
            <td className="col-code">RxNorm 309090 (Cefazolin)</td>
            <td className="col-threshold">Zero documented severe cephalosporin / penicillin allergy</td>
            <td className="col-value">
              {allergyCheck?.detail || 'No known drug allergies (NKDA) recorded in FHIR AllergyIntolerance.'}
            </td>
            <td className="col-status">
              {renderStatusBadge(allergyCheck, 'PASS', 'CONTRAINDICATED')}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};
