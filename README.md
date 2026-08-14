# AI Agent Harness Monorepo

Milestone 1 sets up a clean monorepo foundation for an AI agent harness with:

- `apps/api`: FastAPI service managed with `uv`
- `apps/web`: React + Vite frontend, ready for Tailwind/shadcn usage
- SQLite as the local default persistence layer for fast iteration

## Why this shape

- `uv` is fast and a good fit for Python app and dependency management.
- FastAPI gives us a reliable API surface for agents, orchestration, and tool execution.
- React + Vite keeps the frontend lightweight while we define the product surface.
- SQLite is enough for local harness state, runs, and logs during early milestones.
- shadcn is best added where UI needs become concrete, so this setup is prepared for it without over-scaffolding.

## Repo layout

```text
.
|-- apps
|   |-- api
|   `-- web
|-- package.json
`-- pyproject.toml
```

## Getting started

### API

```bash
cd apps/api
uv sync
uv run uvicorn agent_harness_api.main:app --reload
```

The API will start on `http://127.0.0.1:8000` and initialize a SQLite database in `apps/api/data/app.db`.

### Web

```bash
cd apps/web
npm install
npm run dev
```

Or from the repo root:

```bash
npm install
npm run dev:web
```

## Milestone 1 deliverables

- Monorepo folder structure
- Root workspace metadata
- FastAPI app scaffold with health and DB status endpoints
- SQLite initialization seam for future agent state
- React app scaffold with shared aliases and shadcn-ready config

## Next likely milestones

1. Add agent run models and persistence.
2. Add background task execution and streaming updates.
3. Introduce shadcn components once the first real workflows are designed.
4. Add linting, tests, and CI once core flows exist.

