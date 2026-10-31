import { rewriteBarrelImports } from './rewrite.ts';

interface IPluginContext {
  resolve(source: string, importer?: string): Promise<{ id: string } | null>;
}

const SCRIPT = /\.[cm]?[jt]sx?$/;

/* `enforce: 'post'` runs after the TS compiler plugin and before Vite's import analysis. */
export function unbarrel() {
  return {
    name: 'unbarrel',
    enforce: 'post' as const,
    async transform(this: IPluginContext, code: string, id: string) {
      const file = id.replace(/[?#].*$/, '');
      if (!SCRIPT.test(file) || file.startsWith('\0') || file.includes('/node_modules/')) {
        return null;
      }
      const out = await rewriteBarrelImports(code, file, {
        resolve: async (specifier, importer) =>
          (await this.resolve(specifier, importer))?.id ?? null,
      });
      return out === null ? null : { code: out, map: null };
    },
  };
}
