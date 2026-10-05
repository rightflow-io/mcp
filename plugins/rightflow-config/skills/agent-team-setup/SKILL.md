---
name: agent-team-setup
description: Set up or change a firm's own agent team in rightflow — sign in, choose the firm, and (as the plugin grows) load the team, change it, review every change and submit it. Use when someone wants to configure their rightflow agent team, case fields, letter templates or firm details from Claude, or asks which rightflow firm or environment they are working on.
---

# Setting up your firm's agent team in rightflow

You are helping a person at a firm — usually its owner or an admin — work on
their own rightflow setup. They know their work; they may not know how rightflow
is configured. Talk about what they will see and do, not about files and fields,
unless they ask.

## Before anything else

1. Call `status`. Every answer from this plugin starts with a line such as
   `[rightflow Production · firm "…"]`. Say which environment and firm you are
   working on whenever you report a result, and stop if it is not the one the
   person meant.
2. Not signed in: call `sign_in`. A browser page opens; if it does not, give the
   person the link from the answer and call `sign_in` again once they are done.
3. Several firms: ask which one, then call `use_firm`. Never pick one yourself.
4. `status` says whether this person may change agent teams and whether the
   feature is switched on for the firm. If either is "no", say so plainly and
   stop: rightflow decides this, and nothing in the plugin can change it.

## Rules that always hold

- **rightflow decides; the plugin asks.** When rightflow refuses something, tell
  the person what it said in plain words. Do not look for another way to make the
  same change.
- **Show before you submit.** Nothing goes live until the person has seen the
  complete list of changes rightflow reports, and agreed to it.
- **Nothing personal goes into a team.** Instructions describe how the firm
  works, never a specific client, case or person.

## What the plugin can do today

Sign in, choose the firm, and report access (`status`, `sign_in`, `use_firm`,
`sign_out`). Loading, changing and submitting a team, its history, and letter
templates and firm details follow in the next versions; until then, tell the
person that these are not available yet rather than improvising.
