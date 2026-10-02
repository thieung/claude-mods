# ak-cockpit

An AgentKit cockpit above the Claude Code prompt.

- **Context.** Shows how full the context window is and how much the last turn added. At the handoff threshold (75% by default, set through the `handoffPercent` option) the reading turns red, a toast fires once per crossing, and a **Handoff** button runs `/ak:handoff`. Nothing is ever blocked.
- **Plan.** Follows the plan in `plans/` whose `plan.md` changed last, read with `ak plan parse --json`. The band shows the current phase and how many of its tasks are checked. Press it to open a pane listing the phases and the open checklist items of the current phase.

Requires the `ak` CLI on `PATH` and the `ak:handoff` skill.

## What it runs, reads and sends

Nothing leaves your machine. The mod makes no network calls; what it shows stays in your terminal or desktop app.

- **Programs it starts:** `ak plan parse <plans/that-plan> --json`, a read-only parse of the newest plan, run only when that plan's `plan.md` changed since the last read.
- **Files it reads:** the entries of `plans/`, each `plans/*/plan.md`'s modification time, and the current phase's file, for its checklist. It writes nothing.
- **What it reads from the session:** the context window's fill (`tokens`, `percent`) after each main-thread turn. It does not read messages.
- **Slash commands it runs:** `/ak:handoff`, and only when you press the **Handoff** button.
