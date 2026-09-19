/**
 * 局域网静态服务器：把项目的 assets 目录只读托管到 0.0.0.0，供同网段浏览器打开预览页。
 *
 * 只允许 assets 目录内的文件，路径穿越一律 403。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { networkInterfaces } from 'node:os';

/**
 * 列出本机所有非回环 IPv4 地址。
 *
 * @returns {string[]} 形如 ['192.168.1.20']。
 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/**
 * 起一个只读静态服务器，把 <项目根>/assets 挂到局域网。
 *
 * @param {string} projectRoot - 项目根绝对路径（assets 的上一级）。
 * @param {number} port - 监听端口（0 = 由系统分配）。
 * @returns {Promise<{port: number, close: Function}>} 实际端口与关闭函数。
 */
function serve(projectRoot, port) {
  const assetsDir = resolve(projectRoot, 'assets');
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.png': 'image/png',
    '.mjs': 'text/javascript; charset=utf-8',
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = path === '/' ? 'preview.html' : path.replace(/^\/+/, '');
    // 只允许 assets 目录内的文件，挡掉 ../ 穿越
    const target = resolve(assetsDir, rel);
    if (target !== assetsDir && !target.startsWith(assetsDir + '/')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(target)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  });
  return new Promise((ok) => {
    server.listen(port, '0.0.0.0', () => ok({ port: server.address().port, close: () => server.close() }));
  });
}

export { lanAddresses, serve };
