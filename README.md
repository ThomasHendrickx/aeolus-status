# Aeolus status

The status page of the Aeolus fleet, at [status.aeolus-fleet.dev](https://status.aeolus-fleet.dev). It runs [Upptime](https://upptime.js.org) on GitHub Actions and GitHub Pages, outside production, so it still answers when the fleet does not.

## The checks

`.upptimerc.yml` lists them, each a public URL, checked every 5 minutes by `Uptime CI`. The fleet read check calls the fleet as a read-only probe ship, its crew token kept in the Actions secret `FLEET_PROBE_TOKEN`.

## Incidents

Each incident is an issue of this repository with the label `status`, its comments the updates. A failed check opens one by itself and closes it when the check passes again. Open one by hand, with the Incident issue template, for what the checks do not see; close it when it is resolved. Issues are assigned to ThomasHendrickx, so GitHub notifies him.

## Pinned

Every action is pinned to a commit, its version beside it; the runner image and Node.js to a version. The status page package is pinned by version and checksum in `site.yml`, its dependencies by `site/package-lock.json`. No workflow regenerates the workflows: change them by hand.

<!--start: status pages-->
<!--end: status pages-->
