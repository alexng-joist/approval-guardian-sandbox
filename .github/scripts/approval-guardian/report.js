'use strict';

const crypto = require('node:crypto');

const MARKER = '<!-- approval-guardian -->';
const POLICY_VERSION = 'phase1@2';
const MAX_LISTED_PATHS = 30;

const REASONS = {
  CHANGES_REQUESTED: 'A code owner has requested changes.',
  NO_HUMAN_APPROVAL: 'No human code owner approval can be restored.',
  UNSUPPORTED_CODEOWNERS: 'CODEOWNERS uses rules the guardian does not evaluate.',
  AMBIGUOUS_BASE: 'The reviewed base could not be determined unambiguously.',
  MISSING_OBJECT: 'A commit needed for the comparison is unavailable.',
  UNTRUSTED_BASE: 'The PR targets a branch that is neither the default branch nor an open parent pull request.',
  LAYER_NOT_APPROVED: 'A stacked layer brought in by this PR has no human code owner approval.',
  UNSUPPORTED_HISTORY: 'The PR history is not one the guardian supports.',
  PROTECTED_PATHS: 'The PR changes guardian, workflow, or CODEOWNERS files.',
  TREE_MISMATCH: 'The PR head differs from re-applying the approved changes onto the new base.',
  NO_INTEGRATION_EVIDENCE: 'The approved commits were not replayed by a rebase or kept by a merge.',
  CONFLICT: 'Re-applying the approved changes conflicts, and no syntax rule explains the resolution.',
  STACK_CONFLICT: 'Composing the stacked layers conflicts.',
  GIT_ERROR: 'Git could not complete the comparison.',
  ERROR: 'The guardian failed while evaluating this PR.',
};

const short = (sha) => (sha ? sha.slice(0, 9) : 'n/a');

function scopeOf(decision) {
  if (!decision.layers) return 'n/a';
  if (decision.layers.length > 1) return 'parent+child';
  return decision.parentPr ? `child-only (parent #${decision.parentPr})` : 'pr';
}

function layerLines(decision, serverUrl, repo) {
  return (decision.layers || []).map((layer) => {
    const url = `${serverUrl}/${repo}/pull/${layer.pr}#pullrequestreview-${layer.reviewId}`;
    return `Human review: [${layer.reviewId}](${url}) by ${layer.reviewer} on \`${short(layer.reviewed)}\` (#${layer.pr}, old base \`${short(layer.oldBase)}\`)`;
  });
}

function pathList(title, paths) {
  if (!paths || !paths.length) return [];
  const listed = paths.slice(0, MAX_LISTED_PATHS).map((p) => `- \`${p}\``);
  const more = paths.length > MAX_LISTED_PATHS ? [`- … ${paths.length - MAX_LISTED_PATHS} more`] : [];
  return [`**${title}**`, ...listed, ...more];
}

function evidenceLines(decision, { serverUrl, repo, runUrl }) {
  return [
    ...layerLines(decision, serverUrl, repo),
    `Old base: \`${short(decision.layers && decision.layers[0] && decision.layers[0].oldBase)}\` → Integrated base: \`${short(decision.newBase)}\``,
    `Target branch / tip: \`${decision.snapshot.baseRef}\` / \`${short(decision.snapshot.baseSha)}\``,
    `Reviewed head: \`${decision.snapshot.head}\``,
    `Scope: ${scopeOf(decision)}`,
    `Rules: ${[POLICY_VERSION, ...(decision.rules || [])].join(', ')}`,
    `Evidence: ${runUrl}`,
  ];
}

function reviewBody(decision, links) {
  return [
    `Approval Guardian: ${decision.verdict}`,
    ...evidenceLines(decision, links),
    `Reason summary: ${decision.verdict === 'DET_GIT_PASS'
      ? 'the head tree equals the approved changes re-applied onto the integrated base'
      : 'both sides only added declarations that the listed syntax rules compose'}`,
  ].join('\n');
}

function fingerprint(decision, outcome) {
  const key = JSON.stringify([decision.verdict, decision.reason, decision.snapshot.head, decision.newBase, decision.expectedTree, outcome.action]);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

const OUTCOMES = {
  approved: 'Approved this head on behalf of the continued human review.',
  withdrawn: 'Approved, then withdrew the approval because the head or base changed during submission.',
  superseded: 'The PR changed during evaluation; nothing was approved.',
  observe: 'Observe-only: this verdict is not enforced, so nothing was approved.',
  none: 'A code owner needs to review this PR.',
};

function commentBody(decision, outcome, links) {
  const fp = fingerprint(decision, outcome);
  const { pr, head } = decision.snapshot;
  const commit = `[\`${short(head)}\`](${links.serverUrl}/${links.repo}/pull/${pr}/commits/${head})`;
  const lines = [MARKER, `<!-- approval-guardian:fp=${fp} -->`, `### Approval Guardian: ${decision.verdict} for ${commit}`, ''];
  if (decision.verdict === 'HUMAN') {
    lines.push(`**${REASONS[decision.reason] || decision.reason}**`);
    if (decision.detail) lines.push('', `> \`${String(decision.detail).replace(/[`\n]/g, ' ')}\``);
    lines.push('');
  }
  lines.push(OUTCOMES[outcome.action] + (outcome.note ? ` (${outcome.note})` : ''), '');
  lines.push(...evidenceLines(decision, links).map((line) => `- ${line}`));
  const conflictPaths = decision.conflicts ? decision.conflicts.paths : [];
  const unexplained = (decision.residual || []).filter((p) => !conflictPaths.includes(p));
  if (decision.verdict === 'HUMAN') {
    lines.push('', ...pathList('Conflicted paths', conflictPaths), ...pathList('Other paths that differ from the expected tree', unexplained));
  }
  lines.push('', FEEDBACK);
  return { body: lines.join('\n'), fingerprint: fp };
}

const FEEDBACK = 'Code owners: react 👍 if this verdict for this commit is right or 👎 if it is wrong. Reactions are collected to evaluate the guardian; later commits get their own comment.';


function summaryMarkdown({ decision, outcome, comment, attempts, trigger, dispatched }, { serverUrl, repo }) {
  const { snapshot } = decision;
  const prUrl = `${serverUrl}/${repo}/pull/${snapshot.pr}`;
  const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = [
    ['Verdict', `**${decision.verdict}**${decision.reason ? ` (${decision.reason})` : ''}`],
    ['Outcome', `${outcome.action}${outcome.note ? ` (${outcome.note})` : ''}`],
    ['Lost approval', decision.lostApproval ? 'yes' : 'no'],
    ['Trigger', trigger || 'n/a'],
    ['Head', `\`${snapshot.head}\``],
    ['Target', `\`${snapshot.baseRef}\` @ \`${short(snapshot.baseSha)}\``],
    ['Comment', comment ? `[${comment.action}](${prUrl}#issuecomment-${comment.id})` : 'none'],
    ['Children dispatched', dispatched && dispatched.length ? dispatched.map((n) => `#${n}`).join(', ') : 'none'],
  ];
  const lines = [`### Approval Guardian · [#${snapshot.pr}](${prUrl})`, '', '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`)];
  if (decision.verdict === 'HUMAN') lines.push('', `**${REASONS[decision.reason] || decision.reason}**`);
  if (decision.detail) lines.push('', `> \`${String(decision.detail).replace(/[`\n]/g, ' ')}\``);
  if (attempts && attempts.length) {
    lines.push('', '| Attempt | Verdict | Head | Outcome | Evaluate | Total |', '|---|---|---|---|---|---|');
    attempts.forEach((a, i) => lines.push(`| ${i + 1} | ${a.verdict}${a.reason ? ` (${a.reason})` : ''} | \`${short(a.head)}\` | ${a.outcome} | ${a.evaluateMs} ms | ${a.totalMs} ms |`));
  }
  if (decision.layers) lines.push('', ...layerLines(decision, serverUrl, repo).map((line) => `- ${line}`), `- Scope: ${scopeOf(decision)}`);
  const conflictPaths = decision.conflicts ? decision.conflicts.paths : [];
  const unexplained = (decision.residual || []).filter((p) => !conflictPaths.includes(p));
  lines.push('', ...pathList('Conflicted paths', conflictPaths), ...pathList('Other paths that differ from the expected tree', unexplained));
  if (decision.syntax && decision.syntax.files && decision.syntax.files.length) {
    lines.push('', '**Explained by syntax rules**', ...decision.syntax.files.map((f) => `- \`${f.file}\`: ${f.rules.join(', ')}`));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { MARKER, POLICY_VERSION, commentBody, reviewBody, summaryMarkdown };
