import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import ts from 'typescript';
import type { TResolve } from './resolve.ts';

interface IReexport {
  specifier: string;
  /* `*` for `export * as name from`. */
  imported: string;
  type: boolean;
}

interface IStar {
  specifier: string;
  type: boolean;
}

interface IModuleExports {
  barrel: boolean;
  locals: Map<string, { type: boolean }>;
  reexports: Map<string, IReexport>;
  stars: IStar[];
}

export interface IExportSource {
  file: string;
  /* `*` when the barrel re-exports a whole module as a namespace. */
  name: string;
  type: boolean;
}

const BARREL_NAME = /^index\.[cm]?[jt]s$/;
const moduleCache = new Map<string, { mtimeMs: number; exports: IModuleExports }>();

export function scriptKind(file: string): ts.ScriptKind {
  return /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
  );
}

function collectBindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, into);
    }
  }
}

function parseModuleExports(file: string, code: string): IModuleExports {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, scriptKind(file));
  const result: IModuleExports = {
    barrel: BARREL_NAME.test(basename(file)),
    locals: new Map(),
    reexports: new Map(),
    stars: [],
  };
  const localTypes = new Set<string>();
  const localExports: Array<{ local: string; exported: string; type: boolean }> = [];

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      const clause = statement.exportClause;

      if (specifier === null) {
        result.barrel = false;
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            localExports.push({
              local: (element.propertyName ?? element.name).text,
              exported: element.name.text,
              type: statement.isTypeOnly || element.isTypeOnly,
            });
          }
        }
      } else if (!clause) {
        result.stars.push({ specifier, type: statement.isTypeOnly });
      } else if (ts.isNamespaceExport(clause)) {
        result.reexports.set(clause.name.text, {
          specifier,
          imported: '*',
          type: statement.isTypeOnly,
        });
      } else {
        for (const element of clause.elements) {
          result.reexports.set(element.name.text, {
            specifier,
            imported: (element.propertyName ?? element.name).text,
            type: statement.isTypeOnly || element.isTypeOnly,
          });
        }
      }
      continue;
    }

    result.barrel = false;
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    const declared = hasModifier(statement, ts.SyntaxKind.DeclareKeyword);

    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      localTypes.add(statement.name.text);
      if (exported) {
        result.locals.set(isDefault ? 'default' : statement.name.text, { type: true });
      }
    } else if (ts.isVariableStatement(statement)) {
      if (exported) {
        const names: string[] = [];
        for (const declaration of statement.declarationList.declarations) {
          collectBindingNames(declaration.name, names);
        }
        for (const name of names) {
          result.locals.set(name, { type: declared });
        }
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (exported) {
        const name = isDefault ? 'default' : statement.name?.text;
        if (name) {
          result.locals.set(name, { type: declared });
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      result.locals.set('default', { type: false });
    }
  }

  for (const { local, exported, type } of localExports) {
    result.locals.set(exported, { type: type || localTypes.has(local) });
  }

  return result;
}

function readModuleExports(file: string): IModuleExports {
  const { mtimeMs } = statSync(file);
  const cached = moduleCache.get(file);
  if (cached?.mtimeMs === mtimeMs) {
    return cached.exports;
  }

  const exports = parseModuleExports(file, readFileSync(file, 'utf8'));
  moduleCache.set(file, { mtimeMs, exports });
  return exports;
}

/* A barrel is an `index.*` file made only of `export … from` statements; anything else is an ordinary module. */
export function isBarrel(file: string): boolean {
  return BARREL_NAME.test(basename(file)) && existsSync(file) && readModuleExports(file).barrel;
}

async function resolveIn(file: string, specifier: string, resolve: TResolve): Promise<string> {
  const resolved = await resolve(specifier, file);
  if (resolved === null) {
    throw new Error(`unbarrel: cannot resolve '${specifier}' re-exported by ${file}`);
  }
  return resolved;
}

/* Whether a non-barrel module provides `name`, following its own `export *`; null when it does not. */
async function provides(
  file: string,
  name: string,
  resolve: TResolve,
  seen: Set<string>,
): Promise<{ type: boolean } | null> {
  if (seen.has(file)) {
    return null;
  }
  seen.add(file);

  const exports = readModuleExports(file);
  const own = exports.locals.get(name) ?? exports.reexports.get(name);
  if (own) {
    return { type: own.type };
  }

  let found: { type: boolean } | null = null;
  for (const star of exports.stars) {
    if (name === 'default') {
      break;
    }
    const hit = await provides(await resolveIn(file, star.specifier, resolve), name, resolve, seen);
    if (hit && (found === null || found.type)) {
      found = { type: hit.type || star.type };
    }
  }
  return found;
}

/* Follows `name` through (nested) barrels to the module that provides it, mirroring ESM `export *` rules:
   explicit re-exports shadow stars, and a name two stars provide as values is ambiguous. */
export async function findExport(
  barrel: string,
  name: string,
  resolve: TResolve,
  seen: Set<string> = new Set(),
): Promise<IExportSource | null> {
  if (seen.has(barrel)) {
    return null;
  }
  seen.add(barrel);

  const exports = readModuleExports(barrel);
  const reexport = exports.reexports.get(name);
  if (reexport) {
    const target = await resolveIn(barrel, reexport.specifier, resolve);
    if (reexport.imported !== '*' && isBarrel(target)) {
      const nested = await findExport(target, reexport.imported, resolve, seen);
      return nested && { ...nested, type: nested.type || reexport.type };
    }
    return { file: target, name: reexport.imported, type: reexport.type };
  }

  if (name === 'default') {
    return null;
  }

  const candidates: IExportSource[] = [];
  for (const star of exports.stars) {
    const target = await resolveIn(barrel, star.specifier, resolve);
    let found: IExportSource | null;
    if (isBarrel(target)) {
      found = await findExport(target, name, resolve, seen);
    } else {
      const hit = await provides(target, name, resolve, new Set());
      found = hit && { file: target, name, type: hit.type };
    }
    if (found) {
      candidates.push({ ...found, type: found.type || star.type });
    }
  }

  const values = candidates.filter((candidate) => !candidate.type);
  if (values.length > 1) {
    throw new Error(
      `unbarrel: '${name}' is ambiguous in ${barrel} (${values.map((v) => v.file).join(', ')})`,
    );
  }
  return values[0] ?? candidates[0] ?? null;
}

/* Flattens `export * from barrel` into the stars and named re-exports it stands for. */
export async function expandStar(
  barrel: string,
  resolve: TResolve,
): Promise<Array<{ file: string; names: Array<{ imported: string; exported: string }> | null }>> {
  const exports = readModuleExports(barrel);
  const out: Array<{ file: string; names: Array<{ imported: string; exported: string }> | null }> =
    [];

  for (const [exported, reexport] of exports.reexports) {
    if (reexport.type) {
      continue;
    }
    const target = await resolveIn(barrel, reexport.specifier, resolve);
    if (reexport.imported === '*' || !isBarrel(target)) {
      out.push({ file: target, names: [{ imported: reexport.imported, exported }] });
      continue;
    }
    const source = await findExport(target, reexport.imported, resolve);
    if (!source) {
      throw new Error(
        `unbarrel: ${barrel} re-exports missing '${reexport.imported}' from ${target}`,
      );
    }
    out.push({ file: source.file, names: [{ imported: source.name, exported }] });
  }

  for (const star of exports.stars) {
    if (star.type) {
      continue;
    }
    const target = await resolveIn(barrel, star.specifier, resolve);
    if (isBarrel(target)) {
      out.push(...(await expandStar(target, resolve)));
    } else {
      out.push({ file: target, names: null });
    }
  }

  return out;
}
