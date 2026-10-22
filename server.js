const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8086);
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.gz': 'application/gzip'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const relPath = urlPath === '/' ? '/index.html' : (urlPath === '/download' ? '/download.html' : urlPath);
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': mime,
      'Cache-Control': 'no-cache, no-transform',
      'Content-Length': stat.size,
      'Accept-Ranges': 'none'
    };
    if (ext === '.zip' || ext === '.gz') {
      headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
      headers['Content-Transfer-Encoding'] = 'binary';
      headers['Connection'] = 'close';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MoiréTwist 3D server listening on http://0.0.0.0:${PORT}`);
});
