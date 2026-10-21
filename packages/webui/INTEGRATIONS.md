# Host appearance overlays

Set `SNOWLUMA_WEBUI_TARGET=maibot` on the **SnowLuma process** to use MaiBot's
millennium appearance. The same release bundle supports standalone and embedded
deployments. An unset or empty value keeps the existing SnowLuma experience;
unknown values fail WebUI startup with an explicit diagnostic.

This first adapter implements **millennium only**, in light and dark modes.
Other MaiBot styles are not implemented. There is no new appearance selector in
SnowLuma. The host owns theme changes; existing theme controls are unavailable
while managed, and the settings page explains which preferences are preserved.

## Runtime and ownership

1. Core reads the environment at startup. [Static document delivery](../core/src/webui/static-frontend.ts)
   injects a validated, public JSON bootstrap into `/`, `/index.html` and SPA
   fallback documents. Documents use `Cache-Control: no-store`. No secrets or
   arbitrary environment variables reach the browser.
2. [Frontend bootstrap](src/appearance/runtime.ts) loads only the selected
   target's assets before mounting React. Standalone deployments load no target
   stylesheet, font or host listener. Vite development serves the same bootstrap
   when its process has the environment variable; production builds remain neutral.
3. [ThemeContext](src/contexts/ThemeContext.tsx) keeps `savedAppearance` separate
   from effective `appearance`. Only saved preferences enter localStorage or
   `config/ui.json`. Target updates never invoke the persistence API.
4. The target owns colors, fonts, radius, wallpaper, CSS variable overrides,
   custom CSS and custom cursor presentation. These saved values are preserved
   but suspended. UI scale, density, motion/accessibility, navigation layout and
   data preferences remain available. Safe-mode restrictions still apply when
   returning to native appearance.
5. A single layout effect applies effective appearance. Changes do not reload
   the document, change React keys or restart sessions. All target rules are
   scoped to `html[data-webui-target]`, including portals under `body`.

## Host protocol, version 1

The contract lives in [common/webui-target.ts](../common/src/webui-target.ts).
The deployment environment is an opt-in, **not a live transport**. Existing
launchers need to implement the sender below; merely setting the environment
variable cannot convey another process's current theme.

A same-document embedding bridge (for example Electron `executeJavaScript`)
publishes the latest snapshot before dispatching the event:

```js
const appearance = {
    version: 1,
    target: 'maibot',
    style: 'millennium',
    mode: 'dark', // 'light' | 'dark' | 'system'
};
window.__SNOWLUMA_HOST_APPEARANCE__ = appearance;
window.dispatchEvent(new CustomEvent('snowluma:host-appearance', { detail: appearance }));
```

The snapshot handles messages sent before React or the lazy asset loader is
ready. Publish on each guest `dom-ready` and whenever the host's resolved
brightness changes. A host that already follows MaiBot should forward its own
resolved `light`/`dark` state; this avoids competing sources of truth. Validate
the guest's expected origin before injecting, serialize values with
`JSON.stringify`, and do not enable Node integration in the guest.

Send `{ version: 1, target: null }` using the same mechanism to release the
override for the current document. The original appearance returns immediately.
The opted-in document keeps its host subscription so the host can reapply the
target later. Listeners are released on provider unmount. This does not change
the startup environment or enable a target in a standalone deployment.

The current adapter starts with millennium and system brightness before a host
snapshot arrives. The last valid snapshot remains active if the host stops
sending. Snapshots are not persisted or shared across origins/tabs. A reload
requires the host to publish again. Unsupported versions, targets, styles or
modes are rejected with `[SnowLuma appearance]` console diagnostics; the previous
valid snapshot remains. The host cannot supply CSS, URLs or executable content
through this protocol. No unauthenticated HTTP write endpoint is introduced.

## Adding a target

- Add its identifier, styles and default style to `WEBUI_TARGETS` in the shared
  contract. Keep validation at this boundary; do not accept arbitrary strings.
- Add one lazy loader to the exhaustive [frontend registry](src/appearance/registry.ts).
  Implement a pure saved-to-effective resolver and scoped stylesheet under
  `src/appearance/targets`. Keep any fonts local with their redistribution license.
- Use semantic color variables, shared component classes and neutral
  `data-ui-surface` markers. Do not add target-name checks to business pages.
- Never persist resolved overrides, mutate saved preferences, introduce a
  second DOM theme writer, or remount the application to switch presentation.
- Test default asset/listener isolation, initial document routes, malformed
  messages, rapid updates, cleanup and exact restoration of saved preferences.
  Verify forms, focus, scroll, portals and mobile layout with an isolated backend.
  Electron integration needs a separate real-host check.

## Sources and checks

The adapter follows the main MaiBot repository's
[millennium stylesheet](https://github.com/Mai-with-u/MaiBot/blob/5c7637e6913c84d1c3d5e742fa9e95a7e70d3501/dashboard/src/styles/millennium.css),
not the archived standalone WebUI. Colors/materials also match the
[OneKey shell](https://github.com/Mai-with-u/MaiBotOneKey/blob/e8073b0bce35c8c4da973b06156602e14c42fee5/src/renderer/src/styles/millennium.css).
The bundled Jersey 20 font is from that MaiBot revision, copyright The Soft Type
Project Authors, under the [SIL Open Font License](src/appearance/targets/assets/Jersey20-OFL.txt).
Its license is emitted alongside the font in production assets.

Focused checks (from the repository root):

```sh
pnpm --filter @snowluma/common exec vitest run tests/webui-target.test.ts
pnpm --filter @snowluma/core exec vitest run tests/webui-static-frontend.test.ts
pnpm --filter webui exec vitest run tests/target-appearance.test.ts
```

Run the normal workspace checks from `AGENTS.md` before handing off changes.
