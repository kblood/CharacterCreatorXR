// SPDX-License-Identifier: GPL-3.0-or-later
// Tiny static server for local development (no dependencies). WebXR needs a secure context: http://localhost
// counts as secure, so on a Quest use `adb reverse tcp:8080 tcp:8080` and open http://localhost:8080 in the
// headset browser (README "Headset access"). Serves the project root; never uploads anything anywhere.
//   node tools/serve.mjs [--port 8080] [--root build/site]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

/** Start the server; resolves to { server, port, url, close() }. port 0 = any free port. */
export function startServer({ port = 8080, root = join(HERE, '..'), quiet = false } = {}) {
  root = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(root, p));
      if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, () => {
      const p = server.address().port;
      if (!quiet) console.log(`serving ${root} at http://localhost:${p}/`);
      ok({ server, port: p, url: `http://localhost:${p}/`, close: () => new Promise(r => server.close(r)) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  startServer({ port: +arg('--port', process.env.PORT || 8080), root: arg('--root', join(HERE, '..')) })
    .catch(e => { console.error(e.code === 'EADDRINUSE' ? `port in use: try --port <n>` : e); process.exit(1); });
}
