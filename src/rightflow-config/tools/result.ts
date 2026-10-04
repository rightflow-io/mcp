import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Environment } from "../env.ts";
import { UserFacingError } from "../errors.ts";
import { header } from "../header.ts";

export type ToolResult = CallToolResult;

export interface ToolOutcome {
  firm: { name: string } | null;
  team?: { name: string } | null;
  text: string;
}

/**
 * Runs a tool body and shapes its answer: the header first, always. A refusal
 * the person can act on is shown as written; anything unexpected is reported
 * without its stack, which goes to stderr for whoever debugs the plugin.
 */
export async function run(env: Environment, body: () => Promise<ToolOutcome>): Promise<ToolResult> {
  try {
    const out = await body();
    return { content: [{ type: "text", text: `${header(env, out.firm, out.team ?? null)}\n${out.text}` }] };
  } catch (err) {
    if (err instanceof UserFacingError) {
      return { isError: true, content: [{ type: "text", text: `${header(env)}\n${err.message}` }] };
    }
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `${header(env)}\nSomething went wrong inside the plugin: ${message}` }],
    };
  }
}
