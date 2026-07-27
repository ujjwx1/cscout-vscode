/*
 * extension.ts — entry point.  Wires the lifecycle, sidebar panels,
 * editor providers, and diagnostics.  Every UI action goes through
 * commands so keyboard shortcuts and menus stay consistent.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
    CScoutCallEntry,
    CScoutClient,
    CScoutFile,
    CScoutFunction,
    CScoutIdentifier,
    CScoutLocation,
} from './cscoutClient';
import { CScoutLifecycle, CScoutState } from './lifecycle';
import { CScoutSettings } from './buildSystem';
import { fromWslPath } from './platform';

const CSCOUT_KEY_FIRST_ACTIVATION = 'cscout.firstActivationShown';

// -----------------------------------------------------------------------
// Settings helpers
// -----------------------------------------------------------------------

/*
 * Fall back to sensible defaults per platform.  On WSL Linux users, the
 * bare names ('cscout', 'python3') resolve via PATH.  On Windows the
 * user must set explicit paths pointing into WSL, or install the
 * binaries natively.
 */
function loadSettings(): CScoutSettings {
    const cfg = vscode.workspace.getConfiguration('cscout');
    const cscocoPy = cfg.get<string>('cscocoPyPath', 'cscoco.py');
    const csapiPy =
        cfg.get<string>('csapiPyPath') ||
        (cscocoPy && cscocoPy.endsWith('cscoco.py')
            ? cscocoPy.replace(/cscoco\.py$/, 'csapi.py')
            : 'csapi.py');

    return {
        host: cfg.get<string>('host', 'localhost'),
        port: cfg.get<number>('port', 8081),
        cscoutBinaryPath: cfg.get<string>('binaryPath', 'cscout'),
        cscocoPyPath: cscocoPy,
        csapiPyPath: csapiPy,
        csmakePath: cfg.get<string>('csmakePath', 'csmake'),
        pythonPath: cfg.get<string>('pythonPath', 'python3'),
        sqlite3Path: cfg.get<string>('sqlite3Path', 'sqlite3'),
        autoStart: cfg.get<boolean>('autoStart', false),
        projectName: cfg.get<string>('projectName') || undefined,
    };
}

// -----------------------------------------------------------------------
// Sidebar providers
// -----------------------------------------------------------------------

type Node = { kind: 'group'; label: string; count?: number; groupKey: string }
    | { kind: 'identifier'; id: CScoutIdentifier }
    | { kind: 'file'; file: CScoutFile }
    | { kind: 'function'; fn: CScoutFunction }
    | { kind: 'empty'; label: string }
    | { kind: 'action'; label: string; command: string };

class IdentifierTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;
    private cache: CScoutIdentifier[] = [];

    constructor(private getClient: () => CScoutClient | undefined) { }

    refresh(): void {
        this.cache = [];
        this._emitter.fire();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'empty') {
            return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        }
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label };
            item.iconPath = new vscode.ThemeIcon('play');
            return item;
        }
        if (node.kind === 'group') {
            const label = node.count !== undefined ? `${node.label} (${node.count})` : node.label;
            return new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        }
        if (node.kind !== 'identifier') { return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None); }
        const id = node.id;
        const item = new vscode.TreeItem(id.NAME, vscode.TreeItemCollapsibleState.None);
        const kind = describeIdKind(id);
        item.description = kind;
        item.tooltip = new vscode.MarkdownString(
            `**${id.NAME}**  \n${kind}  \nEID: \`${id.EID}\`  \n` +
            (id.UNUSED ? 'Unused  \n' : '') +
            (id.READONLY ? 'Read-only  \n' : 'Writable  \n')
        );
        item.iconPath = new vscode.ThemeIcon(iconForId(id));
        item.command = {
            command: 'cscout.gotoIdentifier',
            title: 'Go to identifier',
            arguments: [id.EID],
        };
        return item;
    }

    async getChildren(node?: Node): Promise<Node[]> {
        const client = this.getClient();
        if (!client) {
            return [{ kind: 'action', label: 'Start CScout', command: 'cscout.start' }];
        }

        if (!node) {
            if (this.cache.length === 0) {
                try {
                    this.cache = await client.getIdentifiers({ limit: 10000 });
                } catch (err) {
                    return [{ kind: 'empty', label: `Error: ${(err as Error).message}` }];
                }
            }
            return [
                {
                    kind: 'group',
                    label: 'Unused',
                    count: this.cache.filter((i) => i.UNUSED).length,
                    groupKey: 'unused',
                },
                {
                    kind: 'group',
                    label: 'Macros',
                    count: this.cache.filter((i) => i.MACRO && !i.UNUSED).length,
                    groupKey: 'macros',
                },
                {
                    kind: 'group',
                    label: 'Functions',
                    count: this.cache.filter((i) => i.FUN && !i.MACRO && !i.READONLY).length,
                    groupKey: 'functions',
                },
                {
                    kind: 'group',
                    label: 'Library Functions',
                    count: this.cache.filter((i) => i.FUN && !i.MACRO && i.READONLY).length,
                    groupKey: 'library-functions',
                },
                {
                    kind: 'group',
                    label: 'Variables & Types',
                    count: this.cache.filter((i) => i.ORDINARY && !i.FUN && !i.MACRO).length,
                    groupKey: 'variables',
                },
                {
                    kind: 'group',
                    label: 'All',
                    count: this.cache.length,
                    groupKey: 'all',
                },
            ];
        }

        if (node.kind === 'group') {
            let filtered: CScoutIdentifier[];
            switch (node.groupKey) {
                case 'unused':
                    filtered = this.cache.filter((i) => i.UNUSED);
                    break;
                case 'macros':
                    filtered = this.cache.filter((i) => i.MACRO && !i.UNUSED);
                    break;
                case 'functions':
                    filtered = this.cache.filter((i) => i.FUN && !i.MACRO && !i.READONLY);
                    break;
                case 'library-functions':
                    filtered = this.cache.filter((i) => i.FUN && !i.MACRO && i.READONLY);
                    break;
                case 'variables':
                    filtered = this.cache.filter((i) => i.ORDINARY && !i.FUN && !i.MACRO);
                    break;
                default:
                    filtered = this.cache;
            }
            // Cap displayed items to prevent tree overload.
            const limit = 500;
            const items: Node[] = filtered.slice(0, limit).map((id) => ({ kind: 'identifier' as const, id }));
            if (filtered.length > limit) {
                items.push({
                    kind: 'empty',
                    label: `… ${filtered.length - limit} more not shown`,
                });
            }
            return items;
        }

        return [];
    }
class ActionTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;
    private state: CScoutState = 'stopped';

    setState(state: CScoutState) {
        this.state = state;
        this.refresh();
    }

    refresh(): void {
        this._emitter.fire();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label, arguments: node.args };

            // Assign corresponding icons based on the command
            switch (node.command) {
                case 'cscout.start': item.iconPath = new vscode.ThemeIcon('play'); break;
                case 'cscout.stop': item.iconPath = new vscode.ThemeIcon('debug-stop'); break;
                case 'cscout.refresh': item.iconPath = new vscode.ThemeIcon('refresh'); break;
                case 'cscout.reanalyze': item.iconPath = new vscode.ThemeIcon('sync'); break;
                case 'workbench.action.openSettings': item.iconPath = new vscode.ThemeIcon('settings'); break;
                case 'cscout.showWalkthrough': item.iconPath = new vscode.ThemeIcon('book'); break;
                default: item.iconPath = new vscode.ThemeIcon('play');
            }
            return item;
        }
        return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None);
    }

    async getChildren(node?: Node): Promise<Node[]> {
        if (node) return [];

        if (this.state === 'stopped' || this.state === 'error') {
            return [
                { kind: 'action', label: 'Start CScout', command: 'cscout.start' },
                { kind: 'action', label: 'Tutorial', command: 'cscout.showWalkthrough' },
                { kind: 'action', label: 'Configure CScout', command: 'workbench.action.openSettings', args: ['cscout'] }
            ];
        } else {
            return [
                { kind: 'action', label: 'Stop CScout', command: 'cscout.stop' },
                { kind: 'action', label: 'Refresh UI', command: 'cscout.refresh' },
                { kind: 'action', label: 'Re-analyze Codebase', command: 'cscout.reanalyze' },
                { kind: 'action', label: 'Configure CScout', command: 'workbench.action.openSettings', args: ['cscout'] }
            ];
        }
    }
}

export class FileTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;

    // Bounded memory: only stores pages the user has actually expanded.
    private groupItems: Map<string, CScoutFile[]> = new Map();
    private groupTotals: Map<string, number> = new Map();
    private counts: Record<string, number> | null = null;

    constructor(private getClient: () => CScoutClient | undefined) { }

    refresh(): void {
        this.cache = [];
        this._emitter.fire();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'empty') {
            return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        }
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label };
            item.iconPath = new vscode.ThemeIcon('play');
            return item;
        }
        if (node.kind !== 'file') {
            return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None);
        }
        const file = node.file;
        const uri = vscode.Uri.file(toEditorPath(file.NAME));
        const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
        
        const rwText = file.RO ? '🔒 read-only' : 'writable';
        const complexity = (file as any).COMPLEXITY || 0;
        item.description = `${rwText}  ·  complexity ${complexity}`;
        
        item.tooltip = `${file.NAME}\nStatus: ${file.RO ? 'read-only' : 'writable'}\nComplexity: ${complexity}`;
        item.command = {
            command: 'cscout.openFile',
            title: 'Open',
            arguments: [file.NAME],
        };
        return item;
    }

    async getChildren(node?: Node): Promise<Node[]> {
        const client = this.getClient();
        if (!client) {
            return [{ kind: 'action', label: 'Start CScout', command: 'cscout.start' }];
        }
        if (node) {
            return [];
        }

        let files: CScoutFile[] = [];
        let functions: CScoutFunction[] = [];
        try {
            files = await client.getFiles();
            functions = await client.getFunctions({ limit: 10000 });
        } catch (err) {
            return [{ kind: 'empty', label: `Error: ${(err as Error).message}` }];
        }

        const complexityMap = new Map<number, number>();
        for (const fn of functions) {
            if (fn.FID !== undefined && fn.FID !== null) {
                const comp = fn.CCYCL1 || 0;
                complexityMap.set(fn.FID, (complexityMap.get(fn.FID) || 0) + comp);
            }
        }

        const filesWithComplexity = files.map(file => {
            const complexity = complexityMap.get(file.FID) || 0;
            return { ...file, COMPLEXITY: complexity };
        });

        // Always sort alphabetically by name
        filesWithComplexity.sort((a, b) => a.NAME.localeCompare(b.NAME));

        return filesWithComplexity.map(file => ({ kind: 'file' as const, file }));
    }
}

class FunctionTreeProvider implements vscode.TreeDataProvider<Node> {
    private _emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._emitter.event;
    private cache: CScoutFunction[] = [];

    constructor(private getClient: () => CScoutClient | undefined) { }

    refresh(): void {
        this.cache = [];
        this._emitter.fire();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'empty') {
            return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        }
        if (node.kind === 'action') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
            item.command = { command: node.command, title: node.label };
            item.iconPath = new vscode.ThemeIcon('play');
            return item;
        }
        if (node.kind !== 'function') {
            return new vscode.TreeItem('?', vscode.TreeItemCollapsibleState.None);
        }
        const fn = node.fn;
        const item = new vscode.TreeItem(fn.NAME, vscode.TreeItemCollapsibleState.None);
        const cx = fn.CCYCL1 !== null ? ` cx:${fn.CCYCL1}` : '';
        item.description = `in:${fn.FANIN} out:${fn.FANOUT ?? 0}${cx}`;
        item.tooltip = new vscode.MarkdownString(
            `**${fn.NAME}**  \nin: ${fn.FANIN} | out: ${fn.FANOUT ?? 0} | cx: ${fn.CCYCL1 ?? '?'}  \n` +
            (fn.ISMACRO ? 'Macro  \n' : '') +
            (fn.FILESCOPED ? 'file-scoped  \n' : 'linkage-scoped  \n')
        );
        item.iconPath = new vscode.ThemeIcon(fn.ISMACRO ? 'symbol-constant' : 'symbol-function');
        item.command = {
            command: 'cscout.gotoIdentifier',
            title: 'Go to function',
            arguments: [fn.ID],
        };
        return item;
    }

    async getChildren(node?: Node): Promise<Node[]> {
        const client = this.getClient();
        if (!client) {
            return [{ kind: 'action', label: 'Start CScout', command: 'cscout.start' }];
        }
        if (node) {
            return [];
        }
        if (this.cache.length === 0) {
            try {
                this.cache = await client.getFunctions({ defined: true, limit: 10000 });
            } catch (err) {
                return [{ kind: 'empty', label: `Error: ${(err as Error).message}` }];
            }
        }
        return this.cache.map((fn) => ({ kind: 'function' as const, fn }));
    }
}

// -----------------------------------------------------------------------
// Identifier utility functions
// -----------------------------------------------------------------------

function describeIdKind(id: CScoutIdentifier): string {
    if (id.FUNMACRO) return 'function-like macro';
    if (id.MACRO) return 'macro';
    if (id.FUN) return 'function';
    if (id.TYPEDEF) return 'typedef';
    if (id.SUETAG) return 'struct/union/enum tag';
    if (id.SUMEMBER) return 'struct/union member';
    if (id.ENUM) return 'enum member';
    if (id.LABEL) return 'label';
    if (id.YACC) return 'yacc identifier';
    if (id.ORDINARY) return 'variable';
    return 'identifier';
}

function iconForId(id: CScoutIdentifier): string {
    if (id.UNUSED) return 'warning';
    if (id.MACRO) return 'symbol-constant';
    if (id.FUN) return 'symbol-function';
    if (id.TYPEDEF) return 'symbol-interface';
    if (id.SUETAG) return 'symbol-structure';
    if (id.SUMEMBER || id.ENUM) return 'symbol-field';
    return 'symbol-variable';
}

/*
 * Convert a CScout file path back into something VS Code can open.
 * On Windows the paths CScout produces may be either Windows style
 * (from a native install) or /mnt/... (from WSL); we normalize.
 */
function toEditorPath(p: string): string {
    if (process.platform === 'win32' && p.startsWith('/mnt/')) {
        return fromWslPath(p);
    }
    return p;
}

// -----------------------------------------------------------------------
// Editor providers: hover, definition, references, CodeLens
// -----------------------------------------------------------------------

class CScoutHoverProvider implements vscode.HoverProvider {
    constructor(private getClient: () => CScoutClient | undefined) { }

    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
        const client = this.getClient();
        if (!client) {
            return;
        }
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!range) return;
        const name = document.getText(range);
        try {
            const results = await client.getIdentifiers({ name, limit: 5 });
            const exact = results.find((r) => r.NAME === name);
            if (!exact) return;
            const md = new vscode.MarkdownString(undefined, true);
            md.isTrusted = true;

            // Header — name and kind
            md.appendMarkdown(`### $(symbol-${exact.FUN ? 'function' : exact.MACRO ? 'constant' : 'variable'}) ${exact.NAME}\n\n`);
            md.appendMarkdown(`**Kind:** ${describeIdKind(exact)}  \n`);

            // Scope
            const scope = exact.LSCOPE ? 'project (linkage)' : exact.CSCOPE ? 'file (static)' : 'local';
            md.appendMarkdown(`**Scope:** ${scope}  \n`);

            // For functions, fetch cyclomatic complexity from functions list
            if (exact.FUN) {
                try {
                    const fns = await client.getFunctions({ defined: true, limit: 10000 });
                    const fn = fns.find(f => f.NAME === exact.NAME);
                    if (fn && fn.CCYCL1 !== null) {
                        md.appendMarkdown(`**Cyclomatic complexity:** ${fn.CCYCL1}  \n`);
                    }
                } catch { /* skip */ }
            }

            // Cross-file boundary
            const detail = await client.getIdentifier(exact.EID).catch(() => null);
            if (detail && detail.locations.length > 0) {
                const files = new Set(detail.locations.map(l => l.FID));
                if (files.size > 1) {
                    md.appendMarkdown(`**Crosses file boundaries** (${files.size} files)  \n`);
                }
            }

            // Status flags
            if (exact.UNUSED) md.appendMarkdown(`\n⚠ **Unused** — whole-program analysis  \n`);
            if (exact.READONLY) md.appendMarkdown(`🔒 Read-only  \n`);

            // Action links
            md.appendMarkdown(`\n---\n`);
            md.appendMarkdown(`[Find References](command:editor.action.referenceSearch.trigger) | `);
            md.appendMarkdown(`[Rename](command:editor.action.rename) | `);
            md.appendMarkdown(`[Call Graph](command:cscout.showCallGraph?${encodeURIComponent(JSON.stringify([exact.EID]))})`);

            return new vscode.Hover(md, range);
        } catch {
            return;
        }
    }
}

class CScoutDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private getClient: () => CScoutClient | undefined) { }

    async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
        const client = this.getClient();
        if (!client) return;
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!range) return;
        const name = document.getText(range);
        try {
            const results = await client.getIdentifiers({ name, limit: 5 });
            const exact = results.find((r) => r.NAME === name);
            if (!exact) return;
            const detail = await client.getIdentifier(exact.EID);
            return detail.locations.filter((l) => l.LNUM !== null).map(locationToVSCode);
        } catch {
            return;
        }
    }
}

class CScoutReferenceProvider implements vscode.ReferenceProvider {
    constructor(private getClient: () => CScoutClient | undefined) { }

    async provideReferences(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
        const client = this.getClient();
        if (!client) return;
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!range) return;
        const name = document.getText(range);
        try {
            const results = await client.getIdentifiers({ name, limit: 5 });
            const exact = results.find((r) => r.NAME === name);
            if (!exact) return;
            const detail = await client.getIdentifier(exact.EID);
            return detail.locations.filter((l) => l.LNUM !== null).map(locationToVSCode);
        } catch {
            return;
        }
    }
}

class CScoutRenameProvider implements vscode.RenameProvider {
    constructor(private getClient: () => CScoutClient | undefined) { }

    async prepareRename(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Range | undefined> {
        return document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    }

    async provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string
    ): Promise<vscode.WorkspaceEdit | undefined> {
        const client = this.getClient();
        if (!client) return;
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!range) return;
        const oldName = document.getText(range);
        try {
            const results = await client.getIdentifiers({ name: oldName, limit: 5 });
            const exact = results.find((r) => r.NAME === oldName);
            if (!exact) return;
            const preview = await client.previewRename(exact.EID, newName);
            const edit = new vscode.WorkspaceEdit();
            for (const loc of preview.locations) {
                if (loc.LNUM === null) continue;
                const uri = vscode.Uri.file(toEditorPath(loc.FILE));
                const line = loc.LNUM - 1;
                // Best-effort: replace the identifier on that line.
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const lineText = doc.lineAt(line).text;
                    const idx = lineText.indexOf(oldName);
                    if (idx >= 0) {
                        edit.replace(uri, new vscode.Range(line, idx, line, idx + oldName.length), newName);
                    }
                } catch {
                    /* file may not be openable */
                }
            }
            return edit;
        } catch {
            return;
        }
    }
}

function locationToVSCode(loc: CScoutLocation): vscode.Location {
    const uri = vscode.Uri.file(toEditorPath(loc.FILE));
    const line = Math.max(0, (loc.LNUM || 1) - 1);
    return new vscode.Location(uri, new vscode.Position(line, 0));
}

// -----------------------------------------------------------------------
// Diagnostics — unused identifiers surfaced in Problems panel
// -----------------------------------------------------------------------

async function resolveRange(
    file: string,
    loc: CScoutLocation,
    name: string,
    docCache: Map<string, vscode.TextDocument>
): Promise<vscode.Range> {
    try {
        if (loc.LNUM === null) {
            return new vscode.Range(0, 0, 0, 200);
        }
        let doc = docCache.get(file);
        if (!doc) {
            doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            docCache.set(file, doc);
        }

        if (loc.FOFFSET !== undefined && loc.FOFFSET !== null) {
            const startPos = doc.positionAt(loc.FOFFSET);
            const endPos = doc.positionAt(loc.FOFFSET + name.length);
            const text = doc.getText(new vscode.Range(startPos, endPos));
            if (text === name) {
                return new vscode.Range(startPos, endPos);
            }
        }

        const line = loc.LNUM - 1;
        const lineText = doc.lineAt(line).text;
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedName}\\b`);
        const match = regex.exec(lineText);
        if (match && match.index !== undefined) {
            return new vscode.Range(line, match.index, line, match.index + name.length);
        } else {
            const idx = lineText.indexOf(name);
            if (idx >= 0) {
                return new vscode.Range(line, idx, line, idx + name.length);
            } else {
                return new vscode.Range(line, 0, line, lineText.length);
            }
        }
    } catch {
        const line = loc.LNUM === null ? 0 : loc.LNUM - 1;
        return new vscode.Range(line, 0, line, 200);
    }
}

async function refreshDiagnostics(
    client: CScoutClient,
    diagnostics: vscode.DiagnosticCollection
): Promise<void> {
    diagnostics.clear();
    try {
        const [unused, shouldStatic] = await Promise.all([
            client.getIdentifiers({ unused: true, limit: 5000 }),
            client.getIdentifiers({ should_be_static: true, limit: 5000 })
        ]);

        const byFile = new Map<string, vscode.Diagnostic[]>();
        const docCache = new Map<string, vscode.TextDocument>();

        // Limit how many we resolve locations for — resolving each hits the
        // server.  Prioritize ordinary identifiers and functions.
        const worthUnused = unused.filter((id) => id.ORDINARY || id.FUN || id.MACRO).slice(0, 500);
        const worthStatic = shouldStatic.filter((id) => (id.ORDINARY || id.FUN) && !id.TYPEDEF && !id.ENUM && !id.SUETAG).slice(0, 500);

        for (const id of worthUnused) {
            try {
                const detail = await client.getIdentifier(id.EID);
                for (const loc of detail.locations) {
                    if (loc.LNUM === null) continue;
                    const file = toEditorPath(loc.FILE);
                    const list = byFile.get(file) || [];
                    const range = await resolveRange(file, loc, id.NAME, docCache);
                    list.push(
                        new vscode.Diagnostic(
                            range,
                            `CScout: unused identifier '${id.NAME}'`,
                            vscode.DiagnosticSeverity.Warning
                        )
                    );
                    byFile.set(file, list);
                }
            } catch {
                /* skip identifiers that fail to resolve */
            }
        }

        for (const id of worthStatic) {
            try {
                const detail = await client.getIdentifier(id.EID);
                for (const loc of detail.locations) {
                    if (loc.LNUM === null) continue;
                    const file = toEditorPath(loc.FILE);
                    const list = byFile.get(file) || [];
                    const range = await resolveRange(file, loc, id.NAME, docCache);
                    list.push(
                        new vscode.Diagnostic(
                            range,
                            `CScout: identifier '${id.NAME}' should be static`,
                            vscode.DiagnosticSeverity.Information
                        )
                    );
                    byFile.set(file, list);
                }
            } catch {
                /* skip identifiers that fail to resolve */
            }
        }

        for (const [file, list] of byFile) {
            diagnostics.set(vscode.Uri.file(file), list);
        }
    } catch {
        /* server may be down — leave problems empty */
    }
}

// -----------------------------------------------------------------------
// activate()
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// CodeLens provider — shows caller/callee/complexity counts above functions
// -----------------------------------------------------------------------

class CScoutCodeLensProvider implements vscode.CodeLensProvider {
	private _emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._emitter.event;
	private cache: CScoutFunction[] = [];

	constructor(private getClient: () => CScoutClient | undefined) {}

	refresh(): void {
		this.cache = [];
		this._emitter.fire();
	}

	async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		const client = this.getClient();
		if (!client) return [];

		try {
			if (this.cache.length === 0) {
				this.cache = await client.getFunctions({ defined: true, limit: 10000 });
			}
			const lenses: vscode.CodeLens[] = [];
			const text = document.getText();

			for (const fn of this.cache) {
				if (!fn.DEFINED) continue;
				// Match function name followed by ( — handles most C function definitions.
				const pattern = new RegExp(
					`\\b${fn.NAME.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\(`,
					'g'
				);
				let match: RegExpExecArray | null;
				let found = false;
				while ((match = pattern.exec(text)) !== null) {
					const pos = document.positionAt(match.index);
					// Only show on lines that look like definitions (not calls).
					const lineText = document.lineAt(pos.line).text;
					if (!/^\s*(return|if|while|for|switch|&&|\|\|)/.test(lineText)) {
						const range = new vscode.Range(pos, pos);
						const fanin = fn.FANIN ?? 0;
						const fanout = fn.FANOUT ?? 0;
						const callerLabel = fanin === 1 ? '1 caller' : `${fanin} callers`;
						const calleeLabel = fanout === 1 ? '1 callee' : `${fanout} callees`;
						lenses.push(new vscode.CodeLens(range, {
							title: `${callerLabel} | ${calleeLabel}`,
							command: 'cscout.showCallGraph',
							arguments: [fn.ID],
						}));
						found = true;
						break;
					}
				}
			}
			return lenses;
		} catch {
			return [];
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
    const channel = vscode.window.createOutputChannel('CScout');
    context.subscriptions.push(channel);

    const settings = loadSettings();

    // Lifecycle state broadcast.
    let currentState: CScoutState = 'stopped';
    const stateContextKey = 'cscout.state';

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBar);

    const diagnostics = vscode.languages.createDiagnosticCollection('cscout');
    context.subscriptions.push(diagnostics);

    const lifecycle = new CScoutLifecycle(settings, channel, {
        onStateChange: (state, detail) => {
            currentState = state;
            void vscode.commands.executeCommand('setContext', stateContextKey, state);
            updateStatusBar(statusBar, state, detail, lifecycle);
            identifierProvider.refresh();
            fileProvider.refresh();
            codeLensProvider.refresh();
        },
        onReady: async (build) => {
            channel.appendLine(`Ready.  ${build.fileCount} files, workspace: ${build.projectName}`);
            const client = lifecycle.getClient();
            if (client) {
                await refreshDiagnostics(client, diagnostics);
            }
        },
        onError: (message) => {
            vscode.window
                .showErrorMessage(`CScout: ${message}`, 'View Output')
                .then((choice) => {
                    if (choice === 'View Output') {
                        channel.show();
                    }
                });
        },
        onProgress: (message) => channel.appendLine(message),
    });
    context.subscriptions.push({ dispose: () => lifecycle.dispose() });

    const identifierProvider = new IdentifierTreeProvider(() => lifecycle.getClient());
    const fileProvider = new FileTreeProvider(() => lifecycle.getClient());
    const actionProvider = new ActionTreeProvider();
    actionProvider.setState(currentState);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('cscout.identifiers', identifierProvider),
        vscode.window.registerTreeDataProvider('cscout.files', fileProvider)
    );

    // Editor providers.
    const clientAccessor = () => lifecycle.getClient();
    const codeLensProvider = new CScoutCodeLensProvider(clientAccessor);
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: 'c' },
            new CScoutHoverProvider(clientAccessor)
        ),
        vscode.languages.registerDefinitionProvider(
            { language: 'c' },
            new CScoutDefinitionProvider(clientAccessor)
        ),
        vscode.languages.registerReferenceProvider(
            { language: 'c' },
            new CScoutReferenceProvider(clientAccessor)
        ),
        vscode.languages.registerRenameProvider(
            { language: 'c' },
            new CScoutRenameProvider(clientAccessor)
        ),
        vscode.languages.registerCodeLensProvider(
            { language: 'c' },
            codeLensProvider
        )
    );

    // Commands.
    context.subscriptions.push(
        vscode.commands.registerCommand('cscout.start', async () => {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) {
                vscode.window.showErrorMessage('CScout: open a folder first.');
                return;
            }
            await lifecycle.start(ws.uri.fsPath);
        }),
        vscode.commands.registerCommand('cscout.stop', () => lifecycle.stop()),
        vscode.commands.registerCommand('cscout.reanalyze', async () => {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) return;
            await lifecycle.reanalyze(ws.uri.fsPath);
        }),
        vscode.commands.registerCommand('cscout.toggle', () => {
            if (currentState === 'ready' || currentState === 'analyzing' || currentState === 'indexing') {
                return lifecycle.stop();
            }
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) return;
            return lifecycle.start(ws.uri.fsPath);
        }),
        vscode.commands.registerCommand('cscout.refresh', () => {
            identifierProvider.refresh();
            fileProvider.refresh();
            codeLensProvider.refresh();
            const client = lifecycle.getClient();
            if (client) {
                void refreshDiagnostics(client, diagnostics);
            }
        }),
        vscode.commands.registerCommand('cscout.gotoIdentifier', async (eid: number) => {
            const client = lifecycle.getClient();
            if (!client) return;
            try {
                const detail = await client.getIdentifier(eid);
                const first = detail.locations.find((l) => l.LNUM !== null);
                if (!first) {
                    vscode.window.showInformationMessage(`No definition location for identifier ${eid}.`);
                    return;
                }
                const uri = vscode.Uri.file(toEditorPath(first.FILE));
                const doc = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(doc);
                const pos = new vscode.Position(Math.max(0, (first.LNUM || 1) - 1), 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not open identifier: ${(err as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('cscout.openFile', async (filePath: string) => {
            try {
                const uri = vscode.Uri.file(toEditorPath(filePath));
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not open file: ${(err as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('cscout.showCallGraph', async (eid?: number) => {
            const client = lifecycle.getClient();
            if (!client) return;
            const target = eid ?? (await promptForFunctionEid(client));
            if (target === undefined) return;
            await showCallGraph(context, client, target);
        }),
        vscode.commands.registerCommand('cscout.showFunctionMetrics', async (fnid?: number) => {
            const client = lifecycle.getClient();
            if (!client) return;
            const target = fnid ?? (await promptForFunctionEid(client));
            if (target === undefined) return;
            await showFunctionMetrics(context, client, target);
        vscode.commands.registerCommand('cscout.showWalkthrough', () => {
            showWalkthrough(context);
        }),
        vscode.commands.registerCommand('cscout.loadMore', async (node) => {
        })
    );

    // Status bar starts up idle.
    updateStatusBar(statusBar, 'stopped', undefined, lifecycle);
    statusBar.show();

    // First-activation orientation message.
    if (!context.globalState.get<boolean>(CSCOUT_KEY_FIRST_ACTIVATION)) {
        void context.globalState.update(CSCOUT_KEY_FIRST_ACTIVATION, true);
        vscode.window.showInformationMessage(
            'CScout needs to know how your project is compiled. This is standard for any C ' +
            'analysis tool. We support CMake, Meson, Make, and Autotools projects. If your ' +
            'project uses a different build system, you can generate compile_commands.json using Bear.'
        );
    }

    // Autostart if requested.
    if (settings.autoStart) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
            void lifecycle.start(ws.uri.fsPath);
        }
    }
}

// -----------------------------------------------------------------------
// Status bar
// -----------------------------------------------------------------------

function updateStatusBar(
    item: vscode.StatusBarItem,
    state: CScoutState,
    detail: string | undefined,
    lifecycle: CScoutLifecycle
): void {
    switch (state) {
        case 'stopped':
            item.text = '$(play) CScout';
            item.tooltip = 'Start CScout analysis';
            item.command = 'cscout.start';
            break;
        case 'analyzing':
            item.text = '$(sync~spin) CScout: Analyzing';
            item.tooltip = detail || 'Running CScout analysis...';
            item.command = undefined;
            break;
        case 'indexing':
            item.text = '$(sync~spin) CScout: Building indexes';
            item.tooltip = 'csapi is building search indexes...';
            item.command = undefined;
            break;
        case 'ready': {
            const build = lifecycle.getBuildResult();
            item.text = `$(check) CScout${build ? ` · ${build.fileCount} files` : ''}`;
            item.tooltip = 'CScout ready — click to stop';
            item.command = 'cscout.stop';
            break;
        }
        case 'error':
            item.text = '$(error) CScout';
            item.tooltip = detail || 'CScout encountered an error';
            item.command = 'cscout.start';
            break;
    }
}

// -----------------------------------------------------------------------
// Call graph webview
// -----------------------------------------------------------------------

async function promptForFunctionEid(client: CScoutClient): Promise<number | undefined> {
    const name = await vscode.window.showInputBox({
        title: 'Function name',
        placeHolder: 'e.g. main',
    });
    if (!name) return undefined;
    const results = await client.getIdentifiers({ name, fun: true, limit: 20 });
    if (results.length === 0) {
        vscode.window.showInformationMessage(`No function named "${name}" found.`);
        return undefined;
    }
    if (results.length === 1) return results[0].EID;
    const pick = await vscode.window.showQuickPick(
        results.map((r) => ({ label: r.NAME, description: `EID ${r.EID}`, value: r.EID })),
        { title: 'Select function' }
    );
    return pick?.value;
}

async function showCallGraph(
    context: vscode.ExtensionContext,
    client: CScoutClient,
    eid: number
): Promise<void> {
    const [detail, callers, callees] = await Promise.all([
        client.getIdentifier(eid),
        client.getCallers(eid),
        client.getCallees(eid),
    ]);

    const panel = vscode.window.createWebviewPanel(
        'cscoutCallGraph',
        `Call graph: ${detail.identifier.NAME}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );
    panel.webview.html = renderCallGraphHtml(detail.identifier.NAME, callers, callees);
}

function renderCallGraphHtml(
    centerName: string,
    callers: CScoutCallEntry[],
    callees: CScoutCallEntry[]
): string {
    const list = (items: CScoutCallEntry[]) =>
        items.length === 0
            ? '<em>none</em>'
            : '<ul>' +
            items
                .map(
                    (i) =>
                        `<li>${escapeHtml(i.NAME)} <small>${escapeHtml(path.basename(i.FILE))}</small></li>`
                )
                .join('') +
            '</ul>';
    return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
body { font-family: var(--vscode-font-family); padding: 1em; }
h1 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .5em; }
.columns { display: flex; gap: 2em; }
.col { flex: 1; }
h2 { font-size: 1em; color: var(--vscode-descriptionForeground); }
ul { list-style: none; padding: 0; }
li { padding: .25em 0; }
small { color: var(--vscode-descriptionForeground); margin-left: .5em; }
</style></head><body>
<h1>${escapeHtml(centerName)}</h1>
<div class="columns">
	<div class="col"><h2>Callers (${callers.length})</h2>${list(callers)}</div>
	<div class="col"><h2>Callees (${callees.length})</h2>${list(callees)}</div>
</div>
</body></html>`;
}

async function showFunctionMetrics(
    context: vscode.ExtensionContext,
    client: CScoutClient,
    fnid: number
): Promise<void> {
    const metrics = await client.getFunmetrics(fnid);
    const panel = vscode.window.createWebviewPanel(
        'cscoutFuncMetrics',
        `Function metrics`,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );
    const rows = metrics
        .map((m) => {
            const entries = Object.entries(m)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
                .join('');
            return `<h2>${m.PRECPP ? 'Pre-preprocessor' : 'Post-preprocessor'}</h2><table>${entries}</table>`;
        })
        .join('');
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<style>
body { font-family: var(--vscode-font-family); padding: 1em; }
table { border-collapse: collapse; width: 100%; }
td { padding: .25em .75em; border-bottom: 1px solid var(--vscode-panel-border); }
td:first-child { color: var(--vscode-descriptionForeground); }
</style></head><body>${rows}</body></html>`;
function showWalkthrough(context: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
        'cscoutWalkthrough',
        'CScout — Getting Started',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    panel.webview.html = getWalkthroughHtml();
    const listener = panel.webview.onDidReceiveMessage((msg) => {
        if (msg.command === 'openSettings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'cscout');
        }
    });
    panel.onDidDispose(() => listener.dispose());
}

function getWalkthroughHtml(): string {
    return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
body { font-family: var(--vscode-font-family); padding: 2em; max-width: 800px; line-height: 1.6; }
h1 { color: var(--vscode-textLink-foreground); border-bottom: 2px solid var(--vscode-panel-border); padding-bottom: .5em; }
h2 { margin-top: 2em; color: var(--vscode-textLink-foreground); }
.step { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 1em 1.5em; margin: 1em 0; border-left: 3px solid var(--vscode-textLink-foreground); }
.step-number { font-size: .8em; font-weight: bold; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .1em; }
code { background: var(--vscode-textCodeBlock-background); padding: .1em .4em; border-radius: 3px; font-family: var(--vscode-editor-font-family); }
pre { background: var(--vscode-textCodeBlock-background); padding: 1em; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: .5em 1.2em; border-radius: 4px; cursor: pointer; font-size: .95em; margin-top: .5em; }
button:hover { background: var(--vscode-button-hoverBackground); }
.check { color: #4caf50; font-weight: bold; }
.warn { color: var(--vscode-inputValidation-warningForeground); }
table { border-collapse: collapse; width: 100%; margin: .5em 0; }
td, th { padding: .4em .8em; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
th { color: var(--vscode-descriptionForeground); font-size: .9em; }
</style>
</head><body>

<h1>🔍 CScout — Getting Started</h1>
<p>CScout is a whole-program C source code analyzer that understands the C preprocessor. This extension brings CScout's analysis directly into VS Code.</p>

<div class="step">
<div class="step-number">Step 1 — Prerequisites</div>
<h2>Install Required Tools</h2>
<p>The extension needs the following tools installed on your system (Linux/macOS) or accessible via WSL (Windows):</p>
<table>
<tr><th>Tool</th><th>Purpose</th><th>Install</th></tr>
<tr><td><code>cscout</code></td><td>C analysis engine</td><td><a href="https://github.com/dspinellis/cscout">Build from source</a></td></tr>
<tr><td><code>python3</code></td><td>Runs csapi.py REST server</td><td>System package manager</td></tr>
<tr><td><code>sqlite3</code></td><td>Stores analysis database</td><td>System package manager</td></tr>
</table>
<p>On Ubuntu/Debian: <code>sudo apt install python3 sqlite3</code></p>
</div>

<div class="step">
<div class="step-number">Step 2 — Configure Paths</div>
<h2>Set Up Extension Settings</h2>
<p>Tell the extension where to find the CScout tools:</p>
<pre><code># In VS Code settings (cscout.*):
cscout.binaryPath     — path to the cscout binary
cscout.cscocoPyPath   — path to cscoco.py (for CMake/Meson projects)
cscout.csapiPyPath    — path to csapi.py (REST server)
cscout.csmakePath     — path to csmake (for Makefile projects)</code></pre>
<button onclick="openSettings()">Open CScout Settings</button>
</div>

<div class="step">
<div class="step-number">Step 3 — Open a C Project</div>
<h2>Supported Build Systems</h2>
<p>Open any C project folder in VS Code. The extension supports:</p>
<table>
<tr><th>Build System</th><th>How it works</th></tr>
<tr><td>Existing <code>.cs</code> file</td><td>Used directly — fastest option</td></tr>
<tr><td>CMake</td><td>Runs <code>cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON</code> then cscoco</td></tr>
<tr><td>Meson</td><td>Runs <code>meson setup build</code> then cscoco</td></tr>
<tr><td>Makefile</td><td>Intercepts build with csmake</td></tr>
<tr><td>Autotools</td><td>Runs <code>./configure</code> then csmake</td></tr>
</table>
</div>

<div class="step">
<div class="step-number">Step 4 — Start Analysis</div>
<h2>Run CScout</h2>
<p>Click the <strong>▶ Start CScout</strong> button in the sidebar, or run:</p>
<pre><code>Ctrl+Shift+P → CScout: Start Analysis</code></pre>
<p>The extension will:</p>
<ul>
<li>Detect your build system and ask which to use</li>
<li>Generate a CScout workspace file (<code>.cs</code>)</li>
<li>Run CScout analysis and build a SQLite database</li>
<li>Start the csapi REST server</li>
<li>Populate all sidebar panels</li>
</ul>
<p>Status bar shows: <code>⟳ CScout: Analyzing...</code> → <code>✓ CScout · N files</code></p>
</div>

<div class="step">
<div class="step-number">Step 5 — Explore Results</div>
<h2>What You Can Do</h2>
<table>
<tr><th>Feature</th><th>How to use</th></tr>
<tr><td>Browse identifiers</td><td>Expand groups in the Identifiers panel</td></tr>
<tr><td>Hover for info</td><td>Hover over any identifier in a C file</td></tr>
<tr><td>Go to definition</td><td>Ctrl+Click on any identifier</td></tr>
<tr><td>Find all references</td><td>Shift+F12 on any identifier</td></tr>
<tr><td>Rename identifier</td><td>F2 on any identifier (whole-program rename)</td></tr>
<tr><td>Inspect identifier</td><td>Click Inspect in the hover tooltip</td></tr>
<tr><td>Call graph</td><td>Click Call Graph in the hover tooltip</td></tr>
<tr><td>Unused warnings</td><td>Check the Problems panel</td></tr>
</table>
</div>

<hr>
<p style="color: var(--vscode-descriptionForeground); font-size: .9em;">
CScout is developed by <a href="https://github.com/dspinellis">Diomidis Spinellis</a>.
The VS Code extension is part of GSoC 2026.
</p>

<script>
const vscode = acquireVsCodeApi();
function openSettings() {
    vscode.postMessage({ command: 'openSettings' });
}
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}

export function deactivate(): void {
    /* handled via context subscriptions */
}