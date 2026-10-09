'use strict';

const MAX_LAYERS = 10;

class Unresolvable extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

function pickPullForHead(pulls) {
  const open = pulls.filter((p) => p.state === 'open');
  if (open.length === 1) return open[0];
  if (open.length > 1) throw new Unresolvable('AMBIGUOUS_BASE', `several open PRs use head ${open[0].head.ref}`);
  const merged = pulls.filter((p) => p.merged_at).sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));
  if (merged.length) return merged[0];
  return pulls.slice().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] || null;
}

function baseRefAt(pull, timeline, time) {
  const changes = timeline.baseChanges.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let ref = changes.length ? changes[0].previous : pull.base.ref;
  for (const change of changes) {
    if (Date.parse(change.at) <= Date.parse(time)) ref = change.current;
  }
  return ref;
}

async function sourceForRef(api, pull, ref, defaultBranch) {
  const owner = ref === defaultBranch ? null : pickPullForHead(await api.findPullsByHead(ref));
  const revisions = ref === pull.base.ref ? [pull.base.sha] : [];
  let ownerPull = null;
  if (owner && owner.number !== pull.number) {
    const timeline = await api.getTimeline(owner.number);
    revisions.push(owner.head.sha, ...timeline.forcePushes.flatMap((push) => [push.before, push.after]));
    ownerPull = {
      number: owner.number,
      open: owner.state === 'open',
      merged: Boolean(owner.merged_at),
      baseRef: owner.base.ref,
    };
  }
  return { ref, pull: ownerPull, revisions: [...new Set(revisions.filter(Boolean))] };
}

function resolvePoint(git, commit, revisions) {
  const points = new Set();
  for (const revision of revisions) {
    const bases = git.mergeBases(commit, revision);
    if (bases.length > 1) throw new Unresolvable('AMBIGUOUS_BASE', `${commit} has several merge bases with ${revision}`);
    if (bases.length === 1) points.add(bases[0]);
  }
  const candidates = [...points];
  const top = candidates.find((candidate) => candidates.every((other) => other === candidate || git.isAncestor(other, candidate)));
  if (!top) throw new Unresolvable('AMBIGUOUS_BASE', `no single base for ${commit} among ${candidates.length} candidates`);
  return top;
}

function reachable(git, source, required) {
  const missing = git.ensureCommits([required, ...source.revisions]);
  if (missing.includes(required)) throw new Unresolvable('MISSING_OBJECT', `commit ${required} is unavailable`);
  const revisions = source.revisions.filter((sha) => !missing.includes(sha));
  if (!revisions.length) throw new Unresolvable('MISSING_OBJECT', `no revision of ${source.ref} is available`);
  return revisions;
}

async function embeddedParent({ api, git, reviewed, oldBase, exclude, defaultBranch }) {
  const candidates = [];
  const others = [...await api.listChildren(defaultBranch), ...await api.listRecentlyMerged(defaultBranch)];
  for (const other of others) {
    if (exclude.has(other.number) || other.head.ref === defaultBranch) continue;
    const timeline = await api.getTimeline(other.number);
    const revisions = [...new Set([other.head.sha, ...timeline.forcePushes.flatMap((push) => [push.before, push.after])].filter(Boolean))];
    const missing = git.ensureCommits(revisions);
    for (const revision of revisions) {
      if (missing.includes(revision) || revision === oldBase) continue;
      if (git.isAncestor(oldBase, revision) && git.isAncestor(revision, reviewed) && revision !== reviewed) {
        candidates.push({ number: other.number, ref: other.head.ref, revision, merged: Boolean(other.merged_at) });
      }
    }
  }
  if (!candidates.length) return null;
  const top = candidates.filter((c) => candidates.every((o) => o.revision === c.revision || git.isAncestor(o.revision, c.revision)));
  const owners = new Set(top.map((c) => c.number));
  if (top.length === 0 || owners.size > 1) {
    throw new Unresolvable('AMBIGUOUS_BASE', `reviewed commit ${reviewed} contains revisions of #${[...new Set(candidates.map((c) => c.number))].join(', #')}`);
  }
  return top[0];
}

async function buildLayers({ api, git, top, loadRoot, defaultBranch, embedParents = false }) {
  const targetRef = top.pull.base.ref;
  const target = await sourceForRef(api, top.pull, targetRef, defaultBranch);
  if (targetRef !== defaultBranch && !(target.pull && target.pull.open)) {
    throw new Unresolvable('UNTRUSTED_BASE', `${targetRef} is neither ${defaultBranch} nor the head of an open pull request`);
  }
  const layers = [];
  const seen = new Set();
  let current = top;
  while (true) {
    if (seen.has(current.pull.number) || layers.length >= MAX_LAYERS) {
      throw new Unresolvable('UNSUPPORTED_HISTORY', `stack through #${current.pull.number} loops or is too deep`);
    }
    seen.add(current.pull.number);
    if (!current.root) {
      throw new Unresolvable('LAYER_NOT_APPROVED', `#${current.pull.number} has no human code owner approval`);
    }
    const ref = baseRefAt(current.pull, current.timeline, current.root.submitted_at);
    const source = await sourceForRef(api, current.pull, ref, defaultBranch);
    if (ref !== targetRef && !source.pull) {
      throw new Unresolvable('UNSUPPORTED_HISTORY', `#${current.pull.number} was reviewed against ${ref}, which is not a pull request`);
    }
    const oldBase = resolvePoint(git, current.root.commit_id, reachable(git, source, current.root.commit_id));
    const embedded = embedParents && ref === defaultBranch
      ? await embeddedParent({ api, git, reviewed: current.root.commit_id, oldBase, exclude: seen, defaultBranch })
      : null;
    if (embedded) {
      layers.unshift({ pull: current.pull, root: current.root, oldBase: embedded.revision, oldBaseRef: embedded.ref });
      if (embedded.merged) {
        if (targetRef === defaultBranch) break;
        throw new Unresolvable('UNSUPPORTED_HISTORY', `#${embedded.number} was merged into ${defaultBranch}, not ${targetRef}`);
      }
      current = await loadRoot(embedded.number);
      continue;
    }
    layers.unshift({ pull: current.pull, root: current.root, oldBase, oldBaseRef: ref });

    if (ref === targetRef) break;
    if (source.pull.merged) {
      if (targetRef === defaultBranch && source.pull.baseRef === defaultBranch) break;
      throw new Unresolvable('UNSUPPORTED_HISTORY', `#${source.pull.number} was merged into ${source.pull.baseRef}, not ${defaultBranch}`);
    }
    current = await loadRoot(source.pull.number);
  }

  const newBase = resolvePoint(git, top.pull.head.sha, reachable(git, target, top.pull.head.sha));
  return { layers, newBase, parentPr: target.pull && target.pull.open ? target.pull.number : null };
}

module.exports = { buildLayers, Unresolvable };
