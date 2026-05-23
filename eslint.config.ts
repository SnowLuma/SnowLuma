import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

const tsconfigRootDir = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/(.:\/)/, '$1');

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/.vite/**',
    '**/*.tsbuildinfo',
    '**/test/fixtures/**',
    'packages/runtime/native/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.es2023,
        ...globals.node,
      },
    },
    rules: {
      'indent': ['error', 2, { SwitchCase: 1 }],
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
      'prefer-const': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir,
      },
    },
    rules: {
      'indent': ['error', 2, { SwitchCase: 1 }],
      'prefer-const': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // OIDB service layer is namespace-per-cmd by design — the
    // structural-typing contract (namespace IS the OidbCallSpec) and
    // the file:cmd 1:1 mapping are the whole point. Disable the
    // module-syntax preference here only.
    files: [
      'packages/protocol/src/oidb-services/**/*.ts',
      'packages/protocol/tests/oidb-services/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  {
    files: ['packages/webui/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        tsconfigRootDir,
      },
    },
    rules: {
      'indent': ['error', 2, { SwitchCase: 1 }],
      'prefer-const': 'off',
      'react-refresh/only-export-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);