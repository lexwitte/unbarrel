import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createPackageResolver } from '../resolve.ts';
import { rewriteBarrelImports } from '../rewrite.ts';

let root: string;

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const IMPORTS = {
  '#data/*': './data/*',
  '#modules/*': { src: './src/modules/*/index.ts', default: './dist/src/modules/*/index.js' },
  '#core': { src: './src/core/index.ts', default: './dist/src/core/index.js' },
  '#lib': { src: './src/lib/index.ts', default: './dist/src/lib/index.js' },
  '#lib/*': null,
  '#*.ts': { src: './src/*.ts', default: './dist/src/*.js' },
};

function rewrite(file: string, code: string, conditions = ['src']) {
  return rewriteBarrelImports(code, join(root, file), {
    resolve: createPackageResolver(conditions),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unbarrel-'));
  write({
    'package.json': JSON.stringify({ imports: IMPORTS }),
    'src/modules/account/index.ts': [
      "export * from './account.entity.ts';",
      "export * from './account.types.ts';",
      "export { AccountService as Accounts } from './account.service.ts';",
      "export * as dc from './account.dc.ts';",
      '',
    ].join('\n'),
    'src/modules/account/account.entity.ts':
      'export class Account {}\nexport interface IAccount {}\n',
    'src/modules/account/account.types.ts':
      "export const accountTypes = { DEFAULT: 'default' } as const;\nexport type TAccountType = string;\n",
    'src/modules/account/account.service.ts': 'export class AccountService {}\n',
    'src/modules/account/account.dc.ts': 'export const canPlay = () => true;\n',
    'src/core/index.ts': "export * from './cache/index.ts';\n",
    'src/core/cache/index.ts': "export * from './cache.service.ts';\n",
    'src/core/cache/cache.service.ts': 'export class CacheService {}\n',
    'src/lib/index.ts': "export * from './a.ts';\nexport * from './b.ts';\n",
    'src/lib/a.ts': 'export const shared = 1;\n',
    'src/lib/b.ts': 'export const shared = 2;\n',
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createPackageResolver', () => {
  it('maps subpath patterns by condition and prefers the longest prefix', () => {
    const importer = join(root, 'src/x.ts');
    const source = createPackageResolver(['src']);
    expect(source('#modules/a', importer)).toBe(join(root, 'src/modules/a/index.ts'));
    expect(createPackageResolver(['node'])('#modules/a', importer)).toBe(
      join(root, 'dist/src/modules/a/index.js'),
    );
    expect(source('#modules/a/b.ts', importer)).toBe(join(root, 'src/modules/a/b.ts/index.ts'));
    expect(source('#lib', importer)).toBe(join(root, 'src/lib/index.ts'));
    expect(source('#lib/a.ts', importer)).toBeNull();
    expect(source('#test/context.ts', importer)).toBe(join(root, 'src/test/context.ts'));
    expect(source('#data/games.yaml', importer)).toBe(join(root, 'data/games.yaml'));
    expect(source('fastify', importer)).toBeNull();
  });
});

describe('rewriteBarrelImports', () => {
  it('splits a barrel import into relative imports of the defining modules', async () => {
    const out = await rewrite(
      'src/modules/asset/inventory.repository.ts',
      "import { Account, accountTypes, Accounts as Svc } from '#modules/account';\nAccount;\n",
    );
    expect(out).toBe(
      "import { Account } from '../account/account.entity.ts'; import { accountTypes } from '../account/account.types.ts'; import { AccountService as Svc } from '../account/account.service.ts';\nAccount;\n",
    );
  });

  it('follows nested barrels and relative specifiers', async () => {
    expect(await rewrite('src/main.ts', "import { CacheService } from './core/index.ts';\n")).toBe(
      "import { CacheService } from './core/cache/cache.service.ts';\n",
    );
  });

  it('maps namespace re-exports to namespace imports', async () => {
    expect(await rewrite('src/main.ts', "import { dc } from '#modules/account';\n")).toBe(
      "import * as dc from './modules/account/account.dc.ts';\n",
    );
  });

  it('keeps line count for multi-line imports', async () => {
    const out = await rewrite(
      'src/main.ts',
      "import {\n  Account,\n  accountTypes,\n} from '#modules/account';\nAccount;\n",
    );
    expect(out?.split('\n')).toHaveLength(6);
    expect(out?.split('\n')[4]).toBe('Account;');
  });

  it('drops type-only bindings and leaves `import type` alone', async () => {
    const code =
      "import type { IAccount } from '#modules/account';\nimport { type TAccountType, Account } from '#modules/account';\n";
    expect(await rewrite('src/main.ts', code)).toBe(
      "import type { IAccount } from '#modules/account';\nimport { Account } from './modules/account/account.entity.ts';\n",
    );
  });

  it('expands `export * from barrel` and splits named re-exports', async () => {
    expect(
      await rewrite(
        'src/public.ts',
        "export * from '#core';\nexport { Account } from '#modules/account';\n",
      ),
    ).toBe(
      "export * from './core/cache/cache.service.ts';\nexport { Account } from './modules/account/account.entity.ts';\n",
    );
  });

  it('rewrites compiled output against compiled barrels', async () => {
    write({
      'dist/src/modules/account/index.js':
        "export * from './account.entity.js';\nexport * from './account.types.js';\n",
      'dist/src/modules/account/account.entity.js': 'export class Account {\n}\n',
      'dist/src/modules/account/account.types.js': 'export const accountTypes = {};\n',
    });
    expect(
      await rewrite(
        'dist/src/modules/asset/x.js',
        "import { Account, accountTypes } from '#modules/account';\n",
        ['node', 'import'],
      ),
    ).toBe(
      "import { Account } from '../account/account.entity.js'; import { accountTypes } from '../account/account.types.js';\n",
    );
  });

  it('leaves non-barrel and unrelated imports untouched', async () => {
    expect(
      await rewrite(
        'src/main.ts',
        "import { Account } from './modules/account/account.entity.ts';\nimport x from 'fastify/index.js';\n",
      ),
    ).toBeNull();
  });

  it('rejects barrel imports that cannot be split', async () => {
    await expect(
      rewrite('src/main.ts', "import * as account from '#modules/account';\n"),
    ).rejects.toThrow('namespace import');
    await expect(rewrite('src/main.ts', "import '#modules/account';\n")).rejects.toThrow(
      'side-effect import',
    );
    await expect(
      rewrite('src/main.ts', "import { missing } from '#modules/account';\n"),
    ).rejects.toThrow("'missing' is not exported");
    await expect(
      rewrite('src/main.ts', "import { shared } from './lib/index.ts';\n"),
    ).rejects.toThrow('ambiguous');
  });
});
