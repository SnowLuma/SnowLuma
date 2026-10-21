# SnowLuma WebUI

SnowLuma's browser console is a Vite + React application for managing runtime
status, OneBot configuration, logs, storage, and server settings.

## Host appearance integration

`SNOWLUMA_WEBUI_TARGET=maibot` opts a deployment into a reversible millennium
appearance overlay. Standalone defaults are unchanged. Hosts drive live light/dark
updates without saving over personal preferences or adding another selector.
See [the integration contract and extension guide](INTEGRATIONS.md) before changing
target startup, theme ownership, host messaging or scoped styles.

## Interaction conventions

- Destructive actions and second confirmations stay in modal dialogs.
- Operations that may take time show a bottom-right running state.
- Completed and failed operations use bottom-right result notices that close
  automatically after a visible countdown.
- Routine, high-frequency adjustments should not generate a notice for every
  intermediate edit.
- Foreground polling pauses in hidden tabs and waits for each request to finish
  before scheduling the next. Connection-state polling runs only while SSE clients
  are subscribed.
- Data-backed surfaces use the Interior Skeleton Swap defaults (120 ms delay,
  380 ms minimum visibility) so fast local responses do not flash a placeholder.
  Submission, upload, and other explicit operation progress keeps its spinner.
- Variable-height content must release the skeleton's reserved box after it is
  ready; do not introduce a second scrolling region inside the page.
- The mobile navigation menu uses a controlled Icon Morph whose visual state
  follows the actual drawer state.
- Failures must remain visible in the affected control and in the operation
  result; do not convert failed responses into successful feedback.
- JSON endpoints must return an object. Malformed or non-object responses are
  reported as errors rather than displayed as empty lists or default settings.
- Configuration responses include `config`; saves also report `saved`, `applied`,
  `online`, `errors`, and `message`. The UI uses these fields without legacy aliases
  or a second request after saving.
- Password change flows use floating labels and inline validation consistently.
- Password strength details appear only while the new-password field has focus
  and leave with the same motion language when focus moves away.
- The first-run wizard keeps agreement text as the primary reading surface and
  aligns each step's actions inside one responsive footer. Settings includes a
  visible developer page for safely replaying this wizard and exercising the
  page-level crash screen; replayed consent and passwords are never persisted.

## Authentication behind a reverse proxy

Authenticated WebUI requests send the session token in `X-SnowLuma-Token`, leaving
`Authorization` available for the reverse proxy's HTTP authentication (such as
Nginx Basic Auth). Forward `X-SnowLuma-Token` unchanged if the proxy filters
request headers. The backend still accepts `Authorization: Bearer <token>` for
existing clients when the dedicated header is absent. Both layers still require
their own valid credentials.

Late authentication failures from an old session do not sign out a newer session.
Live streams release subscriptions on disconnect and pause with the page.
Malformed stream data is reported; a debug stream invocation fails instead of silently succeeding.

## Process account detection

Process cards use QQ's local account data before injection and the hook's confirmed
identity after login. Missing local data means the account is unknown. It does not
prove that QQ is signed out, and local detection alone never marks a bridge online.
The manual login probe and `/api/processes/:pid/probe-login` endpoint are removed.

Linux resolves data roots from each QQ process's `XDG_CONFIG_HOME` or `HOME`.
Windows uses the bundled addon’s `getFileHoldersAsync` to find the process holding
each account database. Query failures are reported instead of treated as no login.

## Account notification templates

Webhook bodies and email subjects/bodies support `{uin}`, `{nickname}`, `{event}`
(`offline` or `online`), `{time}`, `{status}` (Hook process state), `{pid}`, and
`{error}` (Hook process error). New webhook and email channels include process
status in their default body; existing saved templates are preserved.
JSON templates escape substituted strings, including quotes, line breaks and control characters.

Process facts are resolved when the notification is dispatched, after any offline
debounce. Each transition carries its process PID, including the final PID detached
when an account goes offline. Facts are looked up for that PID and UIN without
substituting another process. Missing facts render empty and mean unknown, not
proof that QQ exited. Hook status alone does not identify the cause of a QQ login
failure. Notifications for one account are delivered in transition order; a slow
account does not delay other accounts.

## Local development

Packaged installations offer download and restart controls in Settings → About.
Downloads are verified and staged; files are applied before the application starts.
Restart confirmation uses the shared modal, and download results use action feedback.

On Windows, the native API logs the process token and EXE integrity label once
at startup. A Low (or lower) token triggers a WebUI warning; file labels and
query failures alone do not. “临时关闭” lasts for the tab session, including
reloads; “永久关闭” persists in this browser's site storage. Neither suppresses
startup logs. Failed queries and preference writes remain visible.

From the repository root:

```bash
pnpm --filter webui dev
pnpm --filter webui typecheck
pnpm --filter webui lint
pnpm --filter webui test
pnpm --filter webui build
```
