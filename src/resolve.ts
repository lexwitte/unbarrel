import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TResolve = (
  specifier: string,
  importer: string,
) => Promise<string | null> | string | null;

type TImportsTarget = string | null | TImportsTarget[] | { [condition: string]: TImportsTarget };

interface IPackageImports {
  dir: string;
  imports: Record<string, TImportsTarget>;
}

const packageCache = new Map<string, IPackageImports | null>();

function findPackageImports(dir: string): IPackageImports | null {
  const cached = packageCache.get(dir);
  if (cached !== undefined) {
    return cached;
  }

  let found: IPackageImports | null;
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    found = { dir, imports: json.imports ?? {} };
  } catch {
    const parent = dirname(dir);
    found = parent === dir ? null : findPackageImports(parent);
  }

  packageCache.set(dir, found);
  return found;
}

function pickTarget(target: TImportsTarget | undefined, conditions: Set<string>): string | null {
  if (typeof target === 'string' || target == null) {
    return target ?? null;
  }
  if (Array.isArray(target)) {
    for (const entry of target) {
      const picked = pickTarget(entry, conditions);
      if (picked !== null) {
        return picked;
      }
    }
    return null;
  }
  for (const [condition, entry] of Object.entries(target)) {
    if (conditions.has(condition)) {
      return pickTarget(entry, conditions);
    }
  }
  return null;
}

/* Node's PATTERN_KEY_COMPARE: the longest prefix before `*` wins, then the longest key. */
function matchImportsKey(
  imports: Record<string, TImportsTarget>,
  specifier: string,
): { target: TImportsTarget | undefined; wildcard: string | null } | null {
  if (Object.hasOwn(imports, specifier) && !specifier.includes('*')) {
    return { target: imports[specifier], wildcard: null };
  }

  let best: { key: string; prefix: number; wildcard: string } | null = null;
  for (const key of Object.keys(imports)) {
    const star = key.indexOf('*');
    if (star === -1 || star !== key.lastIndexOf('*')) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      specifier.length >= key.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (best === null ||
        star > best.prefix ||
        (star === best.prefix && key.length > best.key.length))
    ) {
      best = {
        key,
        prefix: star,
        wildcard: specifier.slice(star, specifier.length - suffix.length),
      };
    }
  }

  return best && { target: imports[best.key], wildcard: best.wildcard };
}

/* Resolves relative and `#` subpath-import specifiers to absolute paths; bare packages are out of scope (null). */
export function createPackageResolver(
  conditions: Iterable<string>,
): (specifier: string, importer: string) => string | null {
  const active = new Set([...conditions, 'default']);

  return (specifier, importer) => {
    if (specifier.startsWith('file:')) {
      return fileURLToPath(specifier);
    }
    if (specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)) {
      return resolve(dirname(importer), specifier);
    }
    if (!specifier.startsWith('#')) {
      return null;
    }

    const pkg = findPackageImports(dirname(importer));
    const match = pkg && matchImportsKey(pkg.imports, specifier);
    const target = match && pickTarget(match.target, active);
    if (!pkg || !match || target === null) {
      return null;
    }

    return resolve(
      pkg.dir,
      match.wildcard === null ? target : target.replaceAll('*', match.wildcard),
    );
  };
}
