# @snowluma/sdk Versioning

The SDK follows SemVer for its public package surface:

- Exported runtime values and classes from `@snowluma/sdk`.
- Exported types from `@snowluma/sdk` and `@snowluma/sdk/types`.
- Supported subpath exports: `client`, `messages`, `events`, `errors`, `actions`, and `types`.
- Runtime behavior of typed client helpers, message builders, event helpers, and SDK error classes.

## Version policy

SDK and application versions are synchronized by `pnpm bump <version>` from the repository root.

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

SnowLuma action coverage is synchronized from `packages/onebot/src/actions/*.ts`. Adding an action type is a minor change unless it changes an existing method signature or return type.
