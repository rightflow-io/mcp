---
name: agent-team-setup
description: Set up or change a firm's own agent team in rightflow — sign in, choose the firm, load the team into a folder, change it, review every change rightflow reports, submit it with the person's own summary, read what the team learned, and look back at or restore earlier versions from its change log. Use when someone wants to configure their rightflow agent team, its case fields, skills or helpers, asks what changed in their team and by whom, wants an earlier version back, or asks which rightflow firm or environment they are working on.
---

# Setting up your firm's agent team in rightflow

You are helping a person at a firm, usually its owner or an admin, work on their
own rightflow setup. They know their work but may not know how rightflow is
configured. Talk about what they will see and what the team will do, not about
files and fields, unless they ask.

## Before anything else

1. **Call `status`.** Every answer from this plugin starts with a line such as
   `[rightflow Production · firm "…" · team "…"]`. Name the environment and firm
   whenever you report a result. Stop if it is not the one the person meant.
2. **Not signed in?** Call `sign_in`. It answers at once with a link and a
   code. Show the person both exactly as given: they open the link in any
   browser, check that the page shows the same code, and sign in. Once they say
   they are done, call `sign_in` again; it waits for the confirmation.
3. **Several firms?** Ask which one, then call `use_firm`. Never pick one
   yourself.
4. **Check access.** `status` says whether this person may change agent teams
   and whether the feature is switched on for the firm. If either is "no", say
   so plainly and stop. rightflow decides this, and nothing in the plugin can
   change it.

## Rules that always hold

- **rightflow decides; the plugin asks.** When rightflow refuses something,
  tell the person what it said in plain words. Do not look for another way to
  make the same change.
- **Show before you submit.**
  - Nothing goes live until the person has seen the complete list of changes
    from `check_team` (or `check_restore`) and agreed to it.
  - `submit_team` only accepts the preview id of a check over exactly the folder
    as it is now. Change anything afterwards and you must check again.
- **The message is the person's.** The change log keeps it for good. Ask them
  what changed and why, and write it in their words. Never invent one.
- **Nothing personal goes into a team.** Instructions describe how the firm
  works, never a specific client, case or person, and that includes the
  examples in them.
- **Never guess the lists.** Tool groups, artifact types, icons, case-field
  keywords and the settings rightflow keeps for itself come from
  `team_reference`. They change, and a remembered list goes stale.

## Changing a team

1. **Find the team.** `list_teams` shows the firm's teams. Only teams the firm
   set up itself can be changed here. For a team rightflow looks after, the
   person asks rightflow to hand it over first.
2. **Load it.** `pull_team` writes the team into a folder. The default is
   `rightflow/<environment>/<team name>` next to where Claude Code runs.
   - **Read the team before you change it.** Start with `TEAM.md`, `AGENT.md`
     and the skills that the change touches. See
     [references/team-folder.md](references/team-folder.md) for what each file
     is.
3. **Check the learnings.** Call `team_learnings` first. A confirmed rule may
   already cover what the person wants, or contradict it. See
   [references/history-and-learnings.md](references/history-and-learnings.md).
4. **Make the change.** Edit the files in the folder with your normal tools.
   Keep it as small as the request. Follow
   [references/writing-instructions.md](references/writing-instructions.md) for
   any text the agents will read.
5. **Check it.** Call `check_team` with the folder.
   - It sends nothing live.
   - It shows whether rightflow accepts the change, every finding, and every
     changed file with its diff.
   - Fix the findings and check again until it is accepted.
6. **Show the person.**
   - Explain in plain words what the team will do differently.
   - Mention anything rightflow flagged: rules that would have nothing left to
     apply to, and letter templates naming a letterhead the firm does not have.
   - Ask them to confirm, and ask for their summary.
7. **Submit.** Call `submit_team` with the folder, their summary and the
   preview id.
   - The answer gives the change-log number.
   - The folder is brought up to date with the team as it is now live.

If rightflow says the team changed since the folder was loaded, pull it into a
**new** folder, carry the change across, and check again. Do not overwrite the
newer version.

## Starting a new team

`new_team` puts rightflow's starter into a folder.
- Give the team its name and description in `TEAM.md`.
- Shape the coordinator, the skills and the case fields for the firm's area of
  work.
- Then check and submit as above. The first submit creates the team in rightflow,
  and its change log starts there.

## Looking back

- **What changed:** `team_history` lists who changed the team, when, how and
  why, newest first. `show_revision` shows what one entry changed.
- **Bringing back an earlier version:**
  1. `check_restore` shows what restoring an entry would change today.
  2. Show the person, as for any change.
  3. `restore_revision` with their reason.

  This adds a new entry to the log; nothing is rewritten. A folder loaded before
  the restore is out of date afterwards: pull again with `replace: true`.

## Development and production

The plugin works against **production** unless the person chose otherwise. To
use rightflow's development environment:
1. Open `/plugin`, select rightflow-config, and set its environment option to
   `development`.
2. Restart Claude Code if asked.
3. Call `sign_in` again. Each environment has its own sign-in.

A folder belongs to the environment and firm it was loaded from, and the plugin
refuses to send it anywhere else. The default folders already keep the two
environments apart.
