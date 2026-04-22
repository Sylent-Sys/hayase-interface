import config from 'eslint-config-standard-universal'
import tseslint from 'typescript-eslint'

import svelteConfig from './svelte.config.js'

export default tseslint.config(
  {
    ignores: ['build/', '.svelte-kit/', 'node_modules/', 'backend/']
  },
  ...config(),
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        svelteConfig
      }
    },
    rules: {
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        {
          ignoreConditionalTests: true,
          ignoreMixedLogicalExpressions: false,
          ignorePrimitives: true
        }
      ]
    }
  }
)
