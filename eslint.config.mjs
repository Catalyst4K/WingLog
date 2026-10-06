import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'
import jsdoc from 'eslint-plugin-jsdoc'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments'
import fileHeader from './eslint-rules/file-header.mjs'

// The coding standards' rules (flightdeck-backend docs/coding-standards.md), as warnings while
// the audit works through the code area by area (robustness/code-standards-audit.md, phase 1).
// They become errors in phase 4. App code only: tests, the vendored shadcn components and the
// scripts are out of scope for now. `npm run lint:report` counts them per rule and area.
const APP_CODE = ['src/**/*.{ts,tsx}']
const NOT_APP_CODE = ['src/**/*.test.{ts,tsx}', 'src/renderer/src/components/ui/**', 'src/**/*.d.ts']

// Host side (sim, tracking, add-ons) never reaches into app-side modules (coding-standards.md §9).
const HOST_SIDE = ['src/main/sim/**', 'src/main/tracking/**', 'src/main/beyondatc/**', 'src/main/gsx/**', 'src/main/gsx-remote/**']
const APP_SIDE_IMPORTS = ['**/simbrief/**', '**/navdata/**', '**/sync/**', '**/backend/**', '**/db/**']

export default tseslint.config(
  { ignores: ['dist', 'out', 'out-manual', 'release', 'node_modules', 'drizzle'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.ts', '*.config.ts'],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    files: APP_CODE,
    ignores: NOT_APP_CODE,
    languageOptions: {
      parserOptions: { project: ['./tsconfig.node.json', './tsconfig.web.json'], tsconfigRootDir: import.meta.dirname }
    },
    plugins: { jsdoc, 'eslint-comments': eslintComments, winglog: { rules: { 'file-header': fileHeader } } },
    rules: {
      // §2 headers
      'winglog/file-header': 'warn',
      'jsdoc/require-jsdoc': [
        'warn',
        {
          publicOnly: true,
          require: { FunctionDeclaration: true, ClassDeclaration: true, ArrowFunctionExpression: true, FunctionExpression: true }
        }
      ],
      'jsdoc/require-param': ['warn', { checkDestructured: false }],
      'jsdoc/require-returns': ['warn', { checkGetters: false }],
      // §4 no mutable module-level state (src/shared/lazy.ts and the renderer store are exempt below)
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'Program > VariableDeclaration[kind=/^(let|var)$/], Program > ExportNamedDeclaration > VariableDeclaration[kind=/^(let|var)$/]',
          message: 'No mutable module-level state: use lazy() or the renderer store (coding-standards.md §4).'
        }
      ],
      // §5 size and shape
      'max-lines-per-function': ['warn', { max: 100, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      // §6 error handling
      'no-empty': 'warn',
      'no-console': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      // §7 types
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'eslint-comments/require-description': 'warn'
    }
  },
  {
    // Components are split above ~300 lines (coding-standards.md §5), not 100.
    files: ['src/renderer/**/*.tsx'],
    ignores: NOT_APP_CODE,
    rules: { 'max-lines-per-function': ['warn', { max: 300, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/shared/lazy.ts'],
    rules: { 'no-restricted-syntax': 'off' }
  },
  {
    files: HOST_SIDE,
    ignores: NOT_APP_CODE,
    rules: {
      'no-restricted-imports': [
        'warn',
        { patterns: [{ group: APP_SIDE_IMPORTS, message: 'Host-side code never imports app-side modules (coding-standards.md §9).' }] }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: NOT_APP_CODE,
    rules: {
      'no-restricted-imports': ['warn', { patterns: [{ group: ['**/main/**'], message: 'The renderer never imports src/main (CLAUDE.md, Rules).' }] }]
    }
  },
  eslintConfigPrettier
)
