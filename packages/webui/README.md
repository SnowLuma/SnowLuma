# SnowLuma WebUI

SnowLuma's browser console is a Vite + React application for managing runtime
status, OneBot configuration, logs, storage, and server settings.

## Interaction conventions

- Destructive actions and second confirmations stay in modal dialogs.
- Operations that may take time show a bottom-right running state.
- Completed and failed operations use bottom-right result notices that close
  automatically after a visible countdown.
- Routine, high-frequency adjustments should not generate a notice for every
  intermediate edit.
- Failures must remain visible in the affected control and in the operation
  result; do not convert failed responses into successful feedback.

## Local development

From the repository root:

```bash
pnpm --filter webui dev
pnpm --filter webui typecheck
pnpm --filter webui lint
pnpm --filter webui test
pnpm --filter webui build
```
