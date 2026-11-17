import type { Outcome } from './types.ts';

export interface Github {
  repository: string;
  token: string;
  assignees: string[];
  runUrl?: string;
  fetch: typeof fetch;
  now(): Date;
}

interface Issue {
  number: number;
  title: string;
  pull_request?: unknown;
}

async function call(github: Github, method: string, path: string, body?: unknown, tolerate?: number): Promise<unknown> {
  const response = await github.fetch(`https://api.github.com/repos/${github.repository}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${github.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && response.status !== tolerate) {
    throw new Error(`GitHub answered ${String(response.status)} to ${method} ${path}`);
  }
  return response.json();
}

/** The titles Upptime's issues carry, so the page and its incident list read the same. */
export function titleOf(name: string, state: 'degraded' | 'down'): string {
  return state === 'down' ? `🛑 ${name} is down` : `⚠️ ${name} has degraded performance`;
}

/**
 * Opens the check's `status` issue when it is down or degraded, retitles it when that changes, and closes it with a comment
 * when the check is up again: what Upptime does for its own checks. Issues are found by the labels `status` and the check's slug.
 */
export async function syncIssue(github: Github, check: { name: string; slug: string }, outcome: Outcome): Promise<'opened' | 'updated' | 'closed' | 'unchanged'> {
  const labels = `status,${check.slug}`;
  const open = ((await call(github, 'GET', `/issues?labels=${encodeURIComponent(labels)}&state=open&per_page=10`)) as Issue[]).filter((issue) => !issue.pull_request);
  const issue = open[0];
  const when = github.now().toISOString();
  const run = github.runUrl ? ` ([run](${github.runUrl}))` : '';
  if (outcome.state === 'up') {
    if (!issue) {
      return 'unchanged';
    }
    await call(github, 'POST', `/issues/${String(issue.number)}/comments`, { body: `**Resolved:** ${check.name} is back up at ${when}${run}.` });
    await call(github, 'PATCH', `/issues/${String(issue.number)}`, { state: 'closed', state_reason: 'completed' });
    return 'closed';
  }
  const title = titleOf(check.name, outcome.state);
  if (!issue) {
    // The check's own label must exist, or the next run cannot find the issue by it: made here, and 422 means it is there already.
    await call(github, 'POST', '/labels', { name: check.slug, color: 'ededed', description: 'An incident the status checks opened' }, 422);
    await call(github, 'POST', '/issues', {
      title,
      labels: ['status', check.slug],
      assignees: github.assignees,
      body: `${check.name} was **${outcome.state}** at ${when}${run}.\n\n- What failed: ${outcome.detail}\n`,
    });
    return 'opened';
  }
  if (issue.title === title) {
    return 'unchanged';
  }
  await call(github, 'PATCH', `/issues/${String(issue.number)}`, { title });
  await call(github, 'POST', `/issues/${String(issue.number)}/comments`, { body: `${check.name} is now **${outcome.state}** at ${when}${run}.\n\n- What failed: ${outcome.detail}` });
  return 'updated';
}
