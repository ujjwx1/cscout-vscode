import * as vscode from 'vscode';
import { CScoutClient, CScoutIdentifier, CScoutFile, CScoutFunction } from './cscoutClient';

function fixPath(p: string): string {
    const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
    if (m) { return `${m[1].toUpperCase()}:/${m[2]}`; }
    return p;
}

let client: CScoutClient | undefined;

// ---- Tree Data Providers ----
// These provide data for the three sidebar panels (Identifiers, Files, Functions)

class IdentifierItem extends vscode.TreeItem {
    constructor(public readonly identifier: CScoutIdentifier) {
        super(identifier.name, vscode.TreeItemCollapsibleState.None);
        const kind = identifier.fun ? 'function' :
                     identifier.macro ? 'macro' :
                     identifier.typedef ? 'typedef' :
                     identifier.suetag ? 'tag' :
                     identifier.sumember ? 'member' : 'variable';
        this.description = kind;
        if (identifier.unused) {
            this.description += ' (unused)';
            this.iconPath = new vscode.ThemeIcon('warning');
        }
        this.tooltip = `${identifier.name} [${kind}] EID: ${identifier.eid}`;
        this.command = {
            command: 'cscout.gotoIdentifier',
            title: 'Go to Identifier',
            arguments: [identifier]
        };
    }
}

class IdentifierTreeProvider implements vscode.TreeDataProvider<IdentifierItem> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private items: IdentifierItem[] = [];

    load(identifiers: CScoutIdentifier[]) {
        this.items = identifiers.map(id => new IdentifierItem(id));
        this._onDidChange.fire();
    }

    clear() { this.items = []; this._onDidChange.fire(); }

    getTreeItem(el: IdentifierItem) { return el; }
    getChildren() { return this.items; }
}

class FileItem extends vscode.TreeItem {
    constructor(public readonly file: CScoutFile) {
        super(file.name.split('/').pop() || file.name, vscode.TreeItemCollapsibleState.None);
        this.description = file.readonly ? 'read-only' : 'writable';
        this.tooltip = file.name;
        this.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [vscode.Uri.file(fixPath(file.name))]
        };
    }
}

class FileTreeProvider implements vscode.TreeDataProvider<FileItem> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private items: FileItem[] = [];

    load(files: CScoutFile[]) {
        this.items = files.map(f => new FileItem(f));
        this._onDidChange.fire();
    }

    clear() { this.items = []; this._onDidChange.fire(); }

    getTreeItem(el: FileItem) { return el; }
    getChildren() { return this.items; }
}

class FunctionItem extends vscode.TreeItem {
    constructor(public readonly func: CScoutFunction) {
        super(func.name, vscode.TreeItemCollapsibleState.None);
        this.description = `in: ${func.fanin} out: ${func.fanout}`;
        if (func.is_macro) { this.description += ' (macro)'; }
        this.tooltip = `${func.name} — ${func.fanin} callers, calls ${func.fanout}`;
    }
}

class FunctionTreeProvider implements vscode.TreeDataProvider<FunctionItem> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private items: FunctionItem[] = [];

    load(functions: CScoutFunction[]) {
        this.items = functions.map(f => new FunctionItem(f));
        this._onDidChange.fire();
    }

    clear() { this.items = []; this._onDidChange.fire(); }

    getTreeItem(el: FunctionItem) { return el; }
    getChildren() { return this.items; }
}

// ---- Diagnostics ----
// Shows unused identifiers as warnings in VS Code's Problems panel

const diagnosticCollection = vscode.languages.createDiagnosticCollection('cscout');

async function refreshDiagnostics() {
    if (!client) { return; }
    diagnosticCollection.clear();

    const identifiers = await client.getIdentifiers();
    const unused = identifiers.filter(id => id.unused && !id.readonly);

    const diagMap = new Map<string, vscode.Diagnostic[]>();

    for (const id of unused.slice(0, 50)) {
        try {
            const detail = await client.getIdentifierDetail(id.eid);
            for (const loc of detail.locations) {
                const range = new vscode.Range(
                    Math.max(0, loc.line - 1), 0,
                    Math.max(0, loc.line - 1), id.name.length
                );
                const diag = new vscode.Diagnostic(
                    range,
                    `Unused identifier '${id.name}' (CScout whole-program analysis)`,
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = 'CScout';
                const bucket = diagMap.get(loc.file) || [];
                bucket.push(diag);
                diagMap.set(loc.file, bucket);
            }
        } catch { /* skip on error */ }
    }

    for (const [file, diags] of diagMap) {
        diagnosticCollection.set(vscode.Uri.file(file), diags);
    }
}

// ---- Go to Definition ----

class CScoutDefinitionProvider implements vscode.DefinitionProvider {
    private cache: CScoutIdentifier[] = [];

    updateCache(identifiers: CScoutIdentifier[]) {
        this.cache = identifiers;
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.Location[] | undefined> {
        if (!client) { return undefined; }

        const range = document.getWordRangeAtPosition(position);
        if (!range) { return undefined; }
        const word = document.getText(range);

        const match = this.cache.find(id => id.name === word);
        if (!match) { return undefined; }

        try {
            const detail = await client.getIdentifierDetail(match.eid);
            return detail.locations.map(loc =>
                new vscode.Location(
                    vscode.Uri.file(fixPath(loc.file)),
                    new vscode.Position(Math.max(0, loc.line - 1), 0)
                )
            );
        } catch {
            return undefined;
        }
    }
}

// ---- Extension Activation ----

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('CScout');
    output.appendLine('CScout extension activated.');

    const idTree = new IdentifierTreeProvider();
    const fileTree = new FileTreeProvider();
    const funcTree = new FunctionTreeProvider();
    const defProvider = new CScoutDefinitionProvider();
    const hoverProvider: vscode.HoverProvider = {
        async provideHover(document, position) {
            if (!client) { return undefined; }
            const range = document.getWordRangeAtPosition(position);
            if (!range) { return undefined; }
            const word = document.getText(range);
            const identifiers = await client.getIdentifiers();
            const match = identifiers.find(id => id.name === word);
            if (!match) { return undefined; }
            const lines = [
                `**${match.name}**`,
                `Kind: ${match.fun ? 'function' : match.macro ? 'macro' : match.typedef ? 'typedef' : match.suetag ? 'tag' : match.sumember ? 'member' : 'variable'}`,
                `Scope: ${match.lscope ? 'project' : match.cscope ? 'file' : 'local'}`,
                `Unused: ${match.unused ? 'yes ⚠️' : 'no'}`,
                `Read-only: ${match.readonly ? 'yes' : 'no'}`,
                `Crosses files: ${match.xfile ? 'yes' : 'no'}`,
            ];
            return new vscode.Hover(new vscode.MarkdownString(lines.join('  \n')));
        }
    };

    vscode.window.registerTreeDataProvider('cscout.identifiers', idTree);
    vscode.window.registerTreeDataProvider('cscout.files', fileTree);
    vscode.window.registerTreeDataProvider('cscout.functions', funcTree);

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            { scheme: 'file', language: 'c' },
            defProvider
        ),
        vscode.languages.registerHoverProvider(
            { scheme: 'file', language: 'c' },
            hoverProvider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cscout.connect', async () => {
            const config = vscode.workspace.getConfiguration('cscout');
            const host = config.get<string>('host') || 'localhost';
            const port = config.get<number>('port') || 8081;

            client = new CScoutClient(host, port);
            output.appendLine(`Connecting to CScout at ${host}:${port}...`);

            const alive = await client.isAlive();
            if (!alive) {
                vscode.window.showErrorMessage(
                    `Cannot reach CScout at ${host}:${port}. Make sure CScout is running.`
                );
                client = undefined;
                return;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'CScout: Loading...' },
                async (progress) => {
                    progress.report({ message: 'Fetching identifiers...' });
                    const identifiers = await client!.getIdentifiers();
                    idTree.load(identifiers);
                    defProvider.updateCache(identifiers);

                    progress.report({ message: 'Fetching files...' });
                    const files = await client!.getFiles();
                    fileTree.load(files);

                    progress.report({ message: 'Fetching functions...' });
                    const functions = await client!.getFunctions();
                    funcTree.load(functions);

                    progress.report({ message: 'Computing diagnostics...' });
                    await refreshDiagnostics();

                    output.appendLine(
                        `Connected: ${identifiers.length} identifiers, ${files.length} files, ${functions.length} functions`
                    );
                    vscode.window.showInformationMessage(
                        `CScout: ${identifiers.length} identifiers, ${files.length} files, ${functions.length} functions`
                    );
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cscout.disconnect', () => {
            client = undefined;
            idTree.clear();
            fileTree.clear();
            funcTree.clear();
            diagnosticCollection.clear();
            vscode.window.showInformationMessage('CScout: Disconnected.');
            output.appendLine('Disconnected.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cscout.gotoIdentifier', async (identifier: CScoutIdentifier) => {
            if (!client) { return; }
            try {
                const detail = await client.getIdentifierDetail(identifier.eid);
                if (detail.locations.length > 0) {
                    const loc = detail.locations[0];
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixPath(loc.file)));
                    const editor = await vscode.window.showTextDocument(doc);
                    const pos = new vscode.Position(Math.max(0, loc.line - 1), 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos));
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to navigate: ${err.message}`);
            }
        })
    );

    output.appendLine('CScout extension ready. Use "CScout: Connect to Server" to start.');
}

export function deactivate() {
    diagnosticCollection.dispose();
}