# worktree-guard

A Claude Code mod for worktrees that several sessions share. It keeps one session from sweeping another session's work into a commit, and from throwing it away.

## What it does

- **Stage guard.** At session start it records which files are already dirty. It also records every file the session writes through Edit, Write or NotebookEdit. When the model runs `git add -A`, `git add .`, `git add -u` or `git commit -a`, the guard sorts the files that command would stage:
  - **foreign**: dirty before the session began, and never edited by it. If there are any, the guard asks you, and blocks the command unless you allow it. The block message suggests `git add <this session's files>`.
  - **unknown**: became dirty during the session, but not through Edit or Write (codegen, formatters, `sed`). These only raise a toast.
- **Destructive preview.** `git stash`, `git checkout -- …`, `git checkout .`, `git restore`, `git reset --hard`, `git switch --discard-changes` and `git clean` are dry-run first. You see which files they would touch, then choose to allow or block.
- **Display.** A pane shows one summary line and the files grouped by directory, at most 8 groups, with a **Xem hết** button that expands the full list. On a terminal too narrow for a pane (under 144 columns), a single line above the prompt stands in for it. `/guard-files` prints the full list of the last guarded command.
- **Ports.** When a command fails with `EADDRINUSE`, a toast names the PID and working directory holding the port. When the session ends, the guard lists processes still listening from inside the worktree.

## Limits

This is a safety net, not access control. Commands it cannot see go through: aliases, scripts, `eval`, and git run by another program. It also does not guard these:

- a `git commit` without `-a`, which commits whatever is already staged, possibly by another session;
- hunks that another session added to a file this session also edited;
- `git stash drop` and `git stash clear`.

When nobody can answer the question (a headless `claude -p` run, or a dismissed dialog), the guard blocks. If its own check fails, a guarded command is blocked too.

## Install

```bash
claude plugin marketplace add thieung/claude-mods
claude plugin install worktree-guard@thieung-mods
```
