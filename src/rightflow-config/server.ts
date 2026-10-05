import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Api } from "./api.ts";
import { Session } from "./auth/session.ts";
import { SessionStore } from "./auth/store.ts";
import { dataDirectory, resolveEnvironment, type Environment } from "./env.ts";
import { registerSessionTools } from "./tools/session-tools.ts";
import { registerTeamTools } from "./tools/team-tools.ts";

// stdout carries the protocol. Anything written there by accident would corrupt
// it, so everything else the server says goes to stderr.
console.log = console.error;
console.info = console.error;

const version = pluginVersion();
const server = new McpServer(
  { name: "rightflow-config", version },
  {
    instructions:
      "Tools for setting up and changing a firm's own agent team in rightflow. Every answer starts with the " +
      "environment and firm it is about; say which one when you report results. Call status first when unsure. " +
      "A change goes: pull_team (or new_team) → edit the folder → check_team → show the person every change → " +
      "submit_team with their own summary. rightflow decides what is allowed; report its refusals, never work around them.",
  },
);

let env: Environment | null = null;
try {
  env = resolveEnvironment();
} catch (err) {
  // The server still starts, so the person sees why instead of a server that failed to launch.
  const reason = err instanceof Error ? err.message : String(err);
  server.registerTool(
    "status",
    { title: "rightflow status", description: "Why this plugin cannot work right now.", inputSchema: {} },
    () => ({ isError: true, content: [{ type: "text", text: reason }] }),
  );
}
if (env) {
  const session = new Session(env, new SessionStore(dataDirectory(), env.name), { openBrowser });
  const api = new Api(session);
  registerSessionTools(server, { session, api, version });
  registerTeamTools(server, { session, api });
}

await server.connect(new StdioServerTransport());

function pluginVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
    if (typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string") {
      return manifest.version;
    }
  } catch {
    // Run from source rather than from the installed plugin.
  }
  return "development build";
}

/** Best effort; the sign-in tool also returns the link. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser available: the link is in the tool result.
  }
}
