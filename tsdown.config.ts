import { defineConfig } from 'tsdown';

export default defineConfig({
  // Two entry points: the core, and the Express adapter under a subpath so
  // the core never carries framework-shaped types.
  entry: {
    index: 'src/index.ts',
    adapters: 'src/adapters/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
});
