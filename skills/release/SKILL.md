---
name: release
description: Generic release assistant — analyzes repo release rules, caches them in .omc/RELEASE_RULE.md, then guides the release
level: 3
---

# Release Skill

A thin, repo-aware release assistant. On first run it inspects the project and CI to derive release rules, stores them in `.omc/RELEASE_RULE.md` for future use, then walks you through a release using those rules.

## Usage

```
/oh-my-claudecode:release [version]
```

- `version` is optional. If omitted the skill will ask. Accepts `patch`, `minor`, `major`, or an explicit semver like `2.4.0`.
- Add `--refresh` to force re-analysis of the repo even when a cached rule file exists.

## Execution Flow

### Step 0 — Load or Build Release Rules

Check whether `.omc/RELEASE_RULE.md` exists.

**If it does NOT exist (or `--refresh` was passed):** Run the full repo analysis below and write the file.

**If it DOES exist:** Read the file. Then do a quick delta check — scan `.github/workflows/` (or equivalent CI dirs: `.circleci/`, `.travis.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml`, `gitlab-ci.yml`) for any modifications newer than the `last-analyzed` timestamp in the rule file. If relevant workflow files changed, re-run the analysis for those sections and update the file. Report what changed.

---

### Step 1 — Repo Analysis (first run or --refresh)

Inspect the repo and answer the following. Write answers into `.omc/RELEASE_RULE.md`.

#### 1a. Version Sources

- Locate all files that contain a version string matching the current version in `package.json` / `pyproject.toml` / `Cargo.toml` / `build.gradle` / `VERSION` file / etc.
- List each file and the field or regex pattern used to find the version.
- Detect whether there is a release automation script (e.g. `scripts/release.*`, `Makefile release` target, `bump2version`, `release-it`, `semantic-release`, `changesets`, `goreleaser`).

#### 1b. Registry / Distribution

- npm (`package.json` with `publishConfig` or `npm publish` in CI), PyPI (`pyproject.toml` + `twine`/`flit`), Cargo (`Cargo.toml`), Docker (`Dockerfile` + push step), GitHub Packages, other.
- Is there a CI step that publishes automatically on tag push? Which workflow file and job?

#### 1c. Release Trigger

- Identify what starts the release: tag push (`v*`), manual dispatch (`workflow_dispatch`), merge to main/master, a release branch merge, a commit message pattern.

#### 1d. Test Gate

- Identify the test command and where it runs in CI.
- Are tests required to pass before publish? Note any bypass flags.

#### 1e. Release Notes / Changelog

- Does a `CHANGELOG.md` or `CHANGELOG.rst` exist?
- What convention is used: Keep a Changelog, Conventional Commits, GitHub auto-generated, none?
- Is there a release body file (e.g. `.github/release-body.md`) committed pre-tag?

#### 1f. First-Time User Check

- Does a release workflow exist in `.github/workflows/` (or equivalent)? If not, flag this and offer to scaffold one.
- Is there a `.gitignore` entry preventing build artifacts from being committed? If not, flag it.
- Are git tags being used? Run `git tag --list` to check. If no tags exist, flag and explain best practice.

---

### Step 2 — Write `.omc/RELEASE_RULE.md`

Create or overwrite the file with this structure:

```markdown
# Release Rules
<!-- last-analyzed: YYYY-MM-DDTHH:MM:SSZ -->

## Version Sources
<!-- list of files + patterns -->

## Release Trigger
<!-- what kicks off the release -->

## Test Gate
<!-- command + CI job name -->

## Registry / Distribution
<!-- npm, PyPI, Docker, etc. + CI job that publishes -->

## Release Notes Strategy
<!-- convention + files -->

## CI Workflow Files
<!-- paths to relevant workflow files -->

## First-Time Setup Gaps
<!-- any missing pieces found during analysis, or "none" -->
```

---

### Step 3 — Determine Version

If the user provided a version argument, use it. Otherwise:

1. Show the current version (from the primary version file).
2. Show what `patch`, `minor`, and `major` would produce.
3. Ask the user which to use.

Validate the chosen version is a valid semver string.

---

### Step 4 — Pre-Release Checklist

Present a checklist derived from the release rules. At minimum:

- [ ] All changes intended for this release are committed and pushed
- [ ] CI is green on the target branch
- [ ] Tests pass locally (run the test gate command)
- [ ] Version bump applied to all version source files
- [ ] Release notes / changelog prepared (see Step 5)

Ask the user to confirm before proceeding, or run each step if they say "go ahead".

---

### Step 5 — Release Notes Guidance

Help the user write good release notes. Apply whichever convention the repo uses. Default guidance when no convention is detected:

**What makes a good release note:**
- Lead with **what changed for users**, not internal implementation details.
- Group by type: `New Features`, `Bug Fixes`, `Breaking Changes`, `Deprecations`, `Internal / Chores`.
- For each item: one sentence, link to the PR or issue, credit the author if external.
- **Breaking changes** go first and must include a migration path.
- Omit changes users never see (refactors, CI tweaks, test-only changes) unless they affect build reproducibility.

**Example entry format:**
```
### Bug Fixes
- Fix session drop on token expiry (#123) — @contributor
```

If the repo uses Conventional Commits, generate a draft changelog from `git log <prev-tag>..HEAD --no-merges --format="%s"` grouped by commit type. Show it to the user and let them edit.

---

### Step 6 — Execute Release

Using the rules discovered, walk through:

1. **Bump version** — apply to each version source file.
2. **Run tests** — execute the test gate command.
3. **Commit** — `git add <version files> CHANGELOG.md` and commit with `chore(release): bump version to vX.Y.Z`.
4. **Tag** — `git tag -a vX.Y.Z -m "vX.Y.Z"` (annotated tags are preferred over lightweight).
5. **Push** — `git push origin <branch> && git push origin vX.Y.Z`.
6. **CI takes over** — if the release trigger is a tag push, remind the user that CI will handle the rest (publish, GitHub release creation). Show the expected CI workflow file.
7. **Manual publish** — if no CI automation exists, list the manual publish command (e.g. `npm publish --access public`, `twine upload dist/*`).

---

### Step 7 — First-Time Setup Suggestions

If gaps were found in Step 1f, offer concrete help:

**No release workflow:**
> Your repo doesn't have a release CI workflow. A GitHub Actions workflow triggered on `v*` tag push is the most common best practice. It can:
> - Run tests
> - Publish to npm/PyPI/etc.
> - Create a GitHub Release with your release notes
>
> Want me to scaffold a `.github/workflows/release.yml` for your stack?

**No git tags:**
> This appears to be the first release. Git tags let GitHub, npm, and other tools understand your version history. We'll create your first tag in Step 6.

**Build artifacts not gitignored:**
> Build artifacts are present in git history or not gitignored. This inflates repo size and creates merge conflicts. Want me to add them to `.gitignore`?

---

### Step 8 — Verify

After the push:
- Check CI status: `gh run list --workflow=<release workflow> --limit=3` (if `gh` is available).
- Check the registry (npm, PyPI) for the new version after a few minutes.
- Confirm a GitHub Release was created: `gh release view vX.Y.Z`.

Report success or flag any failures.

---

## Notes

- This skill does **not** hardcode any project-specific version files or commands. Everything is derived from repo inspection.
- `.omc/RELEASE_RULE.md` is a local cache. Commit it to your repo if you want to share the derived rules with your team, or add it to `.gitignore` if you prefer it stays local.
- For complex monorepos or multi-package workspaces, the skill will detect workspace patterns (npm workspaces, pnpm workspaces, Cargo workspace) and adapt accordingly.
