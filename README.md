# claude-mods

Claude Code mods (function-hook plugins).

```bash
claude plugin marketplace add thieung/claude-mods
claude plugin install worktree-guard@thieung-mods
```

| Mod | What it does |
| --- | --- |
| [worktree-guard](worktree-guard/) | Stops `git add -A` from staging files this session did not touch, previews destructive git commands, and points at the process holding a busy port. |
