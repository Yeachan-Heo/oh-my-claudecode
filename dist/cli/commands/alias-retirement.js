/**
 * Alias retirement CLI — Issue #3711 / Epic #3698.
 *
 * Read-only, deterministic verifier + closure reporter. Never deletes files.
 * Retire ONLY after (2 minors AND 90 days) AND (>=95% canonical share for 2
 * consecutive releases) AND (zero critical integrations). Otherwise the
 * receipt's `extensionReceipt` is true and blockers explain why.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ALIAS_REGISTRY, assertAliasRegistryIntegrity } from '../../alias-retirement/registry.js';
import { verifyAllAliases, summarizeReceipts } from '../../alias-retirement/verifier.js';
import { buildClosureReport, summarizeClosureForEvidence } from '../../alias-retirement/closure.js';
export const ALIAS_RETIREMENT_HELP = `omc alias-retirement - Alias retirement verifier and generated-closure inventory (issue #3711)

Usage:
  omc alias-retirement verify [options]   Verify all aliases against the retirement contract (default)
  omc alias-retirement help               Show this help

Options:
  --json                                 Machine-readable JSON output
  --out <path>                           Write receipts JSON to file (implies --json content)
  --current-version <semver>             Override current package version (default: package.json)
  --now <ISO-8601>                       Override evaluation time (default: now)
  --usage-history <json|path>            Mapping alias -> [{aliasCount,canonicalCount}, ...] (oldest->newest)
  --critical-integrations <json|path>    Mapping alias -> string[] of known critical consumers
  --check-eligible                       Exit 2 when any alias is eligible (for future deletion PRs)

Contract (all must be true to retire):
  1) >=2 minor releases AND >=90 days since alias introduction (whichever is longer)
  2) >=95% canonical share for 2 consecutive releases (per-alias, last 2 samples)
  3) zero known critical integrations using the alias

Otherwise an extension receipt is emitted; no alias or generated projection is removed here.
Evidence:
  Receipts are machine-readable (schemaVersion, checks, blockers, nextEligibleDate/Version).
  Generated-closure report lists alias-owned projection paths that become deletable only after eligibility.
`;
function hasFlag(args, flag) {
    return args.includes(flag);
}
function readValue(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1)
        return undefined;
    const next = args[idx + 1];
    if (!next || next.startsWith('--'))
        return undefined;
    return next;
}
function readJsonMaybePath(raw) {
    if (!raw)
        return undefined;
    // Try as file first if it looks like a path
    const looksLikePath = raw.endsWith('.json') ||
        raw.includes('/') ||
        raw.includes('\\') ||
        /^[\w.-]+\.json$/.test(raw);
    if (looksLikePath) {
        try {
            const text = readFileSync(raw, 'utf-8');
            return JSON.parse(text);
        }
        catch {
            // fall through to inline JSON parse
        }
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new Error(`invalid JSON for ${raw.slice(0, 80)}`);
    }
}
function parseUsageHistory(raw) {
    const parsed = readJsonMaybePath(raw);
    if (!parsed)
        return undefined;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--usage-history must be a JSON object mapping alias -> array');
    }
    for (const [k, v] of Object.entries(parsed)) {
        if (!Array.isArray(v))
            throw new Error(`usageHistory for ${k} must be an array`);
    }
    return parsed;
}
function parseCriticalIntegrations(raw) {
    const parsed = readJsonMaybePath(raw);
    if (!parsed)
        return undefined;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--critical-integrations must be a JSON object mapping alias -> string[]');
    }
    for (const [k, v] of Object.entries(parsed)) {
        if (!Array.isArray(v))
            throw new Error(`criticalIntegrations for ${k} must be an array`);
    }
    return parsed;
}
export async function aliasRetirementCommand(args) {
    const sub = args[0];
    if (sub === 'help' || sub === '--help' || sub === '-h') {
        console.log(ALIAS_RETIREMENT_HELP);
        return;
    }
    // Normalize: allow `verify` or no subcommand
    const verifyArgs = sub === 'verify' ? args.slice(1) : args;
    if (verifyArgs.includes('--help') || verifyArgs.includes('-h')) {
        console.log(ALIAS_RETIREMENT_HELP);
        return;
    }
    const integrity = assertAliasRegistryIntegrity();
    if (integrity.length > 0) {
        console.error('alias registry integrity failed:');
        for (const e of integrity)
            console.error(`- ${e}`);
        process.exitCode = 1;
        return;
    }
    const json = hasFlag(verifyArgs, '--json');
    const outPath = readValue(verifyArgs, '--out');
    const currentVersion = readValue(verifyArgs, '--current-version');
    const nowRaw = readValue(verifyArgs, '--now');
    const now = nowRaw ? new Date(nowRaw) : new Date();
    if (Number.isNaN(now.getTime())) {
        console.error(`invalid --now value: ${nowRaw}`);
        process.exitCode = 1;
        return;
    }
    let usageHistoryByAlias;
    let criticalIntegrationsByAlias;
    try {
        usageHistoryByAlias = parseUsageHistory(readValue(verifyArgs, '--usage-history'));
        criticalIntegrationsByAlias = parseCriticalIntegrations(readValue(verifyArgs, '--critical-integrations'));
    }
    catch (e) {
        console.error(e.message);
        process.exitCode = 1;
        return;
    }
    const receipts = verifyAllAliases({
        currentVersion,
        now,
        usageHistoryByAlias,
        criticalIntegrationsByAlias,
    });
    const summary = summarizeReceipts(receipts);
    const closure = buildClosureReport(receipts);
    if (json || outPath) {
        const payload = {
            schemaVersion: 1,
            contract: 'alias-retirement: 2 minors AND 90 days AND >=95% for 2 releases AND zero critical integrations (otherwise extension receipt)',
            owner: 'workflow-registry',
            evaluatedAt: new Date().toISOString(),
            currentVersion: receipts[0]?.currentVersion ?? currentVersion ?? 'unknown',
            receipts,
            summary: {
                eligible: summary.eligible.map((r) => r.alias),
                extended: summary.extended.map((r) => r.alias),
                allExtended: summary.allExtended,
                anyEligible: summary.anyEligible,
            },
            closure,
            registry: ALIAS_REGISTRY,
        };
        const text = JSON.stringify(payload, null, 2);
        if (outPath) {
            mkdirSync(dirname(join(process.cwd(), outPath)), { recursive: true });
            writeFileSync(join(process.cwd(), outPath), `${text}\n`);
            console.log(`wrote ${outPath}`);
        }
        if (json && !outPath) {
            console.log(text);
        }
        else if (json && outPath) {
            console.log(text);
        }
        else if (outPath && !json) {
            // human hint when only --out was given
            console.log(summarizeClosureForEvidence(closure));
        }
    }
    else {
        // Human-readable
        console.log(`Alias retirement verification — ${receipts[0]?.currentVersion ?? 'unknown'} at ${new Date().toISOString()}`);
        console.log(`Contract: 2 minors AND 90d AND >=95% canonical for 2 releases AND zero critical integrations; otherwise extension.`);
        console.log('');
        for (const r of receipts) {
            const verdict = r.verdict === 'eligible' ? 'ELIGIBLE (deletion requires separate review, not performed here)' : 'EXTENDED';
            console.log(`- ${r.alias} -> ${r.canonical}: ${verdict}`);
            if (r.blockers.length > 0) {
                for (const b of r.blockers)
                    console.log(`    blocker: ${b}`);
            }
            if (r.extensionReceipt) {
                if (r.nextEligibleDate)
                    console.log(`    nextEligibleDate: ${r.nextEligibleDate} (90d)`);
                if (r.nextEligibleVersion)
                    console.log(`    nextEligibleVersion: ${r.nextEligibleVersion} (2 minors)`);
            }
            if (r.generatedArtifacts.length > 0) {
                console.log(`    generatedArtifacts: ${r.generatedArtifacts.join(', ')}`);
            }
        }
        console.log('');
        console.log(`Summary: ${summary.eligible.length} eligible, ${summary.extended.length} extended; allExtended=${summary.allExtended}`);
        console.log('');
        console.log(summarizeClosureForEvidence(closure));
        if (summary.allExtended) {
            console.log('\nNo aliases are eligible for removal at this version/date without additional telemetry. Extension receipts emitted — see --json for machine evidence.');
        }
    }
    if (hasFlag(verifyArgs, '--check-eligible')) {
        if (summary.anyEligible)
            process.exitCode = 2;
        else
            process.exitCode = 0;
    }
    // Never exit nonzero on "extended" alone — extension is the expected steady state until thresholds are proven.
}
//# sourceMappingURL=alias-retirement.js.map