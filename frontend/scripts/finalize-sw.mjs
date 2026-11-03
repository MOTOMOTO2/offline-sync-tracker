/**
 * Post-build step: stamp the service worker with a precache manifest and a
 * version derived from the built output.
 *
 * Vite copies `public/sw.js` into `dist/` untouched, which is what we want -
 * the worker must not be bundled or hashed. But it cannot know the hashed
 * asset filenames on its own, so we fill them in here. The version is a hash
 * of the files themselves, so rebuilding identical output does not needlessly
 * invalidate every installed client's cache.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A build made elsewhere (the browser check's) passes its folder.
const dist = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist');
const swPath = join(dist, 'sw.js');

const SKIP_EXTENSIONS = ['.map'];
const SKIP_FILES = ['sw.js'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(dist)
  .map((file) => relative(dist, file).split('\\').join('/'))
  .filter((file) => !SKIP_EXTENSIONS.some((ext) => file.endsWith(ext)))
  .filter((file) => !SKIP_FILES.includes(file))
  .sort();

if (!files.includes('index.html')) {
  throw new Error('dist/index.html is missing - did vite build run?');
}

const precache = files.map((file) => `/${file}`);

const hash = createHash('sha256');
for (const file of files) {
  hash.update(file);
  hash.update(readFileSync(join(dist, file)));
}
const version = hash.digest('hex').slice(0, 12);

let source = readFileSync(swPath, 'utf8');
if (!source.includes('__SW_VERSION__') || !source.includes('__PRECACHE_MANIFEST__')) {
  throw new Error('sw.js placeholders are missing - was it already finalized?');
}

source = source
  .replace('__SW_VERSION__', version)
  .replace('__PRECACHE_MANIFEST__', JSON.stringify(precache, null, 2));

writeFileSync(swPath, source);

console.log(`sw.js finalized: version ${version}, ${precache.length} precached files`);
for (const url of precache) console.log(`  ${url}`);
