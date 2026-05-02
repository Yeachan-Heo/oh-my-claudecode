import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readPlanningArtifacts } from '../planning/artifacts.js';
import { selectLatestPlanningArtifactPath, selectMatchingTestSpecsForPrd } from '../planning/artifact-names.js';
function planningSlugFromPrdPath(prdPath) {
    if (!prdPath)
        return null;
    const match = basename(prdPath).match(/^prd-(?<slug>.*)\.md$/i);
    return match?.groups?.slug ?? null;
}
function asStringArray(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error('expected string array');
    }
    return value;
}
function asOptionalString(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string')
        throw new Error('expected string');
    return value;
}
function asOptionalBoolean(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'boolean')
        throw new Error('expected boolean');
    return value;
}
function asOptionalPositiveInteger(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error('expected positive integer');
    }
    return value;
}
function parseWorkerPolicy(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== 'object')
        throw new Error('worker_policy must be an object');
    const raw = value;
    const countSource = raw.count_source;
    if (countSource !== undefined
        && countSource !== 'cli-explicit'
        && countSource !== 'plan-suggested'
        && countSource !== 'default-derived') {
        throw new Error('worker_policy.count_source is invalid');
    }
    return {
        requested_count: asOptionalPositiveInteger(raw.requested_count),
        count_source: countSource,
        max_count: asOptionalPositiveInteger(raw.max_count),
        reserve_verification_lane: asOptionalBoolean(raw.reserve_verification_lane),
        strict_max_count: asOptionalBoolean(raw.strict_max_count),
    };
}
export function parseTeamDagHandoff(value) {
    if (!value || typeof value !== 'object')
        throw new Error('Team DAG handoff must be an object');
    const raw = value;
    if (raw.schema_version !== 1)
        throw new Error('Team DAG handoff schema_version must be 1');
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0)
        throw new Error('Team DAG handoff nodes must be a non-empty array');
    const seen = new Set();
    const nodes = raw.nodes.map((nodeValue, index) => {
        if (!nodeValue || typeof nodeValue !== 'object')
            throw new Error(`node ${index + 1} must be an object`);
        const node = nodeValue;
        if (typeof node.id !== 'string' || node.id.trim() === '')
            throw new Error(`node ${index + 1} id is required`);
        if (seen.has(node.id))
            throw new Error(`duplicate node id: ${node.id}`);
        seen.add(node.id);
        if (typeof node.subject !== 'string' || node.subject.trim() === '')
            throw new Error(`node ${node.id} subject is required`);
        if (typeof node.description !== 'string' || node.description.trim() === '')
            throw new Error(`node ${node.id} description is required`);
        return {
            id: node.id,
            subject: node.subject,
            description: node.description,
            role: asOptionalString(node.role),
            lane: asOptionalString(node.lane),
            filePaths: asStringArray(node.filePaths),
            domains: asStringArray(node.domains),
            depends_on: asStringArray(node.depends_on),
            requires_code_change: asOptionalBoolean(node.requires_code_change),
            acceptance: asStringArray(node.acceptance),
        };
    });
    for (const node of nodes) {
        for (const dep of node.depends_on ?? []) {
            if (!seen.has(dep))
                throw new Error(`node ${node.id} depends on unknown node: ${dep}`);
        }
    }
    assertAcyclic(nodes);
    return {
        schema_version: 1,
        plan_slug: asOptionalString(raw.plan_slug),
        source_prd: asOptionalString(raw.source_prd),
        nodes,
        worker_policy: parseWorkerPolicy(raw.worker_policy),
    };
}
function assertAcyclic(nodes) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
        if (visited.has(id))
            return;
        if (visiting.has(id))
            throw new Error(`cycle detected at node: ${id}`);
        visiting.add(id);
        for (const dep of byId.get(id)?.depends_on ?? [])
            visit(dep);
        visiting.delete(id);
        visited.add(id);
    };
    for (const node of nodes)
        visit(node.id);
}
function parseJsonText(text) {
    return parseTeamDagHandoff(JSON.parse(text));
}
function assertDagMatchesPlan(dag, slug, prdPath) {
    if (dag.plan_slug !== undefined && dag.plan_slug !== slug) {
        throw new Error(`Team DAG plan_slug ${dag.plan_slug} does not match latest approved plan slug ${slug}`);
    }
    if (dag.source_prd !== undefined && basename(dag.source_prd) !== basename(prdPath)) {
        throw new Error(`Team DAG source_prd ${dag.source_prd} does not match latest approved PRD ${basename(prdPath)}`);
    }
}
function matchesSidecarSlug(file, slug) {
    const prefix = `team-dag-${slug}`;
    return (file === `${prefix}.json` || file.startsWith(`${prefix}-`)) && file.endsWith('.json');
}
function readSidecar(plansDir, slug, prdPath) {
    if (!existsSync(plansDir))
        return null;
    const candidates = readdirSync(plansDir)
        .filter((file) => matchesSidecarSlug(file, slug))
        .sort((a, b) => a.localeCompare(b))
        .map((file) => join(plansDir, file));
    if (candidates.length === 0)
        return null;
    const selected = candidates.at(-1);
    try {
        return {
            dag: (() => {
                const dag = parseJsonText(readFileSync(selected, 'utf-8'));
                assertDagMatchesPlan(dag, slug, prdPath);
                return dag;
            })(),
            source: 'sidecar',
            path: selected,
            warning: candidates.length > 1 ? 'multiple_matches' : undefined,
        };
    }
    catch (error) {
        return {
            dag: null,
            source: 'sidecar',
            path: selected,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
function extractMarkdownHandoff(content) {
    const heading = content.search(/^#{1,6}\s+Team DAG Handoff\s*$/im);
    const searchFrom = heading >= 0 ? heading : 0;
    const fenced = content.slice(searchFrom).match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
    return fenced?.[1]?.trim() || null;
}
export function readTeamDagHandoffForLatestPlan(cwd) {
    const artifacts = readPlanningArtifacts(cwd);
    const prdPath = selectLatestPlanningArtifactPath(artifacts.prdPaths);
    const planSlug = planningSlugFromPrdPath(prdPath);
    if (!prdPath || !planSlug)
        return { dag: null, source: 'none' };
    const matchingTestSpecs = selectMatchingTestSpecsForPrd(prdPath, artifacts.testSpecPaths);
    if (matchingTestSpecs.length === 0) {
        return { dag: null, source: 'none', planSlug, error: 'missing_matching_test_spec' };
    }
    const plansDir = dirname(prdPath);
    const sidecar = readSidecar(plansDir, planSlug, prdPath);
    if (sidecar?.dag)
        return { ...sidecar, planSlug };
    if (sidecar?.error)
        return { ...sidecar, planSlug };
    try {
        const markdownJson = extractMarkdownHandoff(readFileSync(prdPath, 'utf-8'));
        if (!markdownJson)
            return { dag: null, source: 'none', planSlug };
        return {
            dag: (() => {
                const dag = parseJsonText(markdownJson);
                assertDagMatchesPlan(dag, planSlug, prdPath);
                return dag;
            })(),
            source: 'markdown',
            path: prdPath,
            planSlug,
        };
    }
    catch (error) {
        return {
            dag: null,
            source: 'none',
            path: prdPath,
            planSlug,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
//# sourceMappingURL=dag-schema.js.map