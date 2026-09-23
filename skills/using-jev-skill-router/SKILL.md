---
name: using-jev-skill-router
description: Use when a Pi task needs specialized skill guidance not already supplied, or when a user asks about Jev Skill Router visibility, search, status, stats, configuration, or failures.
---

# Using Jev Skill Router

Pi still discovers native skills and keeps `/skill:name` commands. The router advertises only configured `visibleSkills`; other eligible skills can be supplied automatically or searched on demand. A header's skill count is not the model-visible count.

## Find guidance for a task

If a concrete step of the current task lacks guidance, call `jev_skill_search` with a **narrow unmet subtask** (for example, "verify keyboard behavior in this web app"), not the whole task, a file path, or the full conversation. The result contains selected trusted `SKILL.md` bodies; follow the relevant instructions. A no-match or provider failure means continue with current instructions, or use `/skill:name` when a specific skill is known. Simple conversational follow-ups need no search. On-demand search bypasses Luna and remains available when automatic routing is off.

## Inspect and control

| Command | Purpose |
| --- | --- |
| `/jev-skills status` | Router counts (discovered, visible, hidden, manual-only), configuration, and last selection or skip reason. |
| `/jev-skills test <task>` | Dry-run preflight and possible selection without injecting skills. |
| `/jev-skills stats` | Session usage and route counts; Jev cost is estimated only when pricing is configured. |
| `/jev-skills off` / `on` | Disable or enable automatic routing for this session only. |
| `/jev-skills debug on` / `off` | Toggle compact route diagnostics for this session. |

To change always-visible skills, edit `~/.pi/agent/jev-skill-router.json` (`visibleSkills`) and start a new Pi session. An absent list disables routing; `[]` intentionally advertises none. A missing TypeSafe key or Luna model is reported by `status`; provider failures must not block ordinary Pi work. Jev receives bounded user context, so avoid routing sensitive material unless that provider exposure is acceptable. For configuration details, read `../../README.md` relative to this skill's directory.
