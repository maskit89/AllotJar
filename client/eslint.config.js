import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // The screens load their data in effects and set a loading flag as the request starts;
      // this rule targets the React Compiler, which the app doesn't use.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // A context's provider and its hook live in one file by design.
    files: ['src/**/*Context.tsx', 'src/analytics/AnalyticsProvider.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // shadcn/ui building blocks export their variant helpers (buttonVariants and the like)
    // next to the component, as upstream does.
    files: ['src/components/ui/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
