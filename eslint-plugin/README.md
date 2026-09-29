# @sleeperhq/eslint-plugin-cellar

ESLint rules for an app built on [`@sleeperhq/react-native-cellar`](../README.md):

| Rule | What it enforces |
| --- | --- |
| `cellar_store_boundary` | App code reaches a store through its service, never by importing the store (type imports are fine). |
| `facade_call_shape` | Every service read takes one argument, `{ params, options? }`. |
| `no_read_arg_sentinel` | A read's params pass absence through (`playerId`), rather than spelling it `playerId ?? ''`. |
| `no_read_result_rq_field` | A read's result is a `DataResult`, so a React Query field like `isInitialLoading` is always `undefined` on it. |

## Install

```json
"@sleeperhq/eslint-plugin-cellar": "blitzstudios/react-native-cellar.git#eslint-plugin-cellar-v1.0.0-gitpkg"
```

## Configure

The rules find your stores and services from `settings.cellar`, relative to the directory that holds `storesDir`:

```js
module.exports = {
  plugins: ['@sleeperhq/cellar'],
  settings: {
    cellar: {
      storesDir: 'app-shared/src/stores',
      servicesDir: 'app-shared/src/services',
      // Files that bind stores to a database, which may import them directly.
      wiringDir: /\/src\/stores\/cellar\//,
      wiringHint: 'Wiring up a backend belongs in `src/stores/cellar/`.',
      // Services held to `facade_call_shape` that import no store.
      extraCallShapeFacades: [],
    },
  },
  rules: {
    '@sleeperhq/cellar/cellar_store_boundary': 'error',
    '@sleeperhq/cellar/facade_call_shape': 'error',
    '@sleeperhq/cellar/no_read_arg_sentinel': 'error',
    '@sleeperhq/cellar/no_read_result_rq_field': 'error',
  },
};
```

## Release

The plugin ships from its own tag, whose commit holds only this directory: commit here, then tag a commit of
`git subtree split --prefix eslint-plugin` as `eslint-plugin-cellar-v<version>-gitpkg`.
