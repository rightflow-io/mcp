# What a team folder is made of

A team is a folder of text files. rightflow reads a fixed set of places in it and
refuses a file anywhere else, naming the path. Placeholders such as `<name>` stand
for your own names.

```
TEAM.md                          the team: name, description, icon, team settings
AGENT.md                         the coordinator: the agent that leads every case
CASE_SCHEMA.json                 the case fields the team keeps for each case
PUBLIC.md                        what the team does, in words for the firm's staff
README.md                        notes for whoever maintains the team (optional)
skills/<name>/SKILL.md           a skill of the coordinator: how it does one kind of task
skills/<name>/<file>.md          supporting material that skill refers to
skills/<name>/PUBLIC.md          what that skill does, for the firm's staff
subagents/<name>/AGENT.md        a helper the coordinator hands work to
subagents/<name>/skills/<skill>/SKILL.md
bausteine/<name>/REGEL.md        a rule block (only the names team_reference lists)
bausteine/<name>/BAUSTEIN.md     a text block for letters, with its META.json
vorlagen/<slug>/TEMPLATE.md      a letter template, with its META.json
```

The folder is the team, nothing more:
- **Ignored files:**
  - Files and folders whose names start with a dot are never sent.
  - A folder named like `__notes__` is sent but ignored by rightflow. Use it for
    working notes.
- **Removed files:** a file you delete is removed from the team when you submit.

## TEAM.md

A short block of settings between `---` lines, then a description for people.

```markdown
---
name: <team name shown in rightflow>
agentType: <kept as pulled; rightflow assigns it>
description: <one sentence: which cases this team handles and what it delivers>
icon: <one of the icons team_reference lists>
isActive: true
---

# <team name>

<What the team is for, for whoever maintains it.>
```

**Settings rightflow keeps for itself**
- `team_reference` lists which team, agent and case-group settings the firm may
  change and which rightflow keeps for itself. This covers the model, cost
  limits and automatic approval.
- Leave a kept setting as it was pulled. A change to it is refused and the
  answer names it.

**Including helpers rightflow maintains**
- `includes:` adds a ready-made helper that rightflow maintains.
- The keys you can use are listed under "Agents a team may include" in
  `team_reference`.

## AGENT.md (coordinator and helpers)

```markdown
---
name: coordinator
role: coordinator
description: <what this agent does, in one sentence — the other agents read it>
displayName: <name shown to staff>
displayDescription: <one sentence shown to staff>
toolGroups:
  - <tool groups from team_reference>
allowedArtifacts:
  - <artifact types from team_reference>
skills:
  - <skill folder names under skills/>
---

# <Role>

<Instructions: the goal, the steps, what to deliver, when to ask.>
```

**Tool groups and artifact types**
- `toolGroups` decides what an agent can look at and do. Give each agent only
  what its work needs.
- `allowedArtifacts` decides what it may propose: a letter draft, an e-mail
  draft, a deadline, a change to case fields, a question to staff, and so on.
  Everything an agent proposes goes to a person for approval.
- Every agent names its tool groups. A missing list would give it every tool,
  so it is refused.
- An agent that can create anything names its artifact types. An empty list
  would allow every type, so it is refused.

**Helpers**
- A helper (`subagents/<name>/AGENT.md`) has `role: subagent`, a `name` equal
  to its folder name, and its own `toolGroups`, `allowedArtifacts` and skills.
- The coordinator hands work to a helper by its name. The helper's
  `description` is what the coordinator reads to decide when to.

## Skills

A skill is one kind of task, written as steps.

```markdown
---
name: <folder name>
description: <what it does> Trigger - <when the agent should use it>
---

# <Task>

1. <step>
2. <step>
```

**The `description` is what makes the agent pick the skill.**
- Say when to use it, in the words of the situation ("a new case was opened",
  "a reply from the other side arrived").
- List the skill under `skills:` of the agent that should use it.

## CASE_SCHEMA.json: the case fields

A JSON Schema of the facts the team keeps for every case. rightflow builds the
case overview from it, so it is also what staff see.

**Every field**
- Has a `title`, which is the label staff see. Without one, a raw key is shown.
- Has a `description` saying what belongs in it, which the agents read.
- A field with fixed choices has `enum` and `x-enum-labels`, giving a readable
  label for every choice.

**Lists of entries**
- A list (`type: array` of objects) declares how its entries are named:
  - either the entries carry an `id`,
  - or `x-uniqueBy` names the one property that identifies an entry.

  rightflow changes an entry by its name, never by its position, so a list
  without one is refused.

**Platform fields and extra keywords**
- Some fields are filled by rightflow itself. `team_reference` lists them, and
  you should not define them again.
- `team_reference` also lists the extra keywords (`x-…`) rightflow understands,
  the widgets and the tones for choice labels. A keyword not on that list is
  reported.

**Changing existing fields**
- **Renaming or removing a field does not move existing data.** Cases already
  holding a value under the old key keep it there, and the overview no longer
  shows it.
- Prefer adding a field and describing the old one as no longer used.

## PUBLIC.md

These files describe the team and each skill in words staff recognise from their
own work: what it does, when, and what comes out. They hold no instructions to
the agent.
- When a change alters what the team **does**, update the matching `PUBLIC.md`
  in the same change.

## Letter templates and text blocks

`vorlagen/` and `bausteine/` hold the team's letters and the text blocks they
use. They are the firm's own content and stay as the firm wrote them.
- A template's `META.json` names its letterhead. The check reports a letterhead
  the firm does not have yet.
