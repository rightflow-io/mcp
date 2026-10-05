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

### How a change goes

1. Load the team into a folder.
2. Ask Claude to change it.
3. Claude checks the change with rightflow and shows you every file it touches,
   with what rightflow would refuse.
4. Nothing goes live until you agree and give a short summary of the change.
   The summary is kept in the team's change log, next to who made the change
   and when.

You can look back at that log, and bring an earlier version back as a new entry.

### Production and development

The plugin works against rightflow **production** by default. If rightflow asks
you to try something on its development environment:

1. Open `/plugin`, choose rightflow-config, and set its environment option to
   `development`.
2. Call `sign_in` again.

Each environment has its own sign-in and its own default folders
(`rightflow/production/…`, `rightflow/development/…`). A team loaded from one
environment, or for one firm, is never sent to another. The first line of every
answer names the environment and the firm, so you can always see where you are
working.

## License

[Apache-2.0](LICENSE).

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.
