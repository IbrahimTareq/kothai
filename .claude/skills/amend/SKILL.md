---
name: amend
description: Add or remove a rule in the constitution (CLAUDE.md / .claude/clean-code-rules.md) following the case-law process. Use when a standard was violated and should be codified, or when reviewing whether the rules have gone stale.
---

# Amend the constitution

## The governing property

`CLAUDE.md` and `.claude/clean-code-rules.md` are meant to **shrink**.
Growth means rules are accreting instead of being pushed down into something
mechanical — and a long rulebook is the documented way to make an agent (or a
person) stop reading the rules that actually matter. Every amendment is
judged against this: does the rulebook end this change larger than it needed
to?

## Adding a rule: the ordered test

A rule reaching prose has already failed three cheaper checks. Walk this list
in order and stop at the first step that applies:

1. **Can Biome enforce it?** Then it is a `biome.json` rule, not prose. No
   line added to either file.
2. **Can a script check it?** Then it joins `scripts/lint-tokens.ts` or
   `scripts/lint-shape.ts` (or a new script of the same shape), wired into
   the `test` script in `package.json` so `pnpm test` runs it. No line added
   to either file.
3. **Can a test assert it?** Then write the test, under `test/`. No line
   added to either file.
4. **Only if none of the above apply** does it become a line of prose:
   - `.claude/clean-code-rules.md` if it's about how code is written.
   - `CLAUDE.md` if it's about architecture, commands, or etiquette.

A rule that reaches step 4 must **cite the violation that earned it** — the
commit, PR, or incident where its absence caused a real problem. No
speculative rules; "an agent might someday..." is not a citation.

## Removing a rule

Whenever a new mechanical check lands (a Biome rule, a script, a test), read
both prose files against `biome.json`, `scripts/*.ts`, and the test suite.
Delete any prose rule that check now enforces — a rule duplicating a
mechanical check is dead weight that dilutes the rules still doing work. This
is not optional cleanup; it's the other half of why the ordered test exists.

## Size

`CLAUDE.md`'s and `.claude/clean-code-rules.md`'s line counts are
machine-enforced by `scripts/lint-shape.ts` against the baseline recorded
under `_governance` in `scripts/shape-baseline.json` — see
docs/development.md's Governance section. If an addition would fail that
check, that is a signal to cut something else first, not to raise the
baseline.

## Reporting

When you land an amendment, say which tier it landed in (Biome rule / script
/ test / prose in which file) and why each tier above it could not hold it —
e.g. "Biome has no rule for import ordering across auth boundaries; no
existing script checks it either; a test can assert it directly, so it's a
test, not a `CLAUDE.md` line." If it's prose, name the violation it cites.
