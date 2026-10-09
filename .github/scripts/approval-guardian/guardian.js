'use strict';

const { createGit } = require('./git.js');
const { createApi, createBotApi } = require('./github-api.js');
const { parseCodeowners, selectTrustRoot, botApprovedHead, protectedPaths } = require('./policy.js');
const { buildLayers, Unresolvable } = require('./lineage.js');
const { compare } = require('./compare.js');
const { createChecker } = require('./syntax.js');
const { MARKER, POLICY_VERSION, commentBody, reviewBody, summaryMarkdown } = require('./report.js');
const { recordingApi, writeEvidence } = require('./evidence.js');

const MAX_ATTEMPTS = 2;

const human = (reason, detail = null) => ({ verdict: 'HUMAN', reason, detail });

async function evaluate({ api, git, config, number }) {
  const pull = await api.getPull(number, { fresh: true });
  const snapshot = { pr: number, head: pull.head.sha, baseRef: pull.base.ref, baseSha: pull.base.sha, reviews: [], related: [] };
  const loaded = new Map();
  let lostApproval = false;
  const done = (result) => ({ ...result, lostApproval, snapshot, policy: POLICY_VERSION });
  if (pull.state !== 'open') return done({ verdict: 'NO_ACTION', reason: 'CLOSED' });
  if (pull.draft) return done({ verdict: 'NO_ACTION', reason: 'DRAFT' });

  const codeowners = parseCodeowners(await api.getCodeowners(config.defaultBranch));
  if (!codeowners.supported) return done(human('UNSUPPORTED_CODEOWNERS', codeowners.reason));

  const loadLayer = async (layerPull) => {
    const reviews = await api.listReviews(layerPull.number);
    const timeline = await api.getTimeline(layerPull.number);
    const trust = selectTrustRoot({
      reviews, dismissals: timeline.dismissals, owners: codeowners.owners, botLogin: config.botLogin, headSha: layerPull.head.sha,
    });
    loaded.set(layerPull.number, relatedState(layerPull, reviews));
    return { pull: layerPull, reviews, timeline, ...trust };
  };

  const top = await loadLayer(pull);
  snapshot.reviews = reviewStates(top.reviews);
  if (top.activeOnHead) return done({ verdict: 'NO_ACTION', reason: 'HUMAN_APPROVED' });
  lostApproval = Boolean(top.root);
  const guardianReview = botApprovedHead({ reviews: top.reviews, botLogin: config.botLogin, headSha: pull.head.sha });
  const retargeted = guardianReview
    && top.timeline.baseChanges.some((change) => Date.parse(change.at) > Date.parse(guardianReview.submitted_at));
  if (guardianReview && !retargeted) return done({ verdict: 'NO_ACTION', reason: 'GUARDIAN_APPROVED' });
  const stale = retargeted ? { staleGuardianReview: guardianReview.id } : {};
  const finish = (result) => done({ ...stale, ...result });
  if (top.blocking) return finish(human('CHANGES_REQUESTED'));
  if (!top.root) return finish(human('NO_HUMAN_APPROVAL'));

  try {
    const missing = git.ensureCommits([pull.head.sha, pull.base.sha]);
    if (missing.length) return finish(human('MISSING_OBJECT', missing.join(', ')));

    const plan = (embedParents) => buildLayers({
      api,
      git,
      top,
      defaultBranch: config.defaultBranch,
      embedParents,
      loadRoot: async (n) => {
        const layer = await loadLayer(await api.getPull(n));
        return layer.blocking ? { ...layer, root: null } : layer;
      },
    });
    const judge = (lineage) => {
      const layers = lineage.layers.map((layer) => ({
        pr: layer.pull.number,
        reviewer: layer.root.user.login,
        reviewId: layer.root.id,
        reviewed: layer.root.commit_id,
        oldBase: layer.oldBase,
        oldBaseRef: layer.oldBaseRef,
      }));
      const context = { layers, newBase: lineage.newBase, parentPr: lineage.parentPr, gitVersion: config.gitVersion };
      const touched = protectedPaths(git.diffTrees(lineage.newBase, pull.head.sha).map((entry) => entry.path));
      if (touched.length) return { ...context, ...human('PROTECTED_PATHS', touched.join(', ')) };
      return { ...context, ...compare({ git, head: pull.head.sha, newBase: lineage.newBase, layers: lineage.layers, checker: config.checker }) };
    };

    const pass = async (result) => {
      snapshot.related = result.layers.filter((layer) => layer.pr !== number).map((layer) => loaded.get(layer.pr));
      if (result.parentPr) snapshot.related.push(relatedState(await api.getPull(result.parentPr, { fresh: true }), null));
      return finish(result);
    };

    const single = judge(await plan(false));
    if (single.verdict !== 'HUMAN') return pass(single);
    if (single.reason === 'PROTECTED_PATHS') return finish(single);
    let layered = null;
    try {
      const lineage = await plan(true);
      const bases = (layers) => JSON.stringify(layers.map((layer) => [layer.pr, layer.oldBase]));
      if (bases(lineage.layers) !== bases(single.layers)) layered = judge(lineage);
    } catch (error) {
      if (!(error instanceof Unresolvable)) throw error;
    }
    return layered && layered.verdict !== 'HUMAN' ? pass(layered) : finish(single);
  } catch (error) {
    if (error instanceof Unresolvable) return finish(human(error.reason, error.message));
    return finish({ ...human('ERROR', error.message), stack: error.stack });
  }
}

const reviewStates = (reviews) => reviews.map((r) => [r.id, r.state, r.commit_id]);

const relatedState = (pull, reviews) => ({
  pr: pull.number, state: pull.state, head: pull.head.sha, baseRef: pull.base.ref, reviews: reviews ? reviewStates(reviews) : null,
});

function requiredEnforcement(decision) {
  if (decision.verdict === 'DET_GIT_PASS') return ['DET_GIT_PASS'];
  if (decision.verdict === 'DET_SYNTAX_PASS') return decision.rules;
  return null;
}

async function unchanged(api, snapshot, ownReviewId = null) {
  const pull = await api.getPull(snapshot.pr, { fresh: true });
  const reviews = (await api.listReviews(snapshot.pr)).filter((r) => r.id !== ownReviewId);
  if (pull.state !== 'open'
    || pull.head.sha !== snapshot.head
    || pull.base.ref !== snapshot.baseRef
    || pull.base.sha !== snapshot.baseSha
    || JSON.stringify(reviewStates(reviews)) !== JSON.stringify(snapshot.reviews)) return false;
  for (const related of snapshot.related) {
    const now = await api.getPull(related.pr, { fresh: true });
    const nowReviews = related.reviews ? await api.listReviews(related.pr) : null;
    if (JSON.stringify(relatedState(now, nowReviews)) !== JSON.stringify(related)) return false;
  }
  return true;
}

async function enforce({ api, botApi, config, decision, links }) {
  const required = requiredEnforcement(decision);
  if (!required) return { action: 'none' };
  const disabled = required.filter((key) => !config.enforce.has(key));
  if (disabled.length) return { action: 'observe', note: `not enforced: ${disabled.join(', ')}` };
  if (!botApi || !config.botLogin) return { action: 'observe', note: 'bot account is not configured' };

  const { snapshot } = decision;
  if (!(await unchanged(api, snapshot))) return { action: 'superseded' };
  const review = await botApi.approve(snapshot.pr, snapshot.head, reviewBody(decision, links));
  if (!(await unchanged(api, snapshot, review.id))) {
    await botApi.dismiss(snapshot.pr, review.id, 'Approval Guardian: the PR or its approval evidence changed while approving.');
    return { action: 'withdrawn', reviewId: review.id };
  }
  return { action: 'approved', reviewId: review.id };
}

async function publish({ api, decision, outcome, links }) {
  const { body, fingerprint } = commentBody(decision, outcome, links);
  const current = (await api.listComments(decision.snapshot.pr))
    .find((c) => c.body && c.body.startsWith(MARKER) && c.user && c.user.login === links.commentLogin && c.body.includes(`fp=${fingerprint}`));
  if (current) return { id: current.id, fingerprint, action: 'unchanged' };
  const created = await api.createComment(decision.snapshot.pr, body);
  return { id: created.id, fingerprint, action: 'created' };
}

const shouldComment = (decision) => decision.lostApproval && decision.verdict !== 'NO_ACTION';

async function withdrawStale({ botApi, decision }) {
  if (!decision.staleGuardianReview || !botApi) return;
  await botApi.dismiss(decision.snapshot.pr, decision.staleGuardianReview, 'Approval Guardian: the base changed after this approval.');
}

async function guardPull({ makeApi, botApi, git, config, links, number, log }) {
  const inputs = [];
  const attempts = [];
  let api;
  let decision;
  let outcome;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    api = recordingApi(makeApi(), inputs);
    const started = Date.now();
    decision = await evaluate({ api, git, config, number });
    const evaluateMs = Date.now() - started;
    await withdrawStale({ botApi, decision });
    outcome = decision.verdict === 'NO_ACTION' ? { action: 'none' } : await enforce({ api, botApi, config, decision, links });
    attempts.push({
      verdict: decision.verdict, reason: decision.reason || null, head: decision.snapshot.head, outcome: outcome.action,
      evaluateMs, totalMs: Date.now() - started,
    });
    if (outcome.action !== 'superseded' && outcome.action !== 'withdrawn') break;
  }
  log(`#${number}: ${decision.verdict}${decision.reason ? ` (${decision.reason})` : ''} → ${outcome.action}`);
  let comment = null;
  try {
    if (shouldComment(decision)) comment = await publish({ api, decision, outcome, links });
  } finally {
    if (decision.lostApproval) {
      writeEvidence(config.evidenceDir, {
        decision, outcome, attempts, comment, trigger: config.trigger || null, inputs,
        versions: { policy: POLICY_VERSION, git: config.gitVersion, node: process.version },
        recordedAt: new Date().toISOString(),
      });
    }
  }
  return { decision, outcome, comment, attempts, trigger: config.trigger || null };
}

async function runGuardian({ makeApi, botApi, git, config, links, number, log }) {
  const result = await guardPull({ makeApi, botApi, git, config, links, number, log });
  const api = makeApi();
  const pull = await api.getPull(number, { fresh: true });
  const children = pull.state === 'open' || pull.merged_at ? await api.listChildren(pull.head.ref) : [];
  const dispatched = children.map((child) => child.number).filter((n) => n !== number);
  for (const child of dispatched) await api.dispatchGuardian(child, config.defaultBranch);
  const summary = summaryMarkdown({ ...result, dispatched }, links);
  await api.createCheckRun(checkRun(result, summary, links));
  return { ...result, dispatched, summary };
}

const CHECK_SUMMARY_LIMIT = 65000;

function checkConclusion({ decision, outcome }) {
  if (outcome.action === 'approved') return 'success';
  if (decision.verdict === 'NO_ACTION') return 'skipped';
  return 'neutral';
}

function checkRun({ decision, outcome }, summary, links) {
  return {
    name: 'Approval Guardian',
    head_sha: decision.snapshot.head,
    status: 'completed',
    conclusion: checkConclusion({ decision, outcome }),
    details_url: links.runUrl,
    output: {
      title: `${decision.verdict}${decision.reason ? ` (${decision.reason})` : ''} → ${outcome.action}`,
      summary: summary.slice(0, CHECK_SUMMARY_LIMIT),
    },
  };
}

module.exports = async ({ github, context, core, fetch }) => {
  const env = process.env;
  const number = Number(env.GUARDIAN_PR_NUMBER);
  if (!Number.isInteger(number) || number <= 0) {
    core.setFailed(`invalid GUARDIAN_PR_NUMBER: ${env.GUARDIAN_PR_NUMBER}`);
    return;
  }
  const { owner, repo } = context.repo;
  const git = createGit({
    dir: env.GUARDIAN_GIT_DIR,
    remoteUrl: env.GUARDIAN_REMOTE_URL || `${context.serverUrl}/${owner}/${repo}.git`,
    token: env.GUARDIAN_FETCH_TOKEN,
  });
  const gitVersion = git.version();
  git.init();

  const config = {
    defaultBranch: env.GUARDIAN_DEFAULT_BRANCH,
    enforce: new Set((env.GUARDIAN_ENFORCE || '').split(',').map((s) => s.trim()).filter(Boolean)),
    botLogin: env.GUARDIAN_BOT_LOGIN || '',
    checker: createChecker(env.GUARDIAN_SWIFT_CHECKER),
    evidenceDir: env.GUARDIAN_EVIDENCE_DIR,
    trigger: /^[a-z_]{1,40}(:[a-z_]{0,40})?$/.test(env.GUARDIAN_TRIGGER || '') ? env.GUARDIAN_TRIGGER : 'unknown',
    gitVersion,
  };
  const links = {
    serverUrl: context.serverUrl,
    repo: `${owner}/${repo}`,
    runUrl: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
    commentLogin: 'github-actions[bot]',
    shadow: config.enforce.size === 0,
  };
  const botApi = env.GUARDIAN_BOT_TOKEN
    ? createBotApi({ token: env.GUARDIAN_BOT_TOKEN, apiUrl: context.apiUrl, owner, repo, fetch })
    : null;
  const makeApi = () => createApi(github, { owner, repo });
  const { summary } = await runGuardian({ makeApi, botApi, git, config, links, number, log: core.info });
  await core.summary.addRaw(summary).write();
};

module.exports.evaluate = evaluate;
module.exports.runGuardian = runGuardian;
