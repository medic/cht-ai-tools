import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Package root is one level up from dist/.
// This assumes the compiled output lives in dist/ (flat), so going up one
// level reaches the package root where assets (skills/, commands/, hooks/,
// .mcp.json) are located. This will NOT resolve correctly if run directly
// from source (src/installers/), but the CLI is always run from dist/.
const packageRoot = join(__dirname, '..');

export function getAssetPath(relativePath: string): string {
  return join(packageRoot, relativePath);
}
