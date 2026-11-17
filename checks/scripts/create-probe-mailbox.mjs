#!/usr/bin/env node
// Creates the probe account's mailbox on mail.tm and stores its login as the repository secrets PROBE_MAIL_ADDRESS and
// PROBE_MAIL_PASSWORD, through the GitHub CLI signed in as someone who may set secrets here. The password is never printed;
// the address is, because the probe account is created with it.
//
// Usage: node checks/scripts/create-probe-mailbox.mjs <owner>/<repository>
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const repository = process.argv[2];
if (!repository) {
  throw new Error('Usage: node create-probe-mailbox.mjs <owner>/<repository>');
}
const api = 'https://api.mail.tm';
const [domain] = (await (await fetch(`${api}/domains`)).json())['hydra:member'].filter((entry) => entry.isActive);
const address = `status-probe-${randomBytes(6).toString('hex')}@${domain.domain}`;
const password = randomBytes(24).toString('base64url');
const created = await fetch(`${api}/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, password }) });
if (!created.ok) {
  throw new Error(`mail.tm refused the mailbox: ${String(created.status)}`);
}
for (const [name, value] of [['PROBE_MAIL_ADDRESS', address], ['PROBE_MAIL_PASSWORD', password]]) {
  execFileSync('gh', ['secret', 'set', name, '--repo', repository], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
}
console.log(`Mailbox created. The probe account's email is ${address}`);
