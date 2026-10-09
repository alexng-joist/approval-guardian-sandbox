'use strict';

const { checkSyntaxRules } = require('./syntax.js');

const MAX_DIFF_CHARS = 1000000;

function compose(git, newBase, layers) {
  let commit = newBase;
  const steps = [];
  for (const layer of layers) {
    const merge = git.mergeTree(layer.oldBase, commit, layer.root.commit_id);
    steps.push({ pr: layer.pull.number, status: merge.status, tree: merge.tree || null });
    if (merge.status !== 'clean') return { merge, steps, layer };
    commit = git.commitTree(merge.tree);
  }
  return { merge: { status: 'clean', tree: git.treeOf(commit) }, steps };
}

function conflictSummary(merge) {
  return {
    paths: [...new Set(merge.stages.map((s) => s.path))],
    types: [...new Set(merge.messages.filter((m) => m.type.startsWith('CONFLICT')).map((m) => m.type))],
  };
}

const identity = (c) => [c.author, c.email, c.authoredAt, c.subject].join('\x1f');

function approvedCommitsMissing(approved, current) {
  const replayed = new Map();
  for (const c of current.filter((x) => !x.merge)) replayed.set(identity(c), (replayed.get(identity(c)) || 0) + 1);
  return approved.filter((c) => !c.merge).filter((c) => {
    const left = replayed.get(identity(c)) || 0;
    if (left) replayed.set(identity(c), left - 1);
    return !left;
  });
}

function history(git, head, newBase, layers) {
  return {
    current: git.commitLog(newBase, head),
    layers: layers.map((layer) => ({ pr: layer.pull.number, approved: git.commitLog(layer.oldBase, layer.root.commit_id) })),
  };
}

function residualDiff(git, expectedTree, headTree) {
  const text = git.diffText(expectedTree, headTree);
  return text.length > MAX_DIFF_CHARS ? { text: text.slice(0, MAX_DIFF_CHARS), truncated: true } : { text, truncated: false };
}

function compare({ git, head, newBase, layers, checker }) {
  const headTree = git.treeOf(head);
  const composed = compose(git, newBase, layers);
  const { merge } = composed;
  const base = { headTree, steps: composed.steps, history: history(git, head, newBase, layers) };

  if (merge.status === 'error') {
    return { ...base, verdict: 'HUMAN', reason: 'GIT_ERROR', detail: merge.message };
  }
  if (merge.status === 'clean' && merge.tree === headTree) {
    return { ...base, verdict: 'DET_GIT_PASS', expectedTree: merge.tree };
  }

  const residual = git.diffTrees(merge.tree, headTree).map((entry) => entry.path);
  const conflicts = merge.status === 'conflict' ? conflictSummary(merge) : null;
  const evidence = { ...base, expectedTree: merge.tree, residual, conflicts, residualDiff: residualDiff(git, merge.tree, headTree) };

  if (layers.length > 1) {
    return {
      ...evidence,
      verdict: 'HUMAN',
      reason: merge.status === 'conflict' ? 'STACK_CONFLICT' : 'TREE_MISMATCH',
      detail: merge.status === 'conflict' ? `merging #${composed.layer.pull.number} conflicts` : null,
    };
  }

  const [layer] = layers;
  const missing = approvedCommitsMissing(base.history.layers[0].approved, base.history.current);
  if (missing.length) {
    return {
      ...evidence,
      verdict: 'HUMAN',
      reason: 'NO_INTEGRATION_EVIDENCE',
      detail: `approved commits not replayed or merged: ${missing.map((c) => `${c.sha.slice(0, 10)} ${c.subject}`).join('; ')}`,
    };
  }
  const syntax = checkSyntaxRules({
    git,
    checker,
    versions: { base: layer.oldBase, approved: layer.root.commit_id, upstream: newBase, resolved: head },
    merge,
    paths: [...new Set([...(conflicts ? conflicts.paths : []), ...residual])],
  });
  if (syntax.ok) {
    return { ...evidence, verdict: 'DET_SYNTAX_PASS', rules: syntax.rules, syntax };
  }
  return {
    ...evidence,
    verdict: 'HUMAN',
    reason: merge.status === 'conflict' ? 'CONFLICT' : 'TREE_MISMATCH',
    detail: syntax.reason,
    syntax,
  };
}

module.exports = { compare };
