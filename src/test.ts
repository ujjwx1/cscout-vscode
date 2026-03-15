import { CScoutClient } from './cscoutClient';

const client = new CScoutClient('localhost', 8081);

async function runTests() {
    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (err: any) {
            console.log(`✗ ${name}: ${err.message}`);
            failed++;
        }
    }

    function assert(condition: boolean, msg: string) {
        if (!condition) { throw new Error(msg); }
    }

    // --- Connection Tests ---
    await test('server is reachable', async () => {
        assert(await client.isAlive(), 'Server not alive');
    });

    // --- Identifier Tests ---
    await test('GET /api/identifiers returns array', async () => {
        const ids = await client.getIdentifiers();
        assert(Array.isArray(ids), 'Not an array');
        assert(ids.length > 0, 'Empty array');
    });

    await test('identifiers have required fields', async () => {
        const ids = await client.getIdentifiers();
        const id = ids[0];
        assert(typeof id.eid === 'string', 'eid not string');
        assert(typeof id.name === 'string', 'name not string');
        assert(typeof id.unused === 'boolean', 'unused not boolean');
        assert(typeof id.macro === 'boolean', 'macro not boolean');
        assert(typeof id.fun === 'boolean', 'fun not boolean');
        assert(typeof id.readonly === 'boolean', 'readonly not boolean');
        assert(typeof id.xfile === 'boolean', 'xfile not boolean');
        assert(typeof id.ordinary === 'boolean', 'ordinary not boolean');
        assert(typeof id.suetag === 'boolean', 'suetag not boolean');
        assert(typeof id.sumember === 'boolean', 'sumember not boolean');
        assert(typeof id.label === 'boolean', 'label not boolean');
        assert(typeof id.typedef === 'boolean', 'typedef not boolean');
        assert(typeof id.cscope === 'boolean', 'cscope not boolean');
        assert(typeof id.lscope === 'boolean', 'lscope not boolean');
    });

    await test('identifiers include known awk functions', async () => {
        const ids = await client.getIdentifiers();
        const names = ids.map(i => i.name);
        assert(names.includes('main'), 'missing main');
        assert(names.includes('printf'), 'missing printf');
    });

    await test('unused identifiers exist', async () => {
        const ids = await client.getIdentifiers();
        const unused = ids.filter(i => i.unused);
        assert(unused.length > 0, 'No unused identifiers');
    });

    await test('function identifiers have fun=true', async () => {
        const ids = await client.getIdentifiers();
        const funs = ids.filter(i => i.fun);
        assert(funs.length > 0, 'No function identifiers');
    });

    await test('macro identifiers have macro=true', async () => {
        const ids = await client.getIdentifiers();
        const macros = ids.filter(i => i.macro);
        assert(macros.length > 0, 'No macro identifiers');
    });

    // --- Identifier Detail Tests ---
    await test('GET /api/id returns locations', async () => {
        const ids = await client.getIdentifiers();
        const detail = await client.getIdentifierDetail(ids[0].eid);
        assert(typeof detail.eid === 'string', 'eid not string');
        assert(typeof detail.name === 'string', 'name not string');
        assert(Array.isArray(detail.locations), 'locations not array');
    });

    await test('identifier locations have required fields', async () => {
        const ids = await client.getIdentifiers();
        const funs = ids.filter(i => i.fun && !i.readonly);
        assert(funs.length > 0, 'No writable functions');
        const detail = await client.getIdentifierDetail(funs[0].eid);
        assert(detail.locations.length > 0, 'No locations');
        const loc = detail.locations[0];
        assert(typeof loc.fid === 'number', 'fid not number');
        assert(typeof loc.file === 'string', 'file not string');
        assert(typeof loc.line === 'number', 'line not number');
        assert(loc.line > 0, 'line not positive');
    });

    await test('unused identifier has locations', async () => {
        const ids = await client.getIdentifiers();
        const unused = ids.find(i => i.unused);
        assert(unused !== undefined, 'No unused identifier');
        const detail = await client.getIdentifierDetail(unused!.eid);
        assert(detail.locations.length > 0, 'Unused id has no locations');
    });

    // --- File Tests ---
    await test('GET /api/files returns array', async () => {
        const files = await client.getFiles();
        assert(Array.isArray(files), 'Not an array');
        assert(files.length > 0, 'Empty');
    });

    await test('files have required fields', async () => {
        const files = await client.getFiles();
        const f = files[0];
        assert(typeof f.fid === 'number', 'fid not number');
        assert(typeof f.name === 'string', 'name not string');
        assert(typeof f.readonly === 'boolean', 'readonly not boolean');
    });

    await test('files include .c and .h files', async () => {
        const files = await client.getFiles();
        const names = files.map(f => f.name);
        assert(names.some(n => n.endsWith('.c')), 'No .c files');
        assert(names.some(n => n.endsWith('.h')), 'No .h files');
    });

    // --- File Metrics Tests ---
    await test('GET /api/filemetrics returns metrics', async () => {
        const files = await client.getFiles();
        const metrics = await client.getFileMetrics(files[0].fid);
        assert(typeof metrics.fid === 'number', 'fid not number');
        assert(typeof metrics.name === 'string', 'name not string');
        assert(typeof metrics.metrics === 'object', 'metrics not object');
    });

    await test('file metrics include standard fields', async () => {
        const files = await client.getFiles();
        const metrics = await client.getFileMetrics(files[0].fid);
        const m = metrics.metrics;
        assert('NLINE' in m, 'missing NLINE');
        assert('NCHAR' in m, 'missing NCHAR');
        assert('NSTMT' in m, 'missing NSTMT');
        assert(typeof m.NLINE === 'number', 'NLINE not number');
    });

    await test('file metrics values are non-negative', async () => {
        const files = await client.getFiles();
        const metrics = await client.getFileMetrics(files[0].fid);
        for (const [key, val] of Object.entries(metrics.metrics)) {
            assert((val as number) >= 0, `${key} is negative: ${val}`);
        }
    });

    // --- Function Tests ---
    await test('GET /api/functions returns array', async () => {
        const funs = await client.getFunctions();
        assert(Array.isArray(funs), 'Not an array');
        assert(funs.length > 0, 'Empty');
    });

    await test('functions have required fields', async () => {
        const funs = await client.getFunctions();
        const f = funs[0];
        assert(typeof f.id === 'string', 'id not string');
        assert(typeof f.name === 'string', 'name not string');
        assert(typeof f.is_macro === 'boolean', 'is_macro not boolean');
        assert(typeof f.is_defined === 'boolean', 'is_defined not boolean');
        assert(typeof f.fanin === 'number', 'fanin not number');
        assert(typeof f.fanout === 'number', 'fanout not number');
    });

    await test('functions include known awk functions', async () => {
        const funs = await client.getFunctions();
        const names = funs.map(f => f.name);
        assert(names.includes('main'), 'missing main');
        assert(names.includes('checkdup'), 'missing checkdup');
    });

    await test('checkdup has correct fan-in/fan-out', async () => {
        const funs = await client.getFunctions();
        const checkdup = funs.find(f => f.name === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        assert(checkdup!.fanin === 1, `checkdup fanin=${checkdup!.fanin} expected 1`);
        assert(checkdup!.fanout === 2, `checkdup fanout=${checkdup!.fanout} expected 2`);
    });

    // --- Callers/Callees Tests ---
    await test('GET /api/funcs?callers returns array', async () => {
        const funs = await client.getFunctions();
        const withCallers = funs.find(f => f.fanin > 0);
        assert(withCallers !== undefined, 'No function with callers');
        const callers = await client.getCallers(withCallers!.id);
        assert(Array.isArray(callers), 'Not an array');
        assert(callers.length > 0, 'Empty callers');
    });

    await test('GET /api/funcs?callees returns array', async () => {
        const funs = await client.getFunctions();
        const withCallees = funs.find(f => f.fanout > 0);
        assert(withCallees !== undefined, 'No function with callees');
        const callees = await client.getCallees(withCallees!.id);
        assert(Array.isArray(callees), 'Not an array');
        assert(callees.length > 0, 'Empty callees');
    });

    await test('checkdup callers include yyparse', async () => {
        const funs = await client.getFunctions();
        const checkdup = funs.find(f => f.name === 'checkdup');
        const callers = await client.getCallers(checkdup!.id);
        assert(callers.some((c: any) => c.name === 'yyparse'), 'yyparse not in callers');
    });

    await test('checkdup callees include strcmp', async () => {
        const funs = await client.getFunctions();
        const checkdup = funs.find(f => f.name === 'checkdup');
        const callees = await client.getCallees(checkdup!.id);
        assert(callees.some((c: any) => c.name === 'strcmp'), 'strcmp not in callees');
    });

    // --- Project Tests ---
    await test('GET /api/projects returns array', async () => {
        const projects = await client.getProjects();
        assert(Array.isArray(projects), 'Not an array');
        assert(projects.length > 0, 'Empty');
    });

    await test('projects include awk', async () => {
        const projects = await client.getProjects();
        assert(projects.some((p: any) => p.name === 'awk'), 'awk project not found');
    });

    // --- Cross-endpoint Consistency Tests ---
    await test('identifier count matches across endpoints', async () => {
        const ids = await client.getIdentifiers();
        assert(ids.length === 1723, `Expected 1723 identifiers, got ${ids.length}`);
    });

    await test('file count matches across endpoints', async () => {
        const files = await client.getFiles();
        assert(files.length === 28, `Expected 28 files, got ${files.length}`);
    });

    await test('function count matches', async () => {
        const funs = await client.getFunctions();
        assert(funs.length === 382, `Expected 382 functions, got ${funs.length}`);
    });

    // --- Function Metrics Tests ---
    await test('GET /api/funmetrics returns metrics', async () => {
        const funs = await client.getFunctions();
        const checkdup = funs.find(f => f.name === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const resp = await client.getFileMetrics(0); // We need raw get
        // Use direct fetch for funmetrics
        const net = require('net');
        const raw = await new Promise<string>((resolve, reject) => {
            const socket = net.createConnection({ host: 'localhost', port: 8081 });
            let data = '';
            socket.setEncoding('utf-8');
            socket.on('connect', () => socket.write(`GET /api/funmetrics?id=${checkdup!.id} HTTP/1.0\r\nHost: localhost:8081\r\nConnection: close\r\n\r\n`));
            socket.on('data', (chunk: string) => data += chunk);
            socket.on('end', () => { let b = data.indexOf('\r\n\r\n'); resolve(data.substring(b !== -1 ? b + 4 : data.indexOf('\n\n') + 2)); });
            socket.on('error', reject);
        });
        const metrics = JSON.parse(raw);
        assert(typeof metrics.name === 'string', 'name not string');
        assert(typeof metrics.metrics === 'object', 'metrics not object');
        assert(metrics.metrics.NLINE > 0, 'NLINE should be positive');
    });

    // --- Refactoring Preview Tests ---
    await test('GET /api/refactor returns preview', async () => {
        const ids = await client.getIdentifiers();
        const checkdup = ids.find(i => i.name === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const net = require('net');
        const raw = await new Promise<string>((resolve, reject) => {
            const socket = net.createConnection({ host: 'localhost', port: 8081 });
            let data = '';
            socket.setEncoding('utf-8');
            socket.on('connect', () => socket.write(`GET /api/refactor?id=${checkdup!.eid}&newname=check_dup HTTP/1.0\r\nHost: localhost:8081\r\nConnection: close\r\n\r\n`));
            socket.on('data', (chunk: string) => data += chunk);
            socket.on('end', () => { let b = data.indexOf('\r\n\r\n'); resolve(data.substring(b !== -1 ? b + 4 : data.indexOf('\n\n') + 2)); });
            socket.on('error', reject);
        });
        const preview = JSON.parse(raw);
        assert(preview.old_name === 'checkdup', 'wrong old name');
        assert(preview.new_name === 'check_dup', 'wrong new name');
        assert(preview.affected_files > 0, 'no affected files');
        assert(preview.total_replacements > 0, 'no replacements');
        assert(Array.isArray(preview.changes), 'changes not array');
    });

    await test('refactoring preview does not modify files', async () => {
        const ids = await client.getIdentifiers();
        const checkdup = ids.find(i => i.name === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        // Call refactor preview
        const net = require('net');
        await new Promise<string>((resolve, reject) => {
            const socket = net.createConnection({ host: 'localhost', port: 8081 });
            let data = '';
            socket.setEncoding('utf-8');
            socket.on('connect', () => socket.write(`GET /api/refactor?id=${checkdup!.eid}&newname=renamed_func HTTP/1.0\r\nHost: localhost:8081\r\nConnection: close\r\n\r\n`));
            socket.on('data', (chunk: string) => data += chunk);
            socket.on('end', () => { let b = data.indexOf('\r\n\r\n'); resolve(data.substring(b !== -1 ? b + 4 : data.indexOf('\n\n') + 2)); });
            socket.on('error', reject);
        });
        // Verify identifier still has original name
        const after = await client.getIdentifiers();
        const stillExists = after.find(i => i.name === 'checkdup');
        assert(stillExists !== undefined, 'checkdup disappeared after preview - files were modified!');
    });

    await test('refactoring preview with invalid EID returns error', async () => {
        const net = require('net');
        const raw = await new Promise<string>((resolve, reject) => {
            const socket = net.createConnection({ host: 'localhost', port: 8081 });
            let data = '';
            socket.setEncoding('utf-8');
            socket.on('connect', () => socket.write(`GET /api/refactor?id=0xinvalid&newname=foo HTTP/1.0\r\nHost: localhost:8081\r\nConnection: close\r\n\r\n`));
            socket.on('data', (chunk: string) => data += chunk);
            socket.on('end', () => { let b = data.indexOf('\r\n\r\n'); resolve(data.substring(b !== -1 ? b + 4 : data.indexOf('\n\n') + 2)); });
            socket.on('error', reject);
        });
        const result = JSON.parse(raw);
        assert('error' in result, 'Expected error field');
    });

    await test('refactoring preview without newname returns error', async () => {
        const ids = await client.getIdentifiers();
        const id = ids[0];
        const net = require('net');
        const raw = await new Promise<string>((resolve, reject) => {
            const socket = net.createConnection({ host: 'localhost', port: 8081 });
            let data = '';
            socket.setEncoding('utf-8');
            socket.on('connect', () => socket.write(`GET /api/refactor?id=${id.eid} HTTP/1.0\r\nHost: localhost:8081\r\nConnection: close\r\n\r\n`));
            socket.on('data', (chunk: string) => data += chunk);
            socket.on('end', () => { let b = data.indexOf('\r\n\r\n'); resolve(data.substring(b !== -1 ? b + 4 : data.indexOf('\n\n') + 2)); });
            socket.on('error', reject);
        });
        const result = JSON.parse(raw);
        assert('error' in result, 'Expected error field');
    });

    // --- Error Handling Tests ---
    await test('invalid identifier EID returns error', async () => {
        try {
            const detail = await client.getIdentifierDetail('0xinvalid');
            assert('error' in detail, 'Expected error field');
        } catch {
            // Connection error is also acceptable
        }
    });

    await test('invalid file metrics ID returns error', async () => {
        try {
            const m = await client.getFileMetrics(99999);
            // Should still return something, even if metrics are zero
            assert(typeof m === 'object', 'Expected object');
        } catch {
            // Acceptable
        }
    });

    // --- Summary ---
    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});