// dsh-session-migrate 内容缺陷扫描/修复引擎自测（借鉴 dsh-session-migration-repair 的测试想法，
// 按本项目 engine/repair.js 的接口重写）。
//
// 运行：node test/test-repair.mjs
import assert from 'node:assert/strict';
import { scanLog, planRepair, repairLogText, parseLog } from '../lib/engine/repair.js';
import { decodeFull, textToZstd } from '../lib/engine/zstd.js';

const TIME = 1789146000000;

/** 构造一份携带各类缺陷的 v0 日志（每一类可修复缺陷各一处）。 */
function defectiveLog() {
  const rows = [
    { type: 'session', version: 0, id: 'session-test-repair', createdAt: TIME - 1000, cwd: '/tmp/workspace', delegationDepth: 0, agentPreset: 'standard' },
    { type: 'permission/preset', seq: 0, time: TIME, data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 3, time: TIME, data: { turn: 1 } },
    { type: 'step/start', seq: 4, time: TIME, data: { turn: 1, step: 1 } },
    { type: 'assistant/chunk', seq: 5, time: TIME, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } } },
    { type: 'assistant/chunk', seq: 6, time: TIME, data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call_stream_1', name: 'todo_write', argumentsDelta: '' } } },
    // 缺陷 A：tool-call-chunks 分片行 id/name 为空（旧版只在首行写 id）
    { type: 'tool-call-chunks', seq0: 7, time0: TIME, data: { turn: 1, step: 1, index: 0, dt: [5], id: '', name: '', args: ['{"todos":', ' []}'] } },
    // 缺陷 B：block-end 的 tool-call 块 id/name 为空
    { type: 'assistant/chunk', seq: 10, time: TIME, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: '', arguments: '{"todos": []}' } } } },
    // 缺陷 C：assistant/message 里 tool-call 块 name 为空
    { type: 'assistant/message', seq: 11, time: TIME, data: { turn: 1, step: 1, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool-call', id: 'call_repair_1', name: '', arguments: '{"todos": []}' }], source: { kind: 'assistant' } } } },
    // 缺陷 D：tool/call name 为空，且 arguments 与消息声明不一致
    { type: 'tool/call', seq: 12, time: TIME, data: { turn: 1, step: 1, callId: 'call_repair_1', name: '', arguments: '{"todos": [] }' } },
    { type: 'tool/result', seq: 13, time: TIME, data: { turn: 1, step: 1, message: { id: 'res-1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_repair_1', content: [{ type: 'text', text: '已更新待办' }] }], source: { kind: 'tool', callId: 'call_repair_1' } } } },
    { type: 'step/end', seq: 14, time: TIME, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 15, time: TIME, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

let failed = 0;
function check(label, ok, extra) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
}

console.log('── repair 引擎 ──');

const text = defectiveLog();

// 1. scanLog 识别全部缺陷
{
  const { rows } = parseLog(text);
  const scan = scanLog(rows, { text });
  check('packedChunkMissingId=1', scan.counts.packedChunkMissingId === 1, `got ${scan.counts.packedChunkMissingId}`);
  check('blockEndMissingId=1', scan.counts.blockEndMissingId === 1, `got ${scan.counts.blockEndMissingId}`);
  check('blockEndMissingName=1', scan.counts.blockEndMissingName === 1, `got ${scan.counts.blockEndMissingName}`);
  check('messageToolCallMissingName=1', scan.counts.messageToolCallMissingName === 1, `got ${scan.counts.messageToolCallMissingName}`);
  check('toolCallMissingName=1', scan.counts.toolCallMissingName === 1, `got ${scan.counts.toolCallMissingName}`);
  check('toolCallArgumentMismatch=1', scan.counts.toolCallArgumentMismatch === 1, `got ${scan.counts.toolCallArgumentMismatch}`);
  check('blocking>=5', scan.blocking >= 5, `got ${scan.blocking}`);
}

// 2. repairLogText 全部修好，且只改必要行
{
  const repaired = repairLogText(text);
  check('修复后 blocking=0', repaired.after.blocking === 0, JSON.stringify(repaired.after.counts));
  check('arguments 对齐', repaired.after.counts.toolCallArgumentMismatch === 0);
  check('packedChunkIdFilled=1', repaired.stats.packedChunkIdFilled === 1, JSON.stringify(repaired.stats));
  check('blockEndIdFilled=1', repaired.stats.blockEndIdFilled === 1);
  check('blockEndNameFilled=1', repaired.stats.blockEndNameFilled === 1);
  check('messageToolCallNameFilled=1', repaired.stats.messageToolCallNameFilled === 1);
  check('toolCallNameFilled=1', repaired.stats.toolCallNameFilled === 1);
  check('改动行数<=6', repaired.changedLines.length <= 6, `got ${repaired.changedLines.join(',')}`);
  check('无坏行', repaired.invalidLines.length === 0);
  check('修复后仍是合法 JSONL（首行 header 不变）', JSON.parse(repaired.text.split('\n')[0]).id === 'session-test-repair');
}

// 3. 修复保留 header 与无关行原样
{
  const original = text.split('\n');
  const repaired = repairLogText(text).text.split('\n');
  check('header 行不变', repaired[0] === original[0]);
  check('无关行不变（如 step/start）', repaired[3] === original[3]);
  check('行数不变', repaired.length === original.length);
}

// 4. planRepair 可关闭 arguments 对齐
{
  const { rows } = parseLog(text);
  const plan = planRepair(rows, { fixArguments: false });
  check('fixArguments=false 时 arguments 不动', plan.stats.toolCallArgumentsAligned === 0, JSON.stringify(plan.stats));
  check('其它修复不受影响', plan.stats.messageToolCallNameFilled === 1);
}

// 5. 无法解析的行被报告而不是抛错
{
  const { rows, invalid } = parseLog('{"type":"session","version":0}\n{oops\n');
  check('坏行计入 invalid', invalid.length === 1 && invalid[0].line === 2);
  check('坏行 rows 置 undefined', rows[1] === undefined);
}

// 6. zstd 全量解码 + 重编码往返（多字节字符与中文）
{
  const zhLines = ['{"type":"session","version":0,"id":"x","cwd":"/tmp"}', '{"text":"达哥的仙途：修仙文字游戏🎮"}', '{"text":"第二行中文——破折号、emoji 🚀 与标点「」"}'];
  const buf = textToZstd(zhLines.join('\n') + '\n');
  const decoded = decodeFull(buf);
  check('zstd 往返一致', decoded === zhLines.join('\n') + '\n');
  check('无 U+FFFD', !decoded.includes('\uFFFD'));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);