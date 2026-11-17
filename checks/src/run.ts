/**
 * Runs the checks of one cadence and opens or closes their status issues.
 *
 * Usage: node src/run.ts <five|fifteen|hourly> [--dry]    (--dry prints the results and touches no issue)
 * Environment: GITHUB_TOKEN and GITHUB_REPOSITORY for the issues; each check's own secrets, named in its file.
 */
import { realContext } from './context.ts';
import { evaluate } from './engine.ts';
import { type Github, syncIssue } from './issues.ts';
import { checks } from './registry.ts';
import { type Cadence, NotChecked, Unconfigured } from './types.ts';

const cadence = process.argv[2] as Cadence | undefined;
const dry = process.argv.includes('--dry');
if (cadence !== 'five' && cadence !== 'fifteen' && cadence !== 'hourly') {
  throw new Error('Usage: node src/run.ts <five|fifteen|hourly> [--dry]');
}

const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
const github: Github | undefined = !dry && GITHUB_TOKEN && GITHUB_REPOSITORY
  ? {
    repository: GITHUB_REPOSITORY,
    token: GITHUB_TOKEN,
    assignees: ['ThomasHendrickx'],
    runUrl: GITHUB_RUN_ID ? `${GITHUB_SERVER_URL ?? 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined,
    fetch,
    now: () => new Date(),
  }
  : undefined;
if (!dry && !github) {
  throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are needed unless --dry');
}

const context = realContext();
const selected = checks.filter((check) => check.cadence === cadence);
const results = await Promise.all(selected.map(async (check) => {
  const outcome = await evaluate(check, context);
  if (outcome instanceof NotChecked) {
    return `${check.slug}: not checked, ${outcome instanceof Unconfigured ? 'a secret it needs is not set' : outcome.message}`;
  }
  const issue = github ? await syncIssue(github, check, outcome) : 'dry';
  return `${check.slug}: ${outcome.state}, ${outcome.detail} (issue ${issue})`;
}));
console.log(results.join('\n') || `no check has the cadence ${cadence}`);
