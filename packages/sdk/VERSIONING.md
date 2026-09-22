# @snowluma/sdk Versioning

The SDK follows SemVer for its public package surface:

- Exported runtime values and classes from `@snowluma/sdk`.
- Exported types from `@snowluma/sdk` and `@snowluma/sdk/types`.
- Supported subpath exports: `client`, `messages`, `events`, `errors`, `actions`, and `types`.
- Runtime behavior of typed client helpers, message builders, event helpers, and SDK error classes.

## Current 0.x Policy

While the SDK is below `1.0.0`, breaking changes should use a minor release and include a migration note. Patch releases should remain bug fixes only.

Examples:

- `0.1.1`: bug fix, doc fix, type refinement that does not break consumers.
- `0.2.0`: new client helper, new event helper, new action typing, or documented breaking change before 1.0.
- `1.0.0`: first stable release where breaking changes move to major versions.

## After 1.0

- Major: removes or changes a public export, changes runtime behavior incompatibly, changes supported Node version, or changes package subpaths.
- Minor: adds new public API, supports new SnowLuma actions, adds optional parameters, or adds error subclasses.
- Patch: fixes bugs, improves docs, narrows implementation details without breaking public types, or updates action metadata without changing call signatures.

## Release Checklist

1. Update `packages/sdk/package.json` version.
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

SnowLuma action coverage is synchronized from `packages/core/src/onebot/actions/*.ts`. Adding an action type is a minor change unless it changes an existing method signature or return type.
