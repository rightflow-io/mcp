# CLAUDE.md

Guidance for anyone, human or agent, who changes this repository.

The principles that hold in every daemon repository come first: @MANIFEST.md

## This repository is public

Anyone on the internet can read every file, every commit, every pull request
description, every issue, every review comment and every CI log here. That
includes the history: a later commit that deletes something does not unpublish it,
and neither does a force-push, because forks, clones and caches keep what they
already fetched.

So the reader to write for is **a stranger**: a competitor, a security
researcher, a firm's IT administrator deciding whether to install the plugin. Every
rule below follows from that.

## What this repository is

A Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) with the
plugins under `plugins/<name>/`.

- **`rightflow-config`** lets a firm's owner or admin set up and change their own
  agent team in rightflow from Claude Code. It has a skill (how to do it well) and a
  local MCP server (`stdio`) that talks to the public rightflow API with the
  person's own sign-in.

### The server decides, this repository asks

Every decision is made by the rightflow API:
- what a firm may change
- whether a team is valid
- what the diff is
- what the history holds

The plugin formats the request and renders the answer. Nothing that decides whether
a change is allowed lives here, for two reasons:

- **This code runs on the user's machine.** A check here is advice, not
  enforcement, and anyone can read and edit it.
- **Lists that change come from the API at run time.** That covers selectable
  tool groups, case-schema keywords, the settings a firm may not change, and
  icons, which `GET /setup/reference` serves. A copy written into this repository
  would go stale and then lie to the user with confidence.

## What belongs here and what never does

**Belongs here**

- Plugin manifests, the MCP server source and its built `dist/`.
- Skill text: how a firm admin sets up and changes a team, written for that
  person.
- Generic examples that use neutral placeholders (`<firm name>`, `team-a`,
  `field_1`).
- Public endpoints of the rightflow API and sign-in service.
- Public client ids of native sign-in apps. They are public by design, because a
  program on someone's laptop cannot keep a secret. Each one carries a comment
  saying so.

**Never goes in.** This holds even "just for a test", even when it has expired,
and even in a commit you plan to revert:

1. **Secrets.** Access or refresh tokens, API keys, client secrets, passwords,
   cookies, signing keys, `.env` files, credential files, or a token copied out
   of a browser.
2. **Personal data.** Names of people (real or invented), addresses, e-mail
   addresses, phone numbers, dates of birth, bank details, case numbers, file
   numbers. An invented name cannot be told apart from a real one, so it
   carries the same risk.
3. **Customer data.**
   - Firm names, and tenant, organization, team or user ids.
   - Anything from a firm's team: prompts, case schemas, letter templates,
     letterheads, signatures.
   - Logs, screenshots or exports from a real tenant.
4. **Our platform prompts.** This means the content of teams rightflow built:
   prompts, skills, subagents. The starter a firm begins from is served by the
   API. This repository teaches *how*; it does not ship *what*.
5. **Internal infrastructure.**
   - Internal hostnames.
   - Cluster, namespace, bucket or queue names.
   - Database tables or columns, and file paths inside private repositories.
   - Staff organization ids, admin routes, development bypasses, feature-flag
     internals, monitoring addresses.
6. **Security knowledge.**
   - Weaknesses, open gaps, ideas for getting around a lock.
   - The reasoning behind a lock beyond what the API's own refusal message tells
     the user.

   A suspected vulnerability is reported as `SECURITY.md` describes, never in an
   issue or pull request.
7. **Links into private systems.** That covers the ticket tracker, chat, wikis,
   dashboards, cloud consoles, and files or pull requests in private
   repositories. A ticket identifier on its own (`DAE-1234`) is fine; its URL and
   its content are not.

When unsure, leave it out and ask.

If something from this list has already landed, a deleting commit does not undo
it. Tell a maintainer, and **rotate a leaked secret at once**: rotating the secret
is the fix, deleting it from the repository is not.

`scripts/check-public-safety.mjs` catches the mechanical part of this: token
formats, private keys, e-mail addresses, IBANs, phone numbers, links into private
systems, and files that must never be tracked. It runs in CI on every push and on
every pull request's title and description. It cannot recognise a name, a firm or
a sentence copied out of a case, so passing it is necessary, not sufficient.

A line that trips it for a good reason carries `public-safety: allow <rule>`
together with the reason. Use that rarely; every use is a claim a reviewer
checks.

## Where things belong

| Thing | Place |
| --- | --- |
| What a firm may change, validation, diff, change history | The rightflow API |
| Lists that change (tool groups, keywords, locked settings, icons) | The API's reference endpoint, read at run time |
| Starter content and every prompt | The API |
| How a firm admin does it well | The skill under `plugins/rightflow-config/skills/` |
| How a tool behaves | The MCP server under `plugins/rightflow-config/` |

The skill here is written for a firm admin. It is not a copy of rightflow's
internal standards, and it must not grow into one.

## Building the MCP server

- **TypeScript, `strict: true`, no `any`.** ESM, Node 22 or newer.
- **stdout is the protocol.** Logs go to stderr only. Never log a token, a request
  body or a file's content.
- **Never authenticate at startup.** The server always starts and always lists its
  tools; credentials are resolved per call. A call that cannot authenticate names
  the environment and the exact next step, not a stack trace.
- **Credentials live only in the plugin's data directory, with mode `0600`.** Never
  in the working folder, never in a tool result.
- **Every tool result starts with the environment and the firm, and the team when
  there is one.** The server never picks a firm on the user's behalf.
- **Show the server's preview first.** No write without the user having seen it,
  and a submit carries the user's own summary of the change.
- **Few dependencies.** They are pinned by the lockfile and bundled into `dist/`.
  CI rebuilds `dist/` and fails if the committed copy differs.
- **Test data states the property under test.** Fixtures are neutral and never a
  story.

## Commits and pull requests

They are public and permanent, so they are written for a stranger who will read
them years from now.

- **English**, whatever language the request arrived in.
- **Every change has a Linear ticket** in the daemon Dev team (`DAE-…`). Name its
  identifier in the branch name or the title. The `ticket linked` check enforces
  this. Use the identifier only: no tracker URL, no quoted ticket content.
- **Commit message:** `DAE-1234 <type>(<scope>): <what changes>`, imperative mood.
  - `type` is one of `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`,
    `chore`.
  - The body says why.
- **Pull request description:** follow `.github/pull_request_template.md`.
  - **What changes:** told from the side of the person using the plugin.
  - **Why:** the general need ("firm admins need to…"), never who asked or
    about which case.
  - **How it was verified:** fixtures or the development environment; never a
    real tenant's data.
  - **Public safety:** every box ticked honestly.
- **Customer context stays in the ticket.** Who asked, which firm, which case, and
  internal links all belong in the ticket, which is private. The pull request only
  says what changed and why in general terms.
- **On merge, the description is posted to the ticket automatically.** So it has to
  stand on its own, and it is already public.
- **Screenshots and recordings show fixture data only.**
- **Commit with your GitHub no-reply address** (`git config user.email
  <id>+<login>@users.noreply.github.com`). A commit's author address is as public
  as its content, and the public-safety check refuses a personal one.
- **Coding agents keep their attribution and drop their session link.**
  - Keep: the `Co-Authored-By` trailer, and the "Generated with Claude Code" line
    in a pull request.
  - Drop: links to the agent's session. They point into a private workspace, so
    they fall under "links into private systems" above, and the check refuses
    them.

## Gate before you push

```bash
node scripts/check-public-safety.mjs   # whole tree
node --test 'scripts/*.test.mjs'       # the scanner's own tests
```

The plugin adds its own build and test commands here when it lands.

## Closing a ticket

Before you move a ticket to Done or Canceled, post a summary comment on it: the
root cause, the change made, the pull request, and any follow-ups. Never close a
ticket without one.
