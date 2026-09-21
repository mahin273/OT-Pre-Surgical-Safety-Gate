import React from 'react';
import type { AuditEventItem } from '../types';

interface AuditDrawerProps {
  isOpen: boolean;
  auditEvents: AuditEventItem[];
  onClose: () => void;
}

export const AuditDrawer: React.FC<AuditDrawerProps> = ({
  isOpen,
  auditEvents,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <aside className="ehr-drawer" role="complementary" aria-label="Legal Audit Trail">
      <div className="ehr-drawer-header">
        <span>IMMUTABLE LEGAL AUDIT TRAIL (POSTGRESQL)</span>
        <button
          type="button"
          className="btn-modal-x"
          onClick={onClose}
          title="Close audit drawer"
        >
          [X]
        </button>
      </div>

      <div className="ehr-drawer-content">
        {auditEvents.length === 0 ? (
          <p style={{ color: 'var(--ehr-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '11px', padding: '1rem 0' }}>
            No audit events recorded for current session.
          </p>
        ) : (
          auditEvents.map((evt) => (
            <div key={evt.id} className="drawer-event-card">
              <div className="drawer-event-header">
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#1e3a8a' }}>
                  [{evt.action}]
                </span>
                <span
                  className={
                    evt.outcome === 'PASS'
                      ? 'status-badge-inline badge-inline-pass'
                      : 'status-badge-inline badge-inline-fail'
                  }
                >
                  {evt.outcome}
                </span>
              </div>
              <div style={{ color: 'var(--ehr-text-secondary)' }}>ACTOR: {evt.actor}</div>
              <div style={{ color: 'var(--ehr-text-muted)', fontSize: '10px' }}>
                TIME: {new Date(evt.timestamp).toISOString()}
              </div>
              {evt.detail && (
                <pre className="drawer-json-block">
                  {typeof evt.detail === 'string'
                    ? evt.detail
                    : JSON.stringify(evt.detail, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
