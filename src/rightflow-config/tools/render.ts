import type {
  AgentChanges,
  FileChange,
  Finding,
  RevisionDetail,
  RevisionSource,
  RevisionSummary,
  SetupApply,
  SetupCheck,
  SetupLearnings,
  SetupReference,
} from "../setup-api.ts";

/**
 * How much diff text one answer carries. Every changed path is always listed;
 * past this, diffs are named and shown on request, so one large change cannot
 * crowd the rest of the answer out of the conversation.
 */
export const DIFF_BUDGET_CHARS = 40_000;

const STATUS_MARK: Record<FileChange["status"], string> = { added: "+", modified: "~", deleted: "-" };

export function renderChanges(changes: FileChange[], only?: readonly string[], budget = DIFF_BUDGET_CHARS): string {
  if (changes.length === 0) return "Files: nothing changes.";
  const lines = [`Files (${changes.length}):`, ...changes.map((c) => `${STATUS_MARK[c.status]} ${c.path}`)];
  const wanted = only && only.length > 0 ? changes.filter((c) => only.includes(c.path)) : changes;
  const unknown = (only ?? []).filter((p) => !changes.some((c) => c.path === p));
  if (unknown.length > 0) lines.push("", `Not among the changed files: ${unknown.join(", ")}`);

  let used = 0;
  const left: string[] = [];
  for (const c of wanted) {
    if (c.unified === "" || used + c.unified.length > budget) {
      if (c.unified !== "") left.push(c.path);
      continue;
    }
    used += c.unified.length;
    lines.push("", "```diff", c.unified.trimEnd(), "```");
    if (c.truncated) lines.push(`(rightflow cut the diff of ${c.path} short; the file itself is complete.)`);
  }
  if (left.length > 0) {
    lines.push("", `Diffs not shown here, to keep this answer readable: ${left.join(", ")}. Ask for them with \`paths\`.`);
  }
  return lines.join("\n");
}

function renderFindings(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) return [];
  return [title, ...findings.map((f) => `- ${f.path ? `${f.path}: ` : ""}${f.message}`)];
}

export function renderAgents(a: AgentChanges): string | null {
  const parts = [
    a.created.length ? `new: ${a.created.join(", ")}` : null,
    a.updated.length ? `changed: ${a.updated.join(", ")}` : null,
    a.deleted.length ? `removed: ${a.deleted.join(", ")}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? `Agents — ${parts.join("; ")}.` : null;
}

export function renderCheck(check: SetupCheck, only?: readonly string[]): string {
  const out: string[] = [];
  if (check.stale) {
    out.push(
      "The team changed in rightflow since this folder was pulled, so this change would be refused. " +
        "Pull the team into a new folder, carry the change across, and check again.",
    );
  }
  out.push(check.ok ? "rightflow would accept this change." : "rightflow would not accept this change as it is:");
  out.push(...renderFindings("Not allowed:", check.refusals));
  out.push(...renderFindings("Case fields with errors:", check.lint.errors));
  if (check.lint.advisories.length > 0) {
    out.push("Worth a look (not blocking):", ...check.lint.advisories.map((a) => `- ${a.path}: ${a.values.join(", ")}`));
  }
  if (check.missingLetterheads.length > 0) {
    out.push(
      "Letter templates name a letterhead the firm does not have yet:",
      ...check.missingLetterheads.map((m) => `- ${m.letterhead}: ${m.templates.join(", ")}`),
    );
  }
  if (check.absorbRules.length > 0) {
    out.push(
      "Confirmed rules this change takes into the team's text (they stop applying separately once it is submitted):",
      ...check.absorbRules.map((r) => `- ${r.ruleId}: ${r.heading}`),
    );
  }
  if (check.warnings.orphanedRules.length > 0) {
    out.push(
      "Confirmed rules that would have nothing left to apply to:",
      ...check.warnings.orphanedRules.map((r) => `- ${r.id}: ${r.heading} (${r.target})`),
      "Take them into the text with `absorbRules`, or keep what they apply to.",
    );
  }
  const agents = renderAgents(check.agents);
  if (agents) out.push(agents);
  out.push("", renderChanges(check.changes, only));
  return out.join("\n");
}

/** A refusal of an apply: rightflow says why and lists every finding. */
export function renderRefusedApply(detail: Record<string, unknown>): string {
  const findings = (key: string): Finding[] => (Array.isArray(detail[key]) ? (detail[key] as Finding[]) : []);
  const lines = [typeof detail.message === "string" ? detail.message : "rightflow did not apply the change."];
  lines.push(...renderFindings("Not allowed:", findings("refusals")));
  lines.push(...renderFindings("Case fields with errors:", findings("lint")));
  return lines.join("\n");
}

export function renderApplied(result: SetupApply): string {
  const lines = [
    result.revision === null
      ? "Submitted. Nothing differed from the team as it stood, so no new entry was added to its change log."
      : `Submitted as change #${result.revision} in the team's change log. Files changed: ${result.changedFiles}.`,
  ];
  const agents = renderAgents(result.agents);
  if (agents) lines.push(agents);
  for (const r of result.absorbedRules) {
    lines.push(
      r.retired
        ? `Rule ${r.ruleId} is now part of the team's text and no longer applies separately.`
        : `Rule ${r.ruleId} still applies separately: ${r.error ?? "rightflow could not retire it"}.`,
    );
  }
  return lines.join("\n");
}

const SOURCE_TEXT: Record<RevisionSource, string> = {
  firm: "submitted by the firm",
  admin: "changed by rightflow support",
  platform_api: "imported as a folder in the rightflow app",
  library: "installed or updated from rightflow's library",
  restore: "restored",
  outside_import: "changed in the rightflow app (settings, editors or confirmed learnings)",
  baseline: "the team as it stood when its change log started",
};

export function describeSource(r: Pick<RevisionSummary, "source" | "restoredFrom">): string {
  if (r.source === "restore" && r.restoredFrom !== null) return `restored from #${r.restoredFrom}`;
  return SOURCE_TEXT[r.source];
}

export function renderRevisionLine(r: RevisionSummary): string {
  const counts = [
    r.counts.added ? `${r.counts.added} added` : null,
    r.counts.modified ? `${r.counts.modified} changed` : null,
    r.counts.deleted ? `${r.counts.deleted} removed` : null,
  ].filter(Boolean);
  const head = `#${r.number} · ${r.createdAt.slice(0, 16).replace("T", " ")} UTC · ${describeSource(r)}${r.author ? ` · ${r.author}` : ""}`;
  const lines = [head];
  if (r.message) lines.push(`  "${r.message}"`);
  if (counts.length > 0) lines.push(`  files: ${counts.join(", ")}`);
  if (r.absorbedRules.length > 0) lines.push(`  took in rules: ${r.absorbedRules.map((a) => a.ruleId).join(", ")}`);
  return lines.join("\n");
}

export function renderRevision(r: RevisionDetail, only?: readonly string[]): string {
  return [renderRevisionLine(r), "", "What it changed compared with the change before it:", renderChanges(r.changes, only)].join("\n");
}

export function renderLearnings(l: SetupLearnings): string {
  const out: string[] = [];
  if (l.rules.length === 0) {
    out.push("Confirmed rules: none.");
  } else {
    out.push(`Confirmed rules (${l.rules.length}) — the team follows these on top of its text:`);
    for (const r of l.rules) {
      const where = r.target.scope === "general" ? "whole team" : `${r.target.scope} ${r.target.name ?? ""}`.trim();
      out.push(`- ${r.id} · ${where} · ${r.heading}`);
      if (r.when) out.push(`  when: ${r.when}`);
      out.push(`  then: ${r.then}`);
    }
  }
  out.push("");
  if (l.pending.total === 0) {
    out.push("Proposals waiting for review: none.");
  } else {
    out.push(`Proposals waiting for review in the app (${l.pending.total}${l.pending.items.length < l.pending.total ? `, newest ${l.pending.items.length} shown` : ""}):`);
    for (const p of l.pending.items) {
      out.push(`- ${p.kind === "rule" ? "rule" : "text block"}${p.target ? ` for ${p.target}` : ""}${p.proposalCount > 1 ? ` (proposed ${p.proposalCount} times)` : ""}`);
      if (p.proposedText) out.push(`  ${p.proposedText}`);
      if (p.reason) out.push(`  why: ${p.reason}`);
    }
  }
  if (l.fileChanges.length > 0) {
    out.push("", "Files a confirmed learning changed directly:");
    out.push(...l.fileChanges.map((f) => `- ${f.path}${f.changedAt ? ` (${f.changedAt.slice(0, 10)})` : ""}`));
  }
  if (l.orphans.length > 0) {
    out.push("", "Confirmed rules whose skill or helper the team no longer has:");
    out.push(...l.orphans.map((o) => `- ${o.id}: ${o.heading} (${o.target})`));
  }
  return out.join("\n");
}

export function renderReference(r: SetupReference): string {
  const list = (xs: readonly string[]) => (xs.length > 0 ? xs.join(", ") : "none");
  return [
    `Policy version ${r.policyVersion}.`,
    "",
    "Tool groups an agent may be given:",
    ...r.toolGroups.map((g) => `- ${g.id} — ${g.label}: ${g.description}`),
    "",
    `Artifact types: ${list(r.artifactTypes)}`,
    "Agents a team may include from rightflow's templates:",
    ...(r.includableTemplates.length > 0 ? r.includableTemplates.map((t) => `- ${t.key} — ${t.name}: ${t.description}`) : ["- none"]),
    `Icons: ${list(r.icons)}`,
    `Rule blocks: ${list(r.ruleBlocks)}`,
    "",
    "Case fields (CASE_SCHEMA.json):",
    `- extra keywords: ${list(r.caseSchema.keywords)}`,
    `- widgets: ${list(r.caseSchema.widgets)}`,
    `- tones for choice labels: ${list(r.caseSchema.enumTones)}`,
    `- fields rightflow fills itself (do not redefine): ${list(r.caseSchema.platformKeys)}`,
    "",
    "Settings:",
    `- team, may change: ${list(r.settings.teamConfig.open)}`,
    `- team, set by rightflow: ${list(r.settings.teamConfig.locked)}`,
    `- agent, may change: ${list(r.settings.agentConfig.open)}`,
    `- agent, set by rightflow: ${list(r.settings.agentConfig.locked)}`,
    `- case group, may change: ${list(r.settings.caseGroupConfig.open)}`,
    "",
    `Limits: ${r.limits.files} files, ${r.limits.fileCharacters} characters per file, ${r.limits.requestBytes} bytes per request.`,
    `Starter teams: ${list(r.starterLocales)}`,
  ].join("\n");
}
