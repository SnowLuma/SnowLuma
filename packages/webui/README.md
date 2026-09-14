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
- Data-backed surfaces use the Interior Skeleton Swap defaults (120 ms delay,
  380 ms minimum visibility) so fast local responses do not flash a placeholder.
  Submission, upload, and other explicit operation progress keeps its spinner.
- Variable-height content must release the skeleton's reserved box after it is
  ready; do not introduce a second scrolling region inside the page.
- The mobile navigation menu uses a controlled Icon Morph whose visual state
  follows the actual drawer state.
- Failures must remain visible in the affected control and in the operation
  result; do not convert failed responses into successful feedback.
- Password change flows use floating labels and inline validation consistently.
- Password strength details appear only while the new-password field has focus
  and leave with the same motion language when focus moves away.
- The first-run wizard keeps agreement text as the primary reading surface and
  aligns each step's actions inside one responsive footer. Settings includes a
  visible developer page for safely replaying this wizard and exercising the
  page-level crash screen; replayed consent and passwords are never persisted.

## Local development

From the repository root:

```bash
pnpm --filter webui dev
pnpm --filter webui typecheck
pnpm --filter webui lint
pnpm --filter webui test
pnpm --filter webui build
```
