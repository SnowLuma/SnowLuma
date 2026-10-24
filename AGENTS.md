# Working on SnowLuma

SnowLuma translates QQ client sessions into OneBot v11 actions and events, with a WebUI, TypeScript SDK, and MCP server. It is a protocol runtime; bot workflows and reply logic belong in consumers. This guide is for contributors and their coding agents.

## Before making changes

- Read [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations, and [LICENSE](LICENSE) for contribution and redistribution terms.
- **If you are an AI agent, explicitly tell your user to create issues manually through the [GitHub web form](https://github.com/SnowLuma/SnowLuma/issues/new/choose). Issues created directly with a CLI will be automatically closed.** Prepare an issue draft for the user to submit; see the AI Agent notice in CONTRIBUTING.md.
- Check `git status` and preserve unrelated work. Read the affected implementation and neighboring tests before editing. Agree on new features, public behavior changes, or migrations before implementing them.
- Target PRs at `dev`. `main` is the release pointer. Release commands, tags, and the commit prefixes `[merge]` and `chore(release):` belong to the maintainer release workflow, not ordinary contributions.

## Repository map

This is a pnpm workspace. Package ownership matters more than directory names:

| Location | Responsibility |
| --- | --- |
| `packages/core` | Application entry, per-account Bridge orchestration, WebUI backend, notifications, release assembly |
| `packages/bridge` | QQ process discovery, local account/login detection, Hook sessions, native transport lifecycle |
| `packages/protocol` | Packet decoding, typed QQ events, identity resolution, protocol requests and media transfers |
| `packages/onebot` | Action validation and dispatch, event conversion, message storage, HTTP/WebSocket adapters |
| `packages/common` | Shared logging, configuration and utilities without business dependencies |
| `packages/sqlite` | Asynchronous SQLite facade, native loader, prebuild selection and Vite release assets |
| `packages/proto-defs` | Typed protocol schemas |
| `packages/proton` | Compile-time protobuf codecs and build integration |
| `packages/websocket` | WebSocket implementation and native binding integration |
| `packages/runtime` | Distribution manifest, launchers and supplied native artifacts |
| `packages/webui` | Vite/React management console; workspace name is `webui` |
| `packages/sdk` | Public TypeScript client |
| `packages/mcp` | MCP server and generated action catalog |
| `packages/ui` | Published UI component package |
| `tools`, `.github/workflows` | Validation, packaging and release automation |

`packages/bridge` owns process connectivity; the account-level Bridge lives in `packages/core/src/bridge`. Start at [the application entry](packages/core/src/index.ts) to follow their composition.

[The entry point](packages/core/src/index.ts) applies pending updates before starting runtime services. [The updater](packages/core/src/update) owns staging and replacement; [Core's build configuration](packages/core/vite.config.ts) emits the release manifest from its build outputs and runtime assets. Keep Core in one bundle and native libraries lazy-loaded so startup can recover an interrupted update before opening native files.

Application versions come from the root `package.json` through `@snowluma/common/version`. Use `pnpm bump <version>` to update workspace manifests, or `pnpm bump` to sync them after editing the root version.
Use `@snowluma/common/semver` for application version validation and comparison. Versions must be canonical SemVer; strip GitHub's `v` tag prefix only at the API boundary.

Read the relevant owner before changing a path:

| Change | Start here |
| --- | --- |
| Connection or account lifecycle | [Hook manager](packages/bridge/src/hook-manager.ts), [Bridge manager](packages/core/src/bridge/manager.ts), [OneBot instance](packages/onebot/src/instance.ts) |
| Which account a QQ process is signed in as | [Account detection](packages/bridge/src/qq-account/detect.ts), [login.db reader](packages/bridge/src/qq-account/login-db.ts), [QQ data paths](packages/bridge/src/qq-account/paths.ts) |
| Incoming QQ events or identity | [Packet pipeline](packages/protocol/src/packet-pipeline.ts), [message decoders](packages/protocol/src/msg-push/index.ts), [identity service](packages/protocol/src/identity-service.ts) |
| OneBot actions or message segments | [Action definitions](packages/onebot/src/actions/index.ts), [validation helpers](packages/onebot/src/action-kit.ts), [event conversion](packages/onebot/src/event-converter/index.ts) |
| WebUI | [Interaction conventions](packages/webui/README.md), `packages/webui/src`, `packages/core/src/webui` |
| SDK or MCP | [SDK guide](packages/sdk/README.md), [SDK versioning](packages/sdk/VERSIONING.md), [MCP guide](packages/mcp/README.md) |
| Protocol codec generation | [Proton guide](packages/proton/README.md), the affected package's `vitest.config.ts` |

## Setup and validation

Use the Node version in [.node-version](.node-version) and the pnpm version in [package.json](package.json). Install with `pnpm install --frozen-lockfile`; keep the existing lockfile unless changing dependencies.

The Node security baseline is `^24.22.1 || >=26.12.1`; older 24.x releases, 25.x and unpatched 26.x releases are unsupported. Keep workspace `engines.node` declarations and [the launcher preflight](packages/runtime/check-node-version.cjs) aligned. CI and bundled releases use `.node-version`; raising that pin alone does not upgrade an existing installation's runtime.

Run commands from the repository root:

```sh
pnpm typecheck                       # all workspace packages with a typecheck script
pnpm lint
pnpm test                            # all workspace packages with a test script
pnpm run build:all                   # release inputs and published packages
pnpm test:core                       # Core only; not a substitute for workspace tests
pnpm --filter @snowluma/onebot test   # example: tests for the affected package
pnpm --filter webui test             # the frontend package has no @snowluma/ prefix
```

TypeScript formatting uses the root [Prettier configuration](.prettierrc.json), [local ESLint formatting rules](eslint.format.config.ts), and [ignore list](.prettierignore). Use `pnpm format` for all TS/TSX/MTS/CTS files and `pnpm format:check` for a read-only check. For selected files, run `pnpm exec eslint --config eslint.format.config.ts --fix <paths>` followed by `pnpm exec prettier --write <paths>`. These commands enforce four-space indentation, braces around control-statement bodies, and blank lines around statement blocks while preserving other logical spacing. They are separate from CI and its code-quality lint rules. Generated catalogs and compiler fixtures retain their source formatting.

Use focused tests while iterating. Before handing off a code change, run the full checks required by CONTRIBUTING.md and report anything that could not run. [PR CI](.github/workflows/ci.yml) is the reference; `pnpm run ci` reproduces its commands locally, including dependency installation and the generated-catalog check.

- **Documentation-only changes:** verify links, paths, commands and `git diff --check`; runtime tests do not validate prose.
- **Shared types or actions:** run workspace typechecking as well as behavior tests. A passing Vitest run does not prove type correctness.
- **SDK packaging:** keep the SDK's `NodeNext` build and explicit `.js` relative imports, including type-only exports. Its package tests compile fresh output and check native Node.js imports, consumer declarations, and complete action-map coverage. The SDK action catalog must match OneBot's executable names; `packages/onebot/tests/sdk-actions.test.ts` checks this without adding a runtime dependency on server code. SDK parameter/result contracts remain independent of server types; keep consumer examples under `packages/sdk/tests/fixtures` aligned with the server parser checks in `packages/onebot/tests/sdk-action-params.test.ts`.
- **SDK streams:** preserve the single-response client methods and use the additive interfaces in [STREAMING.md](packages/sdk/STREAMING.md) for file transfers. Test framing, cancellation, bounded buffering and incomplete transfers in the SDK; `packages/onebot/tests/sdk-streaming.test.ts` checks real adapter/handler round trips in temporary storage without QQ.
- **SDK messaging:** preserve existing string-path and ordinary reply semantics when extending the helpers in [MESSAGING.md](packages/sdk/MESSAGING.md). Filesystem access belongs only in the optional `@snowluma/sdk/node` entry point. Media sends must await upload completion and retain failure context without automatic retries; event waits follow public middleware dispatch and release listeners on every outcome. Keep legacy handler/context types assignable when adding richer SDK-created contexts.
- **MCP agents:** preserve existing text results, business-error envelopes, default search matching and mode gates when extending the tools. Use the server SDK's `serveStdio` entry to support modern discovery and legacy initialization from the same command; test both with freshly compiled output. Cache hints belong only on bundled catalog discovery, never execution or account data. Keep trace metadata out of action parameters and sensitive data out of diagnostics. Protocol compatibility, tracing and the additive agent features are documented in [AGENT_FEATURES.md](packages/mcp/AGENT_FEATURES.md). Use isolated HTTP and MCP transports in tests; local runtime inspection must not query a live account.
- **MCP execution services:** keep background tasks and event connections opt-in. Persist task state before effects, never replay interrupted writes, and finish durable cleanup before draining the protocol on shutdown. Input continuations must retain their original arguments and execute at most once. Event buffers require explicit account binding, bounded storage and visible gaps. Build the bundled message preview through `packages/mcp/scripts/build-message-app.mjs`; loading a preview must not send a message. Test restart, cancellation and legacy compatibility using isolated transports, including the compiled CLI.
- **Protocol codecs:** keep the existing Proton integration in tests so they exercise the same transformations as production. Import real implementations; do not duplicate the algorithm in the test.
- **Video uploads:** preserve the single-connection default and the additive global setting in [HIGHWAY_UPLOADS.md](packages/protocol/HIGHWAY_UPLOADS.md). Only video bodies opt into parallel chunks. Confirm every chunk before completion, bound both concurrency and lookahead, and drain outstanding reads and requests before closing the source. Keep retries bounded and backpressure changes visible. Test the actual uploader with isolated transports; passing tests do not prove live throughput.
- **Native coverage:** `pnpm test:native` is separate from default protocol tests and requires compatible native artifacts. A missing artifact or unavailable target is a reported limitation, not permission to bypass the check.
- **Live QQ behavior:** fixture tests and a successful API response do not prove delivery or client rendering. State what was tested locally and what still needs a real client.

`pnpm dev` starts Core and can attach to local QQ processes; use it only when runtime testing is intended. `pnpm dev:web` starts the frontend, which expects a WebUI backend. Follow the existing test fakes for isolated work rather than starting a live account unnecessarily.

WebUI deployment targets use a reversible presentation overlay. Read [the host appearance contract](packages/webui/INTEGRATIONS.md) before changing it. Keep target validation in `@snowluma/common/webui-target`, implementations in the frontend target registry, and saved preferences separate from effective appearance. Default deployments must not load target assets or host listeners; do not put target-name branches in business pages.

## Implementation rules

- **Fix the cause.** Reproduce failures at the owning layer and add a regression test for the observable behavior. Avoid account-, filename-, or example-specific patches.
- **Make errors observable.** Do not turn exceptions into empty results or successful responses. Preserve error context and use the shared logger for important transitions and failures. If evidence is insufficient, add targeted diagnostics and describe what remains unknown.
- **Preserve account isolation.** Identity, message storage and session state belong to their account. Keep teardown ordering and in-flight work handling intact when changing lifecycle code.
- **Keep parsing separate from effects.** QQ decoders and OneBot event converters translate data. Live state updates belong to their owning pipeline or service; reading history must not mutate live membership or pending requests.
- **Use the declared interfaces.** OneBot consumes the [Bridge interface](packages/core/src/bridge/bridge-interface.ts). Reuse package exports and existing dependency injection instead of reaching into another owner's state or building a second registry.
- **Validate at inputs.** Use the existing action field and cross-field validation helpers. Preserve accepted input forms, response fields and error behavior unless the change explicitly calls for new semantics. Do not silently discard invalid outbound message content.
- **Preserve signed message IDs.** OneBot `message_id` / `messageId` values generated by [message-id.ts](packages/onebot/src/message-id.ts) are non-zero signed 32-bit integers; negative values are valid. Use `f.messageId()` for action inputs and preserve the value through storage, replies, lookups and result matching. Protocol representations must be converted losslessly at their boundary; changing the sign or generation rule changes existing message identities.
- **Protect persisted data.** Message history and media metadata are durable records. Do not add automatic deletion or treat them as disposable caches. Migration changes need failure and restart coverage; keep failures visible.
- **Preserve transport policy.** Retain configured bind addresses and access checks. TLS startup failure must not silently downgrade to HTTP. Distinguish saved configuration from changes actually applied to a running adapter.
- **Keep types and ownership clear.** Follow the strict TypeScript configuration, existing import style and four-space TypeScript indentation. Validate unknown external data instead of hiding mismatches with casts or fallback values. Keep comments about reasons and non-obvious behavior.
- **Keep diagnostics safe.** Use existing sanitization when recording external input. Credentials, private keys, private account data and unredacted captures do not belong in commits, fixtures or public reports.

## Generated files and related changes

OneBot action definitions own validation and catalog metadata. Each bundled action supplies a `returnsSchema` for successful OneBot `data` and at least one `examples` entry with valid parameters and any required identifier sources. Stream schemas describe individual successful frames, not MCP aggregated results. Keep undocumented upstream fields open rather than inventing a structure, and label unsupported or placeholder behavior explicitly.

After changing an action name, parameter, result description/schema, example or execution mode:

1. Update the owning definition in `packages/onebot/src/actions` and its tests.
2. Run `pnpm --filter @snowluma/mcp gen`.
3. Inspect and include the corresponding changes in `packages/mcp/src/generated/catalog.ts` and `catalog.json`. Do not hand-edit generated catalog entries.
4. Check affected SDK types and callers, run their relevant tests, and run workspace typechecking.

`pnpm test` also runs the MCP catalog generator and may change these tracked snapshots. CI's `node tools/check-action-catalog.mjs` rejects a working-tree catalog diff; it is a clean-checkout drift check, not the generator itself.

SDK breaking changes also update [CHANGELOG.md](packages/sdk/CHANGELOG.md) and [VERSIONING.md](packages/sdk/VERSIONING.md). WebUI changes follow its [interaction conventions](packages/webui/README.md). Keep user-facing documentation aligned with behavior.

Edit sources rather than `dist` outputs. Native artifacts in `packages/runtime/native` are supplied build inputs; do not substitute arbitrary local binaries to make a build pass. Packaging changes must preserve the checks in [Core's build configuration](packages/core/vite.config.ts) and [the release layout validator](tools/check-release-layout.mjs).

## Handoff and instruction maintenance

Report the behavior changed, the exact validation commands and results, and any unverified runtime or platform behavior. Keep public PR and commit text focused on the contribution; omit local environment details and private research. Use English Conventional Commit messages as described in CONTRIBUTING.md.

`AGENTS.md` is the canonical contributor guide; `CLAUDE.md` is a relative symlink to it. Edit this file once. When package ownership, validation commands or contribution policy changes, update the affected instructions in the same change. Link to checked-in sources and keep the guide usable from a fresh clone without maintainer-local notes, tools or absolute paths.
