# claude-mods

Claude Code mods (function-hook plugins). Site: https://thieung.github.io/claude-mods/

```bash
claude plugin marketplace add thieung/claude-mods
claude plugin install worktree-guard@thieung-mods
claude plugin install ak-cockpit@thieung-mods
claude plugin install ghost-proc-guard@thieung-mods
```

| Mod | What it does |
| --- | --- |
| [worktree-guard](worktree-guard/) | Stops `git add -A` from staging files this session did not touch, previews destructive git commands, and points at the process holding a busy port. |
| [ak-cockpit](ak-cockpit/) | AgentKit cockpit above the prompt: context fill with a handoff nudge, and the active plan's phase and checklist. Needs the `ak` CLI. |
| [ghost-proc-guard](ghost-proc-guard/) | Stops Claude from starting a second copy of your dev servers on the next free port (monorepos and worktrees included), tracks the servers it starts, and stops leftovers from a `/procs` pane. |
