import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const output = resolve(root, 'dist');
const files = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon.svg'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(resolve(output, 'server'), { recursive: true });

for (const file of files) {
  await cp(resolve(root, file), resolve(output, file));
}

const assetEntries = await Promise.all(files.map(async file => [file, await readFile(resolve(root, file), 'utf8')]));
const workerSource = `
const ASSETS = new Map(${JSON.stringify(assetEntries)});
const TYPES = {
  'index.html': 'text/html; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  'sw.js': 'text/javascript; charset=utf-8',
  'icon.svg': 'image/svg+xml; charset=utf-8'
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let name = url.pathname.replace(/^\\/+/, '');
    if (!name) name = 'index.html';
    if (!ASSETS.has(name) && request.headers.get('accept')?.includes('text/html')) name = 'index.html';
    if (!ASSETS.has(name)) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'content-type': TYPES[name] || 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cache-control': name === 'index.html' || name === 'sw.js' ? 'no-cache' : 'public, max-age=86400'
    });
    if (name === 'sw.js') headers.set('service-worker-allowed', '/');
    return new Response(ASSETS.get(name), { status: 200, headers });
  }
};
`;

await writeFile(resolve(output, 'server', 'index.js'), workerSource, 'utf8');
console.log(`Built ${files.length} static assets and the hosting entrypoint in dist/`);
