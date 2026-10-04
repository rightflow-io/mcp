import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api } from "../api.ts";
import type { Session } from "../auth/session.ts";
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

  let finishBrowser!: (s: StoredSession) => void;
  let signIns = 0;
  const login: StoredSession = { version: 1, refreshToken: "r", organizationIds: ["firm-1"], signedInAt: "t" };
  const session = {
    env: resolveEnvironment({}),
    signIn: (onUrl: (url: string) => void) => {
      signIns += 1;
      onUrl("https://sign-in.test.invalid/start");
      return new Promise<StoredSession>((resolve) => {
        finishBrowser = resolve;
      });
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
  return { call, finish: () => finishBrowser(login), signIns: () => signIns };
}

test("a sign-in finished after sign_in returned its link is picked up by the next call", async () => {
  const h = harness();
  assert.match(await h.call("sign_in"), /sign-in\.test\.invalid\/start/);
  h.finish();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(await h.call("sign_in"), /Now working on Firm A/);
  assert.equal(h.signIns(), 1);
});

test("a second sign_in while the browser is still open waits for the same sign-in", async () => {
  const h = harness();
  await h.call("sign_in");
  await h.call("sign_in");
  assert.equal(h.signIns(), 1);
});
