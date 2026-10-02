# ak-cockpit

An AgentKit cockpit above the Claude Code prompt.

- **Context.** Shows how full the context window is and how much the last turn added. At the handoff threshold (75% by default, set through the `handoffPercent` option) the reading turns red, a toast fires once per crossing, and a **Handoff** button runs `/ak:handoff`. Nothing is ever blocked.
- **Plan.** Follows the plan in `plans/` whose `plan.md` changed last, read with `ak plan parse --json`. The band shows the current phase and how many of its tasks are checked. Press it to open a pane listing the phases and the open checklist items of the current phase.

Requires the `ak` CLI on `PATH` and the `ak:handoff` skill.
