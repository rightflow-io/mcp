import type { Environment } from "../env.ts";
import { UserFacingError } from "../errors.ts";

export type Fetch = typeof fetch;

// Only what the plugin reads: a refresh token, the firms on the ID token, and
// the organizations resource so that a refresh can be exchanged for one firm's
// token.
const SCOPE = "openid offline_access urn:logto:scope:organizations";
const ORGANIZATIONS_RESOURCE = "urn:logto:resource:organizations";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Token requests run while the sign-in lock is held, so they must end well before
 * another session would take that lock as abandoned (`STALE_LOCK_MS`).
 */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  idToken?: string;
}

/** A sign-in waiting for the person to confirm its code in a browser. */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  /** Where the person enters the code. */
  verificationUri: string;
  /** The same page with the code filled in, when the service offers one. */
  verificationUriComplete: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  intervalMs: number;
}

export type DevicePoll =
  | { status: "done"; tokens: TokenSet }
  | { status: "pending" }
  /** The service asks to be polled less often. */
  | { status: "slow_down" };

export function requireClientId(env: Environment): string {
  if (!env.clientId) {
    throw new UserFacingError(
      `Signing in to ${env.label} is not available in this version of the plugin yet. ` +
        "Update the plugin with /plugin, or ask rightflow when it will be.",
    );
  }
  return env.clientId;
}

/**
 * Starts a device sign-in (RFC 8628). It needs nothing to come back to this
 * machine, so it works the same where the plugin runs without the person's
 * browser — a cloud session — as on their own computer.
 */
export async function startDeviceAuthorization(env: Environment, fetchImpl: Fetch = fetch): Promise<DeviceAuthorization> {
  const clientId = requireClientId(env);
  const endpoint = await deviceAuthorizationEndpoint(env, fetchImpl);
  const { res, json } = await post(env, endpoint, { client_id: clientId, scope: SCOPE, resource: ORGANIZATIONS_RESOURCE }, fetchImpl);
  if (!res.ok) throw refusal(env, res.status, json);
  if (
    typeof json !== "object" ||
    json === null ||
    !("device_code" in json) ||
    !("user_code" in json) ||
    !("verification_uri" in json) ||
    typeof json.device_code !== "string" ||
    typeof json.user_code !== "string" ||
    typeof json.verification_uri !== "string"
  ) {
    throw new Error("Malformed device authorization response.");
  }
  const d = json as Record<string, unknown>;
  const expiresIn = typeof d.expires_in === "number" ? d.expires_in : 600;
  const interval = typeof d.interval === "number" ? d.interval : 5;
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    verificationUriComplete: typeof d.verification_uri_complete === "string" ? d.verification_uri_complete : null,
    expiresAt: Date.now() + expiresIn * 1000,
    intervalMs: interval * 1000,
  };
}

/** One poll of a device sign-in. Ends in tokens, a wait, or a refusal the person can read. */
export async function pollDeviceToken(env: Environment, deviceCode: string, fetchImpl: Fetch = fetch): Promise<DevicePoll> {
  const body = { grant_type: DEVICE_CODE_GRANT, client_id: requireClientId(env), device_code: deviceCode };
  const { res, json } = await post(env, `${env.authUrl}/oidc/token`, body, fetchImpl);
  if (res.ok) return { status: "done", tokens: tokenSet(env, json, undefined) };
  switch (errorOf(json).code) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "expired_token":
      throw new UserFacingError("The sign-in code expired before it was confirmed. Call sign_in to get a new one.");
    case "access_denied":
      throw new UserFacingError("The sign-in was declined in the browser. Call sign_in to try again.");
    default:
      throw refusal(env, res.status, json);
  }
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
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function tokenRequest(env: Environment, body: Record<string, string>, fetchImpl: Fetch): Promise<TokenSet> {
  const { res, json } = await post(env, `${env.authUrl}/oidc/token`, body, fetchImpl);
  if (!res.ok) {
    if (errorOf(json).code === "invalid_grant") {
      throw new UserFacingError(`Your sign-in to ${env.label} has expired. Call sign_in to sign in again.`);
    }
    throw refusal(env, res.status, json);
  }
  return tokenSet(env, json, body.refresh_token);
}

async function deviceAuthorizationEndpoint(env: Environment, fetchImpl: Fetch): Promise<string> {
  let json: unknown;
  try {
    const res = await fetchImpl(`${env.authUrl}/oidc/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    json = res.ok ? parseOrNull(await res.text()) : null;
  } catch {
    throw unreachable(env);
  }
  if (typeof json === "object" && json !== null && "device_authorization_endpoint" in json) {
    const endpoint = json.device_authorization_endpoint;
    if (typeof endpoint === "string" && endpoint.startsWith(`${env.authUrl}/`)) return endpoint;
  }
  throw new UserFacingError(`The ${env.label} sign-in service does not offer sign-in with a code.`);
}

async function post(
  env: Environment,
  url: string,
  body: Record<string, string>,
  fetchImpl: Fetch,
): Promise<{ res: Response; json: unknown }> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    // Parse errors quote their input, and this input can be a token: never let one surface.
    return { res, json: parseOrNull(await res.text()) };
  } catch {
    throw unreachable(env);
  }
}

function tokenSet(env: Environment, json: unknown, previousRefreshToken: string | undefined): TokenSet {
  if (typeof json !== "object" || json === null) throw new Error("Malformed token response.");
  const t = json as Record<string, unknown>;
  if (typeof t.access_token !== "string" || typeof t.expires_in !== "number") {
    throw new Error("Malformed token response.");
  }
  const refreshToken = typeof t.refresh_token === "string" ? t.refresh_token : previousRefreshToken;
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

function unreachable(env: Environment): UserFacingError {
  return new UserFacingError(`Could not reach the ${env.label} sign-in service (${env.authUrl}). Check the connection and try again.`);
}

/**
 * The service's own words for a refusal. Its error code and description name a
 * setting ("requested scope is not allowed"), never a credential, and without
 * them a refusal cannot be told apart from the next one.
 */
function refusal(env: Environment, status: number, json: unknown): UserFacingError {
  const { code, description } = errorOf(json);
  const detail = [code, description].filter(Boolean).join(": ");
  return new UserFacingError(`The ${env.label} sign-in service refused the request (${status}${detail ? `, ${detail}` : ""}).`);
}

function errorOf(json: unknown): { code: string | null; description: string | null } {
  if (typeof json !== "object" || json === null) return { code: null, description: null };
  const e = json as Record<string, unknown>;
  const code = typeof e.error === "string" && /^[a-z_]{1,64}$/.test(e.error) ? e.error : null;
  const description =
    typeof e.error_description === "string" ? e.error_description.replace(/[^\x20-\x7e]/g, " ").slice(0, 200).trim() || null : null;
  return { code, description };
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  const claims = parseOrNull(Buffer.from(payload, "base64url").toString("utf8"));
  if (typeof claims !== "object" || claims === null || !("organizations" in claims)) return [];
  const orgs = claims.organizations;
  return Array.isArray(orgs) ? orgs.filter((o): o is string => typeof o === "string") : [];
}
