# Agent Guidance

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for project setup, validation, changelog,
and pull-request expectations.

## Fork-first Git workflow

- Verify remotes before changing branches: `origin` should be the user's fork and
  `upstream` should be the parent repository.
- Treat `origin/main` as the user's product baseline. Fork development continues
  without waiting for upstream acceptance.
- Do not commit feature work directly to `main`, rewrite shared `main`, or
  force-push it.
- Start each feature branch from an updated `origin/main`, make reviewable
  commits, and open the feature PR against the fork's `main`.
- Prefer squash-merging fork PRs so `main` receives one logical commit per
  feature. Multiple work-in-progress commits are fine on the feature branch.

## Preparing upstream contributions

- Upstream submissions are manual and user-owned. Do not create, reopen, edit,
  or submit upstream PRs, issues, comments, or reviews. Stop after preparing and
  pushing the candidate branch to `origin`.
- Do not use the fork's `main` as an upstream PR branch after it has diverged.
- Create a dedicated candidate branch from the latest `upstream/main`.
- Cherry-pick or reconstruct only the feature commits intended for upstream.
  Exclude fork merge commits and unrelated fork-only changes.
- Squash fixups into the commit that owns the behavior, but keep independently
  reviewable features as separate logical commits.
- Verify the candidate branch's diff, tests, build, and intended final tree
  before pushing it to `origin` for the user to submit manually.
- Upstream review or acceptance must not block continued development on the
  fork.

## Syncing upstream changes

- Integrate upstream changes into the fork through a dedicated sync branch and
  fork PR.
- Avoid rebasing or force-pushing the shared fork `main`.
- After upstream accepts related work, sync `upstream/main` back into the fork
  before building dependent features.
