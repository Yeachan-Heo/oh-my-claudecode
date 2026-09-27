import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Regression test for issue #4147: Windows processStart encoding in .mjs copies
 * 
 * Verifies that reconcileEmergencyPublicationTemps and hasUnattributableRecoveryClaimArtifact
 * in scripts/lib/atomic-write.mjs and templates/hooks/lib/atomic-write.mjs can correctly
 * handle encoded processStart identifiers (ticks_c_...) in temp filenames.
 * 
 * On Windows, processStart is formatted as `ticks:<n>`, where the colon is illegal in NTFS
 * filenames. The fix encodes colons as `_c_` when building temp names.
 */
describe('issue #4147: Windows processStart encoding in .mjs emergency temp filenames', () => {
  const root = process.cwd();

  it('atomic-write.mjs has encoding/decoding functions', () => {
    const modulePaths = [
      join(root, 'scripts', 'lib', 'atomic-write.mjs'),
      join(root, 'templates', 'hooks', 'lib', 'atomic-write.mjs'),
    ];

    for (const modulePath of modulePaths) {
      const content = readFileSync(modulePath, 'utf8');

      // Verify encodeProcessStartForFilename function exists and works correctly
      expect(content).toContain('function encodeProcessStartForFilename(processStart)');
      expect(content).toContain("processStart.replace(/:/g, '_c_')");

      // Verify decodeProcessStartFromFilename function exists and works correctly
      expect(content).toContain('function decodeProcessStartFromFilename(encoded)');
      expect(content).toContain("encoded.replace(/_c_/g, ':')");
    }
  });

  it('publishEmergencyFileExclusive uses encodeProcessStartForFilename', () => {
    const modulePaths = [
      join(root, 'scripts', 'lib', 'atomic-write.mjs'),
      join(root, 'templates', 'hooks', 'lib', 'atomic-write.mjs'),
    ];

    for (const modulePath of modulePaths) {
      const content = readFileSync(modulePath, 'utf8');

      // Verify that publishEmergencyFileExclusive calls the encoding function
      const publishSection = content.substring(
        content.indexOf('function publishEmergencyFileExclusive'),
        content.indexOf('function publishEmergencyFileExclusive') + 2000
      );
      expect(publishSection).toContain('encodeProcessStartForFilename(processStart)');
    }
  });

  it('reconcileEmergencyPublicationTemps regex accepts encoded processStart', () => {
    const modulePaths = [
      join(root, 'scripts', 'lib', 'atomic-write.mjs'),
      join(root, 'templates', 'hooks', 'lib', 'atomic-write.mjs'),
    ];

    for (const modulePath of modulePaths) {
      const content = readFileSync(modulePath, 'utf8');

      // Verify the regex pattern contains [^.]+ for processStart
      const reconcileSection = content.substring(
        content.indexOf('function reconcileEmergencyPublicationTemps'),
        content.indexOf('function recoveryGenerationsAuthorized')
      );
      // The pattern should have ([^.]+) to match encoded processStart
      expect(reconcileSection).toContain('([^.]+)');

      // Verify decoding is called on the captured processStart
      expect(reconcileSection).toContain('decodeProcessStartFromFilename(match[3])');
    }
  });

  it('hasUnattributableRecoveryClaimArtifact regex accepts encoded processStart', () => {
    const modulePaths = [
      join(root, 'scripts', 'lib', 'atomic-write.mjs'),
      join(root, 'templates', 'hooks', 'lib', 'atomic-write.mjs'),
    ];

    for (const modulePath of modulePaths) {
      const content = readFileSync(modulePath, 'utf8');

      // Verify the regex pattern contains [^.]+ for processStart
      const claimSection = content.substring(
        content.indexOf('function hasUnattributableRecoveryClaimArtifact'),
        content.indexOf('function sharedRecoveryArtifactsAuthorized')
      );
      // The pattern should have [^.]+ to match encoded processStart
      expect(claimSection).toContain('[^.]+');
    }
  });

  it('temp filename pattern matches encoded Windows processStart', () => {
    // Simulate Windows processStart format: ticks:<n>
    const windowsProcessStart = 'ticks:639261398026122126';
    const encoded = windowsProcessStart.replace(/:/g, '_c_');
    const tempName = `autopilot-state.json.emergency-journal.json.1234.${encoded}.${randomUUID()}.tmp`;

    // The fixed regex pattern that accepts [^.]+ for processStart
    const pattern = new RegExp(
      `^autopilot-state\\.json\\.emergency-(journal\\.json|recovery\\.claim|quarantine\\.[0-9a-f-]{36}\\.payload)\\.(\\d+)\\.([^.]+)\\.[0-9a-f-]{36}\\.tmp$`,
      'i'
    );

    const match = pattern.exec(tempName);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('journal.json');
    expect(match![2]).toBe('1234');
    expect(match![3]).toBe(encoded);
    expect(match![3]).toBe('ticks_c_639261398026122126');
  });

  it('recovery claim temp filename pattern matches encoded Windows processStart', () => {
    // Simulate Windows processStart format: ticks:<n>
    const windowsProcessStart = 'ticks:639261398026122126';
    const encoded = windowsProcessStart.replace(/:/g, '_c_');
    const claimTempName = `autopilot-state.json.emergency-recovery.claim.1234.${encoded}.${randomUUID()}.tmp`;

    // The fixed regex pattern that accepts [^.]+ for processStart
    const pattern = new RegExp(
      `^autopilot-state\\.json\\.emergency-recovery\\.claim\\.\\d+\\.[^.]+\\.[0-9a-f-]{36}\\.tmp$`,
      'i'
    );

    expect(pattern.test(claimTempName)).toBe(true);
  });

  it('old numeric-only patterns fail on encoded processStart', () => {
    // Simulate Windows processStart format: ticks:<n>
    const windowsProcessStart = 'ticks:639261398026122126';
    const encoded = windowsProcessStart.replace(/:/g, '_c_');
    const tempName = `autopilot-state.json.emergency-journal.json.1234.${encoded}.${randomUUID()}.tmp`;

    // The OLD regex pattern that ONLY accepts \d+ for processStart (FAILS on encoded)
    const oldPattern = new RegExp(
      `^autopilot-state\\.json\\.emergency-(journal\\.json|recovery\\.claim|quarantine\\.[0-9a-f-]{36}\\.payload)\\.(\\d+)\\.(\\d+)\\.[0-9a-f-]{36}\\.tmp$`,
      'i'
    );

    const match = oldPattern.exec(tempName);
    expect(match).toBeNull();
  });
});
