# claude-mods

Claude Code mods (function-hook plugins).

```bash
claude plugin marketplace add thieung/claude-mods
claude plugin install worktree-guard@thieung-mods
claude plugin install ak-cockpit@thieung-mods
```

| Mod | What it does |
| --- | --- |
| [worktree-guard](worktree-guard/) | Stops `git add -A` from staging files this session did not touch, previews destructive git commands, and points at the process holding a busy port. |
| [ak-cockpit](ak-cockpit/) | AgentKit cockpit above the prompt: context fill with a handoff nudge, and the active plan's phase and checklist. Needs the `ak` CLI. |
