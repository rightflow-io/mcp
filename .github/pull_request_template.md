<!--
This repository is public: anyone can read this description, today and for good.
It is also posted to the ticket automatically on merge.

Write it for a stranger. Who asked, which firm, which case, and internal links
belong in the ticket, not here. Name the ticket by its identifier only (DAE-1234),
with no URL.
-->

Ticket: DAE-

## What changes

<!-- From the side of the person using the plugin: what can they do now that they
could not before, or what behaves differently? Before and after, in a few lines. -->

## Why

<!-- The general need ("firm admins need to…"), never who asked. -->

## How it was verified

<!-- Commands run and what they showed. Fixtures or the development environment
only; never a real tenant's data, never a screenshot of one. -->

- [ ] `node scripts/check-public-safety.mjs` passes
- [ ] `node --test 'scripts/*.test.mjs'` passes

## Public safety

- [ ] No secrets, tokens or credentials, not even expired or for testing
- [ ] No personal data: names (real or invented), e-mail addresses, phone numbers, bank details, case or file numbers
- [ ] No customer data: firm names, tenant, organization, team or user ids, content from a firm's team
- [ ] No platform prompts and no internal infrastructure (hostnames, tables, admin routes, staff ids)
- [ ] No links into private systems, and nothing that describes a weakness
