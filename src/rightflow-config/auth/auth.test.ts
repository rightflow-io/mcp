import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../env.ts";
import { UserFacingError } from "../errors.ts";
import { awaitCallback, escapeHtml } from "./loopback.ts";
import { authorizationUrl, organizationIdsFromIdToken, organizationToken, type Fetch } from "./oidc.ts";
import { createPkcePair } from "./pkce.ts";
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

test("the PKCE challenge is the S256 of the verifier", () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(challenge, verifier);
});

test("the authorization URL asks for organizations and PKCE", () => {
  const url = new URL(authorizationUrl(ENV, { redirectUri: "http://127.0.0.1:1/callback", challenge: "c", state: "s" }));
  assert.equal(url.origin + url.pathname, "https://auth.test.invalid/oidc/auth");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope") ?? "", /offline_access/);
  assert.match(url.searchParams.get("scope") ?? "", /urn:logto:scope:organizations/);
});

test("no client id means a plain refusal, not a broken request", () => {
  assert.throws(
    () => authorizationUrl({ ...ENV, clientId: null }, { redirectUri: "x", challenge: "c", state: "s" }),
    UserFacingError,
  );
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

test("the loopback callback accepts its own state and nothing else", async () => {
  const ok = await awaitCallback("expected", { ports: [53790, 53791], timeoutMs: 5000 });
  const res = await fetch(`${ok.redirectUri}?code=abc&state=expected`);
  assert.equal(res.status, 200);
  assert.equal(await ok.code, "abc");

  // A forged answer or a stray error is turned away without ending the wait.
  const second = await awaitCallback("expected", { ports: [53792, 53793], timeoutMs: 5000 });
  assert.equal((await fetch(`${second.redirectUri}?code=forged&state=forged`)).status, 400);
  assert.equal((await fetch(`${second.redirectUri}?error=access_denied`)).status, 400);
  assert.equal((await fetch(`${second.redirectUri}?code=real&state=expected`)).status, 200);
  assert.equal(await second.code, "real");

  const refused = await awaitCallback("expected", { ports: [53794, 53795], timeoutMs: 5000 });
  const rejected = assert.rejects(refused.code, UserFacingError);
  assert.equal((await fetch(`${refused.redirectUri}?error=access_denied&state=expected`)).status, 400);
  await rejected;
});

test("text placed in the callback page is escaped", () => {
  assert.equal(escapeHtml(`<script>"x"&'y'</script>`), "&#60;script&#62;&#34;x&#34;&#38;&#39;y&#39;&#60;/script&#62;");
});
