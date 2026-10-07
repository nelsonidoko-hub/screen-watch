/**
 * ScreenWatch v1 - Viewer Static File Server
 *
 * The viewer is just an HTML/JS page. Opening it directly as a file
 * (file://) only works on the same machine. To load it from a phone
 * or another PC on the same wifi, it needs to be served over HTTP so
 * the other device can fetch it by IP address.
 *
 * This server does nothing clever - it just hands out index.html and
 * viewer.js as plain static files. No frameworks, no dependencies,
 * just Node's built-in http module.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip internal (127.0.0.1) and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

// Only these files are ever served. (The old version joined the request path
// onto this folder without checking, so a URL like /../agent/main.js could
// read files outside it.)
const ALLOWED_FILES = {
  'index.html': 'text/html',
  'join.html': 'text/html',
  'viewer.js': 'text/javascript',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    // Parsing the URL also drops any ?query, so links keep working with one attached.
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const contentType = Object.prototype.hasOwnProperty.call(ALLOWED_FILES, name)
    ? ALLOWED_FILES[name]
    : null;
  if (!contentType) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.readFile(path.join(__dirname, name), (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`Viewer server running.`);
  console.log(`  On this PC:        http://localhost:${PORT}`);
  if (ips.length === 0) {
    console.log('  Could not detect a LAN IP - check ipconfig manually.');
  } else {
    ips.forEach((ip) => {
      console.log(`  From other devices: http://${ip}:${PORT}`);
    });
  }
  console.log('');
  console.log('Make sure the signaling-server (port 8080) is also running,');
  console.log('and that Windows Firewall allows Node.js on your network.');
});
