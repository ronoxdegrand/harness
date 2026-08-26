# AI Agent Harness

A desktop coding-agent harness built with Electron, React, and FastAPI.

![AI Agent Harness showing the thread list, active chat, activity inspector, and model picker](image.png)

## Setup

```bash
npm install
npm run setup
```

`npm run setup` installs a pinned, repository-local copy of `uv` when needed, then creates `.venv` and installs the locked backend, test, and packaging dependencies. It does not modify your shell profile or global `PATH`.

## Development

```bash
npm start
```

`npm start` builds the renderer, starts the authenticated local backend, and opens Electron. It uses the repository as its default workspace in development. Rebuild the web app after UI changes.

## Verify and package

```bash
npm run test:api
npm run test:desktop
npm run typecheck:web
npm run package:desktop
npm run smoke:packaged
```

Unsigned packages are written to `apps/desktop/release`. Before tagging, set the shared version, for example with `npm run version:set -- 1.2.3`; matching version tags trigger the cross-platform release workflow.
