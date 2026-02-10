import { defineConfig } from 'tsup';
import { cp, mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
const root = process.cwd();

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
    const dist = join(root, 'dist/assets');

    // Copy root plugin assets → dist/assets/ for the CLI installer
    await mkdir(join(dist, 'hooks'), { recursive: true });
    await cp(join(root, 'skills'), join(dist, 'skills'), { recursive: true });
    await cp(join(root, 'commands'), join(dist, 'commands'), { recursive: true });
    await cp(join(root, 'hooks/scripts/validate-cht.sh'), join(dist, 'hooks/validate-cht.sh'));
    await cp(join(root, 'hooks/scripts/format-cht.sh'), join(dist, 'hooks/format-cht.sh'));
    console.log('✓ Plugin assets copied to dist/assets for CLI installer');
  },
});
