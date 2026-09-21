#!/usr/bin/env node
/**
 * dsh-session-migrate —— DSH 会话跨版本迁移 CLI（零依赖）
 *
 * 为什么存在：DSH 会话格式随 harness 版本演进（0.1.2 写 v0，0.1.5+ 为 v3）。
 * 官方不提供迁移命令，但持久化层在**打开会话**时会自动把低版本 generation
 * 沿迁移边串行还原（v0→v1→v2→v3）。本工具负责把源会话安全投放成目标实例
 * 中一个「可被自动迁移」的 generation，并把已知的格式陷阱挡在前面。
 *
 * 用法:
 *   node cli.mjs list    <DSH_HOME>                    列出会话与布局问题
 *   node cli.mjs check   <文件> [--home <DSH_HOME>]    单文件体检（首帧契约/header/迁移路径）
 *   node cli.mjs scan    <文件>                        内容缺陷扫描（只读）
 *   node cli.mjs validate <文件> [--home <DSH_HOME>]   离线跑完整 v0→v1→v2→v3 迁移链（只读）
 *   node cli.mjs fix     <DSH_HOME>                    移出 sessions/ 下非法目录
 *   node cli.mjs import  <源文件|源目录> <DSH_HOME>    双路径导入（含 subagents）
 *   node cli.mjs import  <源> <DSH_HOME> --cwd <cwd>   指定目标 cwd
 *   node cli.mjs repair  <文件> [--home <DSH_HOME>]    备份 → 内容修复 → 迁移链校验 → 落盘
 *                       [--dry-run] [--yes] [--no-validate] [--no-fix-arguments]
 *
 * DSH_HOME 可用环境变量 DSH_HOME 提供；未指定时自动探测常见套件路径。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { isPlaintext, decodeFull, textToZstd } from './lib/engine/zstd.js';
import { checkArtifact, printList, fixLayout, renderVersionPlan } from './lib/engine/inspect.js';
import { importAuto } from './lib/engine/import.js';
import { scanLog, repairLogText, parseLog } from './lib/engine/repair.js';
import { validateMigrationChain } from './lib/engine/validate.js';

/** 退出码：0=成功/无需修复，1=错误，2=用法错误或迁移链校验失败，3=scan 发现阻塞缺陷。 */

/** 自动探测 DSH_HOME */
function detectHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const cands = [
    '/volume1/@appdata/DeepSeekHarness-NAS/0.1.6-alpha.1/.dsh',
    `${process.env.HOME || ''}/.dsh`,
  ];
  for (const cand of cands) if (cand && existsSync(cand)) return cand;
  return null;
}

function usage() {
  console.log(`dsh-session-migrate —— DSH 会话跨版本迁移 CLI

用法:
  node cli.mjs list    <DSH_HOME>                    列出会话与布局问题
  node cli.mjs check   <文件> [--home <DSH_HOME>]    单文件体检（首帧契约/header/迁移路径）
  node cli.mjs scan    <文件>                        内容缺陷扫描（只读，不改文件）
  node cli.mjs validate <文件> [--home <DSH_HOME>]   离线跑完整 v0→v1→v2→v3 迁移链（只读）
  node cli.mjs fix     <DSH_HOME>                    移出 sessions/ 下非法目录
  node cli.mjs import  <源文件|源目录> <DSH_HOME>    双路径导入
                     可选 --cwd <目标cwd> 覆盖自动映射
  node cli.mjs repair  <文件> [--home <DSH_HOME>]    备份 → 内容修复 → 迁移链校验 → 落盘
                     可选 --dry-run（只预览） --yes（跳过确认）
                         --no-validate（修复后不校验） --no-fix-arguments（不对齐 arguments）

说明:
  · import 支持会话导出包解出的目录（自动带上 subagents/*）
  · 明文 session.jsonl 会在导入时转成 zstd（目标 compression=zstd 时必需）
  · scan/validate 只读；repair 会先备份到 <文件同目录>.repair-bak-<时间戳>/
  · 本工具不启动/不停止 DSH；迁移应在 DSH 停止时执行
  · 导入后需启动 DSH 并打开会话，由持久化层完成 v0→v1→v2→v3`);
}

function pickArg(rest, flag) {
  for (let i = 0; i < rest.length; i += 1) if (rest[i] === flag) return rest[i + 1];
  return null;
}

function hasFlag(rest, flag) {
  return rest.includes(flag);
}

/** 时间戳串（备份命名用） */
function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 读取文件全文（zstd 自动全量解码，明文原样） */
function readText(path) {
  if (isPlaintext(path)) return { text: readFileSync(path, 'utf8'), plaintext: true };
  return { text: decodeFull(readFileSync(path)), plaintext: false };
}

/** 内容缺陷扫描结果渲染成可读文本 */
function renderScan(scan, filePath) {
  const lines = [
    `文件     : ${filePath}`,
    `行数     : ${scan.rows}`,
    `阻塞缺陷 : ${scan.blocking}`,
  ];
  for (const [key, value] of Object.entries(scan.counts)) {
    if (value > 0) lines.push(`  · ${key.padEnd(30)}: ${value}`);
  }
  lines.push(`工具链   : advertised=${scan.toolChains.advertised} calls=${scan.toolChains.calls} results=${scan.toolChains.results}`);
  if (scan.replacementCharacters > 0) lines.push(`替换字符 : ${scan.replacementCharacters}（U+FFFD，可能被早期工具写坏）`);
  return lines.join('\n');
}

/** 命令失败统一出口（印错误行 + 退出码 1） */
function cliFail(err) {
  console.error(`  ✗ ${err?.message ?? err}`);
  return 1;
}

/** check：单文件体检（首帧契约/header/迁移路径） */
function cmdCheck(rest) {
  const file = rest[0];
  const homeOpt = pickArg(rest, '--home');
  if (!file) { console.error('check 需要 <文件>'); return 2; }
  try {
    const r = checkArtifact(file, { home: homeOpt });
    console.log(`  ${r.plaintext ? '明文 jsonl（导入时自动转码）' : 'zstd'}`);
    console.log('  ✓ 首帧契约满足（恰好一行 header）');
    if (!r.plaintext) console.log(`    frame 数 : ${r.frameCount}`);
    console.log(`    行数     : ${r.lines ?? r.frameCount}`);
    console.log(`    id       : ${r.id}`);
    console.log(`    cwd      : ${r.cwd || '(无)'}`);
    console.log(`    createdAt: ${r.createdAt}`);
    console.log(renderVersionPlan(r));
    return 0;
  } catch (e) {
    return cliFail(e);
  }
}

/** scan：内容缺陷扫描（只读） */
function cmdScan(rest) {
  const file = rest[0];
  if (!file) { console.error('scan 需要 <文件>'); return 2; }
  try {
    const { text } = readText(file);
    const { rows } = parseLog(text);
    const scan = scanLog(rows, { text });
    console.log(renderScan(scan, file));
    return scan.blocking > 0 ? 3 : 0;
  } catch (e) {
    return cliFail(e);
  }
}

/** validate：离线跑完整 v0→v1→v2→v3 迁移链（只读） */
async function cmdValidate(rest) {
  const file = rest[0];
  const homeOpt = pickArg(rest, '--home');
  if (!file) { console.error('validate 需要 <文件>'); return 2; }
  try {
    const { text } = readText(file);
    const result = await validateMigrationChain(text, { dshHome: homeOpt });
    if (result.ok) {
      console.log(`迁移链校验通过 ✅  v3 事件数=${result.events}`);
      console.log(`（使用 ${result.catalogPath}）`);
      return 0;
    }
    if (result.skipped) { console.log(`跳过校验：${result.skipped}`); return 0; }
    console.log('迁移链校验失败 ❌');
    console.log(`${result.error}`);
    console.log(`（使用 ${result.catalogPath}）`);
    return 2;
  } catch (e) {
    return cliFail(e);
  }
}

/** list：列出会话与布局问题 */
function cmdList(rest) {
  const home = rest[0] || detectHome();
  if (!home) { console.error('list 需要 <DSH_HOME>（或设置环境变量 DSH_HOME）'); return 2; }
  printList(home);
  return 0;
}

/** fix：移出 sessions/ 下非法裸目录 */
function cmdFix(rest) {
  const home = rest[0] || detectHome();
  if (!home) { console.error('fix 需要 <DSH_HOME>'); return 2; }
  fixLayout(home);
  return 0;
}

/** repair：备份 → 内容修复 → 迁移链校验 → 落盘 */
/** 打印修复计划（缺陷前/后计数、修复统计、无法自动修复项）。 */
function printRepairPlan(repaired) {
  console.log(`待修复行数: ${repaired.changedLines.length}`);
  console.log(`  缺陷前: ${JSON.stringify(repaired.before.counts)}`);
  console.log(`  缺陷后: ${JSON.stringify(repaired.after.counts)}`);
  console.log(`  修复统计: ${JSON.stringify(repaired.stats)}`);
  if (repaired.skipped.length) {
    console.log(`  无法自动修复 ${repaired.skipped.length} 处:`);
    for (const s of repaired.skipped) console.log(`    L${s.line} ${s.kind}: ${s.reason}`);
  }
}

/** 打印迁移链校验结果的单行摘要。 */
function renderChainResult(validation) {
  if (validation === null) return '  迁移链: 未校验';
  if (validation.ok) return `  迁移链: 通过 ✅ (${validation.events} 个 v3 事件)`;
  if (validation.skipped) return `  迁移链: 跳过（${validation.skipped}）`;
  return `  迁移链: 失败 ❌ ${validation.error}`;
}

/** 修复确认后落盘：备份原文件 → textToZstd 原子写（temp + rename）。 */
function writeRepair(file, repaired, plaintext, originalBytes) {
  const backupDir = join(dirname(file), `${basename(file)}.repair-bak-${stamp()}`);
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, basename(file));
  copyFileSync(file, backupPath);
  console.log(`  已备份 → ${backupPath}`);
  const encoded = textToZstd(repaired.text);
  const temp = file + '.tmp-' + process.pid;
  writeFileSync(temp, encoded);
  renameSync(temp, file);
  console.log(`  已落盘 → ${file}（${plaintext ? '明文' : 'zstd'} ${(originalBytes / 1024).toFixed(1)}KB → ${(repaired.text.length / 1024).toFixed(1)}KB）`);
}

/** dry-run 报告：印出预校验结论并给退出码。 */
function reportDryRun(validation) {
  console.log('');
  console.log('[dry-run] 未写入任何文件。预校验：' +
    (validation === null ? '未执行' : validation.ok ? '通过 ✅' : validation.skipped ? `跳过（${validation.skipped}）` : `仍失败 ❌ ${validation.error}`));
  return (validation === null || validation.ok) ? 0 : 2;
}

/** 校验未通过（catalog 可用）→ 拒绝写入；否则返回 null 放行。 */
function rejectIfValidationFails(validation) {
  if (validation !== null && validation.ok === false && validation.skipped === undefined) {
    console.error('拒绝写入：修复后的日志仍无法通过迁移链校验。');
    console.error(validation.error);
    return 2;
  }
  return null;
}

/** repair：备份 → 内容修复 → 迁移链校验 → 落盘 */
async function cmdRepair(rest) {
  const file = rest[0];
  const homeOpt = pickArg(rest, '--home');
  const dryRun = hasFlag(rest, '--dry-run');
  const yes = hasFlag(rest, '--yes');
  const doValidate = !hasFlag(rest, '--no-validate');
  const fixArguments = !hasFlag(rest, '--no-fix-arguments');
  if (!file) { console.error('repair 需要 <文件>'); return 2; }
  try {
    const { text, plaintext } = readText(file);
    const before = scanLog(parseLog(text).rows, { text });
    const repaired = repairLogText(text, { fixArguments });

    if (repaired.changedLines.length === 0) {
      console.log('无需修复：未发现本工具可处理的缺陷。');
      console.log(renderScan(before, file));
      return before.blocking > 0 ? 3 : 0;
    }

    printRepairPlan(repaired);

    let validation = null;
    if (doValidate) {
      validation = await validateMigrationChain(repaired.text, { dshHome: homeOpt })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    }

    if (dryRun) return reportDryRun(validation);
    if (!yes) {
      console.error('需要确认。请加 --yes 执行，或加 --dry-run 只预览。');
      return 1;
    }
    const rejected = rejectIfValidationFails(validation);
    if (rejected !== null) return rejected;

    writeRepair(file, repaired, plaintext, text.length);
    console.log(renderChainResult(validation));
    return (validation === null || validation.ok) ? 0 : 2;
  } catch (e) {
    return cliFail(e);
  }
}

/** import：双路径导入（含 subagents；可选 --cwd 覆盖目标 cwd） */
function cmdImport(rest) {
  const src = rest[0];
  let home = rest[1];
  let cwd = null;
  for (let i = 2; i < rest.length; i += 1) {
    if (rest[i] === '--cwd') cwd = rest[++i];
    else if (!home) home = rest[i];
  }
  home = home || detectHome();
  if (!src || !home) { console.error('import 需要 <源> <DSH_HOME>'); return 2; }
  try {
    importAuto({ src, home, targetCwd: cwd });
    return 0;
  } catch (e) {
    return cliFail(e);
  }
}

/** 命令 → 处理器 分发表 */
const HANDLERS = {
  check: cmdCheck,
  scan: cmdScan,
  validate: cmdValidate,
  list: cmdList,
  fix: cmdFix,
  repair: cmdRepair,
  import: cmdImport,
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') { usage(); return 0; }
  const handler = HANDLERS[cmd];
  if (!handler) { console.error(`未知命令: ${cmd}`); usage(); return 2; }
  return handler(rest);
}

process.exit(await main());