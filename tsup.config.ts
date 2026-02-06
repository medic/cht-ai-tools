import { defineConfig } from 'tsup';
import { cp } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  splitting: false,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  async onSuccess() {
    await cp(
      join(process.cwd(), 'src/assets'),
      join(process.cwd(), 'dist/assets'),
      { recursive: true }
    );
    console.log('✓ Assets copied to dist/assets');
  },
});
