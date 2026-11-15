# Contributing

## Branches

Three long-lived branches. Work flows in one direction.

| Branch | What it is | Who commits to it |
|---|---|---|
| `dev` | Integration. Everything lands here first. **Default branch.** | Direct work, or merged feature branches |
| `release` | A candidate build being verified. Frozen except for fixes found in testing | Fast-forward from `dev`, then fixes only |
| `production` | Exactly what is deployed to `www.cyraops.com` | Fast-forward from `release` only |

Never commit directly to `release` or `production` except a verified hotfix. If you are on
`production` and typing a feature, you are on the wrong branch.

Full commands, including rollback and hotfix flows: [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md).

## Work on a feature

```bash
git switch dev
git pull
git switch -c feature/lead-scoring
# ... work ...
npm run typecheck && npm run test:unit && npm run test:jobs
git commit -m "feat(leads): deterministic score with provenance"
git switch dev && git merge --no-ff feature/lead-scoring
```

Delete the feature branch after it merges. Keep `dev` green: a red `dev` blocks everyone.

## Commit messages

`type(scope): what changed` — present tense, why over how.

| Type | Use for |
|---|---|
| `feat` | A new capability |
| `fix` | A bug fix |
| `refactor` | Restructuring with no behaviour change |
| `docs` | Documentation only |
| `test` | Tests only |
| `chore` | Dependencies, config, tooling |
| `perf` | Performance work |

Scope is the area: `crm`, `assistant`, `agents`, `tickets`, `site`, `infra`, `prisma`.

Examples:

```
feat(tickets): create tickets from an @tasks message in chat
fix(assistant): keep assistant turns in conversation history
docs(git): document the dev → release → production path
```

One logical change per commit. Do not mix a refactor with a feature — it makes the rollback
decision harder than it needs to be.

## Before you commit

All four must pass:

```bash
npm run typecheck          # tsc --noEmit
npm run test:unit          # unit suite
npm run test:jobs          # end-to-end job suites (needs a *_test database)
cd site-3d && node audit.mjs   # if you touched the marketing site
```

`test:jobs` requires a dedicated test database. Create one with
`CYRAOPS_TEST_DB=cyraops_test_j9 node scripts/make-test-db.mjs`, apply migrations, then run.
The harness refuses any database whose name does not look like a test database, because
`resetDb()` truncates every table.

## What never gets committed

- `.env`, `config/*.yaml`, any `*.key`, `*.pem`, `*.cert` — secrets
- `node_modules/`, `.next/`, `dist/`, `marketing-deploy/` — build output
- `backups/` and `*.dump` — database dumps contain customer data
- `uploads/`, `public/browser-screenshots/` — runtime data
- `*.log`, `dev-server.log`

Check before pushing:

```bash
git status --short
git diff --cached --name-only | grep -E '(\.env|\.key|\.pem)$' && echo "STOP: secret staged"
```

If a secret is committed: **rotate it first**, then rewrite history. Deleting it in a later
commit leaves it in the log forever.


## Hooks (installed per clone)

This repository ships its own git hooks. They are not optional decoration — they are the
guardrail for the two mistakes that are expensive to undo.

```bash
./scripts/install-git-hooks.sh     # once per clone
```

| Hook | What it blocks | Why |
|---|---|---|
| `pre-commit` | `.env`, `*.key`, `*.pem`, `config/*.yaml`, provider tokens (`github_pat_`, `ghp_`, `sk-`, `AKIA`), private keys, connection strings with an inline password, any file over 2 MB | A credential in one commit is in history forever, and rotating it is the only real fix |
| `pre-push` | A failed `npm run typecheck`, when pushing to `dev`, `release` or `production` | Broken code must not reach a long-lived branch |

Both are bypassable with `--no-verify`. That is deliberate: a hook that cannot be bypassed
in an emergency gets disabled permanently, and then protects nothing.

## The loop, in one screen

```bash
# 1. start from dev
git switch dev && git pull --ff-only
git switch -c feature/short-name

# 2. work, then prove it
npm run typecheck && npm run test:unit && npm run test:jobs
cd site-3d && node audit.mjs && cd ..     # only if the marketing site changed

# 3. land on dev
git switch dev && git merge --no-ff feature/short-name && git push

# 4. promote a verified candidate
git switch release && git merge --ff-only dev && git push

# 5. ship it
git switch production && git merge --ff-only release && git push
git tag -a v$(date +%Y.%m.%d) -m "Production release: <one line>" && git push origin --tags
```

Deploying after step 5: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Branch protection on the remote (not available on this plan)

GitHub only offers branch protection and rulesets for **private** repositories on a paid
plan. This repository is private on a free account, so both the protection API and the
rulesets API return `403: Upgrade to GitHub Pro or make this repository public`.

What that means in practice:

- Force-push and branch-deletion protection on `release` and `production` is **not enforced
  by GitHub today**. It is enforced by discipline and by the `pre-push` hook above.
- To get the server-side lock, either upgrade the account to GitHub Pro (~$4/month) or make
  the repository public. Then enable protection on `release` and `production`:
  *Settings → Branches → Add branch protection rule* with **Allow force pushes** and
  **Allow deletions** both off.

Do not describe these branches as "protected" until that is actually on.

## Review checklist

- [ ] Typecheck, unit tests and job suites pass
- [ ] New behaviour has a test that would fail without the change
- [ ] No secrets, no build output, no dumps in the diff
- [ ] If the marketing site changed: `node audit.mjs` reports 0 problems, and the change is
      verified at 1440px and 390px
- [ ] If a migration was added: it is additive and applies cleanly on an empty database
- [ ] Commit message says *why*, not just *what*
