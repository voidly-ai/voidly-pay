import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  clean: true,
  minify: true,
  treeshake: true,
  // dts disabled: package ships as an executable (bin: voidly-mcp),
  // consumers don't import from it as a library. Skips a pre-existing
  // type error unrelated to runtime behavior.
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
