import type { LoadHook, ResolveHook } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createPackageResolver } from './resolve.ts';
import { rewriteBarrelImports } from './rewrite.ts';

const MODULE_FORMATS = new Set(['module', 'module-typescript']);

/* Load hooks get no `conditions` (Node 24), so take them from the ESM resolve that precedes every load. */
let resolveSpecifier: ReturnType<typeof createPackageResolver> | undefined;

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
  resolveSpecifier ??= createPackageResolver(context.conditions);
  return nextResolve(specifier, context);
};

export const load: LoadHook = async (url, context, nextLoad) => {
  const result = await nextLoad(url, context);
  if (
    !url.startsWith('file:') ||
    result.source == null ||
    !MODULE_FORMATS.has(result.format ?? '') ||
    url.includes('/node_modules/')
  ) {
    return result;
  }

  if (!resolveSpecifier) {
    throw new Error(`unbarrel: ${url} loaded before any ESM resolve; conditions unknown`);
  }
  const code =
    typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
  const out = await rewriteBarrelImports(code, fileURLToPath(url), { resolve: resolveSpecifier });
  return out === null ? result : { ...result, source: out };
};
