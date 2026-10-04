import type { Environment } from "../env.ts";
import { UserFacingError } from "../errors.ts";

export type Fetch = typeof fetch;

// The same request rightflow's own web app makes: organization claims in the ID
// token, a refresh token, and the organizations resource so that a refresh can
// then be exchanged for one firm's token.
const SCOPE = "openid profile email offline_access urn:logto:scope:organizations";
const ORGANIZATIONS_RESOURCE = "urn:logto:resource:organizations";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  idToken?: string;
}

export function requireClientId(env: Environment): string {
  if (!env.clientId) {
    throw new UserFacingError(
      `Signing in to ${env.label} is not available in this version of the plugin yet. ` +
        "Update the plugin with /plugin, or ask rightflow when it will be.",
    );
  }
  return env.clientId;
}

export function authorizationUrl(
  env: Environment,
  params: { redirectUri: string; challenge: string; state: string },
): string {
  const query = new URLSearchParams({
    client_id: requireClientId(env),
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: SCOPE,
    resource: ORGANIZATIONS_RESOURCE,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
    prompt: "consent",
  });
  return `${env.authUrl}/oidc/auth?${query.toString()}`;
}

export async function exchangeCode(
  env: Environment,
  params: { code: string; verifier: string; redirectUri: string },
  fetchImpl: Fetch = fetch,
): Promise<TokenSet> {
  return tokenRequest(
    env,
    {
      grant_type: "authorization_code",
      client_id: requireClientId(env),
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    },
    fetchImpl,
  );
}

/** A token for one firm, from the refresh token. The sign-in service may rotate the refresh token. */
export async function organizationToken(
  env: Environment,
  params: { refreshToken: string; organizationId: string },
  fetchImpl: Fetch = fetch,
): Promise<TokenSet> {
  return tokenRequest(
    env,
    {
      grant_type: "refresh_token",
      client_id: requireClientId(env),
      refresh_token: params.refreshToken,
      organization_id: params.organizationId,
    },
    fetchImpl,
  );
}

/** Best effort: a refresh token that is revoked cannot be used even if the file was copied. */
export async function revokeRefreshToken(env: Environment, refreshToken: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  if (!env.clientId) return false;
  try {
    const res = await fetchImpl(`${env.authUrl}/oidc/token/revocation`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: env.clientId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function tokenRequest(env: Environment, body: Record<string, string>, fetchImpl: Fetch): Promise<TokenSet> {
  const res = await fetchImpl(`${env.authUrl}/oidc/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // The service's error code is safe to show; the body is not echoed further.
    const code = safeErrorCode(text);
    if (code === "invalid_grant") {
      throw new UserFacingError(`Your sign-in to ${env.label} has expired. Call sign_in to sign in again.`);
    }
    throw new UserFacingError(`The ${env.label} sign-in service refused the request (${res.status}${code ? `, ${code}` : ""}).`);
  }
  const json: unknown = JSON.parse(text);
  if (typeof json !== "object" || json === null) throw new Error("Malformed token response.");
  const t = json as Record<string, unknown>;
  if (typeof t.access_token !== "string" || typeof t.expires_in !== "number") {
    throw new Error("Malformed token response.");
  }
  const refreshToken = typeof t.refresh_token === "string" ? t.refresh_token : body.refresh_token;
  if (!refreshToken) {
    throw new UserFacingError(`The ${env.label} sign-in service did not grant a lasting sign-in. Try sign_in again.`);
  }
  return {
    accessToken: t.access_token,
    refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
    ...(typeof t.id_token === "string" ? { idToken: t.id_token } : {}),
  };
}

function safeErrorCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return /^[a-z_]{1,64}$/.test(parsed.error) ? parsed.error : null;
    }
  } catch {
    // Not JSON: nothing worth repeating.
  }
  return null;
}

/**
 * The firms a login belongs to, from the ID token's `organizations` claim. The
 * token arrived over TLS straight from the sign-in service and is only used to
 * know which firms to ask about, so its signature is not checked here; the API
 * checks every token it is given.
 */
export function organizationIdsFromIdToken(idToken: string): string[] {
  const payload = idToken.split(".")[1];
  if (!payload) return [];
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (typeof claims !== "object" || claims === null || !("organizations" in claims)) return [];
  const orgs = claims.organizations;
  return Array.isArray(orgs) ? orgs.filter((o): o is string => typeof o === "string") : [];
}
