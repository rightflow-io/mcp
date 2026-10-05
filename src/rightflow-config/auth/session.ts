import type { Environment } from "../env.ts";
import { UserFacingError } from "../errors.ts";
import { awaitCallback } from "./loopback.ts";
import {
  authorizationUrl,
  exchangeCode,
  organizationIdsFromIdToken,
  organizationToken,
  revokeRefreshToken,
  type Fetch,
} from "./oidc.ts";
import { createPkcePair, createState } from "./pkce.ts";
import type { SessionStore, StoredSession } from "./store.ts";

/** Refresh this long before expiry, so a token never runs out in the middle of a call. */
const EXPIRY_MARGIN_MS = 60_000;

export interface SessionOptions {
  fetch?: Fetch;
  /** Opens the sign-in page; failing to open is not an error, the URL is also returned. */
  openBrowser?: (url: string) => void;
  callbackPorts?: readonly number[];
  callbackTimeoutMs?: number;
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
   * Runs the browser sign-in and keeps the login. `onUrl` receives the page to
   * open before the wait starts, so the caller can show it if no browser opens.
   * No firm is selected yet: which one is a decision the person makes.
   */
  async signIn(onUrl: (url: string) => void = () => undefined): Promise<StoredSession> {
    const pkce = createPkcePair();
    const state = createState();
    const callback = await awaitCallback(state, {
      ...(this.opts.callbackPorts ? { ports: this.opts.callbackPorts } : {}),
      ...(this.opts.callbackTimeoutMs ? { timeoutMs: this.opts.callbackTimeoutMs } : {}),
    });
    let code: string;
    try {
      const url = authorizationUrl(this.env, { redirectUri: callback.redirectUri, challenge: pkce.challenge, state });
      onUrl(url);
      this.opts.openBrowser?.(url);
      code = await callback.code;
    } finally {
      callback.close();
    }
    const tokens = await exchangeCode(
      this.env,
      { code, verifier: pkce.verifier, redirectUri: callback.redirectUri },
      this.fetchImpl,
    );
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
