import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Assets are in dist/assets after build
export function getAssetPath(relativePath: string): string {
  return join(__dirname, 'assets', relativePath);
}
