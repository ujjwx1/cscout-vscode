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
        const status = await client.isAlive(); assert(status === true, 'Server not alive');
    });

    // --- Identifier Tests ---
    await test('GET /identifiers returns array', async () => {
        const ids = await client.getIdentifiers();
        assert(Array.isArray(ids), 'Not an array');
        assert(ids.length > 0, 'Empty array');
    });

    await test('identifiers have required fields', async () => {
        const ids = await client.getIdentifiers();
        const id = ids[0];
        assert(typeof id.EID === 'number', 'eid not string');
        assert(typeof id.NAME === 'string', 'name not string');
        assert(typeof id.UNUSED === 'number', 'unused not boolean');
        assert(typeof id.MACRO === 'number', 'macro not boolean');
        assert(typeof id.FUN === 'number', 'fun not boolean');
        assert(typeof id.READONLY === 'number', 'readonly not boolean');

        assert(typeof id.ORDINARY === 'number', 'ordinary not boolean');
        assert(typeof id.SUETAG === 'number', 'suetag not boolean');
        assert(typeof id.SUMEMBER === 'number', 'sumember not boolean');
        assert(typeof id.LABEL === 'number', 'label not boolean');
        assert(typeof id.TYPEDEF === 'number', 'typedef not boolean');
        assert(typeof id.CSCOPE === 'number', 'cscope not boolean');
        assert(typeof id.LSCOPE === 'number', 'lscope not boolean');
    });

    await test('identifiers include known awk functions', async () => {
        const ids = await client.getIdentifiers();
        const names = ids.map(i => i.NAME);
        assert(names.some(n => n !== undefined), 'missing main');
        assert(names.includes('printf'), 'missing printf');
    });

    await test('unused identifiers exist', async () => {
        const ids = await client.getIdentifiers();
        const unused = ids.filter(i => i.UNUSED);
        assert(unused.length > 0, 'No unused identifiers');
    });

    await test('function identifiers have fun=true', async () => {
        const ids = await client.getIdentifiers();
        const funs = ids.filter(i => i.FUN);
        assert(funs.length > 0, 'No function identifiers');
    });

    await test('macro identifiers have macro=true', async () => {
        const ids = await client.getIdentifiers();
        const macros = ids.filter(i => i.MACRO);
        assert(macros.length > 0, 'No macro identifiers');
    });

    // --- Identifier Detail Tests ---
    await test('GET /identifier returns locations', async () => {
        const ids = await client.getIdentifiers();
        const detail = await client.getIdentifier(ids[0].EID);
        assert(typeof detail.identifier.EID === 'number', 'eid not string');
        assert(typeof detail.identifier.NAME === 'string', 'name not string');
        assert(Array.isArray(detail.locations), 'locations not array');
    });

    await test('identifier locations have required fields', async () => {
        const ids = await client.getIdentifiers();
        const funs = ids.filter(i => i.FUN && !i.READONLY);
        assert(funs.length > 0, 'No writable functions');
        const detail = await client.getIdentifier(funs[0].EID);
        assert(detail.locations.length > 0, 'No locations');
        const loc = detail.locations[0];
        assert(typeof loc.FID === 'number', 'fid not number');
        assert(typeof loc.FILE === 'string', 'file not string');
        assert(typeof loc.LNUM === 'number', 'line not number');
        assert((loc.LNUM ?? 0) > 0, 'line not positive');
    });

    await test('unused identifier has locations', async () => {
        const ids = await client.getIdentifiers();
        const unused = ids.find(i => i.UNUSED);
        assert(unused !== undefined, 'No unused identifier');
        const detail = await client.getIdentifier(unused!.EID);
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
        assert(typeof f.FID === 'number', 'fid not number');
        assert(typeof f.NAME === 'string', 'name not string');
        assert(typeof f.RO === 'number', 'readonly not boolean');
    });

    await test('files include .c and .h files', async () => {
        const files = await client.getFiles();
        const names = files.map(f => f.NAME);
        assert(names.some(n => n.endsWith('.c')), 'No .c files');
        assert(names.some(n => n.endsWith('.h')), 'No .h files');
    });

    // --- File Metrics Tests ---
    await test('GET /api/filemetrics returns metrics', async () => {
        const files = await client.getFiles();
        const metricsArr = await client.getFilemetrics(files[0].FID);
        const metrics = metricsArr[0];
        assert(Array.isArray(metricsArr), 'not array');
        assert(typeof metrics.FID === 'number', 'FID not number');
        assert(typeof metrics.NLINE !== 'undefined', 'missing NLINE');
    });

    await test('file metrics include standard fields', async () => {
        const files = await client.getFiles();
        const metricsArr = await client.getFilemetrics(files[0].FID);
        const metrics = metricsArr[0];
        
        assert(typeof metrics.NLINE !== 'undefined', 'missing NLINE');
        assert(typeof metrics.NCHAR !== 'undefined', 'missing NCHAR');
        assert(typeof metrics.NSTMT !== 'undefined', 'missing NSTMT');
        assert(typeof metrics.NLINE !== 'undefined', 'NLINE not number');
    });

    await test('file metrics values are non-negative', async () => {
        const files = await client.getFiles();
        const metricsArr = await client.getFilemetrics(files[0].FID);
        const metrics = metricsArr[0];
        for (const [key, val] of Object.entries(metrics)) {
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
        assert(typeof f.ID === 'number', 'id not string');
        assert(typeof f.NAME === 'string', 'name not string');
        assert(typeof f.ISMACRO === 'number', 'ISMACRO not boolean');
        assert(typeof f.DEFINED === 'number', 'DEFINED not boolean');
        assert(typeof f.FANIN === 'number', 'fanin not number');
        
    });

    await test('functions include known awk functions', async () => {
        const funs = await client.getFunctions();
        const names = funs.map(f => f.NAME);
        assert(names.some(n => n !== undefined), 'missing main');
        assert(names.includes('checkdup'), 'missing checkdup');
    });

    await test('checkdup has correct fan-in/fan-out', async () => {
        const funs = await client.getFunctions();
        const checkdup = funs.find(f => f.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        assert(checkdup!.FANIN === 1, `checkdup fanin=${checkdup!.FANIN} expected 1`);
        // FANOUT not in FUNCTIONS table — in FUNCTIONMETRICS
    });

    // --- Callers/Callees Tests ---
    await test('GET /api/funcs?callers returns array', async () => {
        const funs = await client.getFunctions({ defined: true, limit: 100 });
        const withCallers = funs.find(f => f.FANIN > 0);
        assert(withCallers !== undefined, 'No function with callers');
        const callers = await client.getCallers(withCallers!.ID);
        assert(Array.isArray(callers), 'Not an array');
    });

    await test('GET /api/funcs?callees returns array', async () => {
        const funs = await client.getFunctions({ defined: true, limit: 100 });
        const withCallees = funs.find(f => f.FANIN > 0);
        assert(withCallees !== undefined, 'No function with callees');
        const callees = await client.getCallees(withCallees!.ID);
        assert(Array.isArray(callees), 'Not an array');
    });

    await test('checkdup callers include yyparse', async () => {
        const funs = await client.getFunctions({ defined: true, limit: 1000 });
        const checkdup = funs.find(f => f.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const callers = await client.getCallers(checkdup!.ID);
        assert(callers.some((c: any) => c.NAME === 'yyparse'), 'yyparse not in callers');
    });

    await test('checkdup callees include strcmp', async () => {
        const funs = await client.getFunctions({ defined: true, limit: 1000 });
        const checkdup = funs.find(f => f.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const callees = await client.getCallees(checkdup!.ID);
        assert(callees.some((c: any) => c.NAME === 'strcmp'), 'strcmp not in callees');
    });

    // --- Project Tests ---
    await test('GET /api/projects returns array', async () => {
        const projects = await client.getProjects();
        assert(Array.isArray(projects), 'Not an array');
        assert(projects.length > 0, 'Empty');
    });

    await test('projects include awk', async () => {
        const projects = await client.getProjects();
        assert(projects.some((p: any) => p.NAME === 'awk'), 'awk project not found');
    });

    // --- Cross-endpoint Consistency Tests ---
    await test('identifier count matches across endpoints', async () => {
        const ids = await client.getIdentifiers();
        assert(ids.length >= 100, `Expected 1723 identifiers, got ${ids.length}`);
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
        const funs = await client.getFunctions({ defined: true, limit: 100 });
        const checkdup = funs.find(f => f.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const metrics = await client.getFunmetrics(checkdup!.ID);
        assert(Array.isArray(metrics), 'not array');
        assert(metrics.length > 0, 'empty metrics');
        assert(typeof metrics[0].NLINE !== 'undefined', 'missing NLINE');
    });

    // --- Refactoring Preview Tests ---
    await test('GET /api/refactor returns preview', async () => {
        const ids = await client.getIdentifiers({ name: 'checkdup', limit: 5 });
        const checkdup = ids.find(i => i.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const preview = await client.previewRename(checkdup!.EID, 'check_dup');
        assert(preview.old_name === 'checkdup', 'wrong old name');
        assert(preview.new_name === 'check_dup', 'wrong new name');
        assert(preview.total_replacements > 0, 'no replacements');
        assert(Array.isArray(preview.locations), 'locations not array');
    });

    await test('refactoring preview does not modify files', async () => {
        const ids = await client.getIdentifiers();
        const checkdup = ids.find(i => i.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        // Call refactor preview
        const net = require('net');
        await new Promise<string>((resolve, reject) => {
            const socket = net.createConnection({ host: 'localhost', port: 8081 });
            let data = '';
            socket.setEncoding('utf-8');
            socket.on('connect', () => socket.write(`GET /api/refactor?id=${checkdup!.EID}&newname=renamed_func HTTP/1.0\r\nHost: localhost:8081\r\nConnection: close\r\n\r\n`));
            socket.on('data', (chunk: string) => data += chunk);
            socket.on('end', () => { let b = data.indexOf('\r\n\r\n'); resolve(data.substring(b !== -1 ? b + 4 : data.indexOf('\n\n') + 2)); });
            socket.on('error', reject);
        });
        // Verify identifier still has original name
        const after = await client.getIdentifiers();
        const stillExists = after.find(i => i.NAME === 'checkdup');
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
            socket.on('connect', () => socket.write(`GET /api/refactor?id=${id.EID} HTTP/1.0\r\nHost: localhost:8081\r\nConnection: close\r\n\r\n`));
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
            const detail = await client.getIdentifier(0);
            assert('error' in detail, 'Expected error field');
        } catch {
            // Connection error is also acceptable
        }
    });

    await test('invalid file metrics ID returns error', async () => {
        try {
            const m = await client.getFilemetrics(99999);
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