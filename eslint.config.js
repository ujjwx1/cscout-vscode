const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
    {
        files: ['src/**/*.ts'],
        extends: [...tseslint.configs.recommended],
        rules: {
            // Loosened on purpose for the first rollout: this codebase
            // uses `any` a lot already. Tighten later once the backlog
            // of existing findings is dealt with, not on day one.
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'warn',
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
    {
        ignores: ['out/**', 'node_modules/**'],
    }
);
