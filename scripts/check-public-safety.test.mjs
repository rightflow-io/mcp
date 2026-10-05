import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIban, scanCommits, scanPath, scanText } from "./check-public-safety.mjs";

// Samples are assembled at run time so that this file does not itself contain what
// the scanner looks for.
const j = (...parts) => parts.join("");

const rules = (text, opts) => scanText(text, opts).map((f) => f.rule);

test("secrets are found", () => {
  assert.deepEqual(rules(j("-----BEGIN ", "RSA PRIVATE KEY-----")), ["private-key"]);
  assert.deepEqual(rules(j("eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiIxMjM0In0", ".abcdefghijk")), ["jwt"]);
  assert.deepEqual(rules(j("Authorization: Bear", "er abcdefghijklmnopqrstuvwxyz0123")), ["bearer"]);
  assert.deepEqual(rules(j("gh", "p_", "a".repeat(36))), ["token"]);
  assert.deepEqual(rules(j("const api", "Key = '", "q8Zr2LmP0vX7'")), ["assigned-secret"]);
});

test("placeholders are not secrets", () => {
  assert.deepEqual(rules(j("api", "Key: '<your key>'")), []);
  assert.deepEqual(rules(j("pass", "word = '${PASSWORD}'")), []);
  assert.deepEqual(rules(j("sec", "ret: 'xxxxxxxxxx'")), []);
});

test("personal data is found, example domains are not", () => {
  assert.deepEqual(rules(j("write to someone", "@", "firm-domain.de")), ["email"]);
  assert.deepEqual(rules(j("see someone", "@", "example.org")), []);
  assert.deepEqual(rules(j("Co-Authored-By: Claude <noreply", "@", "anthropic.com>")), []);
  assert.deepEqual(rules(j("call +49 ", "30 1234567")), ["phone"]);
});

test("an IBAN is recognised by its checksum, not by its shape", () => {
  const valid = j("GB82 WEST ", "1234 5698 7654 32");
  assert.equal(isIban(valid), true);
  assert.deepEqual(rules(`account ${valid}`), ["iban"]);
  assert.equal(isIban("GB00WEST12345698765432"), false);
  assert.deepEqual(rules("id AB12CDEF34GH56IJ78"), []);
});

test("personal-data rules can be skipped for vendored code, secret rules cannot", () => {
  assert.deepEqual(rules(j("author ", "dev", "@", "pkg-author.io"), { personal: false }), []);
  assert.deepEqual(rules(j("gh", "p_", "b".repeat(36)), { personal: false }), ["token"]);
});

test("links into private systems and internal hosts are found", () => {
  assert.deepEqual(rules(j("https://lin", "ear.app/acme/issue/ABC-1")), ["private-link"]);
  assert.deepEqual(rules(j("https://github.com/rightflow-io/", "daemon/pull/1")), ["private-link"]);
  assert.deepEqual(rules("https://github.com/rightflow-io/mcp/pull/1"), []);
  assert.deepEqual(rules(j("https://claude.ai/code/", "session_0123")), ["private-link"]);
  assert.deepEqual(rules(j("http://api.default.svc.", "cluster.local")), ["internal-host"]);
  assert.deepEqual(rules(j("https://admin.", "rightflow.one")), ["internal-host"]);
  assert.deepEqual(rules("https://api.rightflow.one/api"), []);
});

test("an allow mark silences only the rule it names", () => {
  const line = j("contact security", "@", "firm-domain.de");
  assert.deepEqual(rules(`${line} <!-- public-safety: allow email -->`), []);
  assert.deepEqual(rules(`${line} <!-- public-safety: allow phone -->`), ["email"]);
});

test("files that must never be tracked are refused by path", () => {
  for (const p of [".env", "server/.env.local", "certs/tls.pem", "id_ed25519", "credentials-production.json", "my-team/__rightflow__/state.json"]) {
    assert.equal(scanPath(p)[0]?.rule, "forbidden-file", p);
  }
  for (const p of [".env.example", "server/src/env.ts", "README.md"]) {
    assert.deepEqual(scanPath(p), [], p);
  }
});

test("a link to this repository is fine, a look-alike repository is not", () => {
  assert.deepEqual(rules(j("https://github.com/rightflow-io/", "mcp/pull/1")), []);
  assert.deepEqual(rules(j("https://github.com/rightflow-io/", "mcp-internal")), ["private-link"]);
});

test("a secret added in one commit and removed in the next is still found", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-safety-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", j("bot", "@users.noreply.github.com"));
    git("config", "user.name", "bot");
    git("commit", "-q", "--allow-empty", "-m", "root");
    writeFileSync(join(dir, "config.txt"), j("token gh", "p_", "a".repeat(36), "\n"));
    git("add", "config.txt");
    git("commit", "-q", "-m", "add");
    writeFileSync(join(dir, "config.txt"), "token removed\n");
    git("commit", "-q", "-am", "remove");
    const findings = scanCommits("HEAD~2..HEAD", dir);
    assert.deepEqual(findings.map((f) => f.rule), ["token"]);
    assert.match(findings[0].where, /config\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
