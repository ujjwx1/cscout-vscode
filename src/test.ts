const Module = require('module');
import * as path from 'path';
import * as fs from 'fs';

// Setup VS Code Mocks before importing anything that uses it
class MockRange {
    constructor(public start: MockPosition, public end: MockPosition) { }
}
class MockPosition {
    constructor(public line: number, public character: number) { }
}
class MockLocation {
    constructor(public uri: any, public range: any) { }
}
class MockHover {
    public contents: any[];
    constructor(contents: any | any[], public range?: any) {
        this.contents = Array.isArray(contents) ? contents : [contents];
    }
}
class MockCodeLens {
    constructor(public range: any, public command?: any) { }
}
class MockThemeIcon {
    constructor(public id: string) { }
}
class MockMarkdownString {
    public value: string = '';
    constructor(value?: string) {
        if (value) { this.value = value; }
    }
    appendMarkdown(s: string) {
        this.value += s;
        return this;
    }
}
class MockEventEmitter {
    private listeners: any[] = [];
    event = (listener: any) => {
        this.listeners.push(listener);
        return { dispose: () => { } };
    };
    fire(data?: any) {
        for (const l of this.listeners) { l(data); }
    }
}
class MockDisposable {
    static from(...disposables: { dispose(): any }[]) {
        return { dispose: () => disposables.forEach(d => d.dispose()) };
    }
}

class MockDocument {
    constructor(public uri: any, public content: string) { }
    get lineCount() { return this.content.split('\n').length; }
    lineAt(line: number) {
        const lines = this.content.split('\n');
        return {
            text: lines[line] || '',
            lineNumber: line
        };
    }
    getWordRangeAtPosition(position: any, regex: RegExp) {
        return new MockRange(position, position);
    }
    getText(range?: any) {
        if (!range) { return this.content; }
        return 'checkdup';
    }
    offsetAt(position: any) {
        const lines = this.content.split('\n');
        let offset = 0;
        for (let i = 0; i < position.line; i++) {
            offset += lines[i].length + 1; // +1 for \n
        }
        offset += position.character;
        return offset;
    }
}
let activeWatcher: MockFileSystemWatcher | undefined = undefined;
let activeStatusBar: MockStatusBarItem | undefined = undefined;
let mockInfoMessageChoice: string | undefined = undefined;
const mockCommands = new Map<string, (...args: any[]) => any>();

class MockFileSystemWatcher {
    private changeListeners: any[] = [];
    private createListeners: any[] = [];
    private deleteListeners: any[] = [];

    onDidChange(listener: any) {
        this.changeListeners.push(listener);
        return { dispose: () => { } };
    }
    onDidCreate(listener: any) {
        this.createListeners.push(listener);
        return { dispose: () => { } };
    }
    onDidDelete(listener: any) {
        this.deleteListeners.push(listener);
        return { dispose: () => { } };
    }

    fireChange(uri: any) {
        for (const l of this.changeListeners) l(uri);
    }
    fireCreate(uri: any) {
        for (const l of this.createListeners) l(uri);
    }
    fireDelete(uri: any) {
        for (const l of this.deleteListeners) l(uri);
    }
}

class MockStatusBarItem {
    public text: string = '';
    public tooltip: string = '';
    public command: any = undefined;
    show() { }
    hide() { }
    dispose() { }
}

const mockVSCode = {
    Range: MockRange,
    Position: MockPosition,
    Location: MockLocation,
    Hover: MockHover,
    CodeLens: MockCodeLens,
    ThemeIcon: MockThemeIcon,
    MarkdownString: MockMarkdownString,
    EventEmitter: MockEventEmitter,
    Disposable: MockDisposable,
    TreeItem: class {
        public id?: string;
        public contextValue?: string;
        public description?: string;
        public tooltip?: string;
        public command?: any;
        public iconPath?: any;
        constructor(public label: any, public collapsibleState?: any) { }
    },
    TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2
    },
    StatusBarAlignment: {
        Left: 1,
        Right: 2
    },
    window: {
        showInformationMessage: (msg: string, ...items: string[]) => {
            return Promise.resolve(mockInfoMessageChoice || '');
        },
        showErrorMessage: (msg: string) => {
            console.error('VSCode Error:', msg);
            return Promise.resolve('');
        },
        createWebviewPanel: () => ({
            webview: {
                onDidReceiveMessage: () => ({ dispose: () => { } }),
                html: ''
            },
            onDidDispose: () => { }
        }),
        activeTextEditor: undefined,
        registerTreeDataProvider: () => ({ dispose: () => { } }),
        createOutputChannel: () => ({
            append: () => { },
            appendLine: () => { }
        }),
        createStatusBarItem: () => {
            activeStatusBar = new MockStatusBarItem();
            return activeStatusBar;
        }
    },
    workspace: {
        workspaceFolders: [
            {
                uri: { fsPath: '/mnt/c/Users/ujjwa/OneDrive/Desktop/GSOC/cscout/example/awk', path: '/mnt/c/Users/ujjwa/OneDrive/Desktop/GSOC/cscout/example/awk' },
                name: 'awk',
                index: 0
            }
        ],
        getConfiguration: () => ({
            get: (key: string) => undefined
        }),
        openTextDocument: () => Promise.resolve(new MockDocument({ fsPath: 'awk/awk.c' }, 'void checkdup() {}')),
        createFileSystemWatcher: () => {
            activeWatcher = new MockFileSystemWatcher();
            return activeWatcher;
        }
    },
    commands: {
        registerCommand: (command: string, callback: (...args: any[]) => any, thisArg?: any) => {
            mockCommands.set(command, callback);
            return { dispose: () => { mockCommands.delete(command); } };
        },
        executeCommand: (command: string, ...rest: any[]) => {
            const cb = mockCommands.get(command);
            if (cb) {
                return Promise.resolve(cb(...rest));
            }
            return Promise.resolve();
        }
    },
    languages: {
        createDiagnosticCollection: () => ({
            clear: () => { },
            set: () => { },
            delete: () => { },
            dispose: () => { }
        }),
        registerHoverProvider: () => ({ dispose: () => { } }),
        registerDefinitionProvider: () => ({ dispose: () => { } }),
        registerReferenceProvider: () => ({ dispose: () => { } }),
        registerRenameProvider: () => ({ dispose: () => { } }),
        registerCodeLensProvider: () => ({ dispose: () => { } })
    },
    Uri: {
        file: (p: string) => ({ fsPath: p, path: p, toLowerCase: () => p.toLowerCase() })
    }
};

const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean) {
    if (request === 'vscode') {
        return 'vscode';
    }
    return originalResolve.call(this, request, parent, isMain);
};

(Module as any)._cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: mockVSCode
};

// Now import target files
import { CScoutClient } from './cscoutClient';
import { toWslPath, fromWslPath, setWslMountRootForTesting } from './platform';
import { detectAll } from './buildSystem';
import { CScoutLifecycle } from './lifecycle';
import {
    activate,
    CScoutHoverProvider,
    CScoutCodeLensProvider,
    IdentifierTreeProvider,
    FunctionTreeProvider,
    FileTreeProvider
} from './extension';
import { toEditorPath } from './platform';

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

    // --- Platform WSL Path Tests ---
    await test('toWslPath translates Windows paths (standard mount)', async () => {
        setWslMountRootForTesting('/mnt/');
        const wsl = toWslPath('C:\\Users\\foo\\project');
        assert(wsl === '/mnt/c/Users/foo/project', `Expected /mnt/c/Users/foo/project, got ${wsl}`);
    });

    await test('fromWslPath translates WSL paths (standard mount)', async () => {
        setWslMountRootForTesting('/mnt/');
        const win = fromWslPath('/mnt/c/Users/foo/project');
        assert(win === 'C:\\Users\\foo\\project', `Expected C:\\Users\\foo\\project, got ${win}`);
    });

    await test('toWslPath translates Windows paths (custom mount /)', async () => {
        setWslMountRootForTesting('/');
        const wsl = toWslPath('C:\\Users\\foo\\project');
        assert(wsl === '/c/Users/foo/project', `Expected /c/Users/foo/project, got ${wsl}`);
    });

    await test('fromWslPath translates WSL paths (custom mount /)', async () => {
        setWslMountRootForTesting('/');
        const win = fromWslPath('/c/Users/foo/project');
        assert(win === 'C:\\Users\\foo\\project', `Expected C:\\Users\\foo\\project, got ${win}`);
    });

    // Reset back to default so other tests don't fail unexpectedly
    setWslMountRootForTesting('/mnt/');

    // --- Build System Detection Tests ---
    await test('detectAll detects CMake project', async () => {
        const tempDir = path.join(__dirname, 'temp_cmake_test');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        fs.writeFileSync(path.join(tempDir, 'CMakeLists.txt'), 'project(test)');
        fs.writeFileSync(path.join(tempDir, 'compile_commands.json'), '[]');

        const detected = detectAll(tempDir);
        fs.unlinkSync(path.join(tempDir, 'CMakeLists.txt'));
        fs.unlinkSync(path.join(tempDir, 'compile_commands.json'));
        fs.rmdirSync(tempDir);

        assert(detected.hasCMake === true, 'CMake lists not detected');
        assert(detected.hasCompileCommands === true, 'Compile commands not detected');
    });

    await test('detectAll detects Meson project', async () => {
        const tempDir = path.join(__dirname, 'temp_meson_test');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        fs.writeFileSync(path.join(tempDir, 'meson.build'), 'project()');

        const detected = detectAll(tempDir);
        fs.unlinkSync(path.join(tempDir, 'meson.build'));
        fs.rmdirSync(tempDir);

        assert(detected.hasMeson === true, 'Meson project not detected');
    });

    await test('detectAll detects Makefile project', async () => {
        const tempDir = path.join(__dirname, 'temp_make_test');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        fs.writeFileSync(path.join(tempDir, 'Makefile'), 'all:');

        const detected = detectAll(tempDir);
        fs.unlinkSync(path.join(tempDir, 'Makefile'));
        fs.rmdirSync(tempDir);

        assert(detected.hasMakefile === true, 'Makefile not detected');
    });

    // --- API Count and Pagination Tests ---
    await test('GET /identifiers/counts returns counts', async () => {
        const counts = await client.getIdentifierCounts();
        assert(typeof counts.all === 'number' && counts.all > 0, 'all not a positive number');
        assert(typeof counts.unused_project === 'number', 'unused_project not a number');
    });

    await test('GET /functions/counts returns counts', async () => {
        const counts = await client.getFunctionCounts();
        assert(typeof counts.all === 'number' && counts.all > 0, 'all not a positive number');
        assert(typeof counts.project_scoped === 'number', 'project_scoped not a number');
    });

    await test('GET /files/counts returns counts', async () => {
        const counts = await client.getFileCounts();
        assert(typeof counts.all === 'number' && counts.all > 0, 'all not a positive number');
        assert(typeof counts.writable === 'number', 'writable not a number');
    });

    await test('GET /functions/byname works', async () => {
        const fn = await client.getFunctionByName('checkdup');
        assert(fn !== null, 'checkdup not found');
        assert(fn!.NAME === 'checkdup', 'wrong name returned');
        assert(typeof fn!.CCYCL1 === 'number', 'CCYCL1 missing or not number');
    });

    await test('pagination on functions works', async () => {
        const page1 = await client.getFunctions({ limit: 5, offset: 0 });
        const page2 = await client.getFunctions({ limit: 5, offset: 5 });
        assert(page1.length === 5, `Expected 5 items, got ${page1.length}`);
        assert(page2.length === 5, `Expected 5 items, got ${page2.length}`);
        assert(page1[0].ID !== page2[0].ID, 'Page 1 and Page 2 are identical (offset ignored)');
    });

    await test('pagination on identifiers works', async () => {
        const page1 = await client.getIdentifiers({ limit: 5, offset: 0 });
        const page2 = await client.getIdentifiers({ limit: 5, offset: 5 });
        assert(page1.length === 5, `Expected 5 items, got ${page1.length}`);
        assert(page2.length === 5, `Expected 5 items, got ${page2.length}`);
        assert(page1[0].EID !== page2[0].EID, 'Page 1 and Page 2 are identical (offset ignored)');
    });

    // --- Mock Provider Unit Tests ---
    await test('Hover Provider returns function complexity', async () => {
        const hoverProvider = new CScoutHoverProvider(() => client);
        const doc = new MockDocument({ fsPath: 'awk/awk.c' }, 'void checkdup() {}');
        const pos = new MockPosition(0, 5);
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) };

        const hover: any = await hoverProvider.provideHover(doc as any, pos as any, token as any);
        assert(hover !== undefined, 'Hover was undefined');
        const contentStr = hover.contents[0].value;
        assert(contentStr.includes('checkdup'), 'Hover title checkdup not found');
        assert(contentStr.includes('complexity'), 'Hover complexity not found');
    });

    await test('Hover Provider respects cancellation', async () => {
        const hoverProvider = new CScoutHoverProvider(() => client);
        const doc = new MockDocument({ fsPath: 'awk/awk.c' }, 'void checkdup() {}');
        const pos = new MockPosition(0, 5);
        const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => { } }) };

        const hover = await hoverProvider.provideHover(doc as any, pos as any, token as any);
        assert(hover === undefined, 'Hover was not cancelled');
    });

    await test('CodeLens Provider returns lenses for active file', async () => {
        const codeLensProvider = new CScoutCodeLensProvider(() => client);
        const files = await client.getFiles();
        const mainFile = files.find(f => f.NAME.endsWith('main.c'));
        assert(mainFile !== undefined, 'main.c not found in files list');

        const pathInDoc = toEditorPath(mainFile!.NAME);
        const realContent = fs.readFileSync(pathInDoc, 'utf-8');
        const doc = new MockDocument({ fsPath: pathInDoc }, realContent);

        const lenses = await codeLensProvider.provideCodeLenses(doc as any);
        assert(Array.isArray(lenses), 'Lenses not an array');
        assert(lenses.length > 0, `No lenses returned for ${pathInDoc}`);
        const lens = lenses[0];
        assert(lens.command !== undefined, 'Lens missing command');
        const cmd = lens.command;
        assert(cmd !== undefined, 'Lens command is undefined');
        if (cmd) {
            assert(cmd.title.includes('caller'), 'Lens missing callers/callees title');
            assert(cmd.command === 'cscout.showCallGraph', 'Wrong lens command');
        }
    });

    await test('Tree View Providers load top-level counts', async () => {
        const idTree = new IdentifierTreeProvider(() => client);
        const rootNodes = await idTree.getChildren();
        assert(rootNodes.length > 0, 'No root nodes returned');
        const firstGroup = rootNodes[0];
        assert(firstGroup.kind === 'group', 'First node is not a group');
        if (firstGroup.kind === 'group') {
            assert(firstGroup.count !== undefined && firstGroup.count > 0, 'Group count missing or 0');
        }
    });

    await test('Tree View Providers paginate children correctly', async () => {
        const idTree = new IdentifierTreeProvider(() => client);
        const rootNodes = await idTree.getChildren();
        const allGroup = rootNodes.find(n => n.kind === 'group' && n.groupKey === 'all');
        assert(allGroup !== undefined, 'All group not found');

        const firstPage = await idTree.getChildren(allGroup);
        assert(firstPage.length > 0, 'First page of identifiers is empty');

        // Assert that the page is capped at 200 items (or 201 with the load more action)
        assert(firstPage.length <= 201, `Page size is too large: ${firstPage.length}`);

        const loadMoreNode = firstPage.find(n => n.kind === 'load-more');
        assert(loadMoreNode !== undefined, 'Load-more node missing');
        if (loadMoreNode && loadMoreNode.kind === 'load-more') {
            assert(loadMoreNode.offset === 200, `Expected offset 200, got ${loadMoreNode.offset}`);
        }
    });

    // --- Original Integration Tests ---
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
    });

    await test('unused identifiers exist', async () => {
        const ids = await client.getIdentifiers();
        const unused = ids.filter(i => i.UNUSED);
        assert(unused.length > 0, 'No unused identifiers');
    });

    await test('GET /identifier returns locations', async () => {
        const ids = await client.getIdentifiers();
        const detail = await client.getIdentifier(ids[0].EID);
        assert(typeof detail.identifier.EID === 'number', 'eid not string');
        assert(Array.isArray(detail.locations), 'locations not array');
    });

    await test('GET /api/files returns array', async () => {
        const files = await client.getFiles();
        assert(Array.isArray(files), 'Not an array');
    });

    await test('files have required fields', async () => {
        const files = await client.getFiles();
        const f = files[0];
        assert(typeof f.FID === 'number', 'fid not number');
        assert(typeof f.NAME === 'string', 'name not string');
    });

    await test('GET /api/filemetrics returns metrics', async () => {
        const files = await client.getFiles();
        const metricsArr = await client.getFilemetrics(files[0].FID);
        const metrics = metricsArr[0];
        assert(Array.isArray(metricsArr), 'not array');
        assert(typeof metrics.FID === 'number', 'FID not number');
    });

    await test('GET /api/functions returns array', async () => {
        const funs = await client.getFunctions();
        assert(Array.isArray(funs), 'Not an array');
    });

    await test('functions have required fields', async () => {
        const funs = await client.getFunctions();
        const f = funs[0];
        assert(typeof f.ID === 'number', 'id not string');
        assert(typeof f.NAME === 'string', 'name not string');
    });

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

    await test('GET /api/projects returns array', async () => {
        const projects = await client.getProjects();
        assert(Array.isArray(projects), 'Not an array');
    });

    await test('GET /api/funmetrics returns metrics', async () => {
        const funs = await client.getFunctions({ defined: true, limit: 100 });
        const checkdup = funs.find(f => f.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const metrics = await client.getFunmetrics(checkdup!.ID);
        assert(Array.isArray(metrics), 'not array');
    });

    await test('GET /api/refactor returns preview', async () => {
        const ids = await client.getIdentifiers({ name: 'checkdup', limit: 5 });
        const checkdup = ids.find(i => i.NAME === 'checkdup');
        assert(checkdup !== undefined, 'checkdup not found');
        const preview = await client.previewRename(checkdup!.EID, 'check_dup');
        assert(preview.old_name === 'checkdup', 'wrong old name');
        assert(preview.new_name === 'check_dup', 'wrong new name');
    });

    await test('File Watcher detects file changes and updates status bar & prompts re-analysis', async () => {
        // 1. Mock setTimeout to execute immediately
        const originalSetTimeout = global.setTimeout;
        (global as any).setTimeout = (fn: any, delay: number) => {
            const targetDelay = delay === 10000 ? 1 : delay;
            return originalSetTimeout(fn, targetDelay);
        };

        try {
            // 2. Intercept command execution to verify if cscout.reanalyze is triggered
            const reanalyzeState = { called: false };
            let mockCommandRegistered: any = undefined;

            const originalRegister = mockVSCode.commands.registerCommand;
            mockVSCode.commands.registerCommand = (cmd: string, fn: any) => {
                if (cmd === 'cscout.reanalyze') {
                    mockCommandRegistered = fn;
                }
                return originalRegister(cmd, fn);
            };

            const originalExecute = mockVSCode.commands.executeCommand;
            mockVSCode.commands.executeCommand = (cmd: string, ...args: any[]) => {
                if (cmd === 'cscout.reanalyze') {
                    reanalyzeState.called = true;
                    assert(activeStatusBar!.text.includes('stale'), `Status bar should be stale when reanalyze is requested, got: ${activeStatusBar!.text}`);
                    if (mockCommandRegistered) {
                        return mockCommandRegistered();
                    }
                }
                return originalExecute(cmd, ...args);
            };

            // 3. Mock CScoutLifecycle to control state transitions
            let readyCallback: any = undefined;
            const originalStart = CScoutLifecycle.prototype.start;
            const originalReanalyze = CScoutLifecycle.prototype.reanalyze;

            CScoutLifecycle.prototype.start = async function (this: any, root: string) {
                readyCallback = this.events.onReady;
                this.events.onStateChange('analyzing', undefined);
                this.events.onStateChange('ready', undefined);
            };

            CScoutLifecycle.prototype.reanalyze = async function (this: any, root: string) {
                this.events.onStateChange('analyzing', undefined);
                this.events.onStateChange('ready', undefined);
            };

            // 4. Activate the extension (this registers the file watcher and status bar)
            const subscriptions: any[] = [];
            const mockContext = {
                subscriptions,
                globalState: {
                    get: () => true,
                    update: () => Promise.resolve()
                }
            };

            activate(mockContext as any);

            // 5. Transition to ready state
            await mockVSCode.commands.executeCommand('cscout.start');
            assert(activeStatusBar !== undefined, 'Status bar not initialized');
            assert(activeStatusBar!.text.includes('CScout'), 'Status bar should show CScout ready');

            // 6. Simulate a file change
            assert(activeWatcher !== undefined, 'File watcher not initialized');

            mockInfoMessageChoice = 'Re-analyze';
            activeWatcher!.fireChange({ fsPath: 'main.c' } as any);

            // Wait a small amount for the debounced timeout to execute
            await new Promise(resolve => originalSetTimeout(resolve, 5));

            // Verify that reanalyze was triggered
            assert(reanalyzeState.called === true, 'Re-analyze command should be triggered');

            // 7. Verify status bar returns to clean state after re-analysis
            assert(!activeStatusBar!.text.includes('stale'), 'Status bar should clear stale status after re-analysis');

            // 8. Test ignore choice
            reanalyzeState.called = false;
            // Transition back to ready
            await mockVSCode.commands.executeCommand('cscout.start');
            // Fire change again
            mockInfoMessageChoice = 'Ignore';
            activeWatcher!.fireChange({ fsPath: 'main.c' } as any);

            await new Promise(resolve => originalSetTimeout(resolve, 5));
            assert(activeStatusBar!.text.includes('stale'), 'Status bar should be stale');
            assert(reanalyzeState.called === false, 'Re-analyze should not be called when ignored');

            // Clean up subscriptions
            for (const sub of subscriptions) {
                if (typeof sub.dispose === 'function') sub.dispose();
            }

            // Restore prototypes
            CScoutLifecycle.prototype.start = originalStart;
            CScoutLifecycle.prototype.reanalyze = originalReanalyze;
            mockVSCode.commands.executeCommand = originalExecute;
            mockVSCode.commands.registerCommand = originalRegister;

        } finally {
            // Restore setTimeout
            global.setTimeout = originalSetTimeout;
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