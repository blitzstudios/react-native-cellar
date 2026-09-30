import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests run the plugin against Cellar's own source, one directory up, so they exercise the inspector this checkout holds
// rather than whichever release is installed.
const cellar = path.resolve(__dirname, '../src');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@sleeperhq/react-native-cellar/inspector', replacement: `${cellar}/inspector/index.ts` },
      { find: '@sleeperhq/react-native-cellar/sqljs', replacement: `${cellar}/sqljs/index.ts` },
      { find: /^@sleeperhq\/react-native-cellar$/, replacement: `${cellar}/index.ts` },
    ],
  },
  define: {
    __DEV__: 'true',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
