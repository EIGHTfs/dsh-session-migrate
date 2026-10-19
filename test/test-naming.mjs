// 文件名版本段自测：v4 内容必须落成 session.v4.jsonl.zstd（v0 才用无版本段命名）。
//
// 背景：v4 内容叫 session.jsonl.zstd 时，目标实例 workspace 服务会解析失败，
// 表现为**整实例所有会话在前端不可见**（不是只坏一条）。这里锁住两件事：
//   ① expectedLogName 的映射规则；
//   ② fixSessionNames 能检出并（仅改名、不动内容地）修复。
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textToZstd } from '../lib/engine/zstd.js';
import { expectedLogName, fixSessionNames, placeAttachments, checkAttachments } from '../lib/engine/layout.js';

let failed = 0;
/** 断言并打印 */
function check(name, ok) {
  if (ok) console.log('PASS:', name);
  else { failed += 1; console.error('FAIL:', name); }
}

// 1. 命名映射：v0 无版本段，其余带 session.v<version>
check('v0 → session.jsonl.zstd', expectedLogName(0) === 'session.jsonl.zstd');
check('v4 → session.v4.jsonl.zstd', expectedLogName(4) === 'session.v4.jsonl.zstd');
check("字符串 '3' → session.v3.jsonl.zstd", expectedLogName('3') === 'session.v3.jsonl.zstd');
check('缺省/非法 → 视作 v0', expectedLogName(undefined) === 'session.jsonl.zstd' && expectedLogName('x') === 'session.jsonl.zstd');

// 2. 造一个「v4 内容 + 旧名字」的临时 home
const home = mkdtempSync(join(tmpdir(), 'dsh-migrate-naming-'));
const sessionDir = join(home, 'sessions', '--tmp-test--', 'session-abc123');
const subDir = join(sessionDir, 'subagents', 'sub-1');
mkdirSync(subDir, { recursive: true });
const header = JSON.stringify({ type: 'session', version: 4, id: 'session-abc123', createdAt: 1, cwd: '/tmp/test' });
const body = JSON.stringify({ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } });
const buf = textToZstd(`${header}\n${body}\n`);
writeFileSync(join(sessionDir, 'session.jsonl.zstd'), buf);
writeFileSync(join(subDir, 'session.jsonl.zstd'), buf);

// 3. 预览：检出 2 个、不改盘
const preview = fixSessionNames(home, { apply: false });
check('预览检出 2 个命名不一致', preview.checked === 2 && preview.mismatched.length === 2);
check('预览不落盘', existsSync(join(sessionDir, 'session.jsonl.zstd')));

// 4. 执行：改名为 v4，内容字节不变
const applied = fixSessionNames(home, { apply: true });
check('已改名 2 个', applied.renamed.length === 2);
check('v4 文件存在', existsSync(join(sessionDir, 'session.v4.jsonl.zstd')) && existsSync(join(subDir, 'session.v4.jsonl.zstd')));
check('旧名字已不存在', !existsSync(join(sessionDir, 'session.jsonl.zstd')));
check('目录里只剩 v4 名字', readdirSync(sessionDir).filter((n) => n.endsWith('.zstd')).join() === 'session.v4.jsonl.zstd');

// 5. 再跑一次应当「无不一致」（幂等）
const again = fixSessionNames(home, { apply: false });
check('修复后幂等（无不一致）', again.mismatched.length === 0);

// 6. 附件：media/ 里的内容按 sha256 落进 <home>/attachments/v1/objects/<2>/<sha>
{
  const attHome = mkdtempSync(join(tmpdir(), 'dsh-migrate-att-'));
  const stage = mkdtempSync(join(tmpdir(), 'dsh-migrate-att-src-'));
  mkdirSync(join(stage, 'media'), { recursive: true });
  const jpg = Buffer.from('fake-jpeg-bytes-for-test');
  const digest = createHash('sha256').update(jpg).digest('hex');
  writeFileSync(join(stage, 'media', `sha256:${digest}.jpg`), jpg);
  // 一个内容与文件名不符的附件（必须被拒）
  writeFileSync(join(stage, 'media', `sha256:${'0'.repeat(64)}.jpg`), Buffer.from('mismatch'));

  const placed = placeAttachments(stage, attHome);
  check('附件落盘 1 个', placed.copied === 1);
  check('摘要不符被拒', placed.invalid.length === 1);
  check('附件对象存在', existsSync(join(attHome, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)));

  const ref = `{"attachments":["sha256:${digest}","sha256:${'a'.repeat(64)}"]}`;
  const res = checkAttachments(ref, attHome);
  check('引用统计 2 个', res.referenced === 2);
  check('缺失只报没有的那个', res.missing.length === 1 && res.missing[0] === 'a'.repeat(64));
  rmSync(attHome, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
}

rmSync(home, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
