import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Ground rule 1 in CONTRIBUTING.md is that nothing leaves the browser. That is
 * too important to leave to review attention, so every way a page can start a
 * request is a lint error. The network guard, which must name these APIs in
 * order to wrap them, is exempted by path.
 */
const NO_NETWORK =
  'Toolshed makes no network requests at runtime — see ground rule 1 in CONTRIBUTING.md. ' +
  'If you genuinely need this, it belongs in src/lib/netguard.ts and needs a discussion first.';

export default tseslint.config(
  {
    // .claude holds agent worktrees, which are whole copies of this repo.
    ignores: [
      'dist',
      'dist-codec-probe',
      'dev-dist',
      'coverage',
      'playwright-report',
      'test-results',
      '.claude',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: NO_NETWORK },
        { name: 'XMLHttpRequest', message: NO_NETWORK },
        { name: 'WebSocket', message: NO_NETWORK },
        { name: 'EventSource', message: NO_NETWORK },
        { name: 'RTCPeerConnection', message: NO_NETWORK },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'fetch', message: NO_NETWORK },
        { object: 'self', property: 'fetch', message: NO_NETWORK },
        { object: 'globalThis', property: 'fetch', message: NO_NETWORK },
        { object: 'window', property: 'XMLHttpRequest', message: NO_NETWORK },
        { object: 'navigator', property: 'sendBeacon', message: NO_NETWORK },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression > Literal[value=/^(https?:)?\\/\\//]',
          message: NO_NETWORK,
        },
        {
          selector: 'ImportExpression > TemplateLiteral[quasis.0.value.raw=/^(https?:)?\\/\\//]',
          message: NO_NETWORK,
        },
      ],
    },
  },
  {
    // The network guard has to name these APIs in order to wrap them. It is
    // the only file allowed to, and the rule messages point here.
    files: ['src/lib/netguard.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    // Build scripts, config and unit tests run in Node, not the browser.
    files: [
      'scripts/**/*.{js,mjs}',
      '*.config.{ts,js}',
      'src/**/*.test.ts',
      'test/**/*.ts',
      'e2e/**/*.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
