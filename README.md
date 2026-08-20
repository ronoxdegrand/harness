# AI Agent Harness

A small coding-agent harness with a React UI, FastAPI backend, and optional Electron shell.

![AI Agent Harness showing the thread list, active chat, activity inspector, and model picker](image.png)

## Setup

```bash
npm install
uv sync --all-packages --all-groups
```

## Browser development

Run these in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

Open `http://localhost:5173`.

## Desktop development

```bash
npm run build:web
npm --workspace apps/desktop start
```

Electron uses the repository as its default workspace in development. Rebuild the web app after UI changes.

## Verify and package

```bash
npm run test:api
npm run test:desktop
npm run typecheck:web
npm run package:desktop
npm run smoke:packaged
```

Unsigned packages are written to `apps/desktop/release`. Before tagging, set the shared version, for example with `npm run version:set -- 1.2.3`; matching version tags trigger the cross-platform release workflow.
