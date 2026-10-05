# The change log and what the team learned

## The change log

Every change to a team is an entry in its change log. Each entry has:
- a number
- when it happened
- who made it
- how it was made
- the message they gave
- how many files it touched

`team_history` lists the entries and `show_revision <number>` shows what one of
them changed.

**How an entry can come about**

| Shown as | Meaning |
| --- | --- |
| submitted by the firm | Someone at the firm submitted it, for example with this plugin. |
| changed in the rightflow app | Settings, the editors in the app, or a confirmed learning changed the team. rightflow records this the next time the team is changed through a submit, so it can show up just before that entry. |
| imported as a folder in the rightflow app | Someone imported a team folder in the app. |
| changed by rightflow support | rightflow changed it on the firm's behalf. |
| installed or updated from rightflow's library | The team came from, or was updated from, a team rightflow publishes. |
| restored from #n | Someone brought back entry n. |
| the team as it stood when its change log started | The first entry of a team that existed before the change log did. |

**Bringing an earlier version back**
- `check_restore` checks it like any other change, against the team as it is
  today. It reports anything that is no longer allowed, including a setting
  rightflow keeps for itself that has changed since that entry.
- `restore_revision` adds a new entry. The log keeps everything that happened,
  including the restore.

## What the team learned

While staff work with the team, rightflow proposes rules from their
corrections. A rule someone confirmed applies on top of the team's text from
then on. `team_learnings` shows:

- **Confirmed rules**, each with:
  - an id (`r-…`);
  - what it applies to: the whole team, one skill, or one helper;
  - when it applies and what to do.
- **Proposals waiting for review.** These are reviewed in the rightflow app, not
  here.
- **Files a confirmed learning changed directly.**
- **Rules with nothing to apply to**, because their skill or helper is gone.

### Taking a confirmed rule into the team's text

Once a rule belongs in a skill or in `AGENT.md`, it can be written into the text
and stop applying separately:

1. **Write the rule into the right file**, following
   [writing-instructions.md](writing-instructions.md).
2. **Pass it to `check_team`** in `absorbRules`, with its id and where it now
   lives. The check lists it.
3. **Submit with the same `absorbRules`.** rightflow retires the rule. The
   change log notes which rules the entry took in.

**When a change removes a skill or helper**
- `check_team` warns about rules that would have nothing left to apply to.
- Either take them into the text as above, or keep what they apply to.
