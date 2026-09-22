# Jev Skill Router

A Pi extension that limits the skill catalog advertised to the main model while preserving native skill discovery and adding semantic routing for hidden skills.

## Language

**Discovered skill**:
A canonical skill entry produced by Pi's native discovery after Pi applies its precedence and deduplication rules.
_Avoid_: Installed skill, catalog item

**Visible skill**:
A normally advertisable discovered skill explicitly named in the effective `visibleSkills` configuration and therefore retained in Pi's ordinary skill catalog.
_Avoid_: Pre-loaded skill, permanent skill

**Hidden skill**:
A normally advertisable discovered skill that is not visible and may be considered by the router.
_Avoid_: Disabled skill

**Manual-only skill**:
A discovered skill whose native metadata sets `disable-model-invocation: true`. It remains available through `/skill:name`, is excluded from automatic routing, and may be returned by an on-demand search.
_Avoid_: Hidden skill, disabled skill

**Supplied skill**:
A skill whose full instructions are still present in the active branch's model context because an automatic route or on-demand search supplied them.
_Avoid_: Loaded skill, selected skill

**Eligible skill**:
A discovered skill that is neither visible nor currently supplied. Automatic routing additionally excludes manual-only skills.
_Avoid_: Candidate, available skill

**Automatic route**:
A pre-response search initiated by the extension for a substantive user turn. It interprets bounded conversation context with Luna and then asks Jev to judge eligible skills.
_Avoid_: Auto-load

**On-demand search**:
A search initiated by the main model through `jev_skill_search` using a task description authored by that model. It calls Jev directly and does not invoke Luna.
_Avoid_: Manual route

**Routing operation**:
One automatic route, on-demand search, or dry-run command, including candidate construction, classification, selection, and skill loading.
_Avoid_: Session
