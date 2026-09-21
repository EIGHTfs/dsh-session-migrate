/**
 * 内容级缺陷扫描与修复（engine/repair）。
 *
 * 定位：dsh-session-migrate 的「投放」只改 header（cwd/首帧），不碰日志内容行；
 * 但旧版写入器（及更早的修复工具）可能在内容里留下空字段，导致 DSH 打开会话时
 * **迁移链拒绝**（v0→v1 / v2→v3 校验失败，表现为 history unavailable）。本模块补上
 * 内容级诊断与修复，修完再由既有投放链路落盘，DSH 打开时即可正常迁移。
 *
 * 可修复的缺陷（全部能从周边流取回真实值，见各缺陷注释）：
 *   · tool-call-chunks 分片行 id/name 为空（旧版只在首行写 id）→ v0→v1 拒绝
 *   · assistant/message 里 tool-call 块 name/id 为空 → v0→v1 拒绝
 *   · assistant/chunk 的 block-end tool-call 块 id 为空 → v2→v3 拒绝
 *   · tool/call 的 name 为空 / arguments 与消息里声明的不一致 → v0→v1 拒绝
 *
 * 实现借鉴：本模块的检测/修复算法改编自 zzdhsxk 的
 * dsh-session-migration-repair（MIT License, Copyright (c) 2026 zzdhsxk，
 * https://github.com/zzdhsxk/dsh-session-migration-repair），保留了
 * 「从 tool-call-delta 索引取回 id/name」「只重写变化的行」的核心设计；
 * 按本项目风格重写（中文注释、零依赖、并入 engine 目录），接口与 CLI 自定义。
 *
 * @module dsh-session-migrate/lib/engine/repair
 */

/** 事件类型字面量（提为常量，避免散落重复）。 */
const T_CHUNKS = 'tool-call-chunks';
const T_CHUNK = 'assistant/chunk';
const T_MESSAGE = 'assistant/message';
const T_CALL = 'tool/call';
const T_RESULT = 'tool/result';
/** U+FFFD 替换字符——被早期工具写坏的标记，两侧对齐时以未含它的一侧为准。 */
const REPLACEMENT = '\uFFFD';

/** "turn|step" 组合键（delta/名字索引的键）。 */
function stepKey(turn, step) {
  return turn + '|' + step;
}

/** 索引 tool-call-delta 流：名字 by step、delta by step|index、全部 delta by step。 */
function indexDelta(index, data) {
  const chunk = data.chunk ?? {};
  if (chunk.type !== 'tool-call-delta') return;
  const sKey = stepKey(data.turn, data.step);
  if (typeof chunk.name === 'string' && chunk.name.length > 0 && !index.nameByStep.has(sKey)) {
    index.nameByStep.set(sKey, chunk.name);
  }
  if (typeof chunk.id !== 'string' || chunk.id.length === 0) return;
  const iKey = sKey + '|' + chunk.index;
  if (!index.deltaByIndex.has(iKey)) {
    index.deltaByIndex.set(iKey, { id: chunk.id, name: chunk.name, index: chunk.index, turn: data.turn, step: data.step });
  }
  const entry = { id: chunk.id, name: chunk.name, index: chunk.index };
  const list = index.deltasByStep.get(sKey);
  if (list === undefined) index.deltasByStep.set(sKey, [entry]);
  else list.push(entry);
}

/** 索引 assistant/message 里声明的 tool-call（按 call id 去重，首个胜）。 */
function indexMessage(index, row, data, line) {
  const content = messageContent(row);
  if (content === undefined) return;
  for (const block of content) {
    if (block?.type === 'tool-call' && typeof block.id === 'string' && block.id.length > 0
        && !index.advertisedByCall.has(block.id)) {
      index.advertisedByCall.set(block.id, { block, line, turn: data.turn, step: data.step });
    }
  }
}

/** 索引 tool/call 实际调用（后写者胜，与日志回放一致）。 */
function indexCall(index, data, line) {
  if (typeof data.callId === 'string' && data.callId.length > 0) {
    index.callByCall.set(data.callId, { data, line, turn: data.turn, step: data.step });
  }
}

/** 索引 tool/result 已产生的 call id（只收集合，不判重）。 */
function indexResult(index, data) {
  const callId = data.message?.source?.callId;
  if (typeof callId === 'string') index.results.add(callId);
}

/** 建立工具调用流索引（名字 / delta / 声明 / 调用 / 结果 五份）。 */
function indexLog(rows) {
  const index = {
    nameByStep: new Map(),
    deltaByIndex: new Map(),
    deltasByStep: new Map(),
    advertisedByCall: new Map(),
    callByCall: new Map(),
    results: new Set(),
  };
  for (let line = 1; line <= rows.length; line += 1) {
    const row = rows[line - 1];
    if (row === undefined || row === null) continue;
    const data = row.data ?? {};
    if (row.type === T_CHUNK) indexDelta(index, data);
    else if (row.type === T_MESSAGE) indexMessage(index, row, data, line);
    else if (row.type === T_CALL) indexCall(index, data, line);
    else if (row.type === T_RESULT) indexResult(index, data);
  }
  return index;
}

/** 取 "turn|step" 的工具名。 */
function nameFor(index, turn, step) {
  return index.nameByStep.get(stepKey(turn, step));
}

/** 取 "turn|step" 的 delta（优先按 chunk index 精确命中，其次单 delta 场景）。 */
function deltaFor(index, turn, step, chunkIndex) {
  const sKey = stepKey(turn, step);
  if (chunkIndex !== undefined) {
    const exact = index.deltaByIndex.get(sKey + '|' + chunkIndex);
    if (exact !== undefined) return exact;
  }
  const list = index.deltasByStep.get(sKey);
  if (list !== undefined && list.length === 1) return list[0];
  return undefined;
}

/** 逐行解析日志明文字符串（容忍坏行，坏行计入 invalid 而不是抛错）。 */
export function parseLog(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const rows = new Array(lines.length);
  const invalid = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') { rows[index] = undefined; continue; }
    try {
      rows[index] = JSON.parse(line);
    } catch (error) {
      rows[index] = undefined;
      invalid.push({ line: index + 1, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { lines, rows, invalid };
}

/** 行数组 → 日志文本（结尾单个换行）。 */
export function serializeLog(lines) {
  return lines.join('\n') + '\n';
}

/** 取出消息形态事件的 data.message.content 块数组（非数组返回 undefined）。 */
export function messageContent(row) {
  const content = row?.data?.message?.content;
  return Array.isArray(content) ? content : undefined;
}

// ── 扫描：每类行一个处理器（共享 defects，直接往里 push 明细） ──

/** 分片形状是否损坏（args/dt 尺寸不一致、seq0/time0 非法）。 */
function chunkShapeBroken(row, data) {
  const payload = data.args;
  const gaps = data.dt;
  return !Array.isArray(payload) || payload.length === 0
    || payload.some((member) => typeof member !== 'string')
    || !Array.isArray(gaps) || gaps.length !== payload.length - 1
    || gaps.some((gap) => !Number.isSafeInteger(gap))
    || !Number.isSafeInteger(row.seq0) || !Number.isSafeInteger(row.time0);
}

/** tool-call-chunks：缺 id 与分片形状（args/dt 尺寸不一致）检查。 */
function scanChunks(defects, row, data, line) {
  if (typeof data.id !== 'string' || data.id.length === 0) {
    defects.packedChunkMissingId.push({ line, turn: data.turn, step: data.step, index: data.index });
  }
  if (chunkShapeBroken(row, data)) {
    defects.packedChunkShape.push({ line, turn: data.turn, step: data.step, index: data.index });
  }
}

/** assistant/message：content 块里缺 id/name、重复声明。 */
function scanMessage(defects, row, data, line, seenAdvertised) {
  const content = messageContent(row);
  if (content === undefined) return;
  for (let position = 0; position < content.length; position += 1) {
    const block = content[position];
    if (block?.type !== 'tool-call') continue;
    const label = { line, turn: data.turn, step: data.step, position };
    if (typeof block.id !== 'string' || block.id.length === 0) defects.messageToolCallMissingId.push(label);
    else if (seenAdvertised.has(block.id)) defects.duplicateAdvertisedCall.push({ ...label, id: block.id });
    else seenAdvertised.add(block.id);
    if (typeof block.name !== 'string' || block.name.length === 0) defects.messageToolCallMissingName.push(label);
  }
}

/** assistant/chunk 的 block-end tool-call 块：缺 id/name。 */
function scanBlockEnd(defects, data, line) {
  const chunk = data.chunk ?? {};
  if (chunk.type !== 'block-end' || chunk.block?.type !== 'tool-call') return;
  const label = { line, turn: data.turn, step: data.step, index: chunk.index };
  if (typeof chunk.block.id !== 'string' || chunk.block.id.length === 0) defects.blockEndMissingId.push(label);
  if (typeof chunk.block.name !== 'string' || chunk.block.name.length === 0) defects.blockEndMissingName.push(label);
}

/** tool/call：缺 name / 无声明 / arguments 与声明不一致。 */
function scanCall(defects, index, data, line) {
  if (typeof data.name !== 'string' || data.name.length === 0) {
    defects.toolCallMissingName.push({ line, callId: data.callId, turn: data.turn, step: data.step });
  }
  const advertised = index.advertisedByCall.get(data.callId);
  if (advertised === undefined) {
    defects.toolCallWithoutAdvertisement.push({ line, callId: data.callId });
    return;
  }
  if (advertised.block.arguments === data.arguments) return;
  defects.toolCallArgumentMismatch.push({
    line,
    callId: data.callId,
    advertisedLine: advertised.line,
    advertisedBytes: typeof advertised.block.arguments === 'string' ? advertised.block.arguments.length : -1,
    callBytes: typeof data.arguments === 'string' ? data.arguments.length : -1,
    advertisedHasReplacement: typeof advertised.block.arguments === 'string' && advertised.block.arguments.includes(REPLACEMENT),
    callHasReplacement: typeof data.arguments === 'string' && data.arguments.includes(REPLACEMENT),
  });
}

/**
 * 只读扫描：检测一个日志里的全部迁移阻塞缺陷。
 *
 * @param {any[]} rows parseLog 的结果
 * @param {{text?: string}} [options]
 * @returns {object} 含 counts（各缺陷计数）、blocking（阻塞总数）、defects（明细）、toolChains
 */
export function scanLog(rows, options = {}) {
  const index = indexLog(rows);
  const defects = {
    packedChunkMissingId: [],
    packedChunkShape: [],
    messageToolCallMissingId: [],
    messageToolCallMissingName: [],
    blockEndMissingId: [],
    blockEndMissingName: [],
    toolCallMissingName: [],
    toolCallArgumentMismatch: [],
    duplicateAdvertisedCall: [],
    toolCallWithoutAdvertisement: [],
    toolCallWithoutResult: [],
  };
  const seenAdvertised = new Set();

  for (let line = 1; line <= rows.length; line += 1) {
    const row = rows[line - 1];
    if (row === undefined || row === null) continue;
    const data = row.data ?? {};
    if (row.type === T_CHUNKS) scanChunks(defects, row, data, line);
    else if (row.type === T_MESSAGE) scanMessage(defects, row, data, line, seenAdvertised);
    else if (row.type === T_CHUNK) scanBlockEnd(defects, data, line);
    else if (row.type === T_CALL) scanCall(defects, index, data, line);
  }

  for (const [id, advertised] of index.advertisedByCall) {
    if (!index.callByCall.has(id)) defects.toolCallWithoutAdvertisement.push({ line: advertised.line, callId: id, advertised: true });
    else if (!index.results.has(id)) defects.toolCallWithoutResult.push({ line: advertised.line, callId: id });
  }

  const counts = Object.fromEntries(Object.entries(defects).map(([key, list]) => [key, list.length]));
  const text = options.text ?? '';
  return {
    rows: rows.length,
    counts,
    blocking: counts.packedChunkMissingId + counts.packedChunkShape + counts.messageToolCallMissingId
      + counts.messageToolCallMissingName + counts.blockEndMissingId + counts.blockEndMissingName
      + counts.toolCallMissingName + counts.toolCallArgumentMismatch + counts.duplicateAdvertisedCall,
    defects,
    toolChains: {
      advertised: index.advertisedByCall.size,
      calls: index.callByCall.size,
      results: index.results.size,
    },
    replacementCharacters: text.split(REPLACEMENT).length - 1,
  };
}

// ── 修复：每类行一个处理器（返回该行是否被改写；统计写进 stats） ──

/** tool-call-chunks：从 delta 索引补 id/name；无 delta 参考则跳过不硬改。 */
function repairChunks(index, stats, skipped, data, line) {
  // id 已有：只清理非法的 name（空串/非字符串）
  if (typeof data.id === 'string' && data.id.length > 0) {
    if (data.name === '' || (data.name !== undefined && typeof data.name !== 'string')) {
      delete data.name;
      return true;
    }
    return false;
  }
  // id 缺失：从 delta 索引取回；无 delta 则无法恢复，进 skipped 不硬改
  const delta = deltaFor(index, data.turn, data.step, data.index);
  if (delta === undefined) {
    skipped.push({ line, kind: 'packedChunkMissingId', reason: 'no tool-call-delta announces this streamed call' });
    return false;
  }
  data.id = delta.id;
  stats.packedChunkIdFilled += 1;
  if (typeof delta.name !== 'string' || delta.name.length === 0) {
    if (data.name !== undefined) delete data.name;
  } else {
    data.name = delta.name;
    stats.packedChunkNameFilled += 1;
  }
  return true;
}

/** 补单个 tool-call 块的 name（取 step 级工具名；已填或无名可补则不动）。 */
function fillBlockName(block, name, stats) {
  if ((typeof block.name === 'string' && block.name.length > 0) || name === undefined) return false;
  block.name = name;
  stats.messageToolCallNameFilled += 1;
  return true;
}

/** 补单个 tool-call 块的 id（从 delta 索引；无 delta 则进 skipped 不硬改）。 */
function fillBlockId(block, index, stats, skipped, data, position, line) {
  if (typeof block.id === 'string' && block.id.length > 0) return false;
  const delta = deltaFor(index, data.turn, data.step, position);
  if (delta !== undefined) { block.id = delta.id; stats.messageToolCallIdFilled += 1; return true; }
  skipped.push({ line, kind: 'messageToolCallMissingId', reason: 'no delta for content block ' + position });
  return false;
}

/** assistant/message：补 content 块缺的 name/id（name 取 step 级，id 取 delta）。 */
function repairMessage(rows, index, stats, skipped, row, data, line) {
  const content = messageContent(row);
  if (content === undefined) return false;
  let dirty = false;
  const name = nameFor(index, data.turn, data.step);
  for (let position = 0; position < content.length; position += 1) {
    const block = content[position];
    if (block?.type !== 'tool-call') continue;
    if (fillBlockName(block, name, stats) || fillBlockId(block, index, stats, skipped, data, position, line)) {
      dirty = true;
    }
  }
  return dirty;
}

/** 补 block-end tool-call 块的 name（取 step 级工具名）。 */
function fillBlockEndName(block, name, stats) {
  if ((typeof block.name === 'string' && block.name.length > 0) || name === undefined) return false;
  block.name = name;
  stats.blockEndNameFilled += 1;
  return true;
}

/** 补 block-end tool-call 块的 id（从 delta 索引；无 delta 则进 skipped 不硬改）。 */
function fillBlockEndId(block, index, stats, skipped, data, line) {
  if (typeof block.id === 'string' && block.id.length > 0) return false;
  const delta = deltaFor(index, data.turn, data.step, data.chunk?.index);
  if (delta !== undefined) { block.id = delta.id; stats.blockEndIdFilled += 1; return true; }
  skipped.push({ line, kind: 'blockEndMissingId', reason: 'no delta for block index ' + String(data.chunk?.index) });
  return false;
}

/** block-end tool-call 块：补缺的 id/name（同 message 的取回策略）。 */
function repairBlockEnd(index, stats, skipped, data, line) {
  const chunk = data.chunk ?? {};
  if (chunk.type !== 'block-end' || chunk.block?.type !== 'tool-call') return false;
  const name = nameFor(index, data.turn, data.step);
  const nameDirty = fillBlockEndName(chunk.block, name, stats);
  const idDirty = fillBlockEndId(chunk.block, index, stats, skipped, data, line);
  return nameDirty || idDirty;
}

/** tool/call：补缺的 name（取 step 级工具名）。 */
function repairCall(index, stats, data) {
  const name = nameFor(index, data.turn, data.step);
  if ((typeof data.name !== 'string' || data.name.length === 0) && name !== undefined) {
    data.name = name;
    stats.toolCallNameFilled += 1;
    return true;
  }
  return false;
}

/**
 * 内存中修复：只重写真正变化的行，其余行原样保留（最小差异原则）。
 *
 * @param {any[]} rows parseLog 的结果（会原地改写变化行的字段）
 * @param {{fixArguments?: boolean}} [options]
 * @returns {{changedLines: number[], stats: object, skipped: Array<{line:number,kind:string,reason:string}>}}
 */
export function planRepair(rows, options = {}) {
  const fixArguments = options.fixArguments !== false; // 默认开：对齐 tool/call 与声明
  const index = indexLog(rows);
  const stats = {
    packedChunkIdFilled: 0,
    packedChunkNameFilled: 0,
    messageToolCallIdFilled: 0,
    messageToolCallNameFilled: 0,
    blockEndIdFilled: 0,
    blockEndNameFilled: 0,
    toolCallNameFilled: 0,
    toolCallArgumentsAligned: 0,
    toolCallArgumentsLeftAlone: 0,
  };
  const changed = new Set();
  const skipped = [];

  if (fixArguments) alignArguments(index, stats, changed);
  else stats.toolCallArgumentsLeftAlone = index.advertisedByCall.size;

  // 补齐缺失的 id/name（从 delta 索引取回真实值）
  for (let line = 1; line <= rows.length; line += 1) {
    const row = rows[line - 1];
    if (row === undefined || row === null) continue;
    const data = row.data ?? {};
    let dirty = false;
    if (row.type === T_CHUNKS) dirty = repairChunks(index, stats, skipped, data, line);
    else if (row.type === T_MESSAGE) dirty = repairMessage(rows, index, stats, skipped, row, data, line);
    else if (row.type === T_CHUNK) dirty = repairBlockEnd(index, stats, skipped, data, line);
    else if (row.type === T_CALL) dirty = repairCall(index, stats, data);
    if (dirty) changed.add(line);
  }

  return { changedLines: [...changed].sort((a, b) => a - b), stats, skipped };
}

/**
 * 对齐 tool/call 与消息声明的 arguments：以未含 U+FFFD（被早期工具写坏）的一侧为
 * 干净一侧，两侧写回同一份；任一侧非字符串或已一致则不动。
 */
function alignArguments(index, stats, changed) {
  for (const [callId, advertised] of index.advertisedByCall) {
    const call = index.callByCall.get(callId);
    if (call === undefined) continue;
    const advertisedArgs = advertised.block.arguments;
    const callArgs = call.data.arguments;
    if (typeof advertisedArgs !== 'string' || typeof callArgs !== 'string' || advertisedArgs === callArgs) continue;
    const winner = advertisedArgs.includes(REPLACEMENT) && !callArgs.includes(REPLACEMENT) ? callArgs : advertisedArgs;
    if (advertised.block.arguments !== winner) { advertised.block.arguments = winner; changed.add(advertised.line); }
    if (call.data.arguments !== winner) { call.data.arguments = winner; changed.add(call.line); }
    stats.toolCallArgumentsAligned += 1;
  }
}

/**
 * 一步到位：扫描 + 修复一份解压后的日志文本。
 *
 * @param {string} text 明文日志（多行 JSONL）
 * @param {{fixArguments?: boolean}} [options]
 * @returns {{text:string, before:object, after:object, changedLines:number[], stats:object, invalidLines:Array<{line:number,reason:string}>, skipped:Array<object>}}
 */
export function repairLogText(text, options = {}) {
  const { lines, rows, invalid } = parseLog(text);
  const before = scanLog(rows, { text });
  const plan = planRepair(rows, options);
  for (const line of plan.changedLines) {
    if (rows[line - 1] !== undefined) lines[line - 1] = JSON.stringify(rows[line - 1]);
  }
  const after = scanLog(rows, { text: serializeLog(lines) });
  return {
    text: serializeLog(lines),
    before,
    after,
    changedLines: plan.changedLines,
    stats: plan.stats,
    invalidLines: invalid,
    skipped: plan.skipped,
  };
}