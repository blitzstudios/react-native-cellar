#!/usr/bin/env node
// Opens a Cellar database dump in the Cellar panel, without the app: serves the panel and the dump on localhost and
// opens a browser on it.
//
//   cellar-open-dump <dump.db> [--port 8190] [--no-open]
//
// It serves until stopped.

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8190;
const shouldOpen = !args.includes('--no-open');

if (!file) {
  console.error('usage: cellar-open-dump <dump.db> [--port 8190] [--no-open]');
  process.exit(1);
}
const dumpPath = resolve(file);
if (!existsSync(dumpPath) || !statSync(dumpPath).isFile()) {
  console.error(`No such file: ${dumpPath}`);
  process.exit(1);
}

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (path === '/dump.db') {
    response.writeHead(200, { 'Content-Type': 'application/x-sqlite3', 'Content-Length': statSync(dumpPath).size });
    createReadStream(dumpPath).pipe(response);
    return;
  }
  const target = normalize(join(dist, path));
  if (!target.startsWith(dist.endsWith(sep) ? dist : dist + sep) || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream' });
  createReadStream(target).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/devtools/panel.html?dump=/dump.db&name=${encodeURIComponent(basename(dumpPath))}`;
  console.log(`Cellar panel on ${basename(dumpPath)}: ${url}`);
  if (!shouldOpen) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
});
