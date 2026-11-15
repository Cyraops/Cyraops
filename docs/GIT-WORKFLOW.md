# Git workflow: dev → release → production

Three long-lived branches, one direction of travel. `production` is what is live on
`www.cyraops.com`, and nothing else should ever be described as production.

```
feature/*  ──merge──▶  dev  ──fast-forward──▶  release  ──fast-forward──▶  production
                         │                        │                          │
                     integration              verification                live traffic
```

`dev` is the default branch. Work is written there, verified in `release`, and only then
promoted to `production`.

---

## 1. Start a change

```bash
git switch dev
git pull --ff-only
git switch -c feature/short-name
```

## 2. Prepare it

```bash
npm run typecheck
npm run test:unit
npm run test:jobs
cd site-3d && node audit.mjs && cd ..     # only if the marketing site changed
```

Do not open the pull request while any of these is red. A failing `dev` blocks every other
change.

## 3. Merge into dev

```bash
git switch dev
git merge --no-ff feature/short-name
git push origin dev
git branch -d feature/short-name
```

## 4. Cut a release candidate

`release` only ever moves forward to a commit that has already passed on `dev`.

```bash
git switch release
git merge --ff-only dev
git push origin release
```

Now verify on `release`: build it, run the full suite again, and check the marketing site at
1440px and 390px. Fixes discovered here go onto `dev` first, then forward —
never commit directly to `release` except an emergency fix that is also cherry-picked back.

## 5. Promote to production

```bash
git switch production
git merge --ff-only release
git push origin production
```

Then deploy the commit you just promoted:

```bash
npm run build
TAG="prod-$(git rev-parse --short HEAD)"
az acr build --registry cyraopsacr569002 --image "cyraops:$TAG" --file Dockerfile .
az containerapp update --name cyraops-prod-app --resource-group cyraops-prod \
  --image cyraopsacr569002.azurecr.io/cyraops:$TAG \
  --revision-suffix "$(git rev-parse --short HEAD)"
curl -s https://www.cyraops.com/api/health
```

Expected: `{"status":"ok","database":"connected"}`. If it is not healthy, roll back before
doing anything else.

## 6. Tag what shipped

```bash
git tag -a "v$(date +%Y.%m.%d)" -m "Production release: <one line>"
git push origin "v$(date +%Y.%m.%d)"
```

Tags are the record of what was live and when. Without them, "which commit is in production?"
becomes a guess.

---

## Hotfixing production

1. Branch from `production`:
   ```bash
   git switch production && git pull --ff-only
   git switch -c hotfix/broken-checkout
   ```
2. Make the smallest change that fixes the problem. Add a test that fails without it.
3. Verify, then merge **into production** and deploy.
4. Immediately bring the fix back so it is not lost:
   ```bash
   git switch release && git merge --ff-only production
   git switch dev   && git merge --no-ff production
   ```
   A hotfix that exists only on `production` is a future regression.

---

## Rolling back

**Code only** (most common) — point the container at the previous image tag:

```bash
az containerapp revision list -n cyraops-prod-app -g cyraops-prod \
  --query "[].{name:name, image:properties.template.containers[0].image, active:properties.active}" -o table
az containerapp update -n cyraops-prod-app -g cyraops-prod --image <previous-tag>
```

Then revert the commit on `production` so the branch matches what is live:

```bash
git switch production
git revert --no-edit <sha>
git switch release && git merge --ff-only production
git switch dev && git merge --no-ff production
```

**Database** — migrations are additive, so a code rollback does not require a schema
rollback. If a migration itself must be undone, take a dump first (`infra/STOP-RESTART.md`
covers backups) and prefer a forward fix.

---

## Rules that prevent most incidents

1. `release` and `production` only move forward to commits that already passed on `dev`.
2. Deploy from a tagged commit, not from a working tree with uncommitted changes.
3. Never amend or force-push `release` or `production`.
4. Marketing-site changes are only "done" when `node audit.mjs` reports zero problems at both
   1440px and 390px.
5. A database migration is part of the release it ships with, not a follow-up.
