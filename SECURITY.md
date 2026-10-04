# Security

## Reporting a vulnerability

Please report a suspected vulnerability **privately**, through GitHub's
[private vulnerability reporting](https://github.com/rightflow-io/mcp/security/advisories/new).
Do not open an issue or pull request for it, and do not describe it anywhere
public: this repository is.

Please include what you did, what happened, and what you expected, without
real personal or customer data. We acknowledge a report and keep you informed
until it is resolved.

## Scope

- The plugins in this repository and the local MCP server they run.
- How they store and use your sign-in on your machine.

The rightflow service itself enforces what a signed-in person may read and
change; the plugin only asks. A finding in the service is welcome through the
same private channel.

## If you find a credential in this repository

Report it the same way. A leaked credential is revoked; removing it from the
repository alone would not help, because its history stays public.
