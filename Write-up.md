# Pre-Surgical Safety Gate — Design Write-Up

This document details the architectural approach, clinical safety assumptions, and future technical enhancements for the Operating Theater (OT) Pre-Surgical Safety Gate.

---

## 1. Approach & Engineering Philosophy

### Zero-Trust, Fail-Closed Healthcare Invariant
Software deployed in an operating room environment operates under fundamentally different safety constraints than consumer web applications. In consumer software, graceful degradation typically means rendering stale cached data or silently hiding a broken widget. In perioperative care, degraded mode means a blind safety gate. If an automated system allows a surgical incision when critical clinical checks are unverified, patient harm can ensue.

Therefore, this application enforces a strict **Zero-Trust, Fail-Closed** model:
- The system never assumes patient eligibility or safety clearance.
- If upstream EHR endpoints fail, network partitions occur, or circuit breakers trip, the gate defaults immediately to a hard `BLOCK` with an explicit `[FAIL-CLOSED]` rationale.
- The operating room surgical team is immediately notified that automated verification cannot be guaranteed, forcing a clinical verification protocol.

### Backend-For-Frontend (BFF) Architecture
The frontend runs as an embedded web application inside the clinician's EHR workstation. Browser environments are untrusted:
- Confidential OAuth client secrets must never be exposed to the client bundle.
- Direct browser calls to EHR FHIR endpoints face strict CORS policies and third-party cookie blocking inside cross-origin iframes.
- The Express BFF handles OAuth2 PKCE exchanges, maintains session lifecycles, runs all clinical rules server-side, and communicates with PostgreSQL and Redis.

### Deterministic State Machine
Clinical risk is categorized into three terminal states:
1. `PASS`: All 4 perioperative safety checks (indication match, informed consent, recent coagulation panel, and allergy screening) satisfy strict safety thresholds.
2. `MANUAL_REVIEW`: Borderline or unmapped conditions (e.g., coagulation labs older than 24 hours, or unmapped CPT/SNOMED surgical combinations) require active human surgical judgment. An authenticated clinician can grant clearance by providing a mandatory clinical justification.
3. `BLOCK`: Hard contraindications (e.g., absent or revoked surgical consent, critical thrombocytopenia, or active penicillin anaphylaxis paired with beta-lactam prophylaxis). Hard blocks cannot be overridden in software.

### Atomic Single-Use State Security
OAuth authorization code flows using PKCE must be protected against replay attacks. The BFF stores PKCE code verifiers in Redis using atomic single-use retrieval (`GETDEL`). Once read during the token exchange callback, the verifier is immediately destroyed, eliminating replay vulnerabilities across distributed instances.

### Dual Interoperability Document Export
To bridge modern healthcare standards with legacy hospital information systems:
- **USCDI FHIR R4 Document:** Generates a standard FHIR Document Bundle (`type: "document"`) with a root `Composition` resource (LOINC `81218-0`), referencing active conditions, procedures, labs, allergies, and consents.
- **Legacy HL7 CDA XML:** Generates a structured Clinical Document Architecture (C-CDA) XML document with clinical narrative blocks and machine-readable entries for legacy archiving.
- **Printable HTML Summary:** Provides a clean, print-optimized surgical clearance sheet suitable for physical OR timeout binders.

---

## 2. Clinical & Technical Assumptions

1. **SMART on FHIR Launch Environment:**
   The host EHR supports the SMART App Launch Framework (v1 or v2) with authorization code grant and PKCE (`S256`). The EHR supplies a valid `iss` (FHIR base URL) and `launch` context token upon initiating the app.

2. **Laboratory Recency Window (24 Hours):**
   Platelet counts, INR, and Prothrombin Time (PT) fluctuate rapidly in acute perioperative settings. A strict 24-hour cutoff was adopted as the clinical threshold for coagulation recency. Any lab older than 24 hours is marked stale, transitioning the checklist to `MANUAL_REVIEW`.

3. **Non-Overridable Contraindications:**
   A hard `BLOCK` represents an acute danger to patient safety (e.g., operating without informed consent, or administering cross-reactive antibiotics to an anaphylactic patient). These states cannot be bypassed by clicking an override button. The underlying clinical conflict must be addressed in the EHR (e.g., selecting an alternative non-beta-lactam antibiotic, or obtaining signed surgical consent).

4. **Cross-Origin Iframe Session Propagation:**
   Modern browsers restrict third-party cookies inside cross-origin EHR iframes (`SameSite=None; Secure` partitioning). To guarantee reliable session management, the application returns a session token on initial launch and injects an `x-session-id` header in all API requests from the frontend client.

5. **Curated Clinical Terminology Crosswalks:**
   SNOMED-CT indications and CPT procedural codes are mapped through a curated surgical crosswalk. While production systems often query dedicated enterprise terminology servers, a deterministic local crosswalk ensures predictable, sub-millisecond evaluation in emergency surgical contexts.

---

## 3. What I Would Improve With More Time

1. **Event-Driven CDS Hooks:**
   Currently, the application runs when a clinician opens the safety gate flowsheet. With more time, I would implement CDS Hooks (`order-select`, `patient-view`, and `encounter-start`) so the EHR can proactively trigger automated safety checks in the background when a surgery or preoperative antibiotic is ordered, alerting teams hours in advance.

2. **Asymmetric SMART v2 Authentication:**
   Upgrade from symmetric client secrets to asymmetric Private Key JWT (`client_secret_jwt` / `private_key_jwt`) and mutual TLS (mTLS) authentication. This fulfills the latest ONC (Office of the National Coordinator for Health IT) 21st Century Cures Act and TEFCA security mandates.

3. **Dynamic FHIR Terminology Service Integration:**
   Integrate external terminology servers (such as NIH UMLS or CSIRO Ontoserver) using FHIR `$subsumes`, `$lookup`, and `$expand` operations. This would allow automated hierarchical subsumption checks (e.g., automatically recognizing any penicillin derivative or cephalosporin generation without manually maintained code lists).

4. **FHIR Bulk Data API ($export):**
   Implement support for the FHIR Bulk Data Access specification to evaluate safety gates across an entire hospital surgical theater schedule (dozens of operating rooms) in a single batch overnight, generating proactive morning risk dashboards for OR directors.

5. **Multi-Factor Clinical Signature for Overrides:**
   Enhance the override workflow to require biometric or two-factor clinician authentication (e.g., FIDO2 WebAuthn / hospital smart badge tap) before committing an override to the immutable PostgreSQL audit trail.
