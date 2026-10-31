import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    singleQuote: true,
    printWidth: 100,
    ignorePatterns: ['dist/**', 'coverage/**', 'pnpm-lock.yaml'],
  },
  lint: {
    ignorePatterns: ['dist/**', 'coverage/**'],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
