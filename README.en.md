# dsh-literature-workflow (English)

A literature workflow for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), shipped as three DSH plugins:

- **`packages/literature-workflow`** — the pipeline: search → PDF→Markdown → structured extraction → Zotero filing → Excel sheet → card task sheet → HTML slides → optional publishing. Host tools plus a native client page.
- **`packages/knowledge-cards`** — a card library with shelf browsing, deduplication, editing, export and 2D/3D relation graphs.
- **`packages/lit-learning`** — a read-only learning layer: recital, readiness ratings, citations, review items and a field map.

Optional skills live in `skills/`: `knowledge-card-library` and `literature-pipeline`.

## Requirements

DSH `0.2.x` (tested on `0.2.1-rc.3`), Node.js ≥ 22, Python ≥ 3.10 with `openpyxl`, `requests`, `PyMuPDF`. Zotero and Tencent Docs are optional integrations. Windows is the primary tested platform.

## Install

```bash
git clone https://github.com/ysl289/dsh-literature-workflow.git
cd dsh-literature-workflow
python -m pip install -r requirements.txt

dsh plugin --profile <profile> add ./packages/literature-workflow
dsh plugin --profile <profile> add ./packages/knowledge-cards
dsh plugin --profile <profile> add ./packages/lit-learning

cp -r skills/knowledge-card-library ~/.dsh/skills/
cp -r skills/literature-pipeline ~/.dsh/skills/
```

Restart DSH after installing the plugins. Paths are configurable via `DSH_LIT_WORKFLOW`, `DSH_CARDS_HOME`/`KCARD_HOME`, `DSH_LIT_LEARNING` and `DSH_PYTHON`.

Publishing defaults to **preview**; nothing is written to Zotero or Tencent Docs until you enable it on the workflow page.

## Docs

Chinese documentation is authoritative: [README.md](README.md), [docs/configuration.md](docs/configuration.md), [docs/architecture.md](docs/architecture.md), [docs/troubleshooting.md](docs/troubleshooting.md).

## License

MIT. See [LICENSE](LICENSE).
