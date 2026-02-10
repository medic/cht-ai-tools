import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Package root is one level up from dist/
const packageRoot = join(__dirname, '..');

export function getAssetPath(relativePath: string): string {
  return join(packageRoot, relativePath);
}
