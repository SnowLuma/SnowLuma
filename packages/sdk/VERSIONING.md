# @snowluma/sdk Versioning

The SDK follows SemVer for its public package surface:

- Exported runtime values and classes from `@snowluma/sdk`.
- Exported types from `@snowluma/sdk` and `@snowluma/sdk/types`.
- Supported subpath exports: `client`, `messages`, `events`, `errors`, `actions`, and `types`.
- Runtime behavior of typed client helpers, message builders, event helpers, and SDK error classes.

## Version policy

SDK and application versions are synchronized by `pnpm bump <version>` from the repository root.

The current Node.js requirement is `^24.22.1 || >=26.12.1`. Use the repository's `.node-version` for development and builds.

The SDK is an ES module package that supports native Node.js imports and bundler consumers. Its build uses `NodeNext`; relative source imports and re-exports must use `.js` specifiers so both emitted JavaScript and declarations resolve without a bundler. Package tests compile fresh output, load every runtime entry point with Node.js, and typecheck consumers with both NodeNext and bundler resolution.

- Major: removes or changes a public export, changes runtime behavior incompatibly, changes supported Node version, or changes package subpaths.
- Minor: adds new public API, supports new SnowLuma actions, adds optional parameters, or adds error subclasses.
- Patch: fixes bugs, improves docs, narrows implementation details without breaking public types, or updates action metadata without changing call signatures.

## Release Checklist

1. Run `pnpm bump <version>` to update all workspace versions.
2. Update `packages/sdk/CHANGELOG.md`.
3. Run `pnpm --filter @snowluma/sdk typecheck`.
4. Run `pnpm --filter @snowluma/sdk test`.
5. Run `pnpm --filter @snowluma/sdk build`.
6. Run `pnpm --filter @snowluma/sdk pack --dry-run` to inspect published files.

## Automated npm Publish

`.github/workflows/sdk-npm-publish.yml` publishes `@snowluma/sdk` when SDK-related files reach `main`, including the automated `dev` to `main` promotion flow. The publish job uses npm Trusted Publishing with the GitHub Environment named `SnowLuma`; it authenticates through GitHub Actions OIDC and does not require an `NPM_TOKEN` secret.

The one-time npm settings for SDK, UI, and MCP are documented in
[`.github/npm-trusted-publishing.md`](../../.github/npm-trusted-publishing.md).

If the package version already exists on npm, the workflow skips publishing that run. Bump `packages/sdk/package.json` before merging SDK changes that should create a new npm release.

## Action Compatibility

`SNOWLUMA_ACTIONS`, `isSnowLumaAction`, and `SnowLumaKnownAction` are available from both `@snowluma/sdk` and `@snowluma/sdk/actions`. The catalog includes this release's executable action names, compatibility aliases, and raw actions. OneBot's registry tests verify that the SDK catalog stays aligned with the server; the published SDK does not import server code.

This local catalog is not a capability check against a connected server. Detailed parameter and result types remain in `SnowLumaActionMap`; knowing an action name does not imply it has a specialized type mapping. Custom actions remain supported through `raw()`. Adding an action type is a minor change unless it changes an existing method signature or return type.
