import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['src/mcp/**', 'src/copilot/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'],
        patterns: ['**/evals/**']
      }]
    }
  },
  {
    files: ['src/copilot/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'pg'],
        patterns: ['**/evals/**']
      }]
    }
  },
  {
    files: ['src/**', 'scripts/**'],
    ignores: ['src/mcp/**', 'src/copilot/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/evals/**']
      }]
    }
  }
);
