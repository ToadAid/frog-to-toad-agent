# Spec: output styles (north-star Tier 2 #6) — v0.1

Branch: `feat/output-styles` (off main `8a20525`). Mother reference:
`~/claude-code/src/outputStyles/loadOutputStylesDir.ts` (98 LOC) — markdown
files whose body is a style prompt; filename = style name, frontmatter
`{name, description}`; lenient (broken file → skipped, never fails boot).

## The cut

`src/agents/outputStyles.ts`:

- **Two layers** (the mother's project/user layering, desk-sized):
  - `assets/output-styles/*.md` — repo-shipped defaults (layer `repo`)
  - `<dataDir>/output-styles/*.md` — operator-editable (layer `operator`,
    same name **overrides** the repo file)
- **Lenient by law**: broken/empty style file → reported in `failed`,
  never fatal, never closes a gate (same religion as stageSkills
  non-gating). Absent dir = absent layer, not an error.
- **Selection**: `DESK_OUTPUT_STYLE` env (explicit operator choice; the
  Telegram service and the TUI are separate processes, each picks its own).
  Unset ⇒ the system prompt is **byte-for-byte unchanged**. Named-but-missing
  ⇒ warn + no block.
- **Prompt seam**: `buildSystemPrompt` appends one additive
  `## Output style (active: <name>)` block after the lessons section. The
  agent body stays; the style shapes how every reply reads. The block text
  itself declares the boundary: tone and format only, never tools,
  authority, or safety gates (a style is not a grant).

**Desk-native honest mapping**: the mother's style REPLACES the tone/verbosity
section of its system prompt; the desk has no separate tone section (the
agent body IS the tone), so the desk style is an additive authoritative
directive instead of an override.

**Shipped seeds** (`assets/output-styles/`):
- `terse.md` — terminal style: short, declarative, no filler
- `numbers.md` — numbers-first, emoji-free: figure before explanation,
  tables over prose, units explicit, uncertainty as a range

**Not ported**: `keep-coding-instructions` (no coding-instruction section
here), plugin `force-for-plugin`, memoize (styles are read per prompt build,
like the memory/lessons reads beside them), dynamic dir discovery.

## Files

- `src/config.ts` — `paths.assetsDir` (additive).
- `src/agents/outputStyles.ts` — loader, selection, prompt block.
- `src/agents/prompts.ts` — the additive seam after lessons.
- `assets/output-styles/{terse,numbers}.md` — shipped seeds.
- `tests/outputStyles.test.ts` — 8 tests.

## Tests (8)

1. Repo styles load; frontmatter name/description + fallback description.
2. Operator layer overrides a same-name repo style.
3. Broken/empty style file → `failed`, never fatal; repo layer survives.
4. Unset `DESK_OUTPUT_STYLE` ⇒ prompt byte-for-byte unchanged.
5. Selected style ⇒ additive block after the agent body.
6. Named-but-missing ⇒ no block, agent still runs.
7. Block text declares the no-grant boundary.
8. Both shipped seeds parse clean from the real repo assets dir.