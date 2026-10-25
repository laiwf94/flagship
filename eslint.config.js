import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Handlers and hooks are async by contract even when a branch doesn't await.
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['apps/admin/**/*.tsx', 'apps/admin/**/*.ts'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    // Tests read untyped JSON responses; asserting on them is the point.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Benchmark scripts are plain Node programs that print their results.
    files: ['bench/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        ['process', 'console', 'performance', 'setTimeout', 'fetch', 'URL'].map((g) => [
          g,
          'readonly',
        ]),
      ),
    },
    rules: { 'no-console': 'off', 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
);
