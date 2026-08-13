#!/usr/bin/env node
/**
 * Generate deterministic prompt projections for #3705.
 * Canonical source: docs/CLAUDE.md (between OMC markers).
 * Outputs: CLAUDE.md, .github/CLAUDE.md with unified version + digest.
 * Also emits .omc/projection-manifest.json when not in verify mode.
 *
 * Determinism: fixed marker framing, version from package.json, LF normalization,
 * and stable ordering. Build fails on stale projections when --verify is set.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify');

async function main() {
  const docsPath = join(root, 'docs/CLAUDE.md');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (typeof version !== 'string' || !version) throw new Error('package.json missing version');
  const raw = await readFile(docsPath, 'utf8');
  const START='<!-- OMC:START -->'; const END='<!-- OMC:END -->';
  const s=raw.indexOf(START); const e=raw.indexOf(END);
  if(s===-1||e===-1) throw new Error('missing OMC markers in docs/CLAUDE.md');
  const se=raw.indexOf('\n', s);
  if(se===-1) throw new Error('malformed START marker');
  let body=raw.slice(se+1, e);
  body=body.replace(/<!-- OMC:VERSION:[^\s]*? -->\r?\n?/g,'');
  body=body.replace(/\r\n/g,'\n');
  if(body.length && !body.endsWith('\n')) body+='\n';
  const composed = `${START}\n<!-- OMC:VERSION:${version} -->\n${body}${END}\n`;
  const normalizeForDigest = (c) => {
    let n=c.replace(/\r\n/g,'\n');
    if(n.length && !n.endsWith('\n')) n+='\n';
    return n;
  };
  const digestFor = (content) => createHash('sha256').update(normalizeForDigest(content),'utf8').digest('hex');
  const bodyDigest = createHash('sha256').update(normalizeForDigest(body),'utf8').digest('hex');
  const composedDigest = digestFor(composed);
  const targets = ['CLAUDE.md','.github/CLAUDE.md'];
  if (verifyOnly) {
    let ok=true;
    for(const rel of targets){
      const p=join(root, rel);
      if(!existsSync(p)){ console.error(`[verify] missing ${rel}`); ok=false; continue; }
      const actual=await readFile(p,'utf8');
      if(normalizeForDigest(actual)!==normalizeForDigest(composed)){
        console.error(`[verify] stale ${rel}: expected digest ${composedDigest} version ${version}`);
        ok=false;
      } else {
        console.error(`[verify] ok ${rel}`);
      }
    }
    // Bridge coordinator check
    const bridgePath=join(root,'bridge/claude-md-coordinator.cjs');
    if(existsSync(bridgePath)){
      const bridge=await readFile(bridgePath,'utf8');
      const docsBytes=await readFile(docsPath);
      const docsSha=createHash('sha256').update(docsBytes).digest('hex');
      if(!bridge.includes(docsSha)){ console.error(`[verify] bridge not built from current docs/CLAUDE.md (expected ${docsSha.slice(0,12)})`); ok=false; }
      if(!bridge.includes(version)){ console.error(`[verify] bridge missing version ${version}`); ok=false; }
    }
    if(!ok){ console.error('[verify] prompt projection drift detected'); process.exit(1); }
    console.error(`[verify] projections in sync (sourceRevision=${bodyDigest} digest=${composedDigest})`);
    return;
  }
  for(const rel of targets){
    const abs=join(root, rel);
    await mkdir(dirname(abs),{recursive:true});
    await writeFile(abs, composed);
    console.error(`[generate] wrote ${rel} (${composed.length} bytes) digest=${composedDigest.slice(0,12)}`);
  }
  // Emit manifest for migration evidence (non-blocking for #3704)
  try {
    const outDir=join(root,'.omc');
    await mkdir(outDir,{recursive:true});
    const manifest={
      schemaVersion: 1,
      engineVersion: version,
      sourceRevision: bodyDigest,
      generatedAt: new Date().toISOString(),
      projections: targets.map(p=>({kind:'claude',sourcePath:'docs/CLAUDE.md',outputPath:p,digest:composedDigest,byteLength: Buffer.byteLength(composed,'utf8')})),
    };
    await writeFile(join(outDir,'projection-manifest.json'), JSON.stringify(manifest,null,2)+'\n');
    console.error(`[generate] manifest .omc/projection-manifest.json sourceRevision=${bodyDigest.slice(0,12)}`);
  } catch (e) { console.error(`[generate] manifest skipped: ${String(e)}`); }
}
main().catch(e=>{ console.error(String(e?.stack ?? e)); process.exit(1); });
