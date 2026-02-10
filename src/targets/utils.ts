/**
 * Shared utilities for target implementations.
 */

import * as fs from 'node:fs/promises';

/**
 * Read and parse a JSON config file safely.
 * Returns the default value if the file doesn't exist.
 * Throws if the file exists but contains invalid JSON.
 */
export async function readJsonConfig<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
      return defaultValue;
    }
    throw error;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Check if a path exists on the filesystem.
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
