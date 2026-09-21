import React from 'react';
import type { CircuitBreakerInfo } from '../types';

interface ResilienceDrawerProps {
  isOpen: boolean;
  circuits: Record<string, CircuitBreakerInfo>;
  onClose: () => void;
  onRefreshCircuits?: () => void;
}

export const ResilienceDrawer: React.FC<ResilienceDrawerProps> = ({
  isOpen,
  circuits,
  onClose,
  onRefreshCircuits,
}) => {
  if (!isOpen) return null;

  const circuitList = Object.values(circuits);

  return (
    <aside className="ehr-drawer" role="complementary" aria-label="SRE Telemetry">
      <div className="ehr-drawer-header">
        <span>EHR GATEWAY &amp; CIRCUIT TELEMETRY</span>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          {onRefreshCircuits && (
            <button
              type="button"
              className="btn-ehr-subtle"
              onClick={onRefreshCircuits}
              title="Refresh circuit breaker statistics"
            >
              [POLL]
            </button>
          )}
          <button
            type="button"
            className="btn-modal-x"
            onClick={onClose}
            title="Close telemetry drawer"
          >
            [X]
          </button>
        </div>
      </div>

      <div className="ehr-drawer-content">
        {circuitList.length === 0 ? (
          <p style={{ color: 'var(--ehr-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '11px', padding: '1rem 0' }}>
            No circuit breakers currently registered in registry.
          </p>
        ) : (
          circuitList.map((cb) => (
            <div key={cb.name} className="drawer-event-card">
              <div className="drawer-event-header">
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#1e3a8a' }}>
                  {cb.name.toUpperCase()}
                </span>
                <span
                  className={
                    cb.state === 'CLOSED'
                      ? 'status-badge-inline badge-inline-pass'
                      : 'status-badge-inline badge-inline-fail'
                  }
                >
                  [{cb.state}]
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', margin: '0.4rem 0' }}>
                <div>
                  <div style={{ color: 'var(--ehr-text-muted)', fontSize: '10px' }}>SUCCESS</div>
                  <div className="tabular-nums" style={{ color: 'var(--ehr-pass-text)', fontWeight: 700 }}>
                    {cb.stats?.successes || 0}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--ehr-text-muted)', fontSize: '10px' }}>FAILURES</div>
                  <div className="tabular-nums" style={{ color: (cb.stats?.failures || 0) > 0 ? 'var(--ehr-block-text)' : 'inherit', fontWeight: 700 }}>
                    {cb.stats?.failures || 0}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--ehr-text-muted)', fontSize: '10px' }}>TIMEOUTS</div>
                  <div className="tabular-nums" style={{ fontWeight: 600 }}>{cb.stats?.timeouts || 0}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--ehr-text-muted)', fontSize: '10px' }}>FALLBACKS</div>
                  <div className="tabular-nums" style={{ fontWeight: 600 }}>{cb.stats?.fallbacks || 0}</div>
                </div>
              </div>

              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ehr-text-muted)' }}>
                TIMEOUT: {cb.options?.timeout}ms | THRESHOLD: {cb.options?.errorThresholdPercentage}% | RESET: {cb.options?.resetTimeout}ms
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
