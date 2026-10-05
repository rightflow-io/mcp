# rightflow — Claude Code plugins

Plugins that connect [Claude Code](https://claude.com/claude-code) to rightflow.

> **Status: in development.** The plugin below is being built and is not ready
> for use yet.

## rightflow-config

Set up and change your firm's own agent team in rightflow with Claude: load the
team, change it in plain language, see every change before it goes live,
submit it, and look back at what changed, when and by whom.

### Install

In Claude Code:

```
/plugin marketplace add rightflow-io/mcp
/plugin install rightflow-config@rightflow
```

### What you need

- A rightflow account with the owner or admin role in your firm.
- The feature switched on for your firm by rightflow.
- Node.js 22 or newer.

### What it does on your machine

- It signs you in through your browser with your normal rightflow login, and
  keeps that sign-in in the plugin's own data folder, readable only by you.
- It writes a team to a folder you choose when you ask it to load one.
- It talks only to rightflow's sign-in service and API. It sends no telemetry.

What you may change is decided by rightflow's servers, not by the plugin.

## License

[Apache-2.0](LICENSE).

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.
