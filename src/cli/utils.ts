import { mkdir } from 'node:fs/promises';

/**
 * Ensure a directory exists, creating it recursively if needed
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
