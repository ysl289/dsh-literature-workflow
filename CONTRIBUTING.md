# Contributing

Thanks for taking a look. This repository packages three DSH plugins; keep changes scoped to the package you touch.

## Before you start

- Node.js ≥ 22 and Python ≥ 3.10.
- Install Python deps: `python -m pip install -r requirements.txt`.
- Do **not** commit personal paths, credentials, session logs, generated libraries, or `__pycache__`.

## Workflow

1. Open an issue for anything larger than a small fix.
2. Branch from `main`; one logical change per pull request.
3. Run the checks for the package(s) you touched:

   ```bash
   cd packages/literature-workflow && node --test tests/*.test.mjs
   cd packages/knowledge-cards     && node --test tests/*.test.mjs
   cd packages/lit-learning        && npm install && node --test tests/*.test.mjs
   python -m pytest packages/literature-workflow/tests -q
   ```

4. Update the docs when behavior or configuration changes (`README.md`, `docs/`).
5. Describe what you verified in the pull request — "tests pass" alone is not enough; say which path you exercised.

> Python integration tests depend on the workflow renderer version (`src/html`). Five of them are version-sensitive (design/lecture page checks, custom deck `cols`, Excel path linkage); CI treats pytest as informational. The Node suites and package-structure checks are the gate.

## Style

- Plain ESM, no build step for host code.
- Prefer small, testable functions; keep the read-only/write boundaries documented in the code comments.
- Chinese and English are both fine in comments and docs; keep user-facing text consistent with the surrounding file.

## Reporting security issues

Do not open a public issue for credential handling, path traversal, or publishing-side effects. Email the maintainer listed on the GitHub profile instead.
