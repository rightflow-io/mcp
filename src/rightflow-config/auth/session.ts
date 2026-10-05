import type { Environment } from "../env.ts";
import { UserFacingError } from "../errors.ts";
import {
  organizationIdsFromIdToken,
  organizationToken,
  pollDeviceToken,
  revokeRefreshToken,
  startDeviceAuthorization,
  type Fetch,
  type TokenSet,
} from "./oidc.ts";
import type { SessionStore, StoredSession } from "./store.ts";

/** Refresh this long before expiry, so a token never runs out in the middle of a call. */
const EXPIRY_MARGIN_MS = 60_000;

export interface SessionOptions {
  fetch?: Fetch;
  /** Opens the sign-in page; failing to open is not an error, the link and code are also returned. */
  openBrowser?: (url: string) => void;
  /** Overrides the service's polling interval; for tests. */
  pollIntervalMs?: number;
}

/** A sign-in waiting for the person to confirm its code. */
export interface PendingSignIn {
  userCode: string;
  /** The page to open; carries the code where the service allows it. */
  url: string;
  /** Where the code is typed in by hand. */
  verificationUri: string;
  /** Never rejects, so an outcome nobody is waiting for is kept rather than reported as unhandled. */
  done: Promise<{ ok: true; session: StoredSession } | { ok: false; error: unknown }>;
}

/**
 * The plugin's sign-in: one login per environment, and a token for whichever of
 * the login's firms is selected. Tokens never leave this module except as an
 * Authorization header.
 */
export class Session {
  readonly env: Environment;
  private readonly store: SessionStore;
  private readonly fetchImpl: Fetch;
  private readonly opts: SessionOptions;

  constructor(env: Environment, store: SessionStore, opts: SessionOptions = {}) {
    this.env = env;
    this.store = store;
    this.fetchImpl = opts.fetch ?? fetch;
    this.opts = opts;
  }

  current(): Promise<StoredSession | null> {
    return this.store.read();
  }

  /**
   * Starts a sign-in with a code and returns as soon as there is a code to show:
   * the person confirms it in any browser, so this works where no browser can
   * reach the plugin. `done` settles once they have, or the code has expired.
   * No firm is selected yet: which one is a decision the person makes.
   */
  async startSignIn(): Promise<PendingSignIn> {
    const device = await startDeviceAuthorization(this.env, this.fetchImpl);
    const url = device.verificationUriComplete ?? device.verificationUri;
    this.opts.openBrowser?.(url);
    const done = this.awaitDevice(device.deviceCode, device.expiresAt, this.opts.pollIntervalMs ?? device.intervalMs)
      .then((tokens) => this.keepLogin(tokens))
      .then(
        (session) => ({ ok: true as const, session }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    return { userCode: device.userCode, url, verificationUri: device.verificationUri, done };
  }

  private async awaitDevice(deviceCode: string, expiresAt: number, intervalMs: number): Promise<TokenSet> {
    let interval = intervalMs;
    for (;;) {
      await delay(interval);
      if (Date.now() > expiresAt) {
        throw new UserFacingError("The sign-in code expired before it was confirmed. Call sign_in to get a new one.");
      }
      const poll = await pollDeviceToken(this.env, deviceCode, this.fetchImpl);
      if (poll.status === "done") return poll.tokens;
      // RFC 8628: each slow_down adds five seconds for the rest of this sign-in.
      if (poll.status === "slow_down") interval += 5_000;
    }
  }

  private async keepLogin(tokens: TokenSet): Promise<StoredSession> {
    const organizationIds = tokens.idToken ? organizationIdsFromIdToken(tokens.idToken) : [];
    if (organizationIds.length === 0) {
      throw new UserFacingError(`This login does not belong to any firm in ${this.env.label}.`);
    }
    const session: StoredSession = {
      version: 1,
      refreshToken: tokens.refreshToken,
      organizationIds,
      signedInAt: new Date().toISOString(),
    };
    await this.store.write(session);
    return session;
  }

  /** Selects one of the login's firms and fetches its token. */
  async selectFirm(organizationId: string, organizationName: string): Promise<StoredSession> {
    return this.store.withLock(async () => {
      const session = await this.requireLogin();
      if (!session.organizationIds.includes(organizationId)) {
        throw new UserFacingError("This login does not belong to that firm.");
      }
      const tokens = await organizationToken(
        this.env,
        { refreshToken: session.refreshToken, organizationId },
        this.fetchImpl,
      );
      const next: StoredSession = {
        ...session,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.expiresAt,
        organizationId,
        organizationName,
      };
      await this.store.write(next);
      return next;
    });
  }

  /**
   * A token for `organizationId` without selecting it — used once, right after
   * sign-in, to ask the API which firms the login belongs to and what they are
   * called. Persists the rotated refresh token.
   */
  async probeToken(organizationId: string): Promise<string> {
    return this.store.withLock(async () => {
      const session = await this.requireLogin();
      const tokens = await organizationToken(
        this.env,
        { refreshToken: session.refreshToken, organizationId },
        this.fetchImpl,
      );
      await this.store.write({ ...session, refreshToken: tokens.refreshToken });
      return tokens.accessToken;
    });
  }

  /** The selected firm's token, refreshed under the lock when it is about to expire. */
  async accessToken(): Promise<{ token: string; session: StoredSession & { organizationId: string } }> {
    const fresh = (s: StoredSession | null) =>
      s?.accessToken && s.organizationId && (s.accessTokenExpiresAt ?? 0) - EXPIRY_MARGIN_MS > Date.now();

    const before = await this.store.read();
    if (before && fresh(before)) return withFirm(before);

    return this.store.withLock(async () => {
      // Another session may have refreshed while this one waited for the lock.
      const session = await this.requireLogin();
      if (fresh(session)) return withFirm(session);
      if (!session.organizationId) throw noFirm(this.env);
      const tokens = await organizationToken(
        this.env,
        { refreshToken: session.refreshToken, organizationId: session.organizationId },
        this.fetchImpl,
      );
      const next: StoredSession = {
        ...session,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.expiresAt,
      };
      await this.store.write(next);
      return withFirm(next);
    });
  }

  /** Deletes the saved login and asks the sign-in service to revoke it. Returns whether the revocation was confirmed. */
  async signOut(): Promise<boolean> {
    // Under the lock, so a refresh in another session cannot write a new token back after the clear.
    const session = await this.store.withLock(async () => {
      const saved = await this.store.read().catch(() => null);
      await this.store.clear();
      return saved;
    });
    return session ? revokeRefreshToken(this.env, session.refreshToken, this.fetchImpl) : true;
  }

  private async requireLogin(): Promise<StoredSession> {
    const session = await this.store.read();
    if (!session) throw new UserFacingError(`Not signed in to ${this.env.label}. Call sign_in.`);
    return session;
  }
}

function withFirm(session: StoredSession): { token: string; session: StoredSession & { organizationId: string } } {
  if (!session.accessToken || !session.organizationId) throw new Error("No firm token.");
  return { token: session.accessToken, session: { ...session, organizationId: session.organizationId } };
}

function noFirm(env: Environment): UserFacingError {
  return new UserFacingError(`Signed in to ${env.label}, but no firm is selected. Call use_firm.`);
}

// Not unref'd: a sign-in in progress is a reason to stay alive, and it ends when its code expires.
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
