'use strict';

const { spawnSync } = require('node:child_process');

const CHECKER_TIMEOUT_MS = 60 * 1000;
const SUPPORTED_MODES = new Set(['100644', '100755']);

function createChecker(binary) {
  if (!binary) return null;
  return (versions) => {
    const result = spawnSync(binary, [], {
      input: JSON.stringify(versions),
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: CHECKER_TIMEOUT_MS,
    });
    if (result.error) return { ok: false, reason: `syntax checker failed: ${result.error.message}` };
    if (result.status !== 0) {
      return { ok: false, reason: `syntax checker failed: ${String(result.stderr || '').trim() || result.status}` };
    }
    return JSON.parse(result.stdout.toString('utf8'));
  };
}

function decode(buffer) {
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? text : null;
}

function checkFile({ git, checker, versions, file }) {
  if (!file.endsWith('.swift')) return { ok: false, reason: `${file} is not a Swift file` };
  const texts = {};
  let mode = null;
  for (const [name, rev] of Object.entries(versions)) {
    const entry = git.entryAt(rev, file);
    if (!entry || entry.type !== 'blob' || !SUPPORTED_MODES.has(entry.mode)) {
      return { ok: false, reason: `${file} is missing or not a regular file in ${name}` };
    }
    if (mode && entry.mode !== mode) return { ok: false, reason: `${file} changes mode` };
    mode = entry.mode;
    const text = decode(git.readBlob(rev, file));
    if (text === null) return { ok: false, reason: `${file} is not UTF-8 in ${name}` };
    texts[name] = text;
  }

  const result = checker(texts);
  if (!result.ok) return { ok: false, reason: `${file}: ${result.reason}` };
  return { ok: true, rules: result.rules, changes: result.changes };
}

function checkSyntaxRules({ git, checker, versions, merge, paths }) {
  if (!checker) return { ok: false, reason: 'syntax checker is not available' };
  if (merge.status === 'conflict') {
    const unsupported = merge.messages.find((m) => m.type.startsWith('CONFLICT') && m.type !== 'CONFLICT (contents)');
    if (unsupported) return { ok: false, reason: `${unsupported.type}: ${unsupported.paths.join(', ')}` };
  }
  if (!paths.length) return { ok: false, reason: 'no differing paths to explain' };

  const files = [];
  for (const file of paths) {
    const result = checkFile({ git, checker, versions, file });
    if (!result.ok) return { ok: false, reason: result.reason, files };
    files.push({ file, rules: result.rules, changes: result.changes });
  }
  const rules = [...new Set(files.flatMap((f) => f.rules))].sort();
  return { ok: true, rules, files };
}

module.exports = { createChecker, checkSyntaxRules };
