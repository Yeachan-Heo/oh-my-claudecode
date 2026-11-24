import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// Run actual maintained registry and atomic writer in an owned child. Patching
// built-in filesystem exports models a partial ENOSPC write and rename failure
// without mutating the test worker's imports or global registry.
const probe = String.raw `import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const dir=process.argv[1], operation=process.argv[2], mode=process.argv[3];
process.env.OMC_TEST_REGISTRY_DIR=dir;
const registry=path.join(dir,'reply-session-registry.jsonl');
const module=await import(path.resolve('src/notifications/session-registry.ts'));
const mapping=(id,pane,createdAt)=>({platform:'telegram',messageId:id,sessionId:id,tmuxPaneId:pane,tmuxSessionName:'owned',event:'session-start',createdAt});
module.registerMessage(mapping('old','%0','1970-01-01T00:00:00Z'));
module.registerMessage(mapping('current','%1',new Date().toISOString()));
const before=fs.readFileSync(registry,'utf8');
const originalWrite=fs.writeFileSync, originalWriteSync=fs.writeSync, originalRename=fs.renameSync;
const fail=()=>{const e=new Error('owned ENOSPC');e.code='ENOSPC';throw e;};
fs.writeFileSync=function(file,content,...args){if(mode==='write'&&file===registry){originalWrite(file,String(content).slice(0,10),...args);fail();}return originalWrite(file,content,...args);};
fs.writeSync=function(fd,data,...args){if(mode==='write'&&Buffer.isBuffer(data)&&data.includes(Buffer.from('"platform"'))){originalWriteSync(fd,data,0,10,null);fail();}return originalWriteSync(fd,data,...args);};
fs.renameSync=function(from,to){if(mode==='rename'&&to===registry)fail();return originalRename(from,to);};
syncBuiltinESMExports();
let failed=false;
try {if(operation==='session')module.removeSession('old');else if(operation==='pane')module.removeMessagesByPane('%0');else module.pruneStale();}catch{failed=true;}
fs.writeFileSync=originalWrite;fs.writeSync=originalWriteSync;fs.renameSync=originalRename;syncBuiltinESMExports();
console.log(JSON.stringify({failed,preserved:fs.readFileSync(registry,'utf8')===before,current:module.lookupByMessageId('telegram','current')?.messageId,files:fs.readdirSync(dir)}));
`;
function runProbe(operation, fault) {
    const dir = mkdtempSync(join(tmpdir(), 'omc-registry-durability-'));
    try {
        const child = spawnSync(process.execPath, [
            '--import', 'tsx', '--input-type=module', '-e', probe, dir, operation, fault,
        ], { encoding: 'utf8', timeout: 10000 });
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
describe('registry rewrite durability', () => {
    for (const operation of ['session', 'pane', 'prune']) {
        it.each(['write', 'rename'])(`${operation} preserves unrelated mappings on %s failure`, (fault) => {
            const result = runProbe(operation, fault);
            expect(result.failed).toBe(true);
            expect(result.preserved).toBe(true);
            expect(result.current).toBe('current');
            expect(result.files).toEqual(['reply-session-registry.jsonl']);
        });
        it(`${operation} still removes only the selected mappings`, () => {
            const result = runProbe(operation, 'none');
            expect(result.failed).toBe(false);
            expect(result.preserved).toBe(false);
            expect(result.current).toBe('current');
            expect(result.files).toEqual(['reply-session-registry.jsonl']);
        });
    }
});
//# sourceMappingURL=session-registry-durability.test.js.map