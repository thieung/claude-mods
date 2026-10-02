# ghost-proc-guard

A Claude Code mod that keeps one set of dev servers per checkout. Without it, a session that forgets its server is running starts another one, the tool moves to the next free port, and orphaned servers pile up across sessions.

## What it does

- **Refuses duplicate launches.** When Claude runs a dev command through Bash (`npm run dev`, `pnpm dev`, `turbo run dev`, `vite`, `next dev`, `astro dev`, `wrangler dev`, `uvicorn`, `python -m http.server`, and similar), the guard works out which ports the launch will bind. It refuses the launch if one of those ports is taken, or if a server already runs from the same folder. Claude reads who owns the server (command, folder, launching session, process ids) and what to do next: reuse it, stop it if this session started it, or ask you.
- **Monorepos.** For a workspace runner (turbo, `pnpm -r` or `--filter`, nx, lerna, npm workspaces) it reads every package that runs the task, applies turbo's `--filter`, and takes each package's port from the script flag, then the tool's config (`server.port` in vite or astro config, `[dev] port` in `wrangler.toml` or `.jsonc`), then the tool's default.
- **Worktrees.** Each server is placed in its git worktree, including worktrees nested in the main checkout (`.claude/worktrees/*`). A launch that needs a port another worktree holds is refused with a warning not to reuse a server that runs other code. A server in a nested worktree on its own ports does not block the main checkout.
- **Ownership.** Each launch runs with `GHOST_PROC_GUARD_SESSION=<session id>` in its environment, so every server it starts is attributed to that session, even after it is orphaned.
- **/procs.** A pane lists the servers Claude started (this session and earlier ones) and the other servers in the project, one row per app, with its main port and inspector port. **Stop** sends `TERM` to the app's whole process tree; a second press sends `KILL`. Claude's own processes and your interactive shells are never touched. A new session shows a toast about servers earlier sessions left running, and the status line counts the running ones.

If you really want a second server, confirm it and Claude prefixes the command with `GHOST_PROC_GUARD=allow`.

worktree-guard in this marketplace names the process holding a port after a command fails with `EADDRINUSE`; ghost-proc-guard refuses the launch before it starts. They can run together.

## Limits

- Only commands Claude runs through its Bash tool are checked; what you type in your own terminal is not.
- Ports computed in code, such as `port: Number(process.env.PORT)`, are not read; the tool default is assumed.
- Workspace globs are expanded one level (`packages/*`); `**` globs are skipped.
- Tested on macOS. Session ownership is read with BSD `ps -E`; for system binaries whose environment macOS hides, the guard falls back to matching by port and folder.
- The transcript shows the command Claude wrote. The environment prefix is added underneath.
- If the guard's own check fails, the command runs as if the mod were not installed.

## What it runs, reads and sends

Nothing leaves your machine. The mod makes no network calls.

- **Programs it starts**, each as a fixed argument list with no shell:
  - `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` and `lsof -a -d cwd -p <pids> -Fpn`, to list listening processes and their working folders.
  - `ps -A -o pid=,ppid=,command=`, to fold processes into apps by their parent chain.
  - `ps -wwE -o pid=,command= -p <pids>` on listening processes, to read the `GHOST_PROC_GUARD_SESSION` marker. The output includes those processes' environment; only the marker is kept.
  - `sh -c 'echo $PPID'`, to find Claude's own process so it is never folded into an app or stopped.
  - `git -C <folder> worktree list --porcelain`, to place servers in worktrees.
  - `kill -TERM` or `kill -KILL` on an app's processes, only when you press **Stop**.
- **Files it reads:** `package.json` and `pnpm-workspace.yaml` in the launch folder, and in each workspace package its `package.json` plus `vite.config.*`, `astro.config.*` and `wrangler.toml` / `.json` / `.jsonc`. It writes no project files.
- **What it reads from the conversation:** the command text of each Bash call, to recognise dev launches.
- **Hooks that can change a call:** the Bash `tool.call` hook refuses a launch whose ports are taken, and prefixes an allowed launch with `export GHOST_PROC_GUARD_SESSION=<session id>;`. `session.start` registers `/procs`; `command.run` and `ui.render` serve the pane.
- **What it keeps:** the servers Claude started (process ids, ports, command, folder, session id, start time) in the plugin's store under your Claude Code configuration folder, so a later session can list leftovers; and the pane's lists in the session's plugin state.

## Install

```bash
claude plugin marketplace add thieung/claude-mods
claude plugin install ghost-proc-guard@thieung-mods
```

Requires Claude Code 2.1.287 or later.
