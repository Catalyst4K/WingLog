import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'
import jsdoc from 'eslint-plugin-jsdoc'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments'
import fileHeader from './eslint-rules/file-header.mjs'

// The coding standards' rules (winglog-backend docs/coding-standards.md). Errors since the audit
// cleared every area (robustness/code-standards-audit.md, phase 4), so none can come back.
// App code only: tests, the vendored shadcn components and the scripts are out of scope.
// `npm run lint:report` counts them per rule and area.
const APP_CODE = ['src/**/*.{ts,tsx}']
const NOT_APP_CODE = ['src/**/*.test.{ts,tsx}', 'src/renderer/src/components/ui/**', 'src/**/*.d.ts']

// Host side (sim, tracking, add-ons) never reaches into app-side modules (coding-standards.md §9).
const HOST_SIDE = [
  'src/main/sim/**',
  'src/main/tracking/**',
  'src/main/beyondatc/**',
  'src/main/gsx/**',
  'src/main/gsx-remote/**'
]
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
    // Vendored shadcn/ui, kept as generated: it exports its variant helpers beside the components.
    files: ['src/renderer/src/components/ui/**'],
    rules: { 'react-refresh/only-export-components': 'off' }
  },
  {
    files: APP_CODE,
    ignores: NOT_APP_CODE,
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: { jsdoc, 'eslint-comments': eslintComments, winglog: { rules: { 'file-header': fileHeader } } },
    rules: {
      // §2 headers
      'winglog/file-header': 'error',
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true
          }
        }
      ],
      'jsdoc/require-param': ['error', { checkDestructured: false }],
      'jsdoc/require-returns': ['error', { checkGetters: false }],
      // §4 no mutable module-level state (src/shared/lazy.ts and the renderer store are exempt below)
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Program > VariableDeclaration[kind=/^(let|var)$/], Program > ExportNamedDeclaration > VariableDeclaration[kind=/^(let|var)$/]',
          message: 'No mutable module-level state: use lazy() or the renderer store (coding-standards.md §4).'
        },
        {
          selector:
            'Program > VariableDeclaration > VariableDeclarator > NewExpression[callee.name=/^(Map|Set|WeakMap|WeakSet)$/][arguments.length=0]',
          message:
            'No mutable module-level collections: use lazy() or the renderer store (coding-standards.md §4).'
        },
        {
          selector: "TSAsExpression > TSAsExpression.expression[typeAnnotation.type='TSUnknownKeyword']",
          message: 'No `as unknown as` outside tests: narrow with a type guard (coding-standards.md §7).'
        }
      ],
      // §5 size and shape
      'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      // §6 error handling
      'no-empty': 'error',
      'no-console': 'error',
      // `void promise` is not a way out: handle the rejection (coding-standards.md §6).
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      // §7 types
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'eslint-comments/require-description': 'error'
    }
  },
  {
    // The renderer reaches the main process through winglogApi() and LiveClient only (coding-standards.md §9).
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    ignores: [
      ...NOT_APP_CODE,
      'src/renderer/src/data/**',
      'src/renderer/src/live/**',
      'src/renderer/src/report-error.ts'
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'winglog',
          message:
            'Use winglogApi() (data/winglog-api.ts), or LiveClient for live state (coding-standards.md §9).'
        }
      ]
    }
  },
  {
    // Components are split above ~300 lines (coding-standards.md §5), not 100.
    files: ['src/renderer/**/*.tsx'],
    ignores: NOT_APP_CODE,
    rules: { 'max-lines-per-function': ['error', { max: 300, skipBlankLines: true, skipComments: true }] }
  },
  {
    files: ['src/shared/lazy.ts', 'src/renderer/src/ui-memory.ts'],
    rules: { 'no-restricted-syntax': 'off' }
  },
  {
    files: HOST_SIDE,
    ignores: NOT_APP_CODE,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: APP_SIDE_IMPORTS,
              message: 'Host-side code never imports app-side modules (coding-standards.md §9).'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: NOT_APP_CODE,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/main/**'], message: 'The renderer never imports src/main (CLAUDE.md, Rules).' }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
