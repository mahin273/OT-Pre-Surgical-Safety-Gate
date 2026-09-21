import http from 'node:http';
import { createApp } from '../app.js';
import { redis } from '../lib/redis.js';

interface MockEhrState {
  lastReceivedVerifier?: string;
  expectedVerifierHash?: string;
}

const mockState: MockEhrState = {};

function startMockEhrServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);

      if (url.pathname === '/.well-known/smart-configuration') {
        const port = (server.address() as any).port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authorization_endpoint: `http://localhost:${port}/auth/authorize`,
            token_endpoint: `http://localhost:${port}/auth/token`,
            capabilities: ['launch-ehr', 'client-confidential-symmetric', 'context-ehr-patient'],
          })
        );
        return;
      }

      if (url.pathname === '/auth/token' && req.method === 'POST') {
        let rawBody = '';
        req.on('data', (chunk) => {
          rawBody += chunk;
        });

        req.on('end', () => {
          const params = new URLSearchParams(rawBody);
          const grantType = params.get('grant_type');
          const code = params.get('code');
          const verifier = params.get('code_verifier');

          if (grantType !== 'authorization_code' || !code || !verifier) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_request' }));
            return;
          }

          mockState.lastReceivedVerifier = verifier;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'mock-ehr-access-token-999',
              token_type: 'Bearer',
              expires_in: 3600,
              scope: 'launch openid fhirUser patient/Patient.rs',
              patient: 'Patient/mock-pat-001',
              fhirUser: 'Practitioner/mock-doc-042',
              id_token: 'mock-id-token-xyz',
            })
          );
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({ server, port });
    });
  });
}

function startAppServer(app: any): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({ server, port });
    });
  });
}

async function runVerification() {
  console.log('[START] Starting SMART on FHIR EHR Launch & OAuth BFF Verification...');

  // 1. Start mock EHR and App servers
  const { server: mockEhrServer, port: mockEhrPort } = await startMockEhrServer();
  const mockIss = `http://localhost:${mockEhrPort}`;

  const app = createApp();
  const { server: appServer, port: appPort } = await startAppServer(app);
  const appBase = `http://localhost:${appPort}`;

  try {
    // 2. Test Missing 'iss' validation
    console.log('[TEST 1] Testing /launch validation (missing iss parameter)...');
    const res1 = await fetch(`${appBase}/launch`);
    if (res1.status !== 400) {
      throw new Error(`[FAIL] Expected status 400 for missing iss, got: ${res1.status}`);
    }
    const data1 = (await res1.json()) as any;
    if (data1.error !== 'MISSING_ISS') {
      throw new Error(`[FAIL] Expected error code 'MISSING_ISS', got: ${data1.error}`);
    }
    console.log('[PASS] Missing iss rejected with HTTP 400 MISSING_ISS');

    // 3. Test EHR Launch Initiation & PKCE Generation
    console.log('[TEST 2] Testing /launch initiation with dynamic discovery and PKCE...');
    const launchRes = await fetch(
      `${appBase}/launch?iss=${encodeURIComponent(mockIss)}&launch=encounter-test-123`,
      { redirect: 'manual' }
    );

    if (launchRes.status !== 302) {
      throw new Error(`[FAIL] Expected 302 redirect on /launch, got: ${launchRes.status}`);
    }

    const redirectLocation = launchRes.headers.get('location');
    if (!redirectLocation) {
      throw new Error('[FAIL] Missing Location header on /launch redirect');
    }

    const redirectUrl = new URL(redirectLocation);
    const state = redirectUrl.searchParams.get('state');
    const codeChallenge = redirectUrl.searchParams.get('code_challenge');
    const codeChallengeMethod = redirectUrl.searchParams.get('code_challenge_method');
    const aud = redirectUrl.searchParams.get('aud');
    const launchParam = redirectUrl.searchParams.get('launch');

    if (!state || !codeChallenge || codeChallengeMethod !== 'S256') {
      throw new Error('[FAIL] Invalid PKCE parameters in authorization redirect');
    }
    if (aud !== mockIss || launchParam !== 'encounter-test-123') {
      throw new Error('[FAIL] aud or launch parameter mismatch in redirect URL');
    }

    console.log(`[PASS] /launch successfully generated PKCE and state=${state.substring(0, 8)}...`);

    // 4. Test OAuth Callback & Token Exchange
    console.log('[TEST 3] Testing /callback token exchange and session establishment...');
    const callbackRes = await fetch(
      `${appBase}/callback?code=test-auth-code-123&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' }
    );

    if (callbackRes.status !== 302) {
      throw new Error(`[FAIL] Expected 302 redirect on /callback, got: ${callbackRes.status}`);
    }

    const setCookieHeader = callbackRes.headers.get('set-cookie');
    if (!setCookieHeader || !setCookieHeader.includes('sid=')) {
      throw new Error('[FAIL] Expected Set-Cookie header containing sid');
    }

    if (!setCookieHeader.toLowerCase().includes('httponly')) {
      throw new Error('[FAIL] Session cookie must have HttpOnly flag set');
    }

    const cookieMatch = setCookieHeader.match(/sid=([^;]+)/);
    const sessionId = cookieMatch ? cookieMatch[1] : '';
    if (!sessionId) {
      throw new Error('[FAIL] Could not parse sessionId from Set-Cookie header');
    }

    if (!mockState.lastReceivedVerifier) {
      throw new Error('[FAIL] Mock EHR did not receive code_verifier during token exchange');
    }

    console.log('[PASS] Token exchange succeeded; httpOnly session cookie established');

    // 5. Test Anti-Replay: Replaying the same state must fail
    console.log('[TEST 4] Testing anti-replay protection (re-submitting the same OAuth state)...');
    const replayRes = await fetch(
      `${appBase}/callback?code=test-auth-code-123&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' }
    );

    if (replayRes.status !== 400) {
      throw new Error(`[FAIL] Expected 400 on replayed state, got: ${replayRes.status}`);
    }
    const replayData = (await replayRes.json()) as any;
    if (replayData.error !== 'INVALID_STATE') {
      throw new Error(`[FAIL] Expected INVALID_STATE error, got: ${replayData.error}`);
    }
    console.log('[PASS] Replayed OAuth state rejected with HTTP 400 INVALID_STATE');

    // 6. Test authGuard: Unauthorized access without session cookie
    console.log('[TEST 5] Testing authGuard rejection without session cookie...');
    const unauthRes = await fetch(`${appBase}/api/auth/me`);
    if (unauthRes.status !== 401) {
      throw new Error(`[FAIL] Expected 401 Unauthorized, got: ${unauthRes.status}`);
    }
    console.log('[PASS] Protected endpoint correctly rejected request without session cookie');

    // 7. Test authGuard: Authorized access with session cookie
    console.log('[TEST 6] Testing authGuard with valid session cookie...');
    const authMeRes = await fetch(`${appBase}/api/auth/me`, {
      headers: { Cookie: `sid=${sessionId}` },
    });

    if (authMeRes.status !== 200) {
      throw new Error(`[FAIL] Expected 200 OK on /api/auth/me, got: ${authMeRes.status}`);
    }

    const sessionData = (await authMeRes.json()) as any;
    if (sessionData.patientId !== 'Patient/mock-pat-001') {
      throw new Error(`[FAIL] Patient ID mismatch: expected Patient/mock-pat-001, got: ${sessionData.patientId}`);
    }
    if (sessionData.fhirUser !== 'Practitioner/mock-doc-042') {
      throw new Error(`[FAIL] fhirUser mismatch: expected Practitioner/mock-doc-042, got: ${sessionData.fhirUser}`);
    }
    if (sessionData.access_token || sessionData.accessToken) {
      throw new Error('[FAIL] Access token leaked to client through /api/auth/me');
    }

    console.log('[PASS] /api/auth/me returned sanitized patient context (access token safely withheld)');

    // 8. Test Logout
    console.log('[TEST 7] Testing /api/auth/logout...');
    const logoutRes = await fetch(`${appBase}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `sid=${sessionId}` },
    });

    if (logoutRes.status !== 200) {
      throw new Error(`[FAIL] Expected 200 on logout, got: ${logoutRes.status}`);
    }

    // 9. Test Session Revocation: Request after logout should fail
    console.log('[TEST 8] Testing session revocation after logout...');
    const postLogoutRes = await fetch(`${appBase}/api/auth/me`, {
      headers: { Cookie: `sid=${sessionId}` },
    });

    if (postLogoutRes.status !== 401) {
      throw new Error(`[FAIL] Expected 401 after logout, got: ${postLogoutRes.status}`);
    }

    console.log('[PASS] Session successfully revoked in Redis; subsequent request returned 401');
    console.log('[SUCCESS] All SMART on FHIR EHR Launch & OAuth BFF assertions passed successfully!');
  } finally {
    // Teardown servers
    mockEhrServer.close();
    appServer.close();
  }
}

runVerification()
  .catch((err) => {
    console.error('[FAIL] Verification script encountered an error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await redis.quit();
  });
