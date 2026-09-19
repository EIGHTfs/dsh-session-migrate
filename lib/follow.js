/**
 * dsh-session-migrate — 触发迁移（投放的第 4 步，也是真正生效的一步）
 *
 * ## 为什么必须有这一步
 *
 * 实测结论（DSH 持久化层行为）：
 *
 * | 动作                        | 是否触发 v0→v3 迁移 |
 * |-----------------------------|---------------------|
 * | `session/list`（HTTP）      | ✗                   |
 * | `session/page`（HTTP 冷读） | ✗ 能读出内容但不迁移 |
 * | `session/follow`（WebSocket）| ✓ lock 与 vN 立刻落盘 |
 *
 * 所以「把文件投放到位」只是准备工作；**必须让 DSH 打开跟随该会话**，
 * 迁移才真正发生、vN 文件才会产出。
 *
 * ## 协议
 *
 * · follow 是流式方法，**必须走 WebSocket**：`ws://127.0.0.1:<port>/api/remote.mux`
 *   HTTP 直接调会报 `stream Remote methods must be opened through the stream carrier`。
 * · 帧格式：
 *   `{"type":"open","streamId":<id>,"endpoint":"session/follow",
 *     "payload":{"args":{"request":{"address":{"kind":"session","sessionId":"..."},"maxMessages":1}}}}`
 *   收到 `{"type":"item",...}` 即视为成功（snapshot 到手）。
 * · 认证：先用 token 换 cookie，再把 cookie 带进 WebSocket 握手。
 *   token 写在实例根的 `*.log`（`dsh web: http://127.0.0.1:<port>/?token=XXX`），
 *   每次 DSH 重启都会变，所以**运行时现读**，不缓存。
 *
 * 本模块用 Node 内置能力实现（http 换 cookie + 手写 WebSocket 帧），
 * 不引入任何第三方依赖——群晖上没有 node_modules/ws。
 *
 * @module follow
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';

/** WebSocket 握手用的固定 GUID（RFC 6455）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 从实例根目录的日志里找 web token。
 *
 * 日志行形如 `dsh web: http://127.0.0.1:30801/?token=XXXX`；
 * 主日志优先于 proxy 日志，且取**最后一个**（重启后新 token 在后面）。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {{token: string|null, file: string, port: number|null}}
 */
export function findToken(dshHome) {
  const root = dirname(dshHome);
  const cands = collectLogCandidates(root);

  let fallback = { token: null, file: '', port: null };
  for (const p of cands) {
    const found = parseTokenFromLog(p);
    if (!found) continue;
    if (!p.includes('proxy')) return found;
    if (!fallback.token) fallback = found;
  }
  return fallback;
}

/**
 * 收集实例根目录下可用的日志文件路径（*.log + dsh-proxy.log）。
 * 一次性把根目录条目收进内存集合，避免逐个 existsSync。
 *
 * @param {string} root - DSH 主目录的上一级。
 * @returns {string[]} 候选日志路径（主日志在前，proxy 兜底在后）。
 */
function collectLogCandidates(root) {
  const entries = new Set();
  try {
    if (existsSync(root)) {
      for (const f of readdirSync(root)) entries.add(f);
    }
  } catch { /* 根目录不可读 */ }
  const cands = [];
  for (const f of entries) {
    if (f.endsWith('.log')) cands.push(join(root, f));
  }
  // proxy 日志兜底候选（缺失时 parseTokenFromLog 读到空自然返回 null）
  if (!cands.some((p) => p.endsWith('dsh-proxy.log'))) cands.push(join(root, 'dsh-proxy.log'));
  return cands;
}

/**
 * 从一条日志文件里取最后的 token 与端口。
 *
 * 日志行形如 `dsh web: http://127.0.0.1:30801/?token=XXXX`；
 * 主日志优先于 proxy 日志，且取**最后一个**（重启后新 token 在后面）。
 *
 * @param {string} logPath - 日志文件路径。
 * @returns {{token: string|null, file: string, port: number|null}|null} 无 token 返回 null。
 */
function parseTokenFromLog(logPath) {
  let text;
  try { text = readFileSync(logPath, 'utf8'); } catch { return null; }
  const matches = [...text.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  if (!matches.length) return null;
  const token = matches[matches.length - 1][1];
  const ports = [...text.matchAll(/127\.0\.0\.1:(\d{2,5})\/\?token=/g)];
  const port = ports.length ? Number(ports[ports.length - 1][1]) : null;
  return { token, file: logPath, port };
}

/**
 * 发起 HTTP 请求并取回完整响应（含头）。
 *
 * @param {object} opts - { port, path, method, headers, timeoutMs, host }。
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
function httpCall(opts) {
  const { port, path: reqPath, method = 'GET', headers = {}, timeoutMs = 8000, host = '127.0.0.1' } = opts;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 用 token 换认证 cookie。
 *
 * @param {number} port - web 端口。
 * @param {string} token - web token。
 * @returns {Promise<string|null>} `name=value` 形式的 cookie，失败 null。
 */
export async function exchangeCookie(port, token) {
  try {
    const response = await httpCall({ port, path: `/?token=${encodeURIComponent(token)}` });
    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const cookie of list) {
      const kv = String(cookie).split(';')[0].trim();
      if (kv) return kv;
    }
  } catch { /* 换 cookie 失败由调用方处理 */ }
  return null;
}

/**
 * 解析 WebSocket 地址里的 host/port。
 *
 * @param {string} url - ws:// 开头的地址。
 * @returns {{host: string, port: number, path: string}}
 */
function parseWsUrl(url) {
  const matched = /^ws:\/\/([^/:]+):(\d+)(\/.*)?$/.exec(url);
  if (!matched) throw new Error(`无法解析 WebSocket 地址: ${url}`);
  return { host: matched[1], port: Number(matched[2]), path: matched[3] || '/' };
}

/** 操作码：延续帧。 */
const OP_CONT = 0x0;
/** 操作码：文本帧。 */
const OP_TEXT = 0x1;
/** 操作码：二进制帧。 */
const OP_BINARY = 0x2;
/** 操作码：关闭帧。 */
const OP_CLOSE = 0x8;
/** 操作码：ping 帧。 */
const OP_PING = 0x9;
/** 操作码：pong 帧。 */
const OP_PONG = 0x0a;
/** FIN 标志位（首字节最高位）。 */
const FLAG_FIN = 0x80;
/** 掩码标志位（次字节最高位）。 */
const FLAG_MASK = 0x80;
/** 低 7 位掩码（取长度）。 */
const LEN_MASK = 0x7f;
/** 低 4 位掩码（取操作码）。 */
const OPCODE_MASK = 0x0f;
/** 长度字段为 126 时表示随后 2 字节才是真实长度。 */
const LEN_16BIT = 126;
/** 长度字段为 127 时表示随后 8 字节才是真实长度。 */
const LEN_64BIT = 127;
/** 2 字节长度字段能表达的最大值（超过则用 8 字节）。 */
const LEN_16BIT_MAX = 65535;
/** DSH web 端口兜底（探测不到时用；探测结果优先）。 */
const DEFAULT_WEB_PORT = 30801;

/**
 * 帧解析状态（跨 data 事件累积，因为 TCP 分片不保证帧边界）。
 *
 * @typedef {object} FrameState
 * @property {Buffer} buffer - 未消费的字节。
 * @property {number} fragOpcode - 分片起始帧的操作码。
 * @property {Buffer[]} fragParts - 已收到的分片载荷。
 */

/**
 * 尝试从缓冲里读出一个完整的帧头。
 *
 * TCP 分片不保证帧边界，缓冲不足时返回 null（等下一次 data）。
 *
 * @param {FrameState} st - 解析状态。
 * @returns {{fin: boolean, opcode: number, masked: boolean, len: number, offset: number}|null}
 */
function readFrameHeader(st) {
  if (st.buffer.length < 2) return null;
  const first = st.buffer[0];
  const second = st.buffer[1];
  const fin = (first & FLAG_FIN) !== 0;
  const opcode = first & OPCODE_MASK;
  const masked = (second & FLAG_MASK) !== 0;
  let len = second & LEN_MASK;
  let offset = 2;

  if (len === LEN_16BIT) {
    if (st.buffer.length < 4) return null;
    len = st.buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === LEN_64BIT) {
    if (st.buffer.length < 10) return null;
    len = Number(st.buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) offset += 4;
  if (st.buffer.length < offset + len) return null;
  return { fin, opcode, masked, len, offset };
}

/**
 * 分发一个完整帧（帧头已解析、载荷已切出）。
 *
 * @param {FrameState} st - 解析状态（分片累加时被修改）。
 * @param {object} io - { socket, onText, onClose }。
 * @param {{fin: boolean, opcode: number}} header - 帧头。
 * @param {Buffer} payload - 载荷。
 * @returns {boolean} false = 收到 close，应停止收帧。
 */
function handleFrame(st, io, header, payload) {
  const { fin, opcode } = header;
  if (opcode === OP_CLOSE) {
    io.onClose();
    return false;
  }
  if (opcode === OP_PING) {
    try { io.socket.write(encodeFrame(OP_PONG, payload)); } catch { /* 对端可能已断开 */ }
    return true;
  }
  if (opcode === OP_CONT) {
    finishFragment(st, io, payload, fin);
    return true;
  }
  if (opcode === OP_TEXT || opcode === OP_BINARY) {
    if (fin) {
      if (opcode === OP_TEXT) deliverText(io, payload);
    } else {
      st.fragOpcode = opcode;
      st.fragParts = [payload];
    }
  }
  // pong 等其他帧无需处理
  return true;
}

/**
 * 处理 CONTINUATION 分片：非末片直接累加，末片按起始操作码合并交付。
 *
 * @param {FrameState} st - 解析状态（分片累加时被修改）。
 * @param {object} io - { socket, onText, onClose }。
 * @param {Buffer} payload - 本片载荷。
 * @param {boolean} fin - 是否末片。
 */
function finishFragment(st, io, payload, fin) {
  st.fragParts.push(payload);
  if (fin && st.fragOpcode === OP_TEXT) {
    const text = Buffer.concat(st.fragParts).toString('utf8');
    st.fragParts = [];
    try { io.onText?.(text); } catch { /* 回调异常不应中断收帧 */ }
  }
}

/**
 * 交付单个完整文本帧。
 *
 * @param {object} io - { socket, onText, onClose }。
 * @param {Buffer} payload - 文本帧载荷。
 */
function deliverText(io, payload) {
  try { io.onText?.(payload.toString('utf8')); } catch { /* 回调异常不应中断收帧（与上面一致） */ }
}

/**
 * 从累积缓冲里尽可能多地取出完整帧并分发。
 *
 * 抽成独立函数（而非塞在 socket.on('data') 里）的原因：
 * 帧解析逻辑自成一体，独立后既便于单测，也让连接管理保持简短。
 *
 * @param {FrameState} st - 解析状态（会被就地修改）。
 * @param {object} io - { socket, onText, onClose }。
 */
function drainFrames(st, io) {
  for (;;) {
    const header = readFrameHeader(st);
    if (!header) return;
    const payload = st.buffer.subarray(header.offset, header.offset + header.len);
    st.buffer = st.buffer.subarray(header.offset + header.len);
    if (!handleFrame(st, io, header, payload)) return;
  }
}

/**
 * 构造 WebSocket 握手请求报文。
 *
 * @param {object} o - { host, port, path, key, cookie }。
 * @returns {string} 可直接写入 socket 的 HTTP 升级请求。
 */
function buildHandshake(o) {
  const lines = [
    `GET ${o.path} HTTP/1.1`,
    `Host: ${o.host}:${o.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${o.key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (o.cookie) lines.push(`Cookie: ${o.cookie}`);
  return lines.join('\r\n') + '\r\n\r\n';
}

/**
 * 校验握手响应。
 *
 * @param {string} head - 响应头部文本（不含正文）。
 * @param {string} expect - 期望的 Sec-WebSocket-Accept 值。
 * @returns {string|null} 通过返回 null，否则返回错误信息。
 */
function verifyHandshake(head, expect) {
  if (!/^HTTP\/1\.1 101/.test(head)) {
    return `WebSocket 握手失败: ${head.split('\r\n')[0]}`;
  }
  if (!head.includes(expect)) {
    return 'WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）';
  }
  return null;
}

/**
 * 极简 WebSocket 客户端：完成握手、发文本帧、收文本帧。
 *
 * 只实现 follow 需要的最小子集（掩码客户端帧 + 分片重组 + ping/pong），
 * 避免引入 ws 依赖。帧解析委托 drainFrames，握手构造/校验委托
 * buildHandshake / verifyHandshake。
 *
 * @param {object} opts - { url, cookie, onText, timeoutMs }。
 * @returns {Promise<{close: Function, socket: object}>}
 */
export function openWebSocket(opts) {
  const { url, cookie, onText, timeoutMs = 30000 } = opts;
  const { host, port, path } = parseWsUrl(url);

  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expect = createHash('sha1').update(key + WS_GUID).digest('base64');
    const socket = netConnect({ host, port });
    const st = { buffer: Buffer.alloc(0), fragOpcode: 0, fragParts: [] };
    bindSocketLifecycle({
      socket, st, expect, host, port, path, key, cookie, onText, timeoutMs, resolve, reject,
    });
  });
}

/**
 * 绑定 WebSocket socket 的全部生命周期事件：超时、握手消费、数据帧、错误/关闭。
 * 在 Promise executor 里调用，职责是驱动 openWebSocket 的 resolve/reject。
 *
 * @param {object} e - { socket, st, expect, host, port, path, key, cookie, onText, timeoutMs, resolve, reject }。
 */
function bindSocketLifecycle(e) {
  const { socket, st, expect, host, port, path, key, cookie, onText, timeoutMs, resolve, reject } = e;
  const state = { handshakeDone: false, closed: false, timer: null };

  state.timer = setTimeout(() => {
    if (!state.closed) { state.closed = true; destroyQuietly(socket); }
    reject(new Error('WebSocket 超时'));
  }, timeoutMs);

  /** 关闭连接。 */
  const close = () => {
    if (state.closed) return;
    state.closed = true;
    endQuietly(socket);
  };

  /** 断开并拒绝（握手阶段出错时用）。 */
  const fail = (message) => {
    state.closed = true;
    clearTimeout(state.timer);
    destroyQuietly(socket);
    reject(new Error(message));
  };

  attachSocketEvents({
    socket, st, expect, host, port, path, key, cookie, onText,
    state, close, fail,
    markDone: () => { state.handshakeDone = true; clearTimeout(state.timer); resolve({ close, socket }); },
  });
}

/**
 * 绑定 socket 的四个生命周期事件：connect 写握手、data 分发帧、
 * error/close 走统一收尾。
 *
 * @param {object} b - { socket, st, expect, host, port, path, key, cookie, onText, state, close, fail, markDone }。
 */
function attachSocketEvents(b) {
  const { socket, st, expect, host, port, path, key, cookie, onText, state, close, fail, markDone } = b;

  /** 对端关闭时兜底（收到 close 帧或连接断开）。 */
  const peerClosed = () => {
    state.closed = true;
    endQuietly(socket);
  };

  socket.on('connect', () => {
    socket.write(buildHandshake({ host, port, path, key, cookie }));
  });

  socket.on('data', (chunk) => {
    st.buffer = Buffer.concat([st.buffer, chunk]);
    handleSocketData(st, expect, {
      done: state.handshakeDone,
      markDone,
      fail,
      frameIo: { socket, onText, onClose: peerClosed },
    });
  });

  socket.on('error', (err) => {
    if (!state.handshakeDone) { clearTimeout(state.timer); fail(String(err?.message ?? err)); return; }
    state.closed = true;
  });
  socket.on('close', () => {
    state.closed = true;
    clearTimeout(state.timer);
  });
}

/**
 * 静默关闭 WebSocket 句柄（连接已收尾时 close 会抛错，忽略即可）。
 *
 * @param {{close?: Function}|null} ws - openWebSocket 返回的句柄。
 */
function closeQuietly(ws) {
  try { ws?.close?.(); } catch { /* 连接已收尾，close 抛错可忽略 */ }
}

/**
 * 静默结束连接（对端已断开时 end 会抛错，忽略即可）。
 *
 * @param {object} socket - net.Socket。
 */
function endQuietly(socket) {
  try { socket.end(); } catch { /* 对端可能已断开 */ }
}

/**
 * 静默销毁连接（同上，超时/失败路径用）。
 *
 * @param {object} socket - net.Socket。
 */
function destroyQuietly(socket) {
  try { socket.destroy(); } catch { /* 对端可能已断开 */ }
}

/**
 * 分发 socket 的一段数据：尚未完成握手时先消费握手响应，之后解析数据帧。
 *
 * @param {FrameState} st - 解析状态（缓冲会被就地消费）。
 * @param {string} expect - 期望的 Sec-WebSocket-Accept 值。
 * @param {object} h - { done, markDone, fail, frameIo }。
 */
function handleSocketData(st, expect, h) {
  if (!h.done) {
    const outcome = consumeHandshake(st, expect);
    if (outcome === 'wait') return;
    if (outcome === 'bad') { h.fail('WebSocket 握手校验失败'); return; }
    h.markDone();
  }
  drainFrames(st, h.frameIo);
}

/**
 * 消费（且仅消费一次）WebSocket 握手响应：从缓冲里找到头部结束符，
 * 校验 Sec-WebSocket-Accept，消费后把缓冲交给数据帧解析。
 *
 * @param {FrameState} st - 解析状态（被就地修改）。
 * @param {string} expect - 期望的 Sec-WebSocket-Accept 值。
 * @returns {'wait'|'ok'|'bad'} wait=头部未收全、ok=校验通过、bad=校验失败。
 */
function consumeHandshake(st, expect) {
  const idx = st.buffer.indexOf('\r\n\r\n');
  if (idx === -1) return 'wait';
  const head = st.buffer.subarray(0, idx).toString('utf8');
  st.buffer = st.buffer.subarray(idx + 4);
  return verifyHandshake(head, expect) ? 'bad' : 'ok';
}

/**
 * 编码一个客户端 WebSocket 帧（必带掩码）。
 *
 * @param {number} opcode - 操作码（1=文本）。
 * @param {Buffer} payload - 载荷。
 * @returns {Buffer}
 */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = randomBytes(4);
  const len = body.length;
  let header;
  if (len < LEN_16BIT) {
    header = Buffer.alloc(2);
    header[1] = FLAG_MASK | len;
  } else if (len <= LEN_16BIT_MAX) {
    header = Buffer.alloc(4);
    header[1] = FLAG_MASK | LEN_16BIT;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = FLAG_MASK | LEN_64BIT;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = FLAG_FIN | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * 对一个会话发起 session/follow —— 触发 DSH 迁移到当前格式版本。
 *
 * @param {object} opts - 参数。
 * @param {string} opts.dshHome - DSH 主目录。
 * @param {string} opts.sessionId - 会话 id。
 * @param {number} [opts.port] - web 端口（默认从日志探测或 30801）。
 * @param {number} [opts.waitMs] - 等待 snapshot 的毫秒数。
 * @returns {Promise<{ok: boolean, error?: string, port?: number, snapshot?: object}>}
 */
export async function followSession(opts) {
  const { dshHome, sessionId, waitMs = 30000 } = opts;
  const found = findToken(dshHome);
  if (!found.token) {
    return { ok: false, error: '未找到 web token（实例根目录 *.log 里没有 token=…）' };
  }
  const port = opts.port || found.port || DEFAULT_WEB_PORT;
  const cookie = await exchangeCookie(port, found.token);
  if (!cookie) return { ok: false, error: `token 换 cookie 失败（端口 ${port}）`, port };
  return waitForSnapshot({ port, cookie, sessionId, waitMs });
}

/**
 * 建立 WebSocket follow 连接，等待第一条 snapshot 消息（或超时）。
 *
 * @param {object} o - { port, cookie, sessionId, waitMs }。
 * @returns {Promise<{ok: boolean, error?: string, port?: number, snapshot?: object}>}
 */
function waitForSnapshot({ port, cookie, sessionId, waitMs }) {
  return new Promise((resolve) => {
    let settled = false;
    /** 已建立的 WebSocket 连接（onText 里要用来关闭）。 */
    let wsRef = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeQuietly(wsRef);
      resolve({ ...v, port });
    };
    const timer = setTimeout(() => {
      done({ ok: false, error: `等待 snapshot 超时（${waitMs}ms）` });
    }, waitMs);

    openWebSocket({
      url: `ws://127.0.0.1:${port}/api/remote.mux`,
      cookie,
      timeoutMs: waitMs,
      onText: (text) => handleFollowMessage(text, done),
    }).then((ws) => {
      wsRef = ws;
      ws.socket.write(encodeFrame(OP_TEXT, buildOpenFrame(sessionId)));
    }).catch((err) => {
      done({ ok: false, error: String(err?.message ?? err) });
    });
  });
}

/**
 * 处理 follow 流的一条消息（JSON 文本），按类型决定成功/失败/继续等。
 *
 * @param {string} text - 服务端推送的一条 JSON。
 * @param {Function} done - 收尾回调（已保证只触发一次）。
 */
function handleFollowMessage(text, done) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === 'item') {
    handleItemMessage(msg, done);
  } else if (msg.type === 'error') {
    done({ ok: false, error: msg.error?.message ?? JSON.stringify(msg.error ?? msg) });
  } else if (msg.type === 'end') {
    done({ ok: false, error: 'follow 流已结束但未收到 snapshot（会话可能未注册）' });
  }
}

/**
 * 处理一条 item 消息：snapshot 即成功，显式 error 即失败，其余继续等。
 *
 * @param {object} msg - 已解析的 item 消息。
 * @param {Function} done - 收尾回调（已保证只触发一次）。
 */
function handleItemMessage(msg, done) {
  // 成功判据：拿到 value.type === 'snapshot'（follow 是长连接流，
  // 收到 snapshot 即算成功，服务端随后关闭属正常）。
  const itemValue = msg.value;
  if (itemValue && itemValue.type === 'snapshot') {
    done({ ok: true, snapshot: itemValue });
  } else if (itemValue && itemValue.type === 'error') {
    done({ ok: false, error: itemValue.message ?? JSON.stringify(itemValue).slice(0, 300) });
  }
  // 其他 item（如 delta）继续等 snapshot
}

/**
 * 构造 session/follow 的 open 帧（streamId 必须是字符串，见调用处说明）。
 *
 * @param {string} sessionId - 要 follow 的会话 id。
 * @returns {string} JSON 字符串。
 */
function buildOpenFrame(sessionId) {
  return JSON.stringify({
    type: 'open',
    streamId: `probe-${randomBytes(6).toString('hex')}`,
    endpoint: 'session/follow',
    payload: {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          maxMessages: 1,
        },
      },
    },
  });
}

/**
 * 触发迁移并等待目标版本文件落盘。
 *
 * @param {object} opts - { dshHome, sessionId, targetDir, targetVersion, waitMs }。
 * @returns {Promise<{ok: boolean, migratedFile?: string, error?: string, waitedMs?: number}>}
 */
export async function triggerMigration(opts) {
  const { dshHome, sessionId, targetDir, targetVersion, waitMs = 45000 } = opts;
  const started = Date.now();
  const expected = targetVersion === 0
    ? join(targetDir, 'session.jsonl.zstd')
    : join(targetDir, `session.v${targetVersion}.jsonl.zstd`);

  const followed = await followSession({ dshHome, sessionId, waitMs });
  if (!followed.ok) return { ok: false, error: followed.error, waitedMs: Date.now() - started };

  // follow 成功即已触发；再等目标文件真正出现（写入是异步的）
  for (let i = 0; i < 60; i++) {
    if (await fileExists(expected)) {
      return { ok: true, migratedFile: expected, waitedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    ok: false,
    error: `follow 已触发但目标文件未出现: ${expected}`,
    waitedMs: Date.now() - started,
  };
}

/**
 * 异步判断文件是否存在。
 *
 * @param {string} path - 文件路径。
 * @returns {Promise<boolean>}
 */
async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}
