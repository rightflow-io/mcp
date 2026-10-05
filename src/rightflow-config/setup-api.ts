/**
 * The parts of rightflow's `/setup` answers this plugin reads. The API's
 * contract is the source; these are narrow views of it, and a field the
 * plugin does not render is left out.
 */

export interface Page<T> {
  data: T[];
  meta: { total?: number; page?: number; hasNextPage: boolean };
}

export interface SetupTeam {
  id: string;
  name: string;
  agentType: string;
  origin: "platform" | "firm";
  editable: boolean;
}

export interface SetupBundle {
  team: { id: string; name: string; agentType: string };
  files: Record<string, string>;
  bundleHash: string;
}

export interface Starter {
  locale: string;
  files: Record<string, string>;
}

export interface Finding {
  rule: string;
  path: string;
  message: string;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  unified: string;
  truncated: boolean;
}

export interface AgentChanges {
  created: string[];
  updated: string[];
  deleted: string[];
}

export interface SetupCheck {
  ok: boolean;
  stale: boolean;
  bundleHash: string;
  refusals: Finding[];
  lint: { errors: Finding[]; advisories: Array<{ path: string; values: string[] }> };
  changes: FileChange[];
  agents: AgentChanges;
  missingLetterheads: Array<{ letterhead: string; templates: string[] }>;
  absorbRules: Array<{ ruleId: string; heading: string }>;
  warnings: { orphanedRules: OrphanedRule[] };
}

export interface SetupApply {
  bundleHash: string;
  revision: number | null;
  changedFiles: number;
  agents: AgentChanges;
  absorbedRules: Array<{ ruleId: string; retired: boolean; error: string | null }>;
}

export interface SetupCreated {
  teamId: string;
  agentType: string;
  bundleHash: string;
}

export interface OrphanedRule {
  id: string;
  heading: string;
  target: string;
}

export interface SetupLearnings {
  rules: Array<{
    id: string;
    target: { scope: "general" | "skill" | "subagent"; name: string | null };
    heading: string;
    when: string | null;
    then: string;
    summary: string | null;
    confirmedAt: string;
    sourceCaseNumber: string | null;
  }>;
  pending: {
    total: number;
    items: Array<{
      id: string;
      kind: "rule" | "block";
      target: string | null;
      proposedText: string | null;
      reason: string | null;
      proposalCount: number;
      sourceCaseNumber: string | null;
      createdAt: string;
    }>;
  };
  fileChanges: Array<{ path: string; changedAt: string | null; caseNumbers: string[] }>;
  orphans: OrphanedRule[];
}

export type RevisionSource = "firm" | "admin" | "platform_api" | "library" | "restore" | "outside_import" | "baseline";

export interface RevisionSummary {
  number: number;
  createdAt: string;
  source: RevisionSource;
  message: string | null;
  author: string | null;
  bundleHash: string;
  restoredFrom: number | null;
  counts: { added: number; modified: number; deleted: number };
  absorbedRules: Array<{ ruleId: string; heading: string }>;
}

export interface RevisionDetail extends RevisionSummary {
  changes: FileChange[];
  files: Record<string, string> | null;
}

export interface SetupReference {
  policyVersion: string;
  toolGroups: Array<{ id: string; category: string; label: string; description: string }>;
  artifactTypes: string[];
  includableTemplates: Array<{ key: string; name: string; description: string }>;
  icons: string[];
  ruleBlocks: string[];
  caseSchema: { keywords: string[]; widgets: string[]; enumTones: string[]; platformKeys: string[] };
  settings: {
    teamConfig: { open: string[]; locked: string[] };
    agentConfig: { open: string[]; locked: string[] };
    caseGroupConfig: { open: string[] };
  };
  limits: { files: number; fileCharacters: number; requestBytes: number };
  starterLocales: string[];
}
