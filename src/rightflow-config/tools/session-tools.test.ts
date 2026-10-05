import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api } from "../api.ts";
import type { PendingSignIn, Session } from "../auth/session.ts";
import { UserFacingError } from "../errors.ts";
import type { StoredSession } from "../auth/store.ts";
import { resolveEnvironment } from "../env.ts";
import type { Me } from "../me.ts";
import { registerSessionTools } from "./session-tools.ts";
import type { ToolResult } from "./result.ts";

// The sign-in wait does not hold the process open (in the server, stdio does), so
// the tests keep the event loop alive themselves.
let keepAlive: NodeJS.Timeout | undefined;
beforeEach(() => {
  keepAlive = setInterval(() => undefined, 1000);
});
afterEach(() => clearInterval(keepAlive));

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function harness() {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;

  let settle!: (outcome: Awaited<PendingSignIn["done"]>) => void;
  let signIns = 0;
  const login: StoredSession = { version: 1, refreshToken: "r", organizationIds: ["firm-1"], signedInAt: "t" };
  const session = {
    env: resolveEnvironment({}),
    startSignIn: async (): Promise<PendingSignIn> => {
      signIns += 1;
      return {
        userCode: `CODE-${signIns}`,
        url: "https://sign-in.test.invalid/device?user_code=x",
        verificationUri: "https://sign-in.test.invalid/device",
        done: new Promise((resolve) => {
          settle = resolve;
        }),
      };
    },
    probeToken: async () => "probe",
    selectFirm: async () => login,
  } as unknown as Session;

  const me: Me = {
    activeOrganization: { id: "firm-1", name: "Firm A", role: "admin", isAdminOrg: false },
    organizations: [{ id: "firm-1", name: "Firm A", role: "admin", isAdminOrg: false }],
    permissions: [],
    features: {},
  };
  const api = {
    request: async () => ({ status: 200, body: me }),
    requestWithToken: async () => ({ status: 200, body: me }),
  } as unknown as Api;

  registerSessionTools(server, { session, api, version: "test", signInWaitMs: 20 });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`no tool ${name}`);
    const result = await handler(args);
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  };
  return {
    call,
    confirm: () => settle({ ok: true, session: login }),
    expire: () => settle({ ok: false, error: new UserFacingError("The sign-in code expired.") }),
    signIns: () => signIns,
  };
}

test("the first sign_in shows the link and code at once, without waiting", async () => {
  const h = harness();
  const text = await h.call("sign_in");
  assert.match(text, /sign-in\.test\.invalid\/device\?user_code=x/);
  assert.match(text, /Code: CODE-1/);
  assert.equal(h.signIns(), 1);
});

test("the next sign_in picks up the confirmed code instead of starting over", async () => {
  const h = harness();
  await h.call("sign_in");
  h.confirm();
  assert.match(await h.call("sign_in"), /Now working on Firm A/);
  assert.equal(h.signIns(), 1);
});

test("a sign_in before the code is confirmed shows the same code again", async () => {
  const h = harness();
  await h.call("sign_in");
  assert.match(await h.call("sign_in"), /Not confirmed yet[\s\S]*Code: CODE-1/);
  assert.equal(h.signIns(), 1);
});

test("an expired code is reported once, and the call after it starts a new sign-in", async () => {
  const h = harness();
  await h.call("sign_in");
  h.expire();
  assert.match(await h.call("sign_in"), /expired/);
  assert.match(await h.call("sign_in"), /Code: CODE-2/);
});
