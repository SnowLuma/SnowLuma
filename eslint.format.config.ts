import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { sourceIgnores } from './eslint.config.ts';

// Local formatting only; CI continues to use eslint.config.ts for code quality.
export default defineConfig([
    sourceIgnores,
    {
        // Preserve quality-rule suppressions when running only formatting rules.
        linterOptions: { reportUnusedDisableDirectives: 'off' },
    },
    {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: {
            parser: tseslint.parser,
        },
        plugins: {
            '@stylistic': stylistic,
            '@typescript-eslint': tseslint.plugin,
            'react-hooks': reactHooks,
        },
        rules: {
            curly: ['error', 'all'],
            '@stylistic/padding-line-between-statements': [
                'error',
                { blankLine: 'always', prev: '*', next: 'block-like' },
                { blankLine: 'always', prev: 'block-like', next: '*' },
                // Stacked case labels share a branch and must stay adjacent.
                {
                    blankLine: 'never',
                    prev: { selector: 'SwitchCase[consequent.length=0]' },
                    next: ['case', 'default'],
                },
            ],
        },
    },
]);
