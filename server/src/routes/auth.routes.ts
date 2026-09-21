import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { discoverEndpoints, generatePkce, exchangeCodeForToken, type OAuthTokenResponse } from '../lib/oauth.js';
import { sessionStore } from '../lib/sessionStore.js';
import { authGuard } from '../middleware/auth.js';

export const authRouter = Router();

/**
 * Initiates the SMART on FHIR EHR Launch.
 * Discovers endpoints, generates PKCE, stores state in Redis, and redirects to EHR auth.
 */
authRouter.get('/launch', async (req: Request, res: Response): Promise<void> => {
  const iss = req.query.iss;

  if (!iss || typeof iss !== 'string') {
    res.status(400).json({
      error: 'MISSING_ISS',
      message: "Query parameter 'iss' is required",
    });
    return;
  }

  try {
    const { authorizationEndpoint } = await discoverEndpoints(iss);
    const state = crypto.randomUUID();
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();

    const launch = typeof req.query.launch === 'string' ? req.query.launch : undefined;

    await sessionStore.savePkceState(state, {
      codeVerifier,
      iss,
      launch,
      createdAt: Date.now(),
    });

    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', env.SMART_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', `${env.BFF_BASE_URL}/callback`);
    authUrl.searchParams.set(
      'scope',
      'launch openid fhirUser patient/Patient.rs patient/Condition.rs patient/Observation.rs patient/AllergyIntolerance.rs patient/Consent.rs'
    );
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('aud', iss);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', codeChallengeMethod);

    if (launch) {
      authUrl.searchParams.set('launch', launch);
    }

    res.redirect(authUrl.toString());
  } catch (err: any) {
    console.error('[ERROR] SMART EHR launch initiation failed:', err.message);
    res.status(502).json({
      error: 'EHR_DISCOVERY_FAILED',
      message: 'Failed to fetch SMART configuration',
    });
  }
});

/**
 * Handles the OAuth2 callback from the EHR.
 * Atomically consumes PKCE state, exchanges code for token, and sets httpOnly session cookie.
 */
authRouter.get('/callback', async (req: Request, res: Response): Promise<void> => {
  if (req.query.error) {
    res.status(400).json({
      error: 'OAUTH_ERROR',
      message: String(req.query.error_description || req.query.error),
    });
    return;
  }

  const code = req.query.code;
  const state = req.query.state;

  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).json({
      error: 'INVALID_CALLBACK',
      message: "Query parameters 'code' and 'state' are required",
    });
    return;
  }

  // Atomically consume PKCE state (Anti-Replay)
  const pkce = await sessionStore.consumePkceState(state);
  if (!pkce) {
    res.status(400).json({
      error: 'INVALID_STATE',
      message: 'Invalid or expired OAuth state',
    });
    return;
  }

  let tokenResponse: OAuthTokenResponse;
  try {
    const { tokenEndpoint } = await discoverEndpoints(pkce.iss);
    tokenResponse = await exchangeCodeForToken(tokenEndpoint, {
      code,
      redirectUri: `${env.BFF_BASE_URL}/callback`,
      clientId: env.SMART_CLIENT_ID,
      codeVerifier: pkce.codeVerifier,
    });
  } catch (err: any) {
    console.error('[ERROR] Backchannel token exchange failed:', err.message);
    res.status(502).json({
      error: 'TOKEN_EXCHANGE_FAILED',
      message: 'Failed to exchange authorization code for token',
    });
    return;
  }

  const sessionId = crypto.randomUUID();
  const expiresIn = tokenResponse.expires_in || 3600;

  await sessionStore.createSession(
    sessionId,
    {
      accessToken: tokenResponse.access_token,
      tokenType: tokenResponse.token_type || 'Bearer',
      expiresIn,
      patientId: tokenResponse.patient || '',
      fhirUser: tokenResponse.fhirUser,
      scope: tokenResponse.scope || '',
      idToken: tokenResponse.id_token,
      iss: pkce.iss,
      createdAt: Date.now(),
    },
    expiresIn
  );

  res.cookie('sid', sessionId, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: expiresIn * 1000,
    path: '/',
  });

  res.redirect(env.CLIENT_URL);
});

/**
 * Returns sanitized active session metadata to the frontend.
 * The access token is never exposed to the client.
 */
authRouter.get('/api/auth/me', authGuard, (req: Request, res: Response): void => {
  res.json({
    authenticated: true,
    patientId: req.session?.patientId,
    fhirUser: req.session?.fhirUser,
    scope: req.session?.scope,
    expiresIn: req.session?.expiresIn,
  });
});

/**
 * Logs out the active user, purges Redis session, and deletes the cookie.
 */
authRouter.post('/api/auth/logout', async (req: Request, res: Response): Promise<void> => {
  const sid = req.cookies?.sid;

  if (sid && typeof sid === 'string') {
    await sessionStore.destroySession(sid);
  }

  res.clearCookie('sid', { path: '/' });
  res.json({
    authenticated: false,
    message: 'Logged out successfully',
  });
});
