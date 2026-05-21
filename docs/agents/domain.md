# Domain Docs

This repo uses a single-context domain-doc layout.

## Before exploring, read these when present

- `CONTEXT.md` at the repo root
- `docs/adr/` for architecture decisions relevant to the area being changed

If these files do not exist, proceed silently. Do not require creating them before work.

## Consumer rules

Use domain terms from `CONTEXT.md` when writing issues, PRDs, tests, diagnoses, or architecture proposals.

If output contradicts an ADR, call that out explicitly instead of silently overriding it.

## Language defaults

Use Chinese by default for:

- Code comments
- README files
- Repository documentation
- Issue bodies and PRD drafts, unless the target issue tracker or user request explicitly requires another language

Use another language only when the user explicitly asks for it, when preserving existing non-Chinese project wording, or when interacting with external APIs/tools that require English identifiers or exact upstream text.
