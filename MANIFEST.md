# MANIFEST — how we build daemon

These principles hold in every daemon repository, for every contributor, human or
agent. A repository's `CLAUDE.md` adds what is specific to it; it never overrides
them.

The canonical copy lives in the `daemon` repository. Every other repository carries
an identical copy — change it there first, then copy it across unchanged.

## 1. Generic by default

Every feature, fix and prompt is built for all case groups, domains, firms and
countries. Special behaviour for one case group needs explicit confirmation — and
even then it lives where specialisation is meant to live: the bundle, the case
schema, team config, an automation, a process-type `ui` slug. It never branches on
who the customer is. If a request only fits by bending the platform, say so instead
of bending it.

The test: onboarding the next firm — in a new domain, in another country — means
writing configuration and content, not code.

## 2. Leave it cleaner than you found it

Clean, working code is the product. When your change makes something redundant — a
fallback, a parallel helper, a dead flag, an overly verbose or stale comment —
remove it in the same change, once you have confirmed it is unused (search, types,
tests). Delete rather than deprecate. One mechanism per job. Cleanup beyond the
files you are changing is its own ticket, not a bigger pull request.

## 3. Comment the why, not the what

Code says what it does. A comment earns its place only by carrying what the code
cannot: a decision, a constraint, a trade-off, a trap. No narration, no history
("used to…"), no ticket ids — except on a temporary workaround, which names its
ticket and the condition for removing it.

Comments that fail this test go when you come across them in files you are
changing; a comment that is too long is cut to the sentence that carries the
reason. Keep that sentence — brevity is no reason to lose reasoning.

## 4. English is the platform language

Code, identifiers, comments, commit messages, pull requests, Linear tickets and
every prompt written in code are English — whatever language the thread or the
report arrived in. Output language is a parameter: a prompt tells the model which
language to answer in, it is not written in it.

Content a firm or a locale owns may be in its own language: bundles, letter
templates, case-schema labels, and locale-specific conventions kept as content
(such as the rules for German letters). Chat replies follow the language the person
writes in.

## 5. Multi-geo: no silent defaults

Dates, time zones, currency, number and address formats and legal vocabulary come
from the tenant's locale — nothing is assumed to be German. Text a user sees goes
through i18n and is never hard-coded.

## 6. Types are strict

Every repository compiles with `strict: true`, and no `any`. Where a repository is
not there yet, it ratchets towards it: new code is written strict-clean, and the
config is never loosened to make something compile.

## 7. Existing data is part of the design

Every change answers what happens to what already sits in tenants' case files — and
whether anyone will notice. A migration is part of the change, not a follow-up.

## 8. Verify, then claim

Run the repository's gate. Look at what a UI change looks like. Report a failure as
a failure. "Should work" is not done.

## 9. Fail loudly

Don't swallow errors, and don't keep a fallback that hides a broken path. A write
that fails quietly looks exactly like one that works.

## 10. Nothing personal in the repository

No real — or invented — names, addresses, file numbers, e-mail addresses, phone
numbers or bank details in code, fixtures, comments, commits or pull requests. Test
data states the property under test, not a story.

## 11. Explain the flow, not the code

When explaining something to a person, describe what a human experiences — screens,
buttons, the sentences that appear there, what someone sees after a click — not
file names, function names, field names, status values or table columns.

The test: could the case worker who uses it read the paragraph and recognise their
own work? If not, it is too deep.

- **Tell a change as before and after.** "Today it is one click, no confirmation,
  and afterwards nothing records who did it" says more than any list of methods.
- **Keep numbers and names from the domain**, drop names from the code. Deadline,
  follow-up, hearing, summons — yes. Column and variable names — no.
- **Technical depth comes on request**, or when a decision cannot be made without
  it — then as its own clearly separated section, not mixed into the prose.
- For larger work this order helps: How does it work today? How do you see it? How
  do you operate it? What is there afterwards? What changes? What happens to what
  already exists?
- **Backward compatibility is always answered on its own**, never as a footnote:
  what happens to the data already in the case files, and will anyone notice?

This applies to chat replies. Commit messages, pull requests and code comments stay
as precise and technical as they need to be — their reader is a developer.

## 12. Backwards compatible, cleaned up one release later

During a rollout the previous release keeps running next to the new one, against
the same database, the same queues and the same clients. A change is shipped so
that both can: expand first — add the column with a default, accept the old and
the new shape, keep the old path working — and contract only once nothing
running still depends on the old behaviour.

The contracting step is not left to memory. It goes on the repository's
`CLEANUP.md` in the same change, stating what to remove, why it can go and
which ticket carries it, and it ships in the next release, not in this one. A
release starts by working through that list.
