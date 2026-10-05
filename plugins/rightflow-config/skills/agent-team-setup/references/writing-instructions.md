# Writing instructions the agents can follow

Everything in `AGENT.md` and the skills is read by the agents on every case. A
good instruction is one an agent can act on the same way every time, without
guessing what the firm meant.

## One rule, one place

- **Place it where it is needed.** Put a rule in the one file whose task it
  governs:
  - how the coordinator works in `AGENT.md`;
  - how a task is done in that skill;
  - what a helper does in its own `AGENT.md`.
- **Don't repeat it.** Two copies of a rule drift apart, and then the agent has
  to choose.
- **Change before you add.** When a request contradicts an existing rule, change
  that rule rather than adding a second one. If it is unclear which one the
  firm wants, ask the person before writing.

## Decidable, not hopeful

- **Say what to do and when.** "If the reply arrives after the deadline, note it
  in the case and draft a reminder." An agent can follow that. It cannot follow
  "be careful with deadlines".
- **Make conditions checkable.** Name something the agent can see in the case,
  a document or a case field.
- **Say what to do when information is missing:** ask staff, leave the field
  empty, or wait. Otherwise the agent fills the gap with a guess.
- **Keep the firm's own terms.** Use the words staff use for documents, steps
  and outcomes, consistently.

## Rules, not stories

- **Write the rule, not the case it came from.** "Letters to insurers quote
  their claim number in the subject line" carries everything the agent needs. A
  story about one client does not, and it puts that client into every case.
- **No names, addresses, file numbers or other details of real people or
  cases**, not even as examples. Use neutral placeholders such as `<client>` or
  `<date>`.
- **Don't write down where a rule came from.** Who asked for it and when belongs
  in the change-log message, not in the instruction.

## Short beats complete

- **Everything costs attention.** Agents read every line on every case. Cut
  what does not change what the agent does.
- **Steps as a numbered list,** one action per step.
- **Leave out what rightflow already does.** The agents already know how to
  read documents, use their tools, and send everything for approval. Write
  what is specific to the firm's work.

## Case fields and instructions agree

When an instruction tells an agent to record something, the case field must
exist in `CASE_SCHEMA.json`, with the same name, and its `description` must say
what belongs in it. Add or change both in the same change.

## After writing

- **Re-read as the agent would.** Read the changed file top to bottom. Could
  you follow every step on a case you have never seen?
- **Run `check_team`** and read every finding before showing the person the
  result.
