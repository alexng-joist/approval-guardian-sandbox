'use strict';

const TIMELINE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $cursor, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, REVIEW_DISMISSED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } }
          ... on BaseRefChangedEvent { previousRefName currentRefName createdAt }
          ... on ReviewDismissedEvent { previousReviewState dismissalMessage review { databaseId } pullRequestCommit { commit { oid } } }
        }
      }
    }
  }
}`;

function createApi(github, { owner, repo }) {
  const timelines = new Map();
  const pulls = new Map();

  async function getPull(number, { fresh = false } = {}) {
    if (fresh || !pulls.has(number)) {
      pulls.set(number, (await github.rest.pulls.get({ owner, repo, pull_number: number })).data);
    }
    return pulls.get(number);
  }

  const listReviews = (number) =>
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });

  async function getTimeline(number) {
    if (timelines.has(number)) return timelines.get(number);
    const timeline = { forcePushes: [], baseChanges: [], dismissals: [] };
    let cursor = null;
    do {
      const data = await github.graphql(TIMELINE_QUERY, { owner, name: repo, number, cursor });
      const items = data.repository.pullRequest.timelineItems;
      for (const node of items.nodes) {
        if (node.__typename === 'HeadRefForcePushedEvent') {
          timeline.forcePushes.push({ before: node.beforeCommit && node.beforeCommit.oid, after: node.afterCommit && node.afterCommit.oid });
        } else if (node.__typename === 'BaseRefChangedEvent') {
          timeline.baseChanges.push({ previous: node.previousRefName, current: node.currentRefName, at: node.createdAt });
        } else if (node.__typename === 'ReviewDismissedEvent' && node.review) {
          timeline.dismissals.push({
            reviewId: node.review.databaseId,
            previousState: node.previousReviewState,
            staleCommit: node.pullRequestCommit ? node.pullRequestCommit.commit.oid : null,
            message: node.dismissalMessage,
          });
        }
      }
      cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
    } while (cursor);
    timelines.set(number, timeline);
    return timeline;
  }

  async function getCodeowners(ref) {
    try {
      const { data } = await github.rest.repos.getContent({ owner, repo, path: '.github/CODEOWNERS', ref });
      return Buffer.from(data.content, data.encoding).toString('utf8');
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  const findPullsByHead = (ref) =>
    github.paginate(github.rest.pulls.list, { owner, repo, state: 'all', head: `${owner}:${ref}`, per_page: 100 });

  const listChildren = (ref) =>
    github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base: ref, per_page: 100 });

  async function listRecentlyMerged(ref) {
    const { data } = await github.rest.pulls.list({ owner, repo, state: 'closed', base: ref, sort: 'updated', direction: 'desc', per_page: 100 });
    return data.filter((p) => p.merged_at);
  }

  const listComments = (number) =>
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });

  const createComment = async (number, body) => (await github.rest.issues.createComment({ owner, repo, issue_number: number, body })).data;

  const dispatchGuardian = (number, ref) => github.rest.actions.createWorkflowDispatch({
    owner, repo, workflow_id: 'approval-guardian.yml', ref, inputs: { pr_number: String(number) },
  });

  const createCheckRun = async (params) => (await github.rest.checks.create({ owner, repo, ...params })).data;

  return { createCheckRun, dispatchGuardian, listRecentlyMerged, getPull, listReviews, getTimeline, getCodeowners, findPullsByHead, listChildren, listComments, createComment };
}

function createBotApi({ token, apiUrl, owner, repo, fetch }) {
  async function request(method, route, body) {
    const response = await fetch(`${apiUrl}/repos/${owner}/${repo}/${route}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${method} ${route} failed with ${response.status}: ${data && data.message}`);
    return data;
  }

  return {
    approve: (number, commitId, body) =>
      request('POST', `pulls/${number}/reviews`, { commit_id: commitId, event: 'APPROVE', body }),
    dismiss: (number, reviewId, message) =>
      request('PUT', `pulls/${number}/reviews/${reviewId}/dismissals`, { message, event: 'DISMISS' }),
  };
}

module.exports = { createApi, createBotApi };
