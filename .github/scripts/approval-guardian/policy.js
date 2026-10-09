'use strict';

const GUARDIAN_REVIEW_PREFIX = 'Approval Guardian:';
const INTEGRATION_DISMISSALS = new Set(['The merge-base changed after approval.', 'The base branch was changed.']);

const PROTECTED_PATHS = [
  /^\.github\/CODEOWNERS$/,
  /^\.github\/workflows\/approval-guardian[^/]*\.yml$/,
  /^\.github\/scripts\/approval-guardian\//,
];

function parseCodeowners(text) {
  if (text == null) return { supported: false, reason: 'CODEOWNERS not found', owners: new Set() };
  const owners = new Set();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...entries] = line.split(/\s+/);
    if (pattern !== '*') {
      return { supported: false, reason: `path-specific CODEOWNERS rule "${pattern}" is not supported`, owners: new Set() };
    }
    for (const entry of entries) {
      if (/^@[A-Za-z0-9-]+$/.test(entry)) owners.add(entry.slice(1).toLowerCase());
    }
  }
  return { supported: true, owners };
}

function isHumanCodeOwner(user, owners, botLogin) {
  if (!user || user.type === 'Bot') return false;
  const login = user.login.toLowerCase();
  return login !== String(botLogin || '').toLowerCase() && owners.has(login);
}

function selectTrustRoot({ reviews, dismissals, owners, botLogin, headSha }) {
  const human = reviews.filter(
    (review) => isHumanCodeOwner(review.user, owners, botLogin) && !String(review.body || '').startsWith(GUARDIAN_REVIEW_PREFIX),
  );
  const staleApprovals = new Set(
    dismissals
      .filter((d) => d.previousState === 'APPROVED' && (d.staleCommit || INTEGRATION_DISMISSALS.has(d.message)))
      .map((d) => d.reviewId),
  );

  const latestByReviewer = new Map();
  for (const review of human) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      latestByReviewer.set(review.user.login.toLowerCase(), review);
    }
  }
  const blocking = [...latestByReviewer.values()].find((review) => review.state === 'CHANGES_REQUESTED') || null;

  const approvals = human.filter(
    (review) => review.state === 'APPROVED' || (review.state === 'DISMISSED' && staleApprovals.has(review.id)),
  );
  const root = approvals.reduce(
    (latest, review) => (!latest || Date.parse(review.submitted_at) >= Date.parse(latest.submitted_at) ? review : latest),
    null,
  );
  const activeOnHead = human.some((review) => review.state === 'APPROVED' && review.commit_id === headSha);
  return { root, blocking, activeOnHead };
}

function botApprovedHead({ reviews, botLogin, headSha }) {
  if (!botLogin) return null;
  return reviews.find(
    (review) => review.state === 'APPROVED' && review.commit_id === headSha
      && review.user && review.user.login.toLowerCase() === botLogin.toLowerCase(),
  ) || null;
}

const protectedPaths = (paths) => paths.filter((p) => PROTECTED_PATHS.some((re) => re.test(p)));

module.exports = { GUARDIAN_REVIEW_PREFIX, parseCodeowners,isHumanCodeOwner, selectTrustRoot, botApprovedHead, protectedPaths };
