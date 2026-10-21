// 会话按事件截断（轮次/步骤级）：保留 seq <= keepSeq 的事件，必要时补一条 turn/end 收尾。
//
// 【为什么需要】排查「某一段内容导致上游拒绝请求」时，要反复把会话截到不同位置再试。
// 手写脚本每次都要重算边界、补收尾、校验 seq，容易出错（也容易把日志写成 DSH 认不出的样子）。
// 这里把「备份 → 截断 → 补收尾 → 校验 → 原子写回」收成一条命令。
//
// 【安全】默认只预览（dry-run）；--yes 才写盘，且写前一定整目录备份到 <DSH_HOME>/../session-backups。

import { readFileSync, writeFileSync, renameSync, mkdirSync, cpSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { decodeFull, textToZstd } from './zstd.js';

/**
 * 截断一个会话日志。
 * @param {object} o
 * @param {string} o.file 会话日志绝对路径（session*.jsonl.zstd）
 * @param {number} o.keepSeq 保留到哪个 seq（含）
 * @param {boolean} [o.apply] true 才写盘（默认预览）
 * @param {string} [o.backupRoot] 备份根目录（默认 <DSH_HOME>/../session-backups；由调用方按 home 计算）
 * @param {string} [o.provider] 可选：把 descriptor / model-selection-policy / 追加 selection 统一改成该 provider
 * @param {string} [o.model] 可选：同上，模型 id（与 provider 成对）
 * @returns {{ok:true, total:number, kept:number, dropped:number, lastSeq:number, synthesized:boolean, backup?:string} | {ok:false, error:string}}
 */
export function truncateSession({ file, keepSeq, apply = false, backupRoot = null, provider = '', model = '' }) {
  let text;
  try {
    text = decodeFull(readFileSync(file));
  } catch (error) {
    return { ok: false, error: `读取/解码失败: ${String(error?.message ?? error)}` };
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { ok: false, error: '空日志' };
  let head;
  try {
    head = JSON.parse(lines[0]);
  } catch (error) {
    return { ok: false, error: `首行不是合法 header: ${String(error?.message ?? error)}` };
  }
  if (head?.type !== 'session') return { ok: false, error: '首行不是 session header（首帧契约不满足）' };

  // 保留 seq <= keepSeq，但**必须吸附到「无未闭合 step」的边界**：
  // DSH 会校验 turn/end 必须对应一个已闭合 step 的 open turn（实测报错
  // `turn/end does not match the open turn with no open step`），硬塞收尾会被判损坏。
  const parsed = [];
  for (let i = 1; i < lines.length; i += 1) {
    let e; try { e = JSON.parse(lines[i]); } catch { return { ok: false, error: `第 ${i + 1} 行不是合法 JSON` }; }
    parsed.push({ line: lines[i], e });
  }
  let openTurn = null;   // 当前未闭合的 turn
  let openStep = null;   // 当前未闭合的 step
  let cutIndex = -1;     // 最后一个「无未闭合 step」的位置（可安全收尾）
  for (let i = 0; i < parsed.length; i += 1) {
    const e = parsed[i].e;
    // 事件按 seq 递增落盘：遇到第一条超过 keepSeq 的事件就停，后面全部丢弃。
    // 注意不能只 continue 跳过——没有 seq 的事件会被漏进来，末尾混出大 seq ⇒ DSH 判 seq 缺口。
    if (typeof e.seq === 'number' ? e.seq > keepSeq : cutIndex >= 0) break;
    if (e.type === 'turn/start') { openTurn = e.data?.turn ?? null; openStep = null; }
    else if (e.type === 'step/start') { openStep = e.data?.step ?? null; }
    else if (e.type === 'step/end') { openStep = null; cutIndex = i; }
    else if (e.type === 'turn/end') { openTurn = null; openStep = null; cutIndex = i; }
  }
  if (cutIndex < 0) return { ok: false, error: `keepSeq=${keepSeq} 之前没有任何已闭合的 step/turn，无法安全截断` };
  const kept = [lines[0], ...parsed.slice(0, cutIndex + 1).map((x) => x.line)];
  const lastEvent = parsed[cutIndex].e;

  // 收尾：截在 step/end（turn 仍未闭合）就补一条 turn/end，turn 号用真实的 open turn
  let synthesized = false;
  if (lastEvent.type === 'step/end') {
    kept.push(JSON.stringify({
      type: 'turn/end',
      seq: (typeof lastEvent.seq === 'number' ? lastEvent.seq : 0) + 1,
      time: Date.now(),
      data: { turn: lastEvent.data?.turn ?? openTurn ?? 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    }));
    synthesized = true;
  }

  // 校验：seq 必须从 0 连续（DSH 把 seq 缺口当损坏）
  let prev = -1, gaps = 0;
  for (let i = 1; i < kept.length; i += 1) {
    const e = JSON.parse(kept[i]);
    if (typeof e.seq !== 'number') continue;
    if (prev >= 0 && e.seq !== prev + 1) gaps += 1;
    prev = e.seq;
  }
  if (gaps > 0) return { ok: false, error: `截断后 seq 不连续（${gaps} 处缺口），请换一个落在边界上的 --seq` };
  // 二次校验：不得存在 seq > keepSeq 的行。
  // 豁免两类尾部追加：合成的 turn/end（收尾）与 provider 注入的 model/selection。
  const tailSkip = (synthesized ? 1 : 0) + (provider && model ? 1 : 0);
  for (let i = 1; i < kept.length - tailSkip; i += 1) {
    const e = JSON.parse(kept[i]);
    if (typeof e.seq === 'number' && e.seq > keepSeq) {
      return { ok: false, error: `截断后仍残留 seq=${e.seq} > keepSeq=${keepSeq} 的事件（${e.type}），拒绝写盘` };
    }
  }

  // 可选：把「模型路由」改成当前实例可用的 provider（样本里常残留旧 provider，如 wb → 无 adapter）
  if (provider && model) {
    let maxSeq = prev;
    for (let i = 1; i < kept.length; i += 1) {
      let e; try { e = JSON.parse(kept[i]); } catch { continue; }
      if (e.type === 'subagent/descriptor') { e.data.agentProvider = provider; e.data.agentModel = model; kept[i] = JSON.stringify(e); }
      if (e.type === 'subagent/model-selection-policy') { e.data.allowedModels = [{ provider, model }]; kept[i] = JSON.stringify(e); }
      if (typeof e.seq === 'number') maxSeq = Math.max(maxSeq, e.seq);
    }
    kept.push(JSON.stringify({ type: 'model/selection', seq: maxSeq + 1, time: Date.now(), data: { provider, model } }));
    prev = maxSeq + 1;
  }
  const out = kept.join('\n') + '\n';
  const result = {
    ok: true,
    total: lines.length - 1,
    kept: kept.length - 1,
    dropped: lines.length - kept.length,
    lastSeq: prev,
    synthesized,
  };
  if (!apply) return result;

  // 备份整个会话目录（可回滚）
  const dir = dirname(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sid = dir.split('/').pop();
  const root = backupRoot ?? join(dirname(dirname(dirname(dir))), 'session-backups');
  const backupDir = join(root, `${sid}.before-truncate-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  cpSync(dir, backupDir, { recursive: true });
  result.backup = backupDir;

  // 原子写回（保留权限 600）
  const tmp = join(dir, '.session.truncate.tmp');
  writeFileSync(tmp, textToZstd(out), { mode: 0o600 });
  renameSync(tmp, file);
  result.bytes = statSync(file).size;
  return result;
}
