import React, { useState } from 'react';
import type { CheckResult } from '../types';

interface OverrideModalProps {
  isOpen: boolean;
  failingChecks: CheckResult[];
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
  isSubmitting: boolean;
}

const PRESET_RATIONALES = [
  'Emergency surgical intervention: clinical necessity supersedes non-critical discrepancy.',
  'Attending surgeon verified alternative valid surgical consent physically on chart.',
  'Alternative antibiotic prophylaxis regimen ordered (Vancomycin protocol).',
  'Crosswalk discrepancy clinically reconciled; surgical indication validated.',
];

export const OverrideModal: React.FC<OverrideModalProps> = ({
  isOpen,
  failingChecks,
  onClose,
  onSubmit,
  isSubmitting,
}) => {
  const [reason, setReason] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 5) {
      setErrorText('Clinical justification requires at least 5 characters.');
      return;
    }

    try {
      setErrorText(null);
      await onSubmit(reason.trim());
      onClose();
    } catch (err: any) {
      setErrorText(err.message || 'Failed to submit clinical override.');
    }
  };

  return (
    <div
      className="ehr-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ehr-override-title"
    >
      <div className="ehr-modal-window">
        <div className="ehr-modal-titlebar">
          <span id="ehr-override-title">
            ATTENDING CLINICAL OVERRIDE CERTIFICATION
          </span>
          <button
            type="button"
            className="btn-modal-x"
            onClick={onClose}
            disabled={isSubmitting}
            title="Cancel and close dialog"
          >
            [X]
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="ehr-modal-body">
            <div className="modal-notice-box">
              <strong style={{ display: 'block', marginBottom: '0.25rem' }}>
                FLAGGED NON-CRITICAL DISCREPANCIES REQUIRING SIGN-OFF:
              </strong>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {failingChecks.map((check, idx) => (
                  <li key={idx} className="tabular-nums">
                    <strong>[{check.name.toUpperCase()}]:</strong> {check.detail}
                  </li>
                ))}
              </ul>
            </div>

            <div className="modal-form-group">
              <label htmlFor="preset-select" className="modal-form-label">
                INSTITUTIONAL RATIONALE TEMPLATE:
              </label>
              <select
                id="preset-select"
                className="ehr-select"
                onChange={(e) => {
                  if (e.target.value) {
                    setReason(e.target.value);
                  }
                }}
                disabled={isSubmitting}
              >
                <option value="">-- Select standard clinical rationale --</option>
                {PRESET_RATIONALES.map((r, i) => (
                  <option key={i} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div className="modal-form-group">
              <label htmlFor="override-reason" className="modal-form-label">
                MANDATORY CLINICAL JUSTIFICATION (MIN 5 CHARACTERS):
              </label>
              <textarea
                id="override-reason"
                className="ehr-textarea"
                rows={4}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Enter detailed clinical rationale for proceeding despite safety gate discrepancy..."
                disabled={isSubmitting}
                required
              />
            </div>

            {errorText && (
              <div style={{ color: 'var(--ehr-block-text)', fontWeight: 700, fontSize: '11px' }}>
                [VALIDATION ERROR]: {errorText}
              </div>
            )}

            <div className="legal-affirmation-text">
              LEGAL CERTIFICATION: By signing this override, the attending surgeon certifies that patient medical risks have been evaluated and assumes clinical responsibility under institutional surgical governance. This transaction is permanently committed to the audit ledger.
            </div>
          </div>

          <div className="ehr-modal-footer">
            <button
              type="button"
              className="btn-ehr-default"
              onClick={onClose}
              disabled={isSubmitting}
            >
              [CANCEL]
            </button>
            <button
              type="submit"
              className="btn-ehr-override"
              disabled={isSubmitting || reason.trim().length < 5}
            >
              {isSubmitting ? '[RECORDING AUDIT SIGNATURE...]' : '[CONFIRM & SIGN OVERRIDE]'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
