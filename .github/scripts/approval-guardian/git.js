'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHA_RE = /^[0-9a-f]{40}$/;
const MIN_VERSION = [2, 45];

class GitError extends Error {
  constructor(args, result) {
    super(`git ${args.join(' ')} exited ${result.status}: ${String(result.stderr || '').trim()}`);
    this.status = result.status;
  }
}

function createGit({ dir, remoteUrl, token }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-guardian-'));
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    GIT_DIR: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Approval Guardian',
    GIT_AUTHOR_EMAIL: 'approval-guardian@invalid',
    GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Approval Guardian',
    GIT_COMMITTER_EMAIL: 'approval-guardian@invalid',
    GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: basic ${basic}`,
    });
  }

  function raw(args, { input } = {}) {
    return spawnSync('git', ['-c', 'core.attributesFile=/dev/null', '-c', 'core.hooksPath=/dev/null', ...args], {
      env,
      input,
      maxBuffer: 512 * 1024 * 1024,
    });
  }

  function run(args, opts) {
    const result = raw(args, opts);
    if (result.status !== 0) throw new GitError(args, result);
    return result.stdout.toString('utf8');
  }

  const line = (args) => run(args).trim();

  function version() {
    const text = line(['version']);
    const match = /(\d+)\.(\d+)/.exec(text);
    const ok = match && (Number(match[1]) > MIN_VERSION[0] || (Number(match[1]) === MIN_VERSION[0] && Number(match[2]) >= MIN_VERSION[1]));
    if (!ok) throw new Error(`${text} is older than ${MIN_VERSION.join('.')}`);
    return text;
  }

  function init() {
    run(['init', '--bare', '--quiet', dir]);
    run(['config', 'remote.origin.url', remoteUrl]);
    run(['config', 'remote.origin.promisor', 'true']);
    run(['config', 'remote.origin.partialclonefilter', 'blob:none']);
  }

  function ensureCommits(shas) {
    const wanted = [...new Set(shas.filter((sha) => SHA_RE.test(sha)))];
    const missing = () => wanted.filter((sha) => raw(['--no-lazy-fetch', 'cat-file', '-e', `${sha}^{commit}`]).status !== 0);
    let absent = missing();
    if (absent.length && raw(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', ...absent]).status !== 0) {
      for (const sha of absent) raw(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', sha]);
    }
    return missing();
  }

  const treeOf = (rev) => line(['rev-parse', '--verify', '--end-of-options', `${rev}^{tree}`]);

  function mergeBases(a, b) {
    const result = raw(['merge-base', '--all', a, b]);
    if (result.status === 1) return [];
    if (result.status !== 0) throw new GitError(['merge-base', '--all', a, b], result);
    return result.stdout.toString('utf8').split('\n').filter(Boolean);
  }

  function isAncestor(ancestor, descendant) {
    const result = raw(['merge-base', '--is-ancestor', ancestor, descendant]);
    if (result.status > 1 || result.status === null) throw new GitError(['merge-base', '--is-ancestor'], result);
    return result.status === 0;
  }

  function mergeTree(base, ours, theirs) {
    const args = ['merge-tree', '--write-tree', '-z', `--merge-base=${base}`, ours, theirs];
    const result = raw(args);
    if (result.status !== 0 && result.status !== 1) {
      return { status: 'error', message: String(result.stderr || '').trim() || `exit ${result.status}` };
    }
    const fields = result.stdout.toString('utf8').split('\0');
    const tree = fields.shift();
    if (!SHA_RE.test(tree || '')) return { status: 'error', message: 'merge-tree printed no tree id' };
    if (result.status === 0) return { status: 'clean', tree };

    const stages = [];
    while (fields.length && fields[0] !== '') {
      const entry = /^(\d{6}) ([0-9a-f]{40}) ([123])\t(.*)$/s.exec(fields.shift());
      if (!entry) return { status: 'error', message: 'unparseable conflicted file info' };
      stages.push({ mode: entry[1], oid: entry[2], stage: Number(entry[3]), path: entry[4] });
    }
    fields.shift();
    const messages = [];
    while (fields.length > 1) {
      const count = Number(fields.shift());
      if (!Number.isInteger(count)) return { status: 'error', message: 'unparseable merge messages' };
      const paths = fields.splice(0, count);
      const type = fields.shift();
      const message = fields.shift();
      messages.push({ paths, type, message });
    }
    return { status: 'conflict', tree, stages, messages };
  }

  const commitTree = (tree, parents = []) =>
    line(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', 'approval-guardian expected tree']);

  function diffTrees(a, b) {
    const out = run(['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--raw', a, b]);
    const fields = out.split('\0');
    const entries = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) (\w)/.exec(fields[i]);
      if (!meta) break;
      entries.push({ oldMode: meta[1], newMode: meta[2], oldOid: meta[3], newOid: meta[4], status: meta[5], path: fields[i + 1] });
    }
    return entries;
  }

  function commitLog(base, tip) {
    const out = run(['log', '-z', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s', `${base}..${tip}`]);
    return out.split('\0').filter(Boolean).map((record) => {
      const [sha, parents, author, email, authoredAt, subject] = record.replace(/^\n/, '').split('\x1f');
      return { sha, merge: parents.split(' ').length > 1, author, email, authoredAt: Number(authoredAt), subject };
    });
  }

  const diffText = (a, b) => run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '-U3', a, b]);

  function readBlob(rev, file) {
    const result = raw(['cat-file', 'blob', `${rev}:${file}`]);
    return result.status === 0 ? result.stdout : null;
  }

  function entryAt(rev, file) {
    const out = line(['ls-tree', '-z', '--full-tree', rev, '--', file]).replace(/\0$/, '');
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t/.exec(out);
    return match ? { mode: match[1], type: match[2], oid: match[3] } : null;
  }

  return {
    version, init, ensureCommits, treeOf, mergeBases, isAncestor,
    mergeTree, commitTree, diffTrees, commitLog, diffText, readBlob, entryAt,
  };
}

module.exports = { createGit, GitError, SHA_RE };
