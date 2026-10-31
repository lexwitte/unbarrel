# @witte/unbarrel

Write clean barrel imports, run concrete-file imports.

```ts
// what you write
import { Account, accountTypes } from '#modules/account';

// what runs
import { Account } from '../account/account.entity.js';
import { accountTypes } from '../account/account.types.js';
```

`unbarrel` rewrites static imports of your own barrel files (`index.ts` files that only re-export) into imports of the modules that actually define each name. Your source keeps short, boundary-respecting imports; at runtime no barrel is ever evaluated.

## Why

Barrels are the natural public API of a folder, but evaluating them is costly and sometimes fatal:

- **Import cycles.** A barrel pulls in everything it re-exports. Two barrels that reach each other close an ESM cycle, and a class can be read before it is initialized. Frameworks that evaluate classes at definition time (NestJS `@Module({ imports })`, decorator metadata such as `design:paramtypes`, `extends`) crash with `ReferenceError` or `undefined` dependencies. The NestJS docs advise against barrels for exactly this reason.
- **Load cost.** Importing one name loads the whole folder.

`unbarrel` removes the barrel from the runtime graph while keeping it in your source.

## How it works

For every static `import { … } from '…'` / `export { … } from '…'` whose specifier is **local** (relative or a `#` subpath import) and resolves to a **barrel**, `unbarrel`:

1. follows each imported name through the barrel (and nested barrels), with ESM `export *` semantics: explicit re-exports shadow stars, and a name two stars provide is ambiguous;
2. replaces the statement with one import per defining module, using a relative specifier;
3. resolves every emitted specifier again and checks it lands on the same file.

A **barrel** is a file named `index.{ts,js,mts,mjs,cts,cjs}` that contains only `export … from` statements. Any other `index` file is an ordinary module and is left alone.

The rewrite preserves line numbers; it does not regenerate source-map column mappings. `import type` statements stay unchanged, and inline `type` bindings are omitted from rewritten statements because compilers erase them. `export * from './barrel'` expands into the stars and re-exports the barrel stands for.

Anything that cannot be split exactly is an **error**, never a silent fallback to loading the barrel:

- namespace imports (`import * as x from barrel`) and `export * as x from barrel`
- default imports and side-effect imports (`import 'barrel'`)
- names the barrel does not export, or exports ambiguously
- import attributes on a barrel import

Dynamic `import()` is left untouched and may still evaluate a barrel. Import concrete files when loading modules dynamically.

## Install

```sh
pnpm add --save-dev @witte/unbarrel typescript
```

`typescript` is a peer dependency (≥ 5.3), used only for parsing. Node ≥ 20.6. ESM only.

The rewrite has to run on **every** path that executes your code. A path that skips it evaluates the barrels again.

### Build output (`tsc`, any compiler)

Run the CLI over the emitted JavaScript after compiling:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json && unbarrel dist"
  }
}
```

The CLI rewrites every `.js`/`.mjs` file under the given directories in place and exits non-zero if any import cannot be split. It resolves `#` imports from the nearest `package.json` `imports` field with the `node` and `import` conditions; add more with `-C <condition>`.

### Node at runtime (dev servers, scripts, CLIs)

Register the load hook **after** your TypeScript loader. Hooks registered later run first, so `unbarrel` sees the loader's JavaScript output:

```sh
node --import @swc-node/register/esm-register --import @witte/unbarrel/register src/main.ts
```

It also works on its own, or before a loader that registers itself later; it understands TypeScript input. It resolves `#` imports with the conditions the process runs with (`--conditions=…`).

The hook uses `module.register()`, which Node 26 marks deprecated (`DEP0205`). The synchronous `module.registerHooks()` would not work: its hooks never see the output of loaders registered with `module.register()`, such as `@swc-node/register`. The async API stays until those loaders move.

### Vite / Vitest

```ts
import { unbarrel } from '@witte/unbarrel/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [unbarrel()],
});
```

The plugin runs with `enforce: 'post'`, after TypeScript compilation and before Vite's import analysis, and resolves through Vite's own resolver, so aliases and `imports` conditions apply.

### API

```ts
import { createPackageResolver, rewriteBarrelImports } from '@witte/unbarrel';

const out = await rewriteBarrelImports(code, absoluteFilePath, {
  resolve: createPackageResolver(['node', 'import']),
});
// `out` is the rewritten code, or null when nothing changed
```

`resolve(specifier, importer)` may be sync or async and returns an absolute path, or `null` for anything outside your project. `createPackageResolver(conditions)` handles relative specifiers and `#` subpath imports (exact keys, `*` patterns with Node's longest-prefix rule, condition objects, `null` targets).

## Recommended setup

Pair `unbarrel` with subpath imports that only point at barrels, so deep imports into another folder do not resolve at all:

```json
{
  "imports": {
    "#modules/*": { "source": "./src/modules/*/index.ts", "default": "./dist/modules/*/index.js" },
    "#lib": { "source": "./src/lib/index.ts", "default": "./dist/lib/index.js" },
    "#lib/*": null
  }
}
```

Inside a folder, import siblings relatively; never import a folder's own barrel from within it. A dependency-graph linter such as dependency-cruiser can enforce both rules.

## License

MIT

## Development

The package is self-contained: dependency versions, TypeScript settings, Vite+ configuration, and GitHub Actions live here. Copy this directory, including `.github/`, into the root of its own repository. Development uses Node 26 and the pnpm version pinned in `package.json`; the published runtime still supports Node 20.6 and newer.

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Vite+ runs Oxlint, Oxfmt, and Vitest from the local `vite.config.ts`. Use `pnpm lint:fix` for fixes or `pnpm format` for formatting. The build uses TypeScript to emit ESM and declarations into `dist/`.

## Publishing

`.github/workflows/publish.yml` checks formatting, lint, types, tests, and the build on pull requests and pushes to `main`. After a successful push to `main`, it publishes the checked tarball publicly as `@witte/unbarrel` using npm trusted publishing with provenance. Already-published versions are skipped; bump `version` in `package.json` to release a new version. The workflow fills in the published repository URL from the GitHub repository that runs it.

Before enabling automatic releases, publish the initial version once with `pnpm publish`, then configure the package's [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) for its standalone GitHub owner, repository, and workflow filename `publish.yml`, allowing direct publishing. No `NPM_TOKEN` secret is required. Provenance requires a public GitHub repository. The nested workflow becomes active when this directory is the repository root.

The prepack hook runs the checks, tests, and build for local publishes. Only compiled output, this README, package metadata, and the license enter the tarball.
