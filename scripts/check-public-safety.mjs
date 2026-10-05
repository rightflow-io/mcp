#!/usr/bin/env node
// Fails when something that must never be public is about to be: secrets, personal
// data, links into private systems, files that must never be tracked. CLAUDE.md
// ("What belongs here and what never does") is the rule; this is its mechanical
// half. It cannot recognise a name or a sentence lifted from a case, so a pass is
// necessary, not sufficient.
//
//   node scripts/check-public-safety.mjs                  every tracked or new file
//   node scripts/check-public-safety.mjs --text <file>    one text (a PR title and body)
//   node scripts/check-public-safety.mjs --commits <a..b> messages, identities and added lines of a commit range
//
// A finding never prints the matched value, only where it is and which rule fired:
// echoing a leaked token into a public CI log would leak it a second time.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SELF = "scripts/check-public-safety.mjs";
const SELF_TEST = "scripts/check-public-safety.test.mjs";

// Bundled third-party code and lockfiles carry their authors' addresses and long
// digit runs; scanning them for personal data reports other people's packaging.
// They are still scanned for secrets.
const VENDORED = [/^plugins\/[^/]+\/dist\//, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/];

// RFC 2606 example domains, GitHub's private-address relay and the commit trailer
// of the coding agent are the only addresses that may appear.
const ALLOWED_EMAIL = [
  /@example\.(com|org|net)$/i,
  /@users\.noreply\.github\.com$/i,
  /^noreply@(anthropic|github)\.com$/i,
  /^git@github\.com$/i,
  // Dependabot signs its commits off with GitHub's support address.
  /^support@github\.com$/i,
];

// The public face of rightflow. Any other subdomain is internal until someone
// decides otherwise and adds it here.
const PUBLIC_HOSTS = new Set([
  "rightflow.one",
  "www.rightflow.one",
  "app.rightflow.one",
  "api.rightflow.one",
  "auth.rightflow.one",
  "app.dev.rightflow.one",
  "api.dev.rightflow.one",
  "auth.dev.rightflow.one",
]);

const PLACEHOLDER = /^(<.*>|\$\{.*\}|\{\{.*\}\}|process\.env.*|(.)\2+|.*(example|placeholder|changeme|redacted|your[_-]|xxx).*|\*+)$/i;

/** @typedef {{ rule: string, message: string, re: RegExp, personal?: boolean, accept?: (m: RegExpMatchArray) => boolean }} Rule */

/** @type {Rule[]} */
export const RULES = [
  { rule: "private-key", message: "a private key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
  { rule: "jwt", message: "a signed token (JWT)", re: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g },
  { rule: "bearer", message: "a bearer credential", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  {
    rule: "token",
    message: "a provider token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[\w-]{20,}|sk-[A-Za-z0-9]{32,}|xox[abposr]-[\w-]{10,}|lin_(?:api|oauth)_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|npm_[A-Za-z0-9]{36})\b/g,
  },
  {
    rule: "assigned-secret",
    message: "a literal value assigned to a secret-like name",
    re: /\b(?:api[_-]?key|secret|password|passwd|client[_-]?secret|refresh[_-]?token|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    accept: (m) => !PLACEHOLDER.test(m[1] ?? ""),
  },
  {
    rule: "email",
    message: "an e-mail address",
    personal: true,
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    accept: (m) => !ALLOWED_EMAIL.some((a) => a.test(m[0])),
  },
  {
    rule: "iban",
    message: "a bank account number (IBAN)",
    personal: true,
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    accept: (m) => isIban(m[0]),
  },
  {
    rule: "phone",
    message: "a phone number",
    personal: true,
    re: /(?<![\w.+])\+\d{1,3}[ \-/]?\(?\d{2,5}\)?[ \-/]?\d{3,}[\d \-/]{0,8}\d/g,
  },
  {
    rule: "private-link",
    message: "a link into a private system",
    re: /\b(?:linear\.app\/[\w-]+\/(?:issue|project|document|view)|[\w-]+\.slack\.com\/archives|app\.slack\.com\/|notion\.(?:so|site)\/|[\w-]+\.grafana\.net|langfuse\.com\/project|console\.aws\.amazon\.com|console\.cloud\.google\.com|portal\.azure\.com|docs\.google\.com\/|drive\.google\.com\/|github\.com\/rightflow-io\/(?!mcp(?![\w.-]))[\w.-]+|claude\.ai\/code\/session_)/g,
  },
  { rule: "internal-host", message: "an internal hostname", re: /\b[\w-]+(?:\.[\w-]+)*\.(?:svc\.cluster\.local|internal)\b/g },
  {
    rule: "internal-host",
    message: "a rightflow hostname that is not public",
    re: /\b(?:[a-z0-9-]+\.)+rightflow\.one\b/gi,
    accept: (m) => !PUBLIC_HOSTS.has(m[0].toLowerCase()),
  },
];

const FORBIDDEN_FILES = [
  { re: /(^|\/)\.env(\.(?!example$)[^/]*)?$/, message: "an environment file" },
  { re: /\.(pem|key|p12|pfx|keystore|jks)$/i, message: "a key or certificate store" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, message: "an SSH key" },
  { re: /(^|\/)credentials[^/]*\.json$/i, message: "a credentials file" },
  { re: /(^|\/)__rightflow__\//, message: "a pulled team's local state (it names the firm and the team)" },
];

/** ISO 13616 mod-97 check, so that uppercase identifiers are not mistaken for accounts. */
export function isIban(raw) {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

const ALLOW_MARK = /public-safety:\s*allow\s+([\w-]+)/g;

/**
 * @param {string} text
 * @param {{ personal?: boolean }} [opts] personal=false skips the personal-data rules (vendored code)
 * @returns {{ line: number, rule: string, message: string }[]}
 */
export function scanText(text, opts = {}) {
  const personal = opts.personal ?? true;
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const allowed = new Set([...line.matchAll(ALLOW_MARK)].map((m) => m[1]));
    for (const r of RULES) {
      if (r.personal && !personal) continue;
      if (allowed.has(r.rule)) continue;
      for (const m of line.matchAll(r.re)) {
        if (r.accept && !r.accept(m)) continue;
        findings.push({ line: i + 1, rule: r.rule, message: r.message });
        break;
      }
    }
  });
  return findings;
}

export function scanPath(path) {
  for (const f of FORBIDDEN_FILES) {
    if (f.re.test(path)) return [{ line: 0, rule: "forbidden-file", message: `${f.message} must never be tracked` }];
  }
  return [];
}

function git(args, cwd) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...(cwd ? { cwd } : {}) });
}

function scanTree() {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const out = [];
  for (const path of [...new Set(files)]) {
    out.push(...scanPath(path).map((f) => ({ where: path, ...f })));
    if (path === SELF || path === SELF_TEST) continue;
    let buf;
    try {
      if (!statSync(path).isFile()) continue;
      buf = readFileSync(path);
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (buf.includes(0)) continue; // binary
    const personal = !VENDORED.some((v) => v.test(path));
    out.push(...scanText(buf.toString("utf8"), { personal }).map((f) => ({ where: `${path}:${f.line}`, ...f })));
  }
  return out;
}

export function scanCommits(range, cwd) {
  const raw = git(["log", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e", range], cwd);
  const out = [];
  for (const rec of raw.split("\x1e").map((r) => r.trim()).filter(Boolean)) {
    const [sha, , authorEmail, , committerEmail, body = ""] = rec.split("\x1f");
    const short = sha.slice(0, 10);
    for (const [who, email] of [["author", authorEmail], ["committer", committerEmail]]) {
      if (!ALLOWED_EMAIL.some((a) => a.test(email))) {
        out.push({
          where: `commit ${short}`,
          rule: "commit-email",
          message: `the ${who} address is a personal one; configure git to use your GitHub no-reply address`,
        });
      }
    }
    out.push(...scanText(body).map((f) => ({ where: `commit ${short} message line ${f.line}`, ...f })));
  }
  out.push(...scanAddedLines(range, cwd));
  return out;
}

/**
 * Every line a commit in the range adds. The tree scan sees only the last commit,
 * but a secret added in one commit and deleted in the next is just as public: it
 * sits in the branch history and has to be rotated. Merge commits are skipped;
 * what they bring in was scanned on its own branch.
 */
function scanAddedLines(range, cwd) {
  const raw = git(["log", "--no-merges", "--format=%x1e%H", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-renames", range], cwd);
  const out = [];
  for (const rec of raw.split("\x1e").filter((r) => r.trim())) {
    const [sha = "", ...lines] = rec.split("\n");
    const short = sha.slice(0, 10);
    /** @type {Map<string, string[]>} */
    const added = new Map();
    let path = null;
    for (const line of lines) {
      if (line.startsWith("diff --git ")) path = null;
      else if (line.startsWith("+++ ")) {
        const target = line.slice(4).replace(/^"|"$/g, "");
        path = target === "/dev/null" ? null : target.replace(/^b\//, "");
        if (path) {
          out.push(...scanPath(path).map((f) => ({ where: `commit ${short} ${path}`, ...f })));
          if (!added.has(path)) added.set(path, []);
        }
      } else if (path && line.startsWith("+")) added.get(path)?.push(line.slice(1));
    }
    for (const [file, text] of added) {
      if (file === SELF || file === SELF_TEST) continue;
      const personal = !VENDORED.some((v) => v.test(file));
      const seen = new Set();
      for (const f of scanText(text.join("\n"), { personal })) {
        if (seen.has(f.rule)) continue;
        seen.add(f.rule);
        out.push({ where: `commit ${short} ${file} (added lines)`, rule: f.rule, message: f.message });
      }
    }
  }
  return out;
}

function main(argv) {
  let findings;
  if (argv[0] === "--text") {
    if (!argv[1]) throw new Error("--text needs a file");
    findings = scanText(readFileSync(argv[1], "utf8")).map((f) => ({ where: `line ${f.line}`, ...f }));
  } else if (argv[0] === "--commits") {
    if (!argv[1]) throw new Error("--commits needs a range such as origin/main..HEAD");
    findings = scanCommits(argv[1]);
  } else {
    findings = scanTree();
  }
  if (findings.length === 0) {
    console.log("public-safety: nothing found");
    return 0;
  }
  for (const f of findings) console.error(`${f.where}  [${f.rule}]  ${f.message}`);
  console.error(
    `\npublic-safety: ${findings.length} finding(s). This repository is public — see CLAUDE.md, ` +
      '"What belongs here and what never does". A leaked secret must be rotated; deleting it is not enough.',
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
