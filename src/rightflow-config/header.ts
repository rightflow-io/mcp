import type { Environment } from "./env.ts";

/**
 * The first line of every tool result: which rightflow and which firm the
 * answer is about. A session that believes it is on development while pointed at
 * production is the mistake this line exists to make visible.
 */
export function header(env: Environment, firm?: { name: string } | null, team?: { name: string } | null): string {
  const parts = [`rightflow ${env.label}${env.overridden ? " (custom endpoints)" : ""}`];
  parts.push(firm ? `firm "${firm.name}"` : "no firm selected");
  if (team) parts.push(`team "${team.name}"`);
  return `[${parts.join(" · ")}]`;
}
