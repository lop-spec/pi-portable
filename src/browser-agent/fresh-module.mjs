import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Node caches native ESM independently of Pi/Jiti's extension cache.
// A content key reloads changed code without creating a new module for unchanged code.
export async function importFreshModule(url) {
  const sourceUrl = new URL(url);
  sourceUrl.search = '';
  const hash = createHash('sha256').update(await readFile(sourceUrl)).digest('hex');
  sourceUrl.searchParams.set('sha256', hash);
  return import(sourceUrl.href);
}
