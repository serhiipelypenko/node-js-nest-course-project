// hw-32, сходинка 1 «Типи й стиль»: tsc --noEmit + eslint. Лінтимо те, що нове/ключове для конвеєра
// (service/, src/mapping.ts, src/gate-cost.ts, scripts/, demo/, oidc/) — не весь Nest-моноліт: для нього
// тип-перевірку дає tsc, а масове переписування старого коду не є метою ДЗ.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '**/node_modules/**', 'infra/**', 'secrets/**', 'spec.json', 'pacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', require: 'readonly', module: 'readonly', __dirname: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
);
