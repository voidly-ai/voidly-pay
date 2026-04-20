import { defineConfig } from 'tsup';

export default defineConfig([
  // CJS output — require() is natively available, no banner needed
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    noExternal: ['tweetnacl', 'tweetnacl-util', 'mlkem'],
    platform: 'node',
    target: 'es2020',
    clean: true,
    minify: true,
    treeshake: true,
  },
  // ESM output — inject createRequire so bundled CJS deps can use require('crypto')
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    noExternal: ['tweetnacl', 'tweetnacl-util', 'mlkem'],
    platform: 'node',
    target: 'es2020',
    minify: true,
    treeshake: true,
    banner: {
      js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
    },
  },
]);
