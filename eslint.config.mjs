import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The mechanical half of backend-nestjs §12 and coding-standards-nestjs §10.
 *
 * Boundary enforcement (facade-only imports, layer direction, no cycles) is
 * dependency-cruiser's job and arrives with the second module — a boundary
 * graph over two platform modules would pass by having nothing to cross.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/database/migrations/**', 'docs/handbook/**', '**/*.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // ADR-0006 / coding-standards §4: fire-and-forget does not exist in a
      // request path — background work goes through BullMQ, not a dangling promise.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // coding-standards §1: no TS enum. String literal unions and pgEnum.
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'coding-standards-nestjs §1: no TS enum — use a string literal union or pgEnum.' },
      ],
      // §8: the injected pino logger only.
      'no-console': 'error',
    },
  },
  {
    // §6: `new Date()` in domain or application code hides a dependency on now.
    // Infrastructure may use it for timestamps that never feed a business rule.
    files: ['src/modules/*/domain/**/*.ts', 'src/modules/*/application/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'NewExpression[callee.name="Date"]', message: 'coding-standards-nestjs §6: inject the Clock port instead of `new Date()`.' },
      ],
    },
  },
  {
    // §3 / backend-nestjs §7.3: catalog codes are spelled in error factories and
    // nowhere else, which is what keeps the code and the catalog greppable.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.errors.ts', 'src/shared/error-status.registry.ts', 'src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // `:not(CallExpression[callee.name="Symbol"] > Literal)` spares DI
          // tokens, which share the prefix vocabulary by design —
          // `Symbol('AUTH_LOOKUP_REPOSITORY')` is a port name, not a wire code.
          selector:
            'Literal[value=/^(AUTH|AUTHZ|VAL|SYS|TEN|LVE|PAY|ATT)_[A-Z0-9_]+$/]:not(CallExpression[callee.name="Symbol"] > Literal)',
          message: 'Error codes are spelled in *.errors.ts only (coding-standards-nestjs §3).',
        },
      ],
    },
  },
  { files: ['**/*.spec.ts', 'scripts/**/*.ts'], rules: { '@typescript-eslint/no-non-null-assertion': 'off' } },
);
