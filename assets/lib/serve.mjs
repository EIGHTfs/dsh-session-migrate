/**
 * 局域网静态服务器：把项目的 assets 目录只读托管到 0.0.0.0，供同网段浏览器打开预览页。
 *
 * 只允许 assets 目录内的文件，路径穿越一律 403。
 */
import { stat, readFile } from 'node:fs/promises';
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
  const server = createServer((req, res) => handleRequest(req, res, assetsDir, types));
  return new Promise((ok) => {
    server.listen(port, '0.0.0.0', () => ok({ port: server.address().port, close: () => server.close() }));
  });
}

/**
 * 处理一个静态文件请求：路径穿越 403，文件不存在/非文件 404，其余 200。
 *
 * @param {object} req - HTTP 请求。
 * @param {object} res - HTTP 响应。
 * @param {string} assetsDir - assets 绝对目录。
 * @param {object} types - 扩展名 → Content-Type 映射。
 */
async function handleRequest(req, res, assetsDir, types) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = path === '/' ? 'preview.html' : path.replace(/^\/+/, '');
  // 只允许 assets 目录内的文件，挡掉 ../ 穿越
  const target = resolve(assetsDir, rel);
  if (target !== assetsDir && !target.startsWith(assetsDir + '/')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let isFile = false;
  try {
    isFile = (await stat(target)).isFile();
  } catch { /* 不存在或无权限 */ }
  if (!isFile) {
    res.writeHead(404).end('not found');
    return;
  }
  const body = await readFile(target);
  res.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream' });
  res.end(body);
}

export { lanAddresses, serve };
