#!/usr/bin/env node
/**
 * 一键把雅思口语教练 MCP 接进本机所有 AI 工具（纯 Node >=20，零外部依赖，幂等）。
 *
 * 支持：DeepSeek Harness (dsh) / OpenAI Codex CLI / Claude Code + Claude Desktop / Cursor / 豆包桌面端（手动 2 步）
 *
 * 用法：
 *   node scripts/connect-agent.mjs                     # 本机 STDIO 模式
 *   node scripts/connect-agent.mjs --dry-run           # 只预览，不动任何文件
 *   node scripts/connect-agent.mjs --url https://xxx/mcp --token <token>   # 远程 Streamable HTTP
 *   node scripts/connect-agent.mjs --home /tmp/fakehome  # 指向假 home（测试用）
 *
 * 约定：
 *   - 修改任何已存在的配置文件前，先备份为 <file>.bak-YYYYMMDD-HHMMSS；
 *   - 已存在 mcp-ielts-coach / [mcp_servers.ielts-coach] 时跳过，不重复插入；
 *   - 不写 stdout JSON，这是给人看的脚本。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SRC = path.join(REPO_ROOT, 'skills', 'ielts-speaking-coach', 'SKILL.md');
const SKILL_NAME = 'ielts-speaking-coach';
const SERVER_KEY = 'ielts-coach';
const IS_WINDOWS = process.platform === 'win32';
const WRAPPER_BAT = path.join(REPO_ROOT, 'ielts-mcp.bat');
const WRAPPER_SH = path.join(REPO_ROOT, 'ielts-mcp.sh');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dryRun: false, url: '', token: '', home: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const take = () => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i] === undefined ? '' : argv[i];
    };
    if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--url') out.url = String(take()).trim();
    else if (flag === '--token') out.token = String(take()).trim();
    else if (flag === '--home') out.home = String(take()).trim();
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (raw.startsWith('--')) console.error('[warn] 未知参数，已忽略：' + raw);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(
    [
      '雅思口语教练 · 一键接入脚本',
      '',
      '用法：node scripts/connect-agent.mjs [选项]',
      '',
      '  --dry-run              只打印将要做的事，不修改任何文件',
      '  --url <https://…/mcp>  连接远程 Streamable HTTP 部署（默认本机 STDIO）',
      '  --token <token>        远程模式的 MCP Bearer Token（也可用环境变量 MCP_TOKEN）',
      '  --home <dir>           指定 home 目录（默认当前用户 home，测试用）',
      '  -h, --help             显示本帮助',
    ].join('\n'),
  );
  process.exit(0);
}

const DRY = opts.dryRun;
const HOME = path.resolve(opts.home || os.homedir());
const REMOTE_URL = opts.url;
const TOKEN = opts.token || (process.env.MCP_TOKEN || '').trim();
const DATA_DIR = path.join(HOME, '.ielts-coach');

// ---------------------------------------------------------------------------
// 输出与写入状态
// ---------------------------------------------------------------------------

const planned = []; // { file, action }
const notes = [];
const backups = [];
const found = [];

function say(line = '') {
  console.log(line);
}

function status(name, detail) {
  say('  ' + name.padEnd(34, ' ') + detail);
}

function note(message) {
  notes.push(message);
}

function readText(file) {
  try {
    // 容忍 Windows 编辑器写出的 UTF-8 BOM：JSON / YAML / TOML 解析前统一去掉。
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const base = file + '.bak-' + stamp();
  let target = base;
  let n = 1;
  while (fs.existsSync(target)) {
    target = base + '-' + String(n);
    n += 1;
  }
  fs.copyFileSync(file, target);
  backups.push(target);
}

/** 内容有变化才写；dry-run 只登记，不落盘。返回是否（将）写入。 */
function writeIfChanged(file, content, action) {
  const current = readText(file);
  if (current === content) {
    note('已是最新，无需修改：' + file);
    return false;
  }
  const verb = action || (current === null ? '新建' : '更新');
  planned.push({ file, action: verb });
  if (DRY) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

/** 安全合并 JSON：解析失败就跳过（绝不覆盖坏文件），其它键原样保留。 */
function mergeJsonFile(file, mutate) {
  const raw = readText(file);
  let data = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      data = JSON.parse(raw);
    } catch {
      note('跳过（现有文件不是合法 JSON，未改动）：' + file);
      return false;
    }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    note('跳过（现有 JSON 不是对象，未改动）：' + file);
    return false;
  }
  const before = JSON.stringify(data);
  if (mutate(data) === false) return false;
  if (JSON.stringify(data) === before) {
    note('已是最新，无需修改：' + file);
    return false;
  }
  return writeIfChanged(file, JSON.stringify(data, null, 2) + '\n');
}

function copySkillTo(skillsRoot) {
  if (!fs.existsSync(SKILL_SRC)) {
    note('未找到 skills/' + SKILL_NAME + '/SKILL.md，跳过 Skill 复制');
    return false;
  }
  const target = path.join(skillsRoot, SKILL_NAME, 'SKILL.md');
  const content = fs.readFileSync(SKILL_SRC, 'utf8');
  return writeIfChanged(target, content);
}

// ---------------------------------------------------------------------------
// 通用 server 描述（STDIO / 远程 HTTP）
// ---------------------------------------------------------------------------

/** Windows 上 MCP 客户端以 shell:false 启动进程，不能直接执行 .bat，必须 cmd /c。 */
function stdioCommand() {
  if (IS_WINDOWS) return { command: 'cmd', args: ['/c', WRAPPER_BAT] };
  return { command: WRAPPER_SH, args: [] };
}

function stdioDisplay() {
  if (IS_WINDOWS) return 'cmd /c "' + WRAPPER_BAT + '"';
  return WRAPPER_SH;
}

function jsonEntry() {
  if (REMOTE_URL) {
    const entry = { type: 'http', url: REMOTE_URL };
    if (TOKEN) entry.headers = { Authorization: 'Bearer ' + TOKEN };
    return entry;
  }
  const base = stdioCommand();
  return { ...base, env: { IELTS_COACH_DATA_DIR: DATA_DIR } };
}

/** 保证 POSIX 下 ielts-mcp.sh 可执行（不动内容，dry-run 不执行）。 */
function ensureWrapperExecutable() {
  if (IS_WINDOWS || DRY) return;
  try {
    if (fs.existsSync(WRAPPER_SH)) fs.chmodSync(WRAPPER_SH, 0o755);
  } catch {
    note('无法给 ielts-mcp.sh 加可执行权限，可手动执行：chmod +x ielts-mcp.sh');
  }
}

// ---------------------------------------------------------------------------
// DeepSeek Harness：~/.dsh/profiles/*/cordis.patch.yml
// ---------------------------------------------------------------------------

/** YAML 标量：优先单引号（反斜杠原样保留，Windows 路径不会被转义破坏）。 */
function yamlQuote(value) {
  const s = String(value);
  if (/[\r\n]/.test(s)) throw new Error('YAML 值里不能有换行：' + s);
  if (!s.includes("'")) return "'" + s + "'";
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function dshPatchBlock() {
  const lines = [
    '- insert:',
    '    - id: mcp-ielts-coach',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: ielts-coach',
  ];
  if (REMOTE_URL) {
    lines.push('        transport: streamable-http');
    lines.push('        url: ' + yamlQuote(REMOTE_URL));
    if (TOKEN) {
      lines.push('        headers:');
      lines.push('          Authorization: ' + yamlQuote('Bearer ' + TOKEN));
    }
  } else {
    const cmd = stdioCommand();
    lines.push('        transport: stdio');
    lines.push('        command: ' + yamlQuote(cmd.command));
    if (cmd.args.length > 0) {
      lines.push('        args:');
      for (const arg of cmd.args) lines.push('          - ' + yamlQuote(arg));
    } else {
      lines.push('        args: []');
    }
    lines.push('        env:');
    lines.push('          IELTS_COACH_DATA_DIR: ' + yamlQuote(DATA_DIR));
    lines.push('        cwd: ' + yamlQuote(REPO_ROOT));
  }
  lines.push('        failOnStartupError: true');
  return lines.join('\n') + '\n';
}

function connectDsh() {
  const dshDir = path.join(HOME, '.dsh');
  const profilesDir = path.join(dshDir, 'profiles');
  if (!fs.existsSync(profilesDir)) {
    status('DeepSeek Harness (dsh)', '未检测到 ' + profilesDir + '，跳过');
    return false;
  }
  let profiles = [];
  try {
    profiles = fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    profiles = [];
  }
  if (profiles.length === 0) {
    status('DeepSeek Harness (dsh)', 'profiles 为空，跳过');
    return false;
  }
  const targetProfiles = profiles.filter((name) => {
    const dir = path.join(profilesDir, name);
    return (
      fs.existsSync(path.join(dir, 'cordis.yml')) ||
      fs.existsSync(path.join(dir, 'cordis.patch.yml')) ||
      fs.existsSync(path.join(dir, 'package.json'))
    );
  });
  status('DeepSeek Harness (dsh)', '检测到 ' + String(targetProfiles.length) + ' 个 profile');
  const patchBlock = dshPatchBlock();
  for (const name of targetProfiles) {
    const file = path.join(profilesDir, name, 'cordis.patch.yml');
    const current = readText(file);
    if (current !== null && current.includes('mcp-ielts-coach')) {
      note('dsh 已存在 mcp-ielts-coach，跳过（如需换模式请手动删掉该块）：' + file);
      continue;
    }
    const header =
      current === null
        ? '# ielts-speaking-coach MCP patch（由 scripts/connect-agent.mjs 生成；可直接编辑或删除）\n' +
          '# 本文件是该 dsh profile 的顶层 loader patch 列表。\n'
        : '';
    // An empty file or a bare `[]` is the "no patches yet" state: appending a
    // block after `[]` would produce invalid YAML, so replace it with our list.
    const trimmedCurrent = (current || '').trim();
    const body =
      current === null || trimmedCurrent === '' || trimmedCurrent === '[]'
        ? ''
        : current.replace(/\s+$/, '') + '\n\n';
    const comment = '# ---- ielts-speaking-coach（scripts/connect-agent.mjs 自动添加；删除本块即可移除）----\n';
    writeIfChanged(file, header + body + comment + patchBlock);
  }
  if (targetProfiles.length > 0 && fs.existsSync(dshDir)) {
    copySkillTo(path.join(dshDir, 'skills'));
  }
  return targetProfiles.length > 0;
}

// ---------------------------------------------------------------------------
// OpenAI Codex CLI：~/.codex/config.toml
// ---------------------------------------------------------------------------

/** TOML 字符串：优先字面量单引号（反斜杠原样保留）。 */
function tomlStr(value) {
  const s = String(value);
  if (!s.includes("'") && !/[\r\n]/.test(s)) return "'" + s + "'";
  return (
    '"' +
    s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n') +
    '"'
  );
}

function codexSection() {
  const lines = [
    '# ---- ielts-speaking-coach（scripts/connect-agent.mjs 自动添加；删除本节即可移除）----',
    '[mcp_servers.' + SERVER_KEY + ']',
  ];
  if (REMOTE_URL) {
    lines.push('url = ' + tomlStr(REMOTE_URL));
    if (TOKEN) {
      lines.push('# 需要先把 token 放进环境变量（Windows: setx MCP_TOKEN ...，macOS/Linux: export MCP_TOKEN=...）');
      lines.push('bearer_token_env_var = ' + tomlStr('MCP_TOKEN'));
    }
  } else {
    const cmd = stdioCommand();
    lines.push('command = ' + tomlStr(cmd.command));
    lines.push('args = [' + cmd.args.map(tomlStr).join(', ') + ']');
    lines.push('env = { IELTS_COACH_DATA_DIR = ' + tomlStr(DATA_DIR) + ' }');
  }
  return lines.join('\n') + '\n';
}

function connectCodex() {
  const dir = path.join(HOME, '.codex');
  if (!fs.existsSync(dir)) {
    status('OpenAI Codex CLI (codex)', '未检测到 ' + dir + '，跳过');
    return false;
  }
  status('OpenAI Codex CLI (codex)', '检测到 ' + dir);
  const file = path.join(dir, 'config.toml');
  const current = readText(file);
  if (current !== null && current.includes('[mcp_servers.' + SERVER_KEY + ']')) {
    note('codex 已配置 ielts-coach，跳过：' + file);
  } else {
    const preamble =
      current === null || current.trim() === ''
        ? '# OpenAI Codex CLI 配置（由 scripts/connect-agent.mjs 首次创建）\n'
        : current.replace(/\s+$/, '') + '\n\n';
    writeIfChanged(file, preamble + codexSection());
  }
  copySkillTo(path.join(dir, 'skills'));
  return true;
}

// ---------------------------------------------------------------------------
// Claude Code / Claude Desktop：~/.claude.json、claude_desktop_config.json
// ---------------------------------------------------------------------------

function claudeDesktopConfigPaths() {
  if (IS_WINDOWS) {
    return [path.join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')];
  }
  if (process.platform === 'darwin') {
    return [path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
  }
  return [path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json')];
}

function connectClaude() {
  const claudeDir = path.join(HOME, '.claude');
  const codeJson = path.join(HOME, '.claude.json');
  const hasCodeConfig = fs.existsSync(codeJson);
  const hasClaudeDir = fs.existsSync(claudeDir);
  const desktopTargets = claudeDesktopConfigPaths().filter((file) => fs.existsSync(file));
  if (!hasCodeConfig && !hasClaudeDir && desktopTargets.length === 0) {
    status('Claude Code / Desktop (claude)', '未检测到 ~/.claude.json 或 ~/.claude，跳过');
    return false;
  }
  status(
    'Claude Code / Desktop (claude)',
    '检测到 ' + (hasCodeConfig || hasClaudeDir ? 'Claude Code' : '') + (desktopTargets.length > 0 ? ' + Desktop' : ''),
  );
  if (hasCodeConfig || hasClaudeDir) {
    mergeJsonFile(codeJson, (data) => {
      const servers =
        data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
          ? data.mcpServers
          : {};
      servers[SERVER_KEY] = jsonEntry();
      data.mcpServers = servers;
    });
  }
  for (const file of desktopTargets) {
    mergeJsonFile(file, (data) => {
      const servers =
        data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
          ? data.mcpServers
          : {};
      servers[SERVER_KEY] = jsonEntry();
      data.mcpServers = servers;
    });
  }
  if (hasClaudeDir) copySkillTo(path.join(claudeDir, 'skills'));
  return true;
}

// ---------------------------------------------------------------------------
// Cursor：~/.cursor/mcp.json
// ---------------------------------------------------------------------------

function connectCursor() {
  const dir = path.join(HOME, '.cursor');
  if (!fs.existsSync(dir)) {
    status('Cursor (cursor)', '未检测到 ' + dir + '，跳过');
    return false;
  }
  status('Cursor (cursor)', '检测到 ' + dir);
  const file = path.join(dir, 'mcp.json');
  mergeJsonFile(file, (data) => {
    const servers =
      data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
        ? data.mcpServers
        : {};
    servers[SERVER_KEY] = jsonEntry();
    data.mcpServers = servers;
  });
  copySkillTo(path.join(dir, 'skills'));
  return true;
}

// ---------------------------------------------------------------------------
// ~/.agents/skills：跨工具通用 skill 目录（检测到任意 AI 工具时复制）
// ---------------------------------------------------------------------------

function connectAgentsSkill() {
  if (found.length === 0) return;
  copySkillTo(path.join(HOME, '.agents', 'skills'));
}

// ---------------------------------------------------------------------------
// 豆包桌面端手动卡片
// ---------------------------------------------------------------------------

function doubaoCard() {
  const httpUrl = REMOTE_URL || 'http://127.0.0.1:3000/mcp';
  const deployedHint = REMOTE_URL
    ? ''
    : '（部署到云端后换成 https://<你的域名>/mcp）';
  const header = '（服务端设置了 MCP_TOKEN 时）Authorization: Bearer <token>';
  const envHint = 'IELTS_COACH_DATA_DIR=' + DATA_DIR;
  const lines = [
    '',
    '------------------------------------------------------------------',
    '豆包桌面端 / Doubao Desktop：手动 2 步（没有可自动写入的配置文件）',
    '  1) 插件 → 添加自定义连接器（MCP）',
    '     · 推荐 Streamable HTTP：地址填 ' + httpUrl + deployedHint,
    '     · 可选请求头：' + header,
    '     · 备选 STDIO 命令：' + stdioDisplay(),
    '       环境变量：' + envHint,
    '  2) 技能 → 上传技能 → 选择文件夹：',
    '     ' + path.join(REPO_ROOT, 'skills', SKILL_NAME),
    '------------------------------------------------------------------',
  ];
  say(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  say('雅思口语教练 MCP · 一键接入' + (DRY ? '（dry-run 预览）' : ''));
  say('仓库：' + REPO_ROOT);
  say('home：' + HOME);
  say('');
  if (REMOTE_URL) {
    try {
      const parsed = new URL(REMOTE_URL);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    } catch {
      note('--url 不是完整的 http(s) 地址，仍按原样写入：' + REMOTE_URL);
    }
  }
  say('检测本机 AI 工具：');
  if (connectDsh()) found.push('dsh');
  if (connectCodex()) found.push('codex');
  if (connectClaude()) found.push('claude');
  if (connectCursor()) found.push('cursor');
  status('豆包桌面端 (doubao)', '需手动添加，末尾有 2 步卡片');
  ensureWrapperExecutable();
  connectAgentsSkill();
  if (!fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'))) {
    note('未发现 node_modules/tsx：本地 STDIO 模式需要先在仓库根目录运行 npm install');
  }

  say('');
  if (DRY) {
    say('[dry-run] 演练模式：没有修改任何文件。');
  } else {
    say('接入完成。');
  }
  say('模式 mode：' + (REMOTE_URL ? 'Streamable HTTP → ' + REMOTE_URL + (TOKEN ? '（已提供 Bearer Token）' : '（未提供 Token，若服务端要求请加 --token）') : 'STDIO → ' + stdioDisplay()));
  say('数据目录：' + DATA_DIR);
  say('检测到：' + (found.length > 0 ? found.join(' / ') : '（未发现本机 AI 工具，仍可按下面豆包卡片手动接入）'));
  if (planned.length > 0) {
    say((DRY ? '将写入' : '已写入') + ' ' + String(planned.length) + ' 个文件：');
    for (const item of planned) say('  - [' + item.action + '] ' + item.file);
  } else {
    say('没有需要写入的配置文件（均已是配置状态）。');
  }
  if (backups.length > 0) {
    say('已备份 ' + String(backups.length) + ' 个原文件：');
    for (const file of backups) say('  - ' + file);
  }
  if (notes.length > 0) {
    say('提示：');
    for (const message of notes) say('  - ' + message);
  }
  doubaoCard();
}

try {
  main();
} catch (error) {
  console.error('[ielts-connect] 出错：' + String((error && error.message) || error));
  process.exitCode = 1;
}
