import crypto from 'node:crypto';

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface SmartEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface ExchangeTokenParams {
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  patient?: string;
  fhirUser?: string;
  id_token?: string;
}

/**
 * Generates a cryptographically random PKCE verifier and its SHA-256 challenge.
 */
export function generatePkce(): PkcePair {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

/**
 * Discovers SMART OAuth authorization and token endpoints for an EHR FHIR server.
 * First checks .well-known/smart-configuration, then falls back to /metadata CapabilityStatement.
 */
export async function discoverEndpoints(iss: string): Promise<SmartEndpoints> {
  const cleanIss = iss.replace(/\/+$/, '');
  const wellKnownUrl = `${cleanIss}/.well-known/smart-configuration`;

  try {
    const res = await fetch(wellKnownUrl, {
      headers: { Accept: 'application/json' },
    });

    if (res.ok) {
      const config = (await res.json()) as {
        authorization_endpoint?: string;
        token_endpoint?: string;
      };

      if (config.authorization_endpoint && config.token_endpoint) {
        return {
          authorizationEndpoint: config.authorization_endpoint,
          tokenEndpoint: config.token_endpoint,
        };
      }
    }
  } catch {
    // Proceed to CapabilityStatement fallback
  }

  // Fallback: Read FHIR CapabilityStatement (/metadata)
  const metadataUrl = `${cleanIss}/metadata`;
  try {
    const res = await fetch(metadataUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`CapabilityStatement request failed with status ${res.status}`);
    }

    const statement = (await res.json()) as any;
    const rest = statement?.rest?.[0];
    const security = rest?.security;
    const extensions: any[] = security?.extension || [];

    const oauthExtension = extensions.find(
      (ext) =>
        ext.url === 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris'
    );

    if (oauthExtension?.extension) {
      let authUri: string | undefined;
      let tokenUri: string | undefined;

      for (const subExt of oauthExtension.extension) {
        if (subExt.url === 'authorize') {
          authUri = subExt.valueUri;
        } else if (subExt.url === 'token') {
          tokenUri = subExt.valueUri;
        }
      }

      if (authUri && tokenUri) {
        return {
          authorizationEndpoint: authUri,
          tokenEndpoint: tokenUri,
        };
      }
    }
  } catch (err: any) {
    throw new Error(
      `Failed to discover SMART OAuth endpoints from ${cleanIss}: ${err.message}`
    );
  }

  throw new Error(`SMART OAuth endpoints not found in metadata or well-known for ${cleanIss}`);
}

/**
 * Exchanges the temporary authorization code for an EHR access token and clinical context
 * via backchannel HTTP POST.
 */
export async function exchangeCodeForToken(
  tokenEndpoint: string,
  params: ExchangeTokenParams
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(
      `Token exchange failed with status ${res.status}: ${errorBody}`
    );
  }

  return (await res.json()) as OAuthTokenResponse;
}
