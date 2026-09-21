# Operating Theater (OT) Pre-Surgical Safety Gate

A clinical-grade, fail-closed pre-surgical safety gate application embedded directly within hospital Electronic Health Record (EHR) systems via the SMART on FHIR framework. The system evaluates patient clinical records against 4 perioperative safety checks before surgical incision, providing automated clearances, hard interlocks, and audited clinical overrides.

---

## Architecture & Design Approach

The application uses a **Backend-For-Frontend (BFF)** architecture to decouple clinical safety logic from browser environments and maintain confidential OAuth credentials:

```mermaid
flowchart TD
    subgraph EHR["Hospital EHR Environment"]
        Workstation["Hospital EHR Workstation<br/>(Epic / Cerner / SMART Launcher)"]
        FhirServer[("Hospital EHR FHIR R4 Server")]
    end

    subgraph AppServer["Safety Gate Backend (Express BFF) - Port 4000"]
        LaunchRoute["OAuth2 & PKCE Handler<br/>(/launch, /callback)"]
        CircuitBreaker["Circuit Breaker Protected<br/>FHIR Client (Opossum)"]
        RuleEngine["Deterministic Clinical Safety Engine<br/>(4 Perioperative Checks)"]
        DocGen["USCDI FHIR Composition &<br/>HL7 CDA XML Generator"]
    end

    subgraph DataStorage["Data & State Persistence"]
        Redis[("Redis - Port 6380<br/>- Atomic GETDEL PKCE<br/>- Session Token Cache (TTL)")]
        Postgres[("PostgreSQL 16 - Port 5433<br/>- ChecklistRun (Evaluations)<br/>- AuditEvent (Immutable Logs)<br/>- TerminologyCache (Crosswalks)")]
    end

    subgraph Frontend["Clinician Frontend - Port 3002"]
        ReactUI["Embedded React 19 Flowsheet<br/>- Real-time PASS / BLOCK Badges<br/>- Surgical Timeout Evidence<br/>- Attending Surgeon Override Modal"]
    end

    Workstation -->|"1. SMART Launch + PKCE (S256)"| LaunchRoute
    LaunchRoute <-->|"2. Single-use Verifier & Session Storage"| Redis
    LaunchRoute -->|"3. Authenticated Launch Redirect"| ReactUI
    ReactUI -->|"4. Trigger Safety Evaluation (x-session-id)"| RuleEngine
    RuleEngine -->|"5. Fetch Clinical Data (Fail-Closed)"| CircuitBreaker
    CircuitBreaker <-->|"6. Patient, Conditions, Labs, Allergies, Consent"| FhirServer
    RuleEngine -->|"7. Atomic Commit Run & Audit Trail"| Postgres
    RuleEngine -->|"8. Return Evaluation & Checklist Status"| ReactUI
    ReactUI -->|"9. Submit Clinical Override (Mandatory Reason)"| RuleEngine
    RuleEngine -->|"10. Export Standardized Summaries"| DocGen
```

---

## Clinical Safety Rules & State Machine

The safety engine resolves patient data into 3 deterministic states: `PASS`, `BLOCK`, or `MANUAL_REVIEW`.

1. **Diagnosis to Procedure Crosswalk:**
   Matches scheduled surgical procedure (CPT code) against active surgical diagnoses (SNOMED-CT). Recognized mappings (e.g., Laparoscopic Cholecystectomy CPT 47562 paired with Acute Cholecystitis SNOMED 235919008) pass automatically; unmapped combinations transition to `MANUAL_REVIEW`.

2. **Informed Surgical Consent Verification:**
   Verifies an active FHIR `Consent` resource with treatment scope is recorded for the surgical encounter. Missing or revoked consent triggers an immediate hard `BLOCK`.

3. **Pre-Operative Coagulation Panel (24-Hour Recency):**
   Evaluates LOINC laboratory results against surgical safety thresholds:
   - Platelets >= 50,000 /uL (LOINC `777-3`)
   - INR <= 1.5 (LOINC `6301-6`)
   - Prothrombin Time (PT) <= 14.0s (LOINC `5902-2`)
   Critical out-of-range values trigger `BLOCK`. Stale results older than 24 hours trigger `MANUAL_REVIEW`.

4. **Perioperative Antibiotic Allergy Screening:**
   Screens planned prophylactic antibiotics (e.g., Cefazolin RxNorm `309095`) against active `AllergyIntolerance` records. Direct cephalosporin allergies or severe beta-lactam / penicillin anaphylaxis hazards trigger an immediate `BLOCK`.

5. **Attending Surgeon Override Interlock:**
   Runs flagged for `MANUAL_REVIEW` can be cleared only by an authenticated clinician submitting a mandatory medical justification (minimum 5 characters). The action atomically transitions the status to `PASS` and appends an immutable `CLINICAL_OVERRIDE` event to the PostgreSQL audit log. Hard `BLOCK` runs cannot be overridden.

---

## Write-Up: Approach, Assumptions & Future Improvements

### 1. Approach
We designed this safety gate around the **Zero-Trust, Fail-Closed Healthcare Invariant**: software serving the operating theater must never allow a surgical incision based on absent data, unhandled exceptions, or network optimism.

- **BFF Architecture:** Client browsers are untrusted; all FHIR API requests, token exchanges, and clinical rules execute within the Express BFF. Confidential client credentials never touch the frontend.
- **Fail-Closed Circuit Breakers:** Upstream hospital EHR integrations are wrapped with Opossum circuit breakers. If the EHR API times out, partitions, or crashes, the system fails closed immediately to `BLOCK`, alerting the OR team that automated verification is unavailable.
- **Atomic Single-Use State:** OAuth PKCE verifiers use Redis `GETDEL` to prevent authorization code replay attacks.
- **Dual Export Compliance:** Generates both modern USCDI-compliant FHIR R4 `Composition` Document Bundles (LOINC `81218-0`) and legacy HL7 CDA XML documents for broader EHR compatibility.

### 2. Assumptions Made
1. **SMART Authorization Flow:** The host EHR supports the SMART App Launch Framework (v1 or v2) with authorization code exchange and PKCE (`S256`).
2. **Laboratory Recency Window:** A 24-hour cutoff was adopted as the standard perioperative window for coagulation parameters (Platelets, INR, PT). Labs older than 24 hours require human surgical judgment (`MANUAL_REVIEW`).
3. **Non-Overridable Blocks:** A `BLOCK` indicates a definitive surgical contraindication (e.g., severe penicillin anaphylaxis with beta-lactam prophylaxis, or completely missing surgical consent). These cannot be overridden in software without resolving the clinical conflict.
4. **Cross-Site Iframe Session Propagation:** Because EHR systems render SMART apps in cross-origin iframes where modern browsers block third-party cookies by default, the app propagates session tokens via custom `x-session-id` headers alongside standard cookies.

### 3. What I Would Improve With More Time
1. **Event-Driven CDS Hooks:** Implement SMART CDS Hooks (such as `order-select` and `patient-view`) to proactively evaluate safety rules at the moment surgery is scheduled in the EHR, hours or days before the patient reaches the operating room.
2. **Asymmetric SMART v2 Authentication:** Add support for private key JWT (`client_secret_jwt` / `private_key_jwt`) and mTLS client certificates to satisfy stringent TEFCA and 21st Century Cures Act healthcare security standards.
3. **FHIR Terminology Service Integration:** Integrate an external FHIR Terminology Service (using `$subsumes` and `$lookup` operations) to dynamically resolve hierarchical SNOMED and LOINC relationships rather than relying solely on local crosswalks.
4. **FHIR Bulk Data API ($export):** Implement bulk data processing to evaluate pre-surgical safety gates for entire daily operating room slates in advance.

---

## Technology Stack

- **Backend:** Node.js, Express, TypeScript, Opossum (Circuit Breaker)
- **Database & ORM:** PostgreSQL 16, Prisma ORM
- **Session & In-Memory Store:** Redis 7 (with atomic single-use PKCE `GETDEL`)
- **Frontend:** React 19, Vite, Tailwind CSS, Lucide Icons
- **Standards & Formats:** SMART on FHIR R4, USCDI v1/v3, LOINC, SNOMED-CT, CPT, RxNorm, HL7 CDA XML
- **Orchestration & Testing:** Docker, Docker Compose, TypeScript E2E Integration Suite

---

## Project Structure

```
.
├── docker-compose.yml              # PostgreSQL, Redis, Server, and Client services
├── package.json                    # Monorepo root scripts (npm test, build, dev)
├── server/
│   ├── Dockerfile                  # Alpine Node 22 image with Prisma deployment
│   ├── prisma/
│   │   ├── schema.prisma           # ChecklistRun, AuditEvent, TerminologyCache models
│   │   └── migrations/             # Versioned PostgreSQL migration files
│   └── src/
│       ├── app.ts                  # Express application factory & middleware setup
│       ├── server.ts               # Server entrypoint and health probe
│       ├── lib/
│       │   ├── circuitBreaker.ts   # Opossum circuit breaker with fail-closed fallback
│       │   ├── fhirClient.ts       # FHIR R4 resource client (Promise.allSettled)
│       │   ├── prisma.ts           # Prisma database client
│       │   ├── redis.ts            # Redis client connection wrapper
│       │   ├── safetyGate.ts       # Deterministic safety gate state machine
│       │   ├── sessionStore.ts     # PKCE verifier and session management
│       │   ├── uscdiExport.ts      # FHIR Composition & HL7 CDA XML generators
│       │   └── rules/
│       │       ├── allergyMatcher.ts   # RxNorm beta-lactam cross-reactivity checks
│       │       ├── consentMatcher.ts   # FHIR Consent status & treatment scope checks
│       │       ├── crosswalk.ts        # SNOMED-to-CPT surgical indication crosswalk
│       │       ├── labThresholds.ts    # LOINC coagulation ranges & recency checks
│       │       └── ruleEngine.ts       # Orchestrator for all 4 safety checks
│       ├── routes/
│       │   ├── auth.routes.ts          # SMART launch, OAuth callback, /api/auth/me
│       │   └── safetyGate.routes.ts    # Run gate, override, export document endpoints
│       └── scripts/
│           └── verify-e2e.ts       # Comprehensive 7-scenario E2E integration test suite
├── client/
│   ├── Dockerfile                  # Vite development and build container
│   ├── index.html                  # Main SPA entrypoint
│   └── src/
│       ├── App.tsx                 # Main application flowsheet controller
│       ├── components/             # Checklist cards, override modal, export viewer
│       └── services/               # API clients with x-session-id header injection
└── LearningDocs_pre_surgical_safety_gate/ # Learn-by-Building documentation syllabus
```

---

## Getting Started

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/)
- [Node.js](https://nodejs.org/) (v20 or v22)

### 1. Clone & Configure Environment
```bash
git clone https://github.com/mahin273/OT-Pre-Surgical-Safety-Gate.git
cd OT-Pre-Surgical-Safety-Gate
cp .env.example .env
```

Default environment parameters in `.env`:
```env
PORT=4000
NODE_ENV=development
CLIENT_URL=http://localhost:3002
POSTGRES_USER=postgres
POSTGRES_PASSWORD=pass123
POSTGRES_DB=safety_gate
DATABASE_URL=postgresql://postgres:pass123@localhost:5433/safety_gate
REDIS_URL=redis://localhost:6380
```

### 2. Launch with Docker Compose
Start all 4 containers (PostgreSQL, Redis, Express BFF, and React client):
```bash
docker compose up -d --build
```

Verify service health:
```bash
curl http://localhost:4000/health
```
Response:
```json
{
  "status": "UP",
  "services": {
    "postgres": { "status": "UP", "latencyMs": 15 },
    "redis": { "status": "UP", "latencyMs": 2 }
  }
}
```

### 3. Launch from SMART App Launcher
1. Open the [SMART Health IT Launcher](https://launch.smarthealthit.org/).
2. Select **EHR Launch**.
3. Set **App Launch URL** to: `http://localhost:4000/launch`
4. Set **Redirect URL** to: `http://localhost:4000/callback`
5. Choose any patient and clinical practitioner, then click **Launch App**.
6. The EHR launcher initiates the OAuth PKCE handshake, and redirects into the embedded safety flowsheet on `http://localhost:3002`.

---

## Running Automated Integration Tests

The project includes an end-to-end integration test suite (`verify-e2e.ts`) that runs against an ephemeral in-process SMART on FHIR upstream server and live PostgreSQL/Redis databases.

Run the test suite:
```bash
npm test
```

The test validates 7 automated clinical scenarios:
1. **SMART on FHIR OAuth Handshake:** PKCE code challenge verification and Redis session creation.
2. **Clean Pre-Surgical Run (Happy Path):** Valid procedure, consent, recent coagulation labs, and no allergies yields terminal `PASS`.
3. **Standardized Clinical Document Exports:** USCDI FHIR R4 `Composition` Bundle (LOINC `81218-0`), legacy HL7 CDA XML, and formatted HTML summaries.
4. **Antibiotic Allergy Interlock:** Active penicillin allergy triggers beta-lactam cross-reactivity hazard and terminal `BLOCK`.
5. **Stale Coagulation Labs & Attending Surgeon Override:** Labs exceeding 24 hours trigger `MANUAL_REVIEW`. Blank override reason returns HTTP 400. Valid medical justification transitions status to `PASS` and logs `CLINICAL_OVERRIDE` event.
6. **Fail-Closed Circuit Breaker:** Simulates sudden upstream EHR network partition; circuit breaker executes fallback and terminates in hard `BLOCK`.
7. **Security Boundary Enforcement:** Unauthenticated requests without session credentials return HTTP 401 Unauthorized.

---

## Viewing Stored Clinical Data

- **Interactive PostgreSQL CLI:**
  ```bash
  docker exec -it safety-gate-postgres psql -U postgres -d safety_gate -c 'SELECT id, "patientId", "procedureCpt", status, "createdAt" FROM "ChecklistRun";'
  ```

- **Visual Database Studio (Prisma Studio):**
  ```bash
  cd server && npx prisma studio
  ```
  Open `http://localhost:5555` to view `ChecklistRun`, `AuditEvent`, and `TerminologyCache` tables.

- **Real-Time Redis Command Monitor:**
  ```bash
  docker exec -it safety-gate-redis redis-cli monitor
  ```

---

## License

MIT License. Built for clinical educational and healthcare integration research purposes.
