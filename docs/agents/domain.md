# Domain Docs

Where this repository's domain documentation lives, for skills that expect it
at the root.

## Layout

The domain model is **not** in this repository. It lives in the handbook,
mounted as a pinned git submodule (ADR-0025):

- Glossary: `docs/handbook/CONTEXT.md`
- Decisions: `docs/handbook/docs/adr/` — `Accepted` overrides `Proposed`, and a
  `Proposed` ADR still binds new code.

There is no root `CONTEXT.md`, no root `docs/adr/`, and no `CONTEXT-MAP.md`.
Single context, one namespace, held upstream. Do not create local copies — two
numbering schemes would make `ADR-0002` name two different decisions depending
on which repository you are standing in.

## Vocabulary

When your output names a domain concept — an issue title, a test name, a
hypothesis, a variable — use the term as `docs/handbook/CONTEXT.md` defines it.
Indonesian regulatory terms stay in Indonesian: PPh 21, BPJS, THR, PKWT, PKWTT,
cuti.

A concept missing from the glossary is a signal: either you are inventing
language the project does not use, or there is a real gap. Real gaps are
appended upstream in the same pull request that introduces them.

## Contradicting a decision

Surface it, never override it in place. Say which ADR you contradict and why,
then follow `docs/handbook/docs/08-ai-guide/ai-development-guide.md` §3 — an ADR
written inside the submodule clone, a pull request on `hris-handbook`, and a
marker on every dependent line. Changing an `Accepted` decision is a supersession
and a human's call; stop and ask.
