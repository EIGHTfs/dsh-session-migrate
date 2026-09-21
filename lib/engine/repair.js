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

/** 工具调用流按 turn|step 建立的三份索引：名字、delta id、声明（advertised）。 */
function indexLog(rows) {
  /** tool 名 by "turn|step"（首个非空者胜） */
  const nameByStep = new Map();
  /** tool-call-delta by "turn|step|index"（首个非空 id 者胜） */
  const deltaByIndex = new Map();
  /** 某个 "turn|step" 的全部非空 delta id */
  const deltasByStep = new Map();
  /** 声明过的调用（assistant/message content 块）by call id */
  const advertisedByCall = new Map();
  /** tool/call 数据 by call id（后写者胜，与日志回放一致） */
  const callByCall = new Map();
  /** 已产生 result 的 call id 集合 */
  const results = new Set();

  for (let line = 1; line <= rows.length; line += 1) {
    const row = rows[line - 1];
    if (row === undefined || row === null) continue;
    const data = row.data ?? {};
    if (row.type === 'assistant/chunk') {
      const chunk = data.chunk ?? {};
      if (chunk.type !== 'tool-call-delta') continue;
      const stepKey = data.turn + '|' + data.step;
      const indexKey = stepKey + '|' + chunk.index;
      if (typeof chunk.name === 'string' && chunk.name.length > 0 && !nameByStep.has(stepKey)) {
        nameByStep.set(stepKey, chunk.name);
      }
      if (typeof chunk.id === 'string' && chunk.id.length > 0) {
        if (!deltaByIndex.has(indexKey)) {
          deltaByIndex.set(indexKey, { id: chunk.id, name: chunk.name, index: chunk.index, turn: data.turn, step: data.step });
        }
        const list = deltasByStep.get(stepKey);
        if (list === undefined) deltasByStep.set(stepKey, [{ id: chunk.id, name: chunk.name, index: chunk.index }]);
        else list.push({ id: chunk.id, name: chunk.name, index: chunk.index });
      }
    } else if (row.type === 'assistant/message') {
      const content = messageContent(row);
      if (content === undefined) continue;
      for (const block of content) {
        if (block?.type === 'tool-call' && typeof block.id === 'string' && block.id.length > 0 && !advertisedByCall.has(block.id)) {
          advertisedByCall.set(block.id, { block, line, turn: data.turn, step: data.step });
        }
      }
    } else if (row.type === 'tool/call') {
      if (typeof data.callId === 'string' && data.callId.length > 0) {
        callByCall.set(data.callId, { data, line, turn: data.turn, step: data.step });
      }
    } else if (row.type === 'tool/result') {
      const callId = data.message?.source?.callId;
      if (typeof callId === 'string') results.add(callId);
    }
  }
  return { nameByStep, deltaByIndex, deltasByStep, advertisedByCall, callByCall, results };
}

/** 取 "turn|step" 的工具名。 */
function nameFor(index, turn, step) {
  return index.nameByStep.get(turn + '|' + step);
}

/** 取 "turn|step" 的 delta（优先按 chunk index 精确命中，其次单 delta 场景）。 */
function deltaFor(index, turn, step, chunkIndex) {
  const stepKey = turn + '|' + step;
  if (chunkIndex !== undefined) {
    const exact = index.deltaByIndex.get(stepKey + '|' + chunkIndex);
    if (exact !== undefined) return exact;
  }
  const list = index.deltasByStep.get(stepKey);
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
    const type = row.type;
    if (type === 'tool-call-chunks') {
      if (typeof data.id !== 'string' || data.id.length === 0) {
        defects.packedChunkMissingId.push({ line, turn: data.turn, step: data.step, index: data.index });
      }
      const payload = data.args;
      const gaps = data.dt;
      if (!Array.isArray(payload) || payload.length === 0 || payload.some((member) => typeof member !== 'string')
          || !Array.isArray(gaps) || gaps.length !== payload.length - 1
          || gaps.some((gap) => !Number.isSafeInteger(gap))
          || !Number.isSafeInteger(row.seq0) || !Number.isSafeInteger(row.time0)) {
        defects.packedChunkShape.push({ line, turn: data.turn, step: data.step, index: data.index });
      }
    } else if (type === 'assistant/message') {
      const content = messageContent(row);
      if (content === undefined) continue;
      for (let position = 0; position < content.length; position += 1) {
        const block = content[position];
        if (block?.type !== 'tool-call') continue;
        const label = { line, turn: data.turn, step: data.step, position };
        if (typeof block.id !== 'string' || block.id.length === 0) defects.messageToolCallMissingId.push(label);
        else if (seenAdvertised.has(block.id)) defects.duplicateAdvertisedCall.push({ ...label, id: block.id });
        else seenAdvertised.add(block.id);
        if (typeof block.name !== 'string' || block.name.length === 0) defects.messageToolCallMissingName.push(label);
      }
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk ?? {};
      if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        const label = { line, turn: data.turn, step: data.step, index: chunk.index };
        if (typeof chunk.block.id !== 'string' || chunk.block.id.length === 0) defects.blockEndMissingId.push(label);
        if (typeof chunk.block.name !== 'string' || chunk.block.name.length === 0) defects.blockEndMissingName.push(label);
      }
    } else if (type === 'tool/call') {
      if (typeof data.name !== 'string' || data.name.length === 0) {
        defects.toolCallMissingName.push({ line, callId: data.callId, turn: data.turn, step: data.step });
      }
      const advertised = index.advertisedByCall.get(data.callId);
      if (advertised === undefined) defects.toolCallWithoutAdvertisement.push({ line, callId: data.callId });
      else if (advertised.block.arguments !== data.arguments) {
        defects.toolCallArgumentMismatch.push({
          line,
          callId: data.callId,
          advertisedLine: advertised.line,
          advertisedBytes: typeof advertised.block.arguments === 'string' ? advertised.block.arguments.length : -1,
          callBytes: typeof data.arguments === 'string' ? data.arguments.length : -1,
          advertisedHasReplacement: typeof advertised.block.arguments === 'string' && advertised.block.arguments.includes('\uFFFD'),
          callHasReplacement: typeof data.arguments === 'string' && data.arguments.includes('\uFFFD'),
        });
      }
    }
  }

  for (const [id, advertised] of index.advertisedByCall) {
    if (!index.callByCall.has(id)) defects.toolCallWithoutAdvertisement.push({ line: advertised.line, callId: id, advertised: true });
    else if (!index.results.has(id)) defects.toolCallWithoutResult.push({ line: advertised.line, callId: id });
  }

  const counts = Object.fromEntries(Object.entries(defects).map(([key, list]) => [key, list.length]));
  const text = options.text ?? '';
  const report = {
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
    replacementCharacters: text.split('\uFFFD').length - 1,
  };
  return report;
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

  // ① arguments 对齐：以未含 U+FFFD（被早期工具写坏）的一侧为干净一侧，两侧写回同一份。
  if (fixArguments) {
    for (const [callId, advertised] of index.advertisedByCall) {
      const call = index.callByCall.get(callId);
      if (call === undefined) continue;
      const advertisedArgs = advertised.block.arguments;
      const callArgs = call.data.arguments;
      if (typeof advertisedArgs !== 'string' || typeof callArgs !== 'string' || advertisedArgs === callArgs) continue;
      const advertisedDirty = advertisedArgs.includes('\uFFFD');
      const callDirty = callArgs.includes('\uFFFD');
      const winner = advertisedDirty && !callDirty ? callArgs : advertisedArgs;
      if (advertised.block.arguments !== winner) { advertised.block.arguments = winner; changed.add(advertised.line); }
      if (call.data.arguments !== winner) { call.data.arguments = winner; changed.add(call.line); }
      stats.toolCallArgumentsAligned += 1;
    }
  } else {
    stats.toolCallArgumentsLeftAlone = index.advertisedByCall.size;
  }

  // ② 补齐缺失的 id/name（从 delta 索引取回真实值）
  for (let line = 1; line <= rows.length; line += 1) {
    const row = rows[line - 1];
    if (row === undefined || row === null) continue;
    const data = row.data ?? {};
    const type = row.type;
    let dirty = false;

    if (type === 'tool-call-chunks') {
      if (typeof data.id !== 'string' || data.id.length === 0) {
        const delta = deltaFor(index, data.turn, data.step, data.index);
        if (delta !== undefined) {
          data.id = delta.id;
          stats.packedChunkIdFilled += 1;
          dirty = true;
          if (typeof delta.name === 'string' && delta.name.length > 0) { data.name = delta.name; stats.packedChunkNameFilled += 1; }
          else if (data.name !== undefined) delete data.name;
        } else {
          skipped.push({ line, kind: 'packedChunkMissingId', reason: 'no tool-call-delta announces this streamed call' });
        }
      } else if (data.name === '' || (data.name !== undefined && typeof data.name !== 'string')) {
        delete data.name;
        dirty = true;
      }
    } else if (type === 'assistant/message') {
      const content = messageContent(row);
      if (content !== undefined) {
        const name = nameFor(index, data.turn, data.step);
        for (let position = 0; position < content.length; position += 1) {
          const block = content[position];
          if (block?.type !== 'tool-call') continue;
          if ((typeof block.name !== 'string' || block.name.length === 0) && name !== undefined) {
            block.name = name;
            stats.messageToolCallNameFilled += 1;
            dirty = true;
          }
          if (typeof block.id !== 'string' || block.id.length === 0) {
            const delta = deltaFor(index, data.turn, data.step, position);
            if (delta !== undefined) { block.id = delta.id; stats.messageToolCallIdFilled += 1; dirty = true; }
            else skipped.push({ line, kind: 'messageToolCallMissingId', reason: 'no delta for content block ' + position });
          }
        }
      }
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk ?? {};
      if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        const name = nameFor(index, data.turn, data.step);
        if ((typeof chunk.block.name !== 'string' || chunk.block.name.length === 0) && name !== undefined) {
          chunk.block.name = name;
          stats.blockEndNameFilled += 1;
          dirty = true;
        }
        if (typeof chunk.block.id !== 'string' || chunk.block.id.length === 0) {
          const delta = deltaFor(index, data.turn, data.step, chunk.index);
          if (delta !== undefined) { chunk.block.id = delta.id; stats.blockEndIdFilled += 1; dirty = true; }
          else skipped.push({ line, kind: 'blockEndMissingId', reason: 'no delta for block index ' + String(chunk.index) });
        }
      }
    } else if (type === 'tool/call') {
      const name = nameFor(index, data.turn, data.step);
      if ((typeof data.name !== 'string' || data.name.length === 0) && name !== undefined) {
        data.name = name;
        stats.toolCallNameFilled += 1;
        dirty = true;
      }
    }
    if (dirty) changed.add(line);
  }

  return { changedLines: [...changed].sort((a, b) => a - b), stats, skipped };
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