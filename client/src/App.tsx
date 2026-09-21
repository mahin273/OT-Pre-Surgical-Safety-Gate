import { useState, useEffect, useCallback } from 'react';
import { PatientHeader } from './components/PatientHeader';
import { ClearanceHero } from './components/ClearanceHero';
import { ChecklistGrid } from './components/ChecklistGrid';
import { OverrideModal } from './components/OverrideModal';
import { AuditDrawer } from './components/AuditDrawer';
import { ResilienceDrawer } from './components/ResilienceDrawer';
import type {
  SafetyGateRun,
  AuditEventItem,
  CircuitBreakerInfo,
  SessionContext,
} from './types';

export default function App() {
  const [session, setSession] = useState<SessionContext | null>(null);
  const [run, setRun] = useState<SafetyGateRun | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEventItem[]>([]);
  const [circuits, setCircuits] = useState<Record<string, CircuitBreakerInfo>>({});
  const [patientDetails, setPatientDetails] = useState<{ name?: string; dob?: string; gender?: string } | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isOverriding, setIsOverriding] = useState(false);
  const [isOverrideModalOpen, setIsOverrideModalOpen] = useState(false);
  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [isResilienceOpen, setIsResilienceOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Helper to attach session token across iframe boundaries where third-party cookies are blocked
  const getAuthHeaders = useCallback((extra?: Record<string, string>): Record<string, string> => {
    const sid = sessionStorage.getItem('ot_gate_sid');
    const headers: Record<string, string> = { ...(extra || {}) };
    if (sid) {
      headers['x-session-id'] = sid;
    }
    return headers;
  }, []);

  // Fetch telemetry & session context on mount
  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await fetch('/api/resilience/circuits', {
        headers: getAuthHeaders(),
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setCircuits(data.circuits || {});
      }
    } catch {
      // Non-fatal background telemetry
    }
  }, [getAuthHeaders]);

  const fetchSessionContext = useCallback(async () => {
    // Check if sid is passed in the URL from OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const urlSid = urlParams.get('sid');
    if (urlSid) {
      sessionStorage.setItem('ot_gate_sid', urlSid);
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    try {
      const authRes = await fetch('/api/auth/me', {
        headers: getAuthHeaders(),
        credentials: 'include',
      });
      if (authRes.ok) {
        const authData = await authRes.json();
        if (authData.authenticated && authData.patientId) {
          setSession({
            patientId: authData.patientId,
            fhirUser: authData.fhirUser || 'Practitioner',
            iss: authData.iss || 'unknown-ehr',
          });

          // Fetch patient demographics from EHR
          try {
            const clinRes = await fetch('/api/clinical-data', {
              headers: getAuthHeaders(),
              credentials: 'include',
            });
            if (clinRes.ok) {
              const clinData = await clinRes.json();
              const p = clinData.data?.patient;
              if (p) {
                let name = '';
                if (p.name && p.name.length > 0) {
                  const n = p.name[0];
                  const fam = n.family || '';
                  const giv = (n.given || []).join(' ');
                  if (fam || giv) {
                    name = `${fam.toUpperCase()}, ${giv.toUpperCase()}`.trim();
                  } else if (n.text) {
                    name = n.text.toUpperCase();
                  }
                }
                setPatientDetails({
                  name: name || `PATIENT ${authData.patientId.toUpperCase()}`,
                  dob: p.birthDate || '',
                  gender: p.gender || '',
                });
              }
            }
          } catch {
            // Non-fatal background fetch
          }

          return;
        }
      }
      setSession(null);
    } catch {
      setSession(null);
    } finally {
      setIsAuthLoading(false);
    }
  }, [getAuthHeaders]);

  useEffect(() => {
    fetchSessionContext();
    fetchTelemetry();
  }, [fetchSessionContext, fetchTelemetry]);

  // Execute Pre-Surgical Safety Gate evaluation
  const handleRunSafetyGate = async () => {
    setIsLoading(true);
    setErrorBanner(null);

    try {
      const res = await fetch('/api/safety-gate/run', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `Evaluation failed with status ${res.status}`);
      }

      const data = await res.json();
      const newRun: SafetyGateRun = {
        runId: data.runId,
        status: data.status,
        procedureCpt: data.procedureCpt,
        diagnosisSnomed: data.diagnosisSnomed,
        checks: data.checks || [],
        patient: data.patient,
        auditEventId: data.auditEventId,
        createdAt: data.createdAt,
      };

      setRun(newRun);

      if (data.patient) {
        setPatientDetails(data.patient);
      }

      // Fetch full audit trail
      const runDetailRes = await fetch(`/api/safety-gate/${data.runId}`, {
        headers: getAuthHeaders(),
        credentials: 'include',
      });
      if (runDetailRes.ok) {
        const runDetail = await runDetailRes.json();
        setAuditEvents(runDetail.run?.auditEvents || []);
      }

      await fetchTelemetry();
    } catch (err: any) {
      setErrorBanner(err.message || 'Failed to execute Pre-Surgical Safety Gate evaluation');
    } finally {
      setIsLoading(false);
    }
  };

  // Submit clinical override
  const handleOverrideSubmit = async (reason: string) => {
    if (!run) return;

    setIsOverriding(true);
    setErrorBanner(null);

    try {
      const res = await fetch(`/api/safety-gate/${run.runId}/override`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ reason }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Override rejected by safety gate policy');
      }

      const data = await res.json();
      setRun((prev) => (prev ? { ...prev, status: data.status } : null));

      // Re-fetch audit trail
      const runDetailRes = await fetch(`/api/safety-gate/${run.runId}`, {
        headers: getAuthHeaders(),
        credentials: 'include',
      });
      if (runDetailRes.ok) {
        const runDetail = await runDetailRes.json();
        setAuditEvents(runDetail.run?.auditEvents || []);
      }
    } catch (err: any) {
      setErrorBanner(err.message || 'Clinical override submission failed');
      throw err;
    } finally {
      setIsOverriding(false);
    }
  };

  // Document Export Handlers
  const handleExportFhir = () => {
    if (!run) return;
    const sid = sessionStorage.getItem('ot_gate_sid');
    const url = `/api/safety-gate/${run.runId}/document/fhir` + (sid ? `?sid=${encodeURIComponent(sid)}` : '');
    window.open(url, '_blank');
  };

  const handlePrintSummary = () => {
    if (!run) return;
    const sid = sessionStorage.getItem('ot_gate_sid');
    const url = `/api/safety-gate/${run.runId}/document/html` + (sid ? `?sid=${encodeURIComponent(sid)}` : '');
    window.open(url, '_blank');
  };

  const failingChecksForOverride = (run?.checks || []).filter((c) => !c.passed);

  if (isAuthLoading) {
    return (
      <div className="ehr-app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: '#eef2f5' }}>
        <div style={{ padding: '1.5rem 2rem', backgroundColor: '#fff', border: '1px solid #c2cdd6', color: '#1a365d', fontWeight: 600, fontSize: '13px', letterSpacing: '0.05em' }}>
          [AUTHENTICATING EHR CLINICAL CONTEXT...]
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="ehr-app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: '#eef2f5' }}>
        <div style={{ padding: '2rem', backgroundColor: '#fff', border: '1px solid #c2cdd6', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', textAlign: 'center', maxWidth: '500px' }}>
          <h2 style={{ color: '#d9534f', margin: '0 0 1rem 0' }}>Unauthorized Access</h2>
          <p style={{ color: '#334155', lineHeight: '1.5' }}>
            This application is designed to be launched from within an Electronic Health Record (EHR) system.
          </p>
          <p style={{ color: '#334155', lineHeight: '1.5', marginTop: '1rem' }}>
            Please initiate the <strong>SMART on FHIR Launch Sequence</strong> to establish a valid clinical context.
          </p>
          <div style={{ marginTop: '2rem', padding: '1rem', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', fontSize: '12px', color: '#64748b' }}>
            <p><strong>To launch this application:</strong></p>
            <p>Launch from the official SMART on FHIR Sandbox at <code>https://launch.smarthealthit.org/</code></p>
            <p>App Launch URL: <code>http://localhost:4000/launch</code></p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ehr-app-shell">
      {/* 1. Institutional Top System Banner & Patient Ribbon */}
      <PatientHeader
        session={session}
        patient={patientDetails || run?.patient || undefined}
        procedureCpt={run?.procedureCpt}
        diagnosisSnomed={run?.diagnosisSnomed}
        circuits={circuits}
        auditCount={auditEvents.length}
        onToggleAudit={() => setIsAuditOpen((prev) => !prev)}
        onToggleResilience={() => setIsResilienceOpen((prev) => !prev)}
        onRefresh={() => {
          fetchSessionContext();
          fetchTelemetry();
        }}
        isLoading={isLoading}
      />

      {/* 2. Main Clinical Flowsheet Workspace */}
      <main className="ehr-workspace" role="main">
        {errorBanner && (
          <div
            className="modal-notice-box"
            style={{
              backgroundColor: 'var(--ehr-block-bg)',
              borderColor: 'var(--ehr-block-border)',
              color: 'var(--ehr-block-text)',
            }}
            role="alert"
          >
            <strong>[SYSTEM INTERLOCK ALERT]:</strong> {errorBanner}
          </div>
        )}

        {/* Section 1: Pre-Op Safety Decision Bar */}
        <ClearanceHero
          status={run?.status || null}
          runId={run?.runId}
          isLoading={isLoading}
          onRunGate={handleRunSafetyGate}
          onOpenOverride={() => setIsOverrideModalOpen(true)}
          onExportFhir={handleExportFhir}
          onPrintSummary={handlePrintSummary}
        />

        {/* Section 2: Clinical Flowsheet Verification Table */}
        <ChecklistGrid
          checks={run?.checks || []}
          procedureCpt={run?.procedureCpt}
          diagnosisSnomed={run?.diagnosisSnomed}
        />

        {/* Section 3: Institutional System Footer Strip */}
        <footer className="ehr-footer-strip">
          <div className="footer-meta-items">
            <span>GATE ENGINE: V1.4.2-STABLE</span>
            <span>UPSTREAM FHIR: SMART-ON-FHIR R4</span>
            <span>DATABASE AUDIT: ACTIVE (POSTGRESQL)</span>
          </div>
          <div className="footer-actions">
            <button
              type="button"
              className="btn-ehr-default"
              onClick={() => setIsResilienceOpen(true)}
            >
              [CIRCUIT STATUS]
            </button>
            <button
              type="button"
              className="btn-ehr-default"
              onClick={() => setIsAuditOpen(true)}
            >
              [AUDIT LEDGER ({auditEvents.length})]
            </button>
          </div>
        </footer>
      </main>

      {/* Attending Surgeon Override Modal */}
      <OverrideModal
        isOpen={isOverrideModalOpen}
        failingChecks={failingChecksForOverride}
        onClose={() => setIsOverrideModalOpen(false)}
        onSubmit={handleOverrideSubmit}
        isSubmitting={isOverriding}
      />

      {/* Legal Immutable Audit Drawer */}
      <AuditDrawer
        isOpen={isAuditOpen}
        auditEvents={auditEvents}
        onClose={() => setIsAuditOpen(false)}
      />

      {/* SRE Circuit Telemetry Drawer */}
      <ResilienceDrawer
        isOpen={isResilienceOpen}
        circuits={circuits}
        onClose={() => setIsResilienceOpen(false)}
        onRefreshCircuits={fetchTelemetry}
      />
    </div>
  );
}
