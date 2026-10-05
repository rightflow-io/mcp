import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../env.ts";
import { UserFacingError } from "../errors.ts";
import { organizationIdsFromIdToken, organizationToken, pollDeviceToken, startDeviceAuthorization, type Fetch } from "./oidc.ts";
import { Session } from "./session.ts";
import { SessionStore, type StoredSession } from "./store.ts";

const ENV: Environment = {
  name: "development",
  label: "Development",
  apiUrl: "https://api.test.invalid/api",
  authUrl: "https://auth.test.invalid",
  clientId: "public-client",
  overridden: true,
};

const tempDir = () => mkdtemp(join(tmpdir(), "rf-config-"));

function idToken(claims: object): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function tokenEndpoint(responses: Array<{ status?: number; body: object }>, seen: URLSearchParams[] = []): Fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new URLSearchParams(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as Fetch;
}

/** A sign-in service that answers by path: discovery, device authorization, token. */
function signInService(token: Array<{ status?: number; body: object }>, seen: Array<{ path: string; body: URLSearchParams }> = []): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    seen.push({ path, body: new URLSearchParams(String(init?.body ?? "")) });
    if (path === "/oidc/.well-known/openid-configuration") {
      return Response.json({ device_authorization_endpoint: `${ENV.authUrl}/oidc/device/auth` });
    }
    if (path === "/oidc/device/auth") {
      return Response.json({
        device_code: "device-1",
        user_code: "ABCD-EFGH",
        verification_uri: `${ENV.authUrl}/device`,
        verification_uri_complete: `${ENV.authUrl}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 5,
      });
    }
    const next = token.shift();
    if (!next) throw new Error("unexpected request");
    return Response.json(next.body, { status: next.status ?? 200 });
  }) as Fetch;
}

test("a device sign-in asks only for what the plugin reads", async () => {
  const seen: Array<{ path: string; body: URLSearchParams }> = [];
  const device = await startDeviceAuthorization(ENV, signInService([], seen));
  assert.equal(device.userCode, "ABCD-EFGH");
  assert.equal(device.verificationUriComplete, `${ENV.authUrl}/device?user_code=ABCD-EFGH`);
  const request = seen.find((s) => s.path === "/oidc/device/auth")?.body;
  assert.equal(request?.get("client_id"), "public-client");
  assert.equal(request?.get("scope"), "openid offline_access urn:logto:scope:organizations");
  assert.equal(request?.get("resource"), "urn:logto:resource:organizations");
});

test("no client id means a plain refusal, not a broken request", async () => {
  await assert.rejects(startDeviceAuthorization({ ...ENV, clientId: null }, signInService([])), UserFacingError);
});

test("a refusal carries the service's own reason", async () => {
  const f = signInService([{ status: 400, body: { error: "invalid_scope", error_description: "requested scope is not allowed" } }]);
  await assert.rejects(pollDeviceToken(ENV, "device-1", f), (err: unknown) => {
    assert.ok(err instanceof UserFacingError);
    assert.match(err.message, /invalid_scope: requested scope is not allowed/);
    return true;
  });
});

test("waiting, slowing down, expiry and a declined code read as such", async () => {
  const f = signInService([
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down" } },
    { status: 400, body: { error: "expired_token" } },
    { status: 400, body: { error: "access_denied" } },
  ]);
  assert.equal((await pollDeviceToken(ENV, "d", f)).status, "pending");
  assert.equal((await pollDeviceToken(ENV, "d", f)).status, "slow_down");
  await assert.rejects(pollDeviceToken(ENV, "d", f), /expired/);
  await assert.rejects(pollDeviceToken(ENV, "d", f), /declined/);
});

test("a confirmed code becomes a saved login with the firms from the ID token", async () => {
  const store = new SessionStore(await tempDir(), "development");
  const opened: string[] = [];
  const f = signInService([
    { status: 400, body: { error: "authorization_pending" } },
    { body: { access_token: "a", refresh_token: "r1", expires_in: 3600, id_token: idToken({ organizations: ["org-a"] }) } },
  ]);
  const session = new Session(ENV, store, { fetch: f, openBrowser: (u) => opened.push(u), pollIntervalMs: 1 });
  const pending = await session.startSignIn();
  assert.equal(pending.userCode, "ABCD-EFGH");
  assert.deepEqual(opened, [pending.url]);
  const outcome = await pending.done;
  assert.ok(outcome.ok);
  assert.deepEqual((await store.read())?.organizationIds, ["org-a"]);
  assert.equal((await store.read())?.refreshToken, "r1");
});

test("the firms of a login come from the ID token", () => {
  assert.deepEqual(organizationIdsFromIdToken(idToken({ organizations: ["org-a", "org-b", 3] })), ["org-a", "org-b"]);
  assert.deepEqual(organizationIdsFromIdToken(idToken({})), []);
});

test("an expired grant reads as an expired sign-in", async () => {
  const f = tokenEndpoint([{ status: 400, body: { error: "invalid_grant", error_description: "secret detail" } }]);
  await assert.rejects(organizationToken(ENV, { refreshToken: "r", organizationId: "o" }, f), (err: unknown) => {
    assert.ok(err instanceof UserFacingError);
    assert.match(err.message, /expired/);
    assert.doesNotMatch(err.message, /secret detail/);
    return true;
  });
});

test("the saved sign-in is written with mode 0600", async () => {
  const dir = await tempDir();
  const store = new SessionStore(dir, "development");
  await store.write({ version: 1, refreshToken: "r", organizationIds: ["o"], signedInAt: "now" });
  const mode = (await stat(store.path)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await store.read())?.refreshToken, "r");
});

test("a saved file in an unknown format is refused, not trusted", async () => {
  const dir = await tempDir();
  const store = new SessionStore(dir, "development");
  await writeFile(store.path, JSON.stringify({ version: 9 }));
  await assert.rejects(store.read());
});

test("concurrent refreshes spend the refresh token once", async () => {
  const dir = await tempDir();
  const store = new SessionStore(dir, "development");
  const saved: StoredSession = {
    version: 1,
    refreshToken: "r1",
    accessToken: "old",
    accessTokenExpiresAt: Date.now() - 1,
    organizationId: "o",
    organizationName: "Firm",
    organizationIds: ["o"],
    signedInAt: "now",
  };
  await store.write(saved);
  const seen: URLSearchParams[] = [];
  const f = tokenEndpoint([{ body: { access_token: "new", refresh_token: "r2", expires_in: 3600 } }], seen);
  const session = new Session(ENV, store, { fetch: f });
  const [a, b] = await Promise.all([session.accessToken(), session.accessToken()]);
  assert.equal(a.token, "new");
  assert.equal(b.token, "new");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.get("organization_id"), "o");
  assert.equal((await store.read())?.refreshToken, "r2");
});
