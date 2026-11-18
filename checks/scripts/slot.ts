import { appendFileSync } from 'node:fs';
import { slotKey } from '../src/slot.ts';

const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, {
  headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
});
if (!response.ok) throw new Error(`Run metadata answered ${response.status}`);
const run = await response.json() as { created_at: string };
const key = slotKey(process.env.CADENCE ?? 'five', run.created_at);
appendFileSync(process.env.GITHUB_OUTPUT!, `key=${key}\n`);
