import globals from 'globals'
import pluginJs from '@eslint/js'

export default [
    pluginJs.configs.recommended,
    {
        files: ['src/main.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            globals: {
              ...globals.node,
            }
        },
        rules: {
            'semi': ['error', 'never'],
            'indent': ['error', 4],
            'no-unused-vars': 'warn',
            'eqeqeq': 'error'
        }
    },
    {
        files: ['src/s3s-crawl-assistant.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            globals: {
              ...globals.browser,
            }
        },
        rules: {
            'semi': ['error', 'never'],
            'indent': ['error', 4],
            'no-unused-vars': 'warn',
            'eqeqeq': 'error'
        }
    },
]
