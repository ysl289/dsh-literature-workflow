# Changelog

## 0.3.1 — 2026-10

- `literature-workflow`: bundle the workflow `src/` and `templates/` as `assets/`, with a fallback from `workflowRoot`; a fresh install no longer needs the original workflow checkout.
- `literature-workflow`: sanitize the bundled scripts (personal name, personal blog default) and make the custom-deck renderer tolerate deck kits without a `cols` parameter.
- CI: Python tests now run on `windows-latest` without `continue-on-error`.

## 0.3.0 — 2026-10

- `literature-workflow`: native client page (sidebar panel) replaces the standalone preview panel.
- `literature-workflow`: conservative publishing defaults (`preview`), configurable paths, portable Python lookup.
- `knowledge-cards`: shelf browsing, dedup, edit/export, 2D/3D relation graphs.
- `lit-learning`: read-only learning layer with recital, readiness ratings, citations, review items and field map.
- Repo: three packages merged into one MIT-licensed monorepo, personal paths removed.

## 0.2.0

- `literature-workflow`: authenticated local client page, task queue, pause/resume, markdown import.
- `knowledge-cards` and `lit-learning` first packaged as DSH bundles.

## 0.1.0

- Initial workflow engine, Zotero filing, Excel generation and HTML slides.
