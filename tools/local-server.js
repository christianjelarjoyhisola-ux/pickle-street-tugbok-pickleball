const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const published = require('./site-files.cjs');
const port = Number(process.env.PORT || process.argv[2] || 8788);
const host = process.env.HOST || '127.0.0.1';

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${host}:${port}`).pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let candidate = path.resolve(root, relative);

  if (!candidate.startsWith(root + path.sep)) return null;
  if (!path.extname(candidate) && fs.existsSync(candidate + '.html')) candidate += '.html';
  if (!published.includes(path.relative(root,candidate).split(path.sep).join('/'))) return null;
  return candidate;
}

const server = http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }

  let filePath;
  try {
    filePath = resolveRequestPath(request.url || '/');
  } catch {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  fs.createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Pickle Street Tugbok: http://${host}:${port}/`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
