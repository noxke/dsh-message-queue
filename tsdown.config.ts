import { defineConfig } from 'tsdown';

/**
 * Bundles the browser half into the single CJS file that `scripts/build-client.mjs`
 * wraps for the module loader. React stays external: the web client already serves it
 * from its module table.
 */
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  // The host half is emitted into the same directory by tsc just before this runs.
  clean: false,
});
