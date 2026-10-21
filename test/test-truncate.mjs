// 截断自测：吸附闭合边界、补 turn/end、seq 连续、不残留超界事件、写前备份。
//
// 背景（踩过的两个坑）：
//   ① 截在「开了 step 没闭合」的位置再硬塞 turn/end → DSH 报
//      `turn/end does not match the open turn with no open step`
//   ② 过滤用 continue 跳过超界事件 → 没有 seq 的事件漏进来，尾部混出大 seq → DSH 报
//      `has seq gap (expected N, got M)`
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textToZstd, decodeFull } from '../lib/engine/zstd.js';
import { truncateSession } from '../lib/engine/truncate.js';

let failed = 0;
function check(name, ok, extra = '') {
  if (ok) console.log('PASS:', name);
  else { failed += 1; console.error('FAIL:', name, extra); }
}

/** 造一个结构完整的小会话：turn1(step1..step3) + turn2(step1..step2) */
function makeSession(dir) {
  const header = { type: 'session', version: 4, id: 'session-test-1', createdAt: 1, cwd: '/tmp/demo' };
  const events = [];
  let seq = 0;
  const push = (type, data) => { events.push({ type, seq: seq++, time: 1000 + seq, data }); };
  for (const turn of [1, 2]) {
    push('turn/start', { turn });
    for (let step = 1; step <= (turn === 1 ? 3 : 2); step += 1) {
      push('step/start', { turn, step });
      push('assistant/message', { turn, step, message: { role: 'assistant', content: [{ type: 'text', text: `t${turn}s${step}` }] } });
      push('step/end', { turn, step });
    }
    push('turn/end', { turn, reason: { kind: 'stop' } });
  }
  const file = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(file, textToZstd([JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n'));
  return { file, total: events.length };
}

const home = mkdtempSync(join(tmpdir(), 'dsh-truncate-test-'));
const sessDir = join(home, 'sessions', '--tmp--', 'session-test-1');
mkdirSync(sessDir, { recursive: true });
const { file, total } = makeSession(sessDir);
const readBack = (p) => decodeFull(readFileSync(p)).split('\n').filter((l) => l.trim() !== '');

// 从文件里取边界（不手算事件数）
function seqsOf(p) {
  const evs = readBack(p).slice(1).map((l) => JSON.parse(l));
  return {
    evs,
    total: evs.length,
    stepEnds: evs.filter((e) => e.type === 'step/end').map((e) => e.seq),
    turnEnds: evs.filter((e) => e.type === 'turn/end').map((e) => e.seq),
  };
}

// 1. 截在某个 step/end 上 → 补 turn/end，seq 连续
{
  const { stepEnds } = seqsOf(file);
  const target = stepEnds[Math.floor(stepEnds.length / 2)]; // 中间那个 step/end
  const r = truncateSession({ file, keepSeq: target, apply: true, backupRoot: join(home, 'bk') });
  check('截断成功', r.ok === true, JSON.stringify(r));
  const { evs, total: n } = seqsOf(file);
  check('末事件是 turn/end', evs[n - 1].type === 'turn/end');
  check('保留条数 = 边界内事件 + 补的 1 条', n === r.kept, `实际 ${n} / 报告 ${r.kept}`);
  let gap = 0;
  for (let i = 1; i < n; i += 1) if (evs[i].seq !== evs[i - 1].seq + 1) gap += 1;
  check('seq 连续', gap === 0, `缺口 ${gap}`);
  check('写前有备份', Boolean(r.backup), String(r.backup));
}

// 2. 再截一次（更短）：仍必须吸附闭合边界 + seq 连续 + 无超界
{
  const { stepEnds } = seqsOf(file);
  const target = stepEnds[0];
  const r = truncateSession({ file, keepSeq: target, apply: true, backupRoot: join(home, 'bk') });
  check('再次截断成功', r.ok === true, JSON.stringify(r));
  const { evs, total: n } = seqsOf(file);
  check('第二次末事件是 turn/end', evs[n - 1].type === 'turn/end');
  check('第二次 seq 连续', evs.every((e, i) => i === 0 || e.seq === evs[i - 1].seq + 1));
  check('第二次没有残留超界事件', evs.every((e) => e.seq <= target + 1), JSON.stringify(evs.map((e) => e.seq)));
}

// 3. 预览模式不写盘
{
  const before = readFileSync(file, 'utf8');
  const { stepEnds } = seqsOf(file);
  const r = truncateSession({ file, keepSeq: stepEnds[stepEnds.length - 1], apply: false });
  check('预览返回成功', r.ok === true);
  check('预览未写盘', readFileSync(file, 'utf8') === before);
}

// 4. 非法 keepSeq（太小）应如实拒绝而不是写出坏文件
{
  const r = truncateSession({ file, keepSeq: 0, apply: false });
  check('过小的 keepSeq 被拒绝', r.ok === false && /已闭合/.test(String(r.error)), JSON.stringify(r));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
rmSync(home, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
