'use strict';

const fs = require('node:fs');
const path = require('node:path');

const slimPull = (p) => ({
  number: p.number,
  state: p.state,
  created_at: p.created_at,
  updated_at: p.updated_at,
  closed_at: p.closed_at,
  merged_at: p.merged_at,
  head: { ref: p.head.ref, sha: p.head.sha },
  base: { ref: p.base.ref, sha: p.base.sha },
});

const slimReview = (r) => ({
  id: r.id,
  user: r.user && { login: r.user.login, type: r.user.type },
  state: r.state,
  commit_id: r.commit_id,
  submitted_at: r.submitted_at,
  body: r.body,
});

const RECORDED = {
  getPull: slimPull,
  listReviews: (reviews) => reviews.map(slimReview),
  getTimeline: (timeline) => timeline,
  getCodeowners: (text) => text,
  findPullsByHead: (pulls) => pulls.map(slimPull),
  listChildren: (pulls) => pulls.map(slimPull),
  listRecentlyMerged: (pulls) => pulls.map(slimPull),
};

function recordingApi(api, calls) {
  const wrapped = { ...api };
  for (const [method, slim] of Object.entries(RECORDED)) {
    wrapped[method] = async (...args) => {
      const result = await api[method](...args);
      calls.push({ method, args, result: result == null ? result : slim(result) });
      return result;
    };
  }
  return wrapped;
}

function writeEvidence(dir, record) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const { snapshot } = record.decision;
  const file = path.join(dir, `pr-${snapshot.pr}-${snapshot.head.slice(0, 12)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

module.exports = { recordingApi, writeEvidence };
