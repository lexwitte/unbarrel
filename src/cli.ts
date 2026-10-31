#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPackageResolver } from './resolve.ts';
import { rewriteBarrelImports } from './rewrite.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { conditions: { type: 'string', short: 'C', multiple: true, default: [] } },
});

if (positionals.length === 0) {
  console.error('usage: unbarrel [-C condition]... <dir>...');
  process.exit(2);
}

const resolveSpecifier = createPackageResolver(['node', 'import', ...values.conditions]);

function* scripts(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      yield* scripts(path);
    } else if (entry.isFile() && /\.m?js$/.test(entry.name)) {
      yield path;
    }
  }
}

let rewritten = 0;
let failed = 0;
for (const dir of positionals) {
  for (const file of scripts(resolve(dir))) {
    try {
      const out = await rewriteBarrelImports(readFileSync(file, 'utf8'), file, {
        resolve: resolveSpecifier,
      });
      if (out !== null) {
        writeFileSync(file, out);
        rewritten++;
      }
    } catch (error) {
      failed++;
      console.error(error instanceof Error ? error.message : error);
    }
  }
}

console.log(`unbarrel: rewrote ${rewritten} file(s)${failed ? `, ${failed} failed` : ''}`);
process.exitCode = failed ? 1 : 0;
