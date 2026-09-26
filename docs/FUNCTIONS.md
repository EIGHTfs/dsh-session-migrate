# 函数列表

<!-- dshgp-functions:start -->
## 函数列表

### lib/client.js（800 行 · 31 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `apiUrl` | 73-75 | 3 | `function apiUrl(path) {` |
| `apiFetch` | 85-107 | 23 | `async function apiFetch(path, opts = {}) {` |
| `activeLocaleId` | 123-130 | 8 | `function activeLocaleId() {` |
| `tr` | 139-143 | 5 | `function tr(key, vars) {` |
| `lookup` | 152-157 | 6 | `function lookup(key, lang) {` |
| `fill` | 166-170 | 5 | `function fill(text, vars) {` |
| `subscribeDict` | 178-181 | 4 | `function subscribeDict(listener) {` |
| `loadDict` | 184-197 | 14 | `function loadDict() {` |
| `ensureCss` | 235-243 | 9 | `function ensureCss() {` |
| `fmtSize` | 253-262 | 10 | `function fmtSize(n) {` |
| `fmtVersion` | 270-272 | 3 | `function fmtVersion(v) {` |
| `fmtConverted` | 284-292 | 9 | `function fmtConverted(session, targetVersion) {` |
| `usePageState` | 301-348 | 48 | `function usePageState() {` |
| `MigratePage` | 355-393 | 39 | `function MigratePage() {` |
| `statusRows` | 404-413 | 10 | `function statusRows(data) {` |
| `renderStatus` | 423-430 | 8 | `function renderStatus(data, loading, load) {` |
| `renderStatusHeader` | 439-446 | 8 | `function renderStatusHeader(loading, load) {` |
| `renderStatusGrid` | 454-463 | 10 | `function renderStatusGrid(rows) {` |
| `renderStatusBadges` | 471-485 | 15 | `function renderStatusBadges(data) {` |
| `uploadLegacyFiles` | 494-523 | 30 | `async function uploadLegacyFiles(picked, ctx) {` |
| `renderImport` | 531-565 | 35 | `function renderImport(ctx) {` |
| `onPick` | 544-548 | 5 | `const onPick = (ev) => {` |
| `renderList` | 573-616 | 44 | `function renderList(ctx) {` |
| `renderConvert` | 624-649 | 26 | `function renderConvert(ctx) {` |
| `convertSelected` | 659-677 | 19 | `async function convertSelected(selected, workspace, ctx) {` |
| `convertNotice` | 685-699 | 15 | `function convertNotice(results) {` |
| `createModule` | 709-740 | 32 | `function createModule(require) {` |
| `apply` | 725-733 | 9 | `function apply(ctx) {` |
| `registerDictionary` | 750-755 | 6 | `function registerDictionary(ctx) {` |
| `registerSettingsSection` | 766-776 | 11 | `function registerSettingsSection(ctx, React) {` |
| `injectSection` | 786-788 | 3 | `function injectSection(slots, section, React) {` |

### lib/engine/import.js（282 行 · 10 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `stamp` | 24-28 | 5 | `function stamp() {` |
| `pad` | 26-26 | 1 | `const pad = (n) => String(n).padStart(2, '0');` |
| `findSessionFile` | 36-42 | 7 | `function findSessionFile(dir) {` |
| `removeDuplicateCopies` | 57-71 | 15 | `function removeDuplicateCopies({ home, sessionId, targetDir, backupDir, log }) {` |
| `removeInProject` | 79-88 | 10 | `function removeInProject({ project, sessionId, targetDir, backupDir, log, idx }) {` |
| `moveDuplicate` | 100-108 | 9 | `function moveDuplicate(session, backupDir, sessionId, seq) {` |
| `resolveSource` | 114-134 | 21 | `export function resolveSource(src) {` |
| `installSession` | 147-208 | 62 | `export function installSession({ home, srcFile, sid, targetCwd, into, quiet = false }) {` |
| `importAuto` | 217-265 | 49 | `export function importAuto({ src, home, targetCwd }) {` |
| `installSubagent` | 273-281 | 9 | `function installSubagent({ home, srcFile, sid, targetCwd, mainDir }) {` |

### lib/engine/inspect.js（114 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `checkArtifact` | 16-44 | 29 | `export function checkArtifact(path, opts = {}) {` |
| `renderVersionPlan` | 47-67 | 21 | `export function renderVersionPlan(r) {` |
| `printList` | 70-94 | 25 | `export function printList(home) {` |
| `fixLayout` | 97-113 | 17 | `export function fixLayout(home) {` |

### lib/engine/layout.js（125 行 · 6 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `encodeCwd` | 25-43 | 19 | `export function encodeCwd(cwd) {` |
| `isLegalProjectDir` | 46-48 | 3 | `export function isLegalProjectDir(name) {` |
| `generationVersion` | 51-55 | 5 | `export function generationVersion(filename) {` |
| `listSessions` | 61-73 | 13 | `export function listSessions(home) {` |
| `listProjectSessions` | 76-91 | 16 | `function listProjectSessions(pdir) {` |
| `deriveTargetCwd` | 109-124 | 16 | `export function deriveTargetCwd(srcCwd, home) {` |

### lib/engine/repair.js（462 行 · 28 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `stepKey` | 34-36 | 3 | `function stepKey(turn, step) {` |
| `indexDelta` | 39-55 | 17 | `function indexDelta(index, data) {` |
| `indexMessage` | 58-67 | 10 | `function indexMessage(index, row, data, line) {` |
| `indexCall` | 70-74 | 5 | `function indexCall(index, data, line) {` |
| `indexResult` | 77-80 | 4 | `function indexResult(index, data) {` |
| `indexLog` | 83-102 | 20 | `function indexLog(rows) {` |
| `nameFor` | 105-107 | 3 | `function nameFor(index, turn, step) {` |
| `deltaFor` | 110-119 | 10 | `function deltaFor(index, turn, step, chunkIndex) {` |
| `parseLog` | 122-138 | 17 | `export function parseLog(text) {` |
| `serializeLog` | 141-143 | 3 | `export function serializeLog(lines) {` |
| `messageContent` | 146-149 | 4 | `export function messageContent(row) {` |
| `chunkShapeBroken` | 154-162 | 9 | `function chunkShapeBroken(row, data) {` |
| `scanChunks` | 165-172 | 8 | `function scanChunks(defects, row, data, line) {` |
| `scanMessage` | 175-187 | 13 | `function scanMessage(defects, row, data, line, seenAdvertised) {` |
| `scanBlockEnd` | 190-196 | 7 | `function scanBlockEnd(defects, data, line) {` |
| `scanCall` | 199-218 | 20 | `function scanCall(defects, index, data, line) {` |
| `scanLog` | 227-275 | 49 | `export function scanLog(rows, options = {}) {` |
| `repairChunks` | 280-304 | 25 | `function repairChunks(index, stats, skipped, data, line) {` |
| `fillBlockName` | 307-312 | 6 | `function fillBlockName(block, name, stats) {` |
| `fillBlockId` | 315-321 | 7 | `function fillBlockId(block, index, stats, skipped, data, position, line) {` |
| `repairMessage` | 324-337 | 14 | `function repairMessage(rows, index, stats, skipped, row, data, line) {` |
| `fillBlockEndName` | 340-345 | 6 | `function fillBlockEndName(block, name, stats) {` |
| `fillBlockEndId` | 348-354 | 7 | `function fillBlockEndId(block, index, stats, skipped, data, line) {` |
| `repairBlockEnd` | 357-364 | 8 | `function repairBlockEnd(index, stats, skipped, data, line) {` |
| `repairCall` | 367-375 | 9 | `function repairCall(index, stats, data) {` |
| `planRepair` | 384-418 | 35 | `export function planRepair(rows, options = {}) {` |
| `alignArguments` | 424-436 | 13 | `function alignArguments(index, stats, changed) {` |
| `repairLogText` | 445-462 | 18 | `export function repairLogText(text, options = {}) {` |

### lib/engine/target.js（140 行 · 5 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `detectTarget` | 21-42 | 22 | `export function detectTarget(installRoot) {` |
| `targetCandidates` | 45-50 | 6 | `function targetCandidates(installRoot) {` |
| `readGenerator` | 53-81 | 29 | `function readGenerator(installRoot, out) {` |
| `planMigration` | 89-121 | 33 | `export function planMigration(fromVersion, target) {` |
| `detectInstallRoot` | 124-139 | 16 | `export function detectInstallRoot(dshHome) {` |

### lib/engine/validate.js（114 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `catalogCandidates` | 40-54 | 15 | `export function catalogCandidates(dshHome, installRoot) {` |
| `loadCatalog` | 63-75 | 13 | `export async function loadCatalog(dshHome, installRoot) {` |
| `validateMigrationChain` | 84-114 | 31 | `export async function validateMigrationChain(text, options = {}) {` |

### lib/engine/zip.js（183 行 · 5 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `unzipEntries` | 76-93 | 18 | `export function unzipEntries(buf) {` |
| `findCentralDirectory` | 102-129 | 28 | `function findCentralDirectory(buf) {` |
| `inflate` | 140-153 | 14 | `function inflate(rawName, method, payload) {` |
| `safeBaseName` | 164-169 | 6 | `export function safeBaseName(rawName) {` |
| `pickSessionEntry` | 177-182 | 6 | `export function pickSessionEntry(entries) {` |

### lib/engine/zstd.js（184 行 · 10 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `countFrames` | 22-31 | 10 | `export function countFrames(buf) {` |
| `secondFrameOffset` | 34-36 | 3 | `export function secondFrameOffset(buf) {` |
| `decodeFull` | 49-65 | 17 | `export function decodeFull(buf) {` |
| `frameLine` | 68-70 | 3 | `export function frameLine(text) {` |
| `readHeader` | 77-93 | 17 | `export function readHeader(path) {` |
| `rewriteHeader` | 102-122 | 21 | `export function rewriteHeader(src, dst, patch) {` |
| `plaintextToZstd` | 129-145 | 17 | `export function plaintextToZstd(src, dst) {` |
| `textToZstd` | 153-163 | 11 | `export function textToZstd(text) {` |
| `readHeaderAny` | 166-176 | 11 | `export function readHeaderAny(path) {` |
| `isPlaintext` | 179-183 | 5 | `export function isPlaintext(path) {` |

### lib/follow.js（700 行 · 33 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `findToken` | 54-66 | 13 | `export function findToken(dshHome) {` |
| `collectLogCandidates` | 75-89 | 15 | `function collectLogCandidates(root) {` |
| `parseTokenFromLog` | 100-109 | 10 | `function parseTokenFromLog(logPath) {` |
| `httpCall` | 117-133 | 17 | `function httpCall(opts) {` |
| `exchangeCookie` | 142-153 | 12 | `export async function exchangeCookie(port, token) {` |
| `parseWsUrl` | 161-165 | 5 | `function parseWsUrl(url) {` |
| `readFrameHeader` | 213-235 | 23 | `function readFrameHeader(st) {` |
| `handleFrame` | 246-270 | 25 | `function handleFrame(st, io, header, payload) {` |
| `finishFragment` | 280-287 | 8 | `function finishFragment(st, io, payload, fin) {` |
| `deliverText` | 295-297 | 3 | `function deliverText(io, payload) {` |
| `drainFrames` | 308-316 | 9 | `function drainFrames(st, io) {` |
| `buildHandshake` | 324-335 | 12 | `function buildHandshake(o) {` |
| `verifyHandshake` | 344-352 | 9 | `function verifyHandshake(head, expect) {` |
| `openWebSocket` | 364-377 | 14 | `export function openWebSocket(opts) {` |
| `bindSocketLifecycle` | 385-414 | 30 | `function bindSocketLifecycle(e) {` |
| `close` | 395-399 | 5 | `const close = () => {` |
| `fail` | 402-407 | 6 | `const fail = (message) => {` |
| `attachSocketEvents` | 422-453 | 32 | `function attachSocketEvents(b) {` |
| `peerClosed` | 426-429 | 4 | `const peerClosed = () => {` |
| `closeQuietly` | 460-462 | 3 | `function closeQuietly(ws) {` |
| `endQuietly` | 469-471 | 3 | `function endQuietly(socket) {` |
| `destroyQuietly` | 478-480 | 3 | `function destroyQuietly(socket) {` |
| `handleSocketData` | 489-497 | 9 | `function handleSocketData(st, expect, h) {` |
| `consumeHandshake` | 507-513 | 7 | `function consumeHandshake(st, expect) {` |
| `encodeFrame` | 522-543 | 22 | `function encodeFrame(opcode, payload) {` |
| `followSession` | 555-565 | 11 | `export async function followSession(opts) {` |
| `waitForSnapshot` | 573-601 | 29 | `function waitForSnapshot({ port, cookie, sessionId, waitMs }) {` |
| `done` | 578-584 | 7 | `const done = (v) => {` |
| `handleFollowMessage` | 609-619 | 11 | `function handleFollowMessage(text, done) {` |
| `handleItemMessage` | 627-637 | 11 | `function handleItemMessage(msg, done) {` |
| `buildOpenFrame` | 645-659 | 15 | `function buildOpenFrame(sessionId) {` |
| `triggerMigration` | 667-689 | 23 | `export async function triggerMigration(opts) {` |
| `fileExists` | 697-699 | 3 | `async function fileExists(path) {` |

### lib/index.js（489 行 · 11 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `resolvePaths` | 74-95 | 22 | `export function resolvePaths(config = {}) {` |
| `loadDefineTool` | 107-115 | 9 | `async function loadDefineTool(log) {` |
| `textRender` | 124-126 | 3 | `function textRender(_args, value) {` |
| `normalizeParameters` | 134-145 | 12 | `function normalizeParameters(parameters = {}) {` |
| `pickHome` | 154-157 | 4 | `function pickHome(config, home) {` |
| `formatCheckResult` | 169-184 | 16 | `function formatCheckResult(path, r) {` |
| `formatScanResult` | 192-203 | 12 | `function formatScanResult(scan) {` |
| `formatSessionList` | 211-228 | 18 | `function formatSessionList(target) {` |
| `listTools` | 236-379 | 144 | `export function listTools(config = {}) {` |
| `apply` | 405-467 | 63 | `export async function apply(ctx, config = {}) {` |
| `registerTools` | 474-486 | 13 | `function registerTools({ log, registry, tools, defineTool }) {` |

### lib/legacy.js（410 行 · 20 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `versionFromFileName` | 41-45 | 5 | `export function versionFromFileName(fileName) {` |
| `legacyDir` | 59-61 | 3 | `export function legacyDir(dshHome) {` |
| `legacyIndexPath` | 69-71 | 3 | `export function legacyIndexPath(dshHome) {` |
| `ensureLegacyDir` | 79-83 | 5 | `export function ensureLegacyDir(dshHome) {` |
| `loadIndex` | 91-100 | 10 | `export function loadIndex(dshHome) {` |
| `saveIndex` | 109-116 | 8 | `export function saveIndex(dshHome, index) {` |
| `scanLegacy` | 127-147 | 21 | `export function scanLegacy(dshHome) {` |
| `isScanCandidate` | 155-162 | 8 | `function isScanCandidate(en) {` |
| `inspectDirEntry` | 171-174 | 4 | `function inspectDirEntry(dirPath, dirName) {` |
| `findSessionFileInDir` | 182-190 | 9 | `function findSessionFileInDir(dir) {` |
| `inspectLegacyFile` | 201-226 | 26 | `export function inspectLegacyFile(file, dirName) {` |
| `headStr` | 235-237 | 3 | `function headStr(head, key) {` |
| `headNum` | 246-248 | 3 | `function headNum(head, key) {` |
| `brokenEntry` | 259-269 | 11 | `function brokenEntry(file, name, dirName, error) {` |
| `readFileHeader` | 280-287 | 8 | `function readFileHeader(file) {` |
| `safeSize` | 295-297 | 3 | `function safeSize(file) {` |
| `buildList` | 310-357 | 48 | `export function buildList(dshHome) {` |
| `markConverted` | 370-381 | 12 | `export function markConverted(dshHome, id, version) {` |
| `isSessionFileName` | 389-391 | 3 | `export function isSessionFileName(name) {` |
| `uniqueName` | 400-409 | 10 | `export function uniqueName(dir, base) {` |

### lib/routes.js（829 行 · 34 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `sendJson` | 60-64 | 5 | `function sendJson(res, code, body) {` |
| `readBody` | 75-87 | 13 | `async function readBody(req) {` |
| `readJsonBody` | 95-103 | 9 | `async function readJsonBody(req) {` |
| `parseMultipart` | 112-127 | 16 | `export function parseMultipart(buf, contentType) {` |
| `extractBoundary` | 135-138 | 4 | `function extractBoundary(contentType) {` |
| `parsePart` | 146-159 | 14 | `function parsePart(part) {` |
| `loadI18n` | 166-176 | 11 | `export function loadI18n() {` |
| `targetInfo` | 184-196 | 13 | `export function targetInfo(deps) {` |
| `summarize` | 206-225 | 20 | `export function summarize(sessions, targetVersion, migrations = []) {` |
| `buildState` | 233-256 | 24 | `export function buildState(deps) {` |
| `doImport` | 276-303 | 28 | `export function doImport(deps, files) {` |
| `importPlainFile` | 317-324 | 8 | `function importPlainFile(dir, raw, data, used) {` |
| `importZip` | 339-359 | 21 | `function importZip(dir, raw, data, used) {` |
| `zipDirName` | 367-373 | 7 | `function zipDirName(session) {` |
| `firstJsonObject` | 383-398 | 16 | `function firstJsonObject(data) {` |
| `firstFrameEnd` | 408-412 | 5 | `function firstFrameEnd(data) {` |
| `backUpIfNotEmpty` | 420-431 | 12 | `function backUpIfNotEmpty(target) {` |
| `backUpFileIfExists` | 439-445 | 7 | `function backUpFileIfExists(target) {` |
| `uniqueName` | 455-458 | 4 | `function uniqueName(name, used, exists) {` |
| `convertOne` | 470-516 | 47 | `async function convertOne(opts) {` |
| `doConvert` | 525-570 | 46 | `export async function doConvert(deps, payload) {` |
| `doFixLayout` | 578-583 | 6 | `export function doFixLayout(deps) {` |
| `doCheck` | 592-602 | 11 | `export function doCheck(deps, file) {` |
| `registerWebRoutes` | 610-642 | 33 | `export function registerWebRoutes(webServer, deps) {` |
| `handleList` | 651-660 | 10 | `async function handleList(req, res, deps) {` |
| `handleCheck` | 669-672 | 4 | `async function handleCheck(req, res, deps) {` |
| `handleScan` | 681-692 | 12 | `async function handleScan(req, res, deps) {` |
| `readSessionText` | 695-698 | 4 | `function readSessionText(file) {` |
| `handleRepair` | 709-746 | 38 | `async function handleRepair(req, res, deps) {` |
| `runChainValidate` | 749-755 | 7 | `async function runChainValidate(text, deps) {` |
| `buildRepairResponse` | 758-769 | 12 | `function buildRepairResponse(file, dryRun, repaired, validation) {` |
| `writeRepairedFile` | 772-781 | 10 | `function writeRepairedFile(file, repaired) {` |
| `handleImport` | 790-815 | 26 | `async function handleImport(req, res, deps) {` |
| `handleConvert` | 824-828 | 5 | `async function handleConvert(req, res, deps) {` |

### lib/workspace.js（199 行 · 9 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `decodeCwdDirName` | 35-39 | 5 | `export function decodeCwdDirName(dirName) {` |
| `decodeBody` | 47-61 | 15 | `function decodeBody(body) {` |
| `decodeEscape` | 70-74 | 5 | `function decodeEscape(body, i) {` |
| `instanceRoot` | 82-84 | 3 | `export function instanceRoot(dshHome) {` |
| `workspaceRoot` | 92-94 | 3 | `export function workspaceRoot(dshHome) {` |
| `workspacesFromSessions` | 106-121 | 16 | `export function workspacesFromSessions(dshHome) {` |
| `workspacesFromDisk` | 129-140 | 12 | `export function workspacesFromDisk(dshHome) {` |
| `dedupe` | 148-150 | 3 | `function dedupe(list) {` |
| `detectWorkspaces` | 160-198 | 39 | `export function detectWorkspaces(dshHome) {` |

### test/test-client.mjs（115 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeFakeReact` | 18-27 | 10 | `function makeFakeReact() {` |
| `loadClient` | 34-76 | 43 | `function loadClient() {` |
| `check` | 85-88 | 4 | `function check(label, ok) {` |

### test/test-repair.mjs（107 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `defectiveLog` | 12-33 | 22 | `function defectiveLog() {` |
| `check` | 36-39 | 4 | `function check(label, ok, extra) {` |

<!-- dshgp-functions:end -->
