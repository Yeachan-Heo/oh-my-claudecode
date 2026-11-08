# Metadata Sync System

## Overview

The metadata sync system ensures consistency between `package.json` (source of truth) and all documentation files across the project. It prevents version drift, outdated badges, and manual update errors.

## Why We Need This

### The Problem

In a typical project lifecycle:

1. Developer bumps version in `package.json` to `3.5.0`
2. Creates a release commit
3. **Forgets** to update version badge in `README.md` (still shows `3.4.0`)
4. **Forgets** to update version header in `docs/REFERENCE.md`
5. **Forgets** to update agent count in `.github/CLAUDE.md` after adding new agents
6. Users see inconsistent version information across documentation
7. CI builds look professional but contain stale metadata

**Result:** Confusion, reduced trust, unprofessional appearance.

### The Solution

A single automated script that:
- Reads canonical metadata from `package.json`
- Updates all documentation files in one pass
- Can verify sync status (for CI/CD)
- Supports dry-run mode for safety
- Reports exactly what changed

## How It Works

### Source of Truth

`package.json` is the **single source of truth** for:

| Field | Used For |
|-------|----------|
| `version` | Version badges, headers, references |
| `name` | npm package links, download badges |
| `description` | Project taglines (future) |
| `keywords` | SEO metadata (future) |
| `repository.url` | GitHub links |
| `homepage` | Website links |

### Target Files

The script syncs these files:

| File | What Gets Updated |
|------|-------------------|
| `README.md` | npm version/download badges |
| `docs/REFERENCE.md` | Version badges, version headers |
| `.github/CLAUDE.md` | Agent count, skill count |
| `docs/ARCHITECTURE.md` | Version references |
| `CHANGELOG.md` | Latest version header (verify only) |

### Dynamic Metadata

Some metadata is computed, not read:

- **Agent count** - Counts `.yaml`/`.yml` files in `agents/` directory
- **Skill count** - Counts `.md` files in `skills/` directory

This ensures documentation always reflects current state.

## Usage

### Basic Sync

```bash
npm run sync-metadata
```

Syncs all files. Output:
```
📦 Metadata Sync System
========================

Version: 3.5.0
Package: oh-my-claudecode
Agents: 32
Skills: 45

✓ README.md
  - npm version badge

✓ docs/REFERENCE.md
  - Version badge
  - Version header

✓ .github/CLAUDE.md
  - Agent count
  - Slash command count

✅ Successfully synced 3 file(s)!
```

### Dry Run (Preview Changes)

```bash
npm run sync-metadata -- --dry-run
```

Shows what **would** change without writing files:

```
🔍 DRY RUN MODE - No files will be modified

📝 README.md
  - npm version badge

📝 docs/REFERENCE.md
  - Version badge

📊 2 file(s) would be updated
Run without --dry-run to apply changes
```

### Verify Sync (CI/CD)

```bash
npm run sync-metadata -- --verify
```

Checks if files are in sync. Exits with status code:
- `0` - All files in sync
- `1` - Files out of sync (shows which ones)

```
🔍 Verifying metadata sync...
✓ README.md
✗ docs/REFERENCE.md
  - Version badge needs update

❌ Files are out of sync!
Run: npm run sync-metadata
```

### Help

```bash
npm run sync-metadata -- --help
```

## When to Run

### Manual Workflow

Run sync **before** committing version changes:

```bash
# 1. Bump version
npm version patch

# 2. Sync metadata
npm run sync-metadata

# 3. Commit everything together
git add .
git commit -m "chore: release v3.5.0"
```

### Automated Workflow (Recommended)

Add to `package.json`:

```json
{
  "scripts": {
    "version": "npm run sync-metadata && git add ."
  }
}
```

Now `npm version patch` automatically:
1. Bumps version in `package.json`
2. Runs sync script
3. Stages synced files
4. Creates version commit

### Pre-Commit Hook

Add to `.husky/pre-commit`:

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Verify metadata is in sync
npm run sync-metadata -- --verify

if [ $? -ne 0 ]; then
  echo "❌ Metadata out of sync! Run: npm run sync-metadata"
  exit 1
fi
```

### CI/CD Pipeline

Add verification step to GitHub Actions:

```yaml
- name: Verify Metadata Sync
  run: npm run sync-metadata -- --verify
```

## How to Extend

### Adding a New Target File

Edit `scripts/sync-metadata.ts`:

```typescript
function getFileSyncConfigs(): FileSync[] {
  return [
    // ... existing configs ...
    {
      path: 'docs/NEW-FILE.md',
      replacements: [
        {
          pattern: /version \d+\.\d+\.\d+/gi,
          replacement: (m) => `version ${m.version}`,
          description: 'Version references',
        },
        {
          pattern: /\*\*\d+ features\*\*/g,
          replacement: (m) => `**${getFeatureCount()} features**`,
          description: 'Feature count',
        },
      ],
    },
  ];
}
```

### Adding Dynamic Metadata

Add a new function:

```typescript
function getFeatureCount(): number {
  const featuresDir = join(projectRoot, 'features');
  const files = readdirSync(featuresDir);
  return files.filter(f => f.endsWith('.ts')).length;
}
```

Use in replacement:

```typescript
{
  pattern: /\*\*\d+ features\*\*/g,
  replacement: () => `**${getFeatureCount()} features**`,
  description: 'Feature count',
}
```

### Adding New Metadata Sources

Extend the `Metadata` interface:

```typescript
interface Metadata {
  version: string;
  description: string;
  keywords: string[];
  repository: string;
  homepage: string;
  npmPackage: string;
  // NEW:
  author: string;
  license: string;
  engines: { node: string };
}
```

Update `loadMetadata()`:

```typescript
function loadMetadata(): Metadata {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

  return {
    // ... existing fields ...
    author: packageJson.author || '',
    license: packageJson.license || '',
    engines: packageJson.engines || { node: '>=20.0.0' },
  };
}
```

## Implementation Details

### Safe Replacement Strategy

The script uses **regex-based replacement** with safeguards:

1. **Read entire file** into memory
2. **Apply all replacements** to string
3. **Compare** original vs modified content
4. **Only write** if content changed

This prevents:
- Unnecessary file writes (preserves timestamps)
- Partial updates (atomic operation)
- Permission errors (fails before write)

### Pattern Design

Patterns are designed to be:

**Specific enough** to match only intended content:
```typescript
// GOOD - matches only npm badge
/\[!\[npm version\]\(https:\/\/img\.shields\.io\/npm\/v\/[^)]+\)/g

// BAD - too broad, matches any badge
/\[!\[[^\]]+\]\([^)]+\)/g
```

**Flexible enough** to handle variations:
```typescript
// Matches: 3.4.0, 10.0.0, 2.1.3-beta
/\d+\.\d+\.\d+(-[a-z0-9]+)?/
```

### Error Handling

The script handles:

- **Missing files** - Warns but continues
- **Invalid package.json** - Fails fast with clear error
- **Permission errors** - Reports and exits
- **Regex failures** - Reports pattern that failed

### Performance

For a typical project:
- **Files read:** 5-10
- **Execution time:** <100ms
- **Memory usage:** <10MB

Scales linearly with number of target files.

## Testing

### Manual Testing

```bash
# 1. Make a change to package.json
npm version patch

# 2. Run dry-run to preview
npm run sync-metadata -- --dry-run

# 3. Apply changes
npm run sync-metadata

# 4. Verify with git
git diff
```

### Automated Testing

The script exports functions for testing:

```typescript
import { loadMetadata, syncFile, verifySync } from './scripts/sync-metadata.js';

test('loads metadata correctly', () => {
  const metadata = loadMetadata();
  expect(metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test('syncs README badges', () => {
  const config = getFileSyncConfigs().find(c => c.path === 'README.md');
  const result = syncFile(config, mockMetadata, true, projectRoot);
  expect(result.changed).toBe(true);
});
```

## Troubleshooting

### "File not found" warnings

**Symptom:** Script reports files as not found.

**Cause:** File moved or deleted.

**Fix:** Remove from `getFileSyncConfigs()` or update path.

### "No changes detected" but files are stale

**Symptom:** Script reports no changes, but files show old version.

**Cause:** Pattern doesn't match current file format.

**Fix:** Update regex pattern to match actual content.

### Version updated but badge still old

**Symptom:** package.json has new version, badge unchanged.

**Cause:** Badge may be cached by shields.io CDN.

**Fix:** Wait 5 minutes or use `?cache=bust` parameter.

### Permission denied errors

**Symptom:** Script fails with EACCES.

**Cause:** Files are read-only or owned by different user.

**Fix:**
```bash
chmod +w docs/*.md
# or
sudo chown $USER docs/*.md
```

## Best Practices

### 1. Always dry-run first

Before releasing:
```bash
npm run sync-metadata -- --dry-run
```

Review changes, then apply.

### 2. Sync before committing

Add to your workflow:
```bash
npm run sync-metadata && git add -A
```

### 3. Use verification in CI

Catch stale docs in pull requests:
```yaml
- run: npm run sync-metadata -- --verify
```

### 4. Keep patterns maintainable

Document complex regex:
```typescript
{
  // Matches: [![Version](https://img.shields.io/badge/version-3.4.0-ff6b6b)]
  // Captures: version number only
  pattern: /\[!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-([^-]+)-[^)]+\)/g,
  replacement: (m) => `[![Version](https://img.shields.io/badge/version-${m.version}-ff6b6b)]`,
  description: 'Version badge in REFERENCE.md',
}
```

### 5. Test after package.json changes

After any change to package.json:
```bash
npm run sync-metadata -- --verify
```

## Migration Guide

If you're adding this to an existing project:

### Step 1: Audit Current State

Find all hardcoded versions:
```bash
grep -r "3\.4\.0" docs/ README.md .github/
```

### Step 2: Standardize Format

Choose consistent badge format:
```markdown
[![Version](https://img.shields.io/badge/version-3.4.0-ff6b6b)]
```

Update all instances manually.

### Step 3: Run Initial Sync

```bash
npm run sync-metadata
```

Should report "All files are already in sync".

### Step 4: Add to Workflow

Add npm script, pre-commit hook, CI verification.

### Step 5: Document for Team

Update CONTRIBUTING.md:
```markdown
## Releasing

1. Bump version: `npm version patch`
2. Sync metadata: `npm run sync-metadata`
3. Commit and tag
```

## Future Enhancements

Potential improvements:

- [ ] Support for multi-language docs (i18n)
- [ ] Sync to website/landing page
- [ ] Extract feature count from source code
- [ ] Auto-update dependency versions in docs
- [ ] Integration with release workflow
- [ ] Markdown AST-based updates (safer than regex)
- [ ] Configuration file for custom patterns
- [ ] Plugin system for custom metadata sources

## Related

- [CI/CD Pipeline](../.github/workflows/)
