import { dirname, relative, sep } from 'node:path';
import ts from 'typescript';
import { expandStar, findExport, isBarrel, scriptKind } from './barrel.ts';
import type { TResolve } from './resolve.ts';

export interface IRewriteOptions {
  resolve: TResolve;
}

interface IBinding {
  imported: string;
  local: string;
  type: boolean;
}

/* Pre-filter: every static import/re-export reads `from '…'` or `import '…'`; false positives only cost a parse. */
const LOCAL_SPECIFIER = /\b(?:from|import)\s*['"]([.#][^'"]*)['"]/g;
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

function cleanId(id: string | null | undefined): string | null {
  return id ? id.replace(/[?#].*$/, '') : null;
}

function formatName(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('#') || specifier.startsWith('./') || specifier.startsWith('../');
}

function toSpecifier(importer: string, target: string): string {
  const rel = relative(dirname(importer), target).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

async function verifiedSpecifier(
  original: string,
  target: string,
  importer: string,
  resolve: TResolve,
): Promise<string> {
  const specifier = toSpecifier(importer, target);
  if (cleanId(await resolve(specifier, importer)) !== target) {
    throw new Error(
      `unbarrel: ${importer}: '${specifier}' (from '${original}') does not resolve to ${target}`,
    );
  }
  return specifier;
}

async function rewriteStatement(
  statement: ts.Statement,
  source: ts.SourceFile,
  file: string,
  resolve: TResolve,
): Promise<string | null> {
  const isImport = ts.isImportDeclaration(statement);
  if (!isImport && !ts.isExportDeclaration(statement)) {
    return null;
  }

  const specifierNode = statement.moduleSpecifier;
  if (
    !specifierNode ||
    !ts.isStringLiteral(specifierNode) ||
    !isLocalSpecifier(specifierNode.text)
  ) {
    return null;
  }

  const specifier = specifierNode.text;
  const barrel = cleanId(await resolve(specifier, file));
  if (barrel === null || !isBarrel(barrel)) {
    return null;
  }

  const fail = (why: string) => new Error(`unbarrel: ${file}: ${why} '${specifier}'`);
  const quote = source.text[specifierNode.getStart(source)];
  const literal = (value: string) => `${quote}${value}${quote}`;
  if (statement.attributes) {
    throw fail('import attributes on barrel');
  }

  let bindings: IBinding[];
  if (isImport) {
    const clause = statement.importClause;
    if (!clause) {
      throw fail('side-effect import of barrel');
    }
    if (clause.isTypeOnly) {
      return null;
    }
    if (clause.name) {
      throw fail('default import from barrel');
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      throw fail('namespace import of barrel');
    }
    bindings = (clause.namedBindings?.elements ?? []).map((element) => ({
      imported: (element.propertyName ?? element.name).text,
      local: element.name.text,
      type: element.isTypeOnly,
    }));
  } else {
    if (statement.isTypeOnly) {
      return null;
    }
    const clause = statement.exportClause;
    if (!clause) {
      const members = await expandStar(barrel, resolve);
      const parts: string[] = [];
      for (const member of members) {
        const target = literal(await verifiedSpecifier(specifier, member.file, file, resolve));
        if (member.names === null) {
          parts.push(`export * from ${target};`);
          continue;
        }
        for (const { imported, exported } of member.names) {
          parts.push(
            imported === '*'
              ? `export * as ${formatName(exported)} from ${target};`
              : `export { ${formatName(imported)} as ${formatName(exported)} } from ${target};`,
          );
        }
      }
      return parts.join(' ');
    }
    if (ts.isNamespaceExport(clause)) {
      throw fail('namespace re-export of barrel');
    }
    bindings = clause.elements.map((element) => ({
      imported: (element.propertyName ?? element.name).text,
      local: element.name.text,
      type: element.isTypeOnly,
    }));
  }

  /* Type-only bindings are erased by every compiler, so they never load the barrel. */
  const values = bindings.filter((binding) => !binding.type);
  if (values.length === 0) {
    if (bindings.length === 0) {
      throw fail('empty import of barrel');
    }
    return '';
  }

  const keyword = isImport ? 'import' : 'export';
  const groups = new Map<string, string[]>();
  const namespaces: string[] = [];
  for (const binding of values) {
    const found = await findExport(barrel, binding.imported, resolve);
    if (!found) {
      throw fail(`'${binding.imported}' is not exported by`);
    }
    if (found.file === file) {
      throw fail(`'${binding.imported}' resolves back to the importer via`);
    }

    const target = await verifiedSpecifier(specifier, found.file, file, resolve);
    if (found.name === '*') {
      namespaces.push(`${keyword} * as ${formatName(binding.local)} from ${literal(target)};`);
      continue;
    }
    const rendered =
      found.name === binding.local
        ? formatName(binding.local)
        : `${formatName(found.name)} as ${formatName(binding.local)}`;
    groups.set(target, [...(groups.get(target) ?? []), rendered]);
  }

  return [
    ...[...groups].map(
      ([target, names]) => `${keyword} { ${names.join(', ')} } from ${literal(target)};`,
    ),
    ...namespaces,
  ].join(' ');
}

async function importsBarrel(code: string, file: string, resolve: TResolve): Promise<boolean> {
  for (const [, specifier] of code.matchAll(LOCAL_SPECIFIER)) {
    if (specifier && isLocalSpecifier(specifier)) {
      const resolved = cleanId(await resolve(specifier, file));
      if (resolved !== null && isBarrel(resolved)) {
        return true;
      }
    }
  }
  return false;
}

/* Preserve statement line counts for existing maps; column mappings inside replaced imports may drift. */
export async function rewriteBarrelImports(
  code: string,
  file: string,
  options: IRewriteOptions,
): Promise<string | null> {
  if (isBarrel(file) || !(await importsBarrel(code, file, options.resolve))) {
    return null;
  }

  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, scriptKind(file));
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const statement of source.statements) {
    const text = await rewriteStatement(statement, source, file, options.resolve);
    if (text !== null) {
      const start = statement.getStart(source);
      const lineBreaks = code.slice(start, statement.end).split('\n').length - 1;
      edits.push({ start, end: statement.end, text: text + '\n'.repeat(lineBreaks) });
    }
  }

  if (edits.length === 0) {
    return null;
  }

  let out = code;
  for (const edit of edits.reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
