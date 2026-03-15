export interface CScoutIdentifier {
    eid: string;
    name: string;
    readonly: boolean;
    macro: boolean;
    ordinary: boolean;
    suetag: boolean;
    sumember: boolean;
    label: boolean;
    typedef: boolean;
    fun: boolean;
    cscope: boolean;
    lscope: boolean;
    unused: boolean;
    xfile: boolean;
}

export interface CScoutFile {
    fid: number;
    name: string;
    readonly: boolean;
}

export interface CScoutFunction {
    id: string;
    name: string;
    is_macro: boolean;
    is_defined: boolean;
    is_file_scoped: boolean;
    fanin: number;
    fanout: number;
}

export interface CScoutLocation {
    fid: number;
    file: string;
    line: number;
    offset: number;
}

export interface CScoutIdDetail {
    eid: string;
    name: string;
    unused: boolean;
    xfile: boolean;
    locations: CScoutLocation[];
}

export class CScoutClient {
    private host: string;
    private port: number;

    constructor(host: string = 'localhost', port: number = 8081) {
        this.host = host;
        this.port = port;
    }

    async isAlive(): Promise<boolean> {
        try {
            const html = await this.get('/index.html');
            return html.includes('CScout');
        } catch {
            return false;
        }
    }

    async getIdentifiers(): Promise<CScoutIdentifier[]> {
        const resp = await this.get('/api/identifiers');
        return JSON.parse(resp);
    }

    async getIdentifierDetail(eid: string): Promise<CScoutIdDetail> {
        const resp = await this.get(`/api/id?id=${eid}`);
        return JSON.parse(resp);
    }

    async getFiles(): Promise<CScoutFile[]> {
        const resp = await this.get('/api/files');
        return JSON.parse(resp);
    }

    async getFileMetrics(fid: number): Promise<any> {
        const resp = await this.get(`/api/filemetrics?id=${fid}`);
        return JSON.parse(resp);
    }

    async getFunctions(): Promise<CScoutFunction[]> {
        const resp = await this.get('/api/functions');
        return JSON.parse(resp);
    }

    async getCallers(funcId: string): Promise<any[]> {
        const resp = await this.get(`/api/funcs?callers=${funcId}`);
        return JSON.parse(resp);
    }

    async getCallees(funcId: string): Promise<any[]> {
        const resp = await this.get(`/api/funcs?callees=${funcId}`);
        return JSON.parse(resp);
    }

    async getProjects(): Promise<any[]> {
        const resp = await this.get('/api/projects');
        return JSON.parse(resp);
    }

    async previewRename(eid: string, newName: string): Promise<any> {
        const resp = await this.get(`/api/refactor?id=${eid}&newname=${encodeURIComponent(newName)}`);
        return JSON.parse(resp);
    }

    private get(path: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const net = require('net');
            const socket = net.createConnection({ host: this.host, port: this.port });
            let raw = '';
            let settled = false;

            const fail = (err: Error) => {
                if (settled) { return; }
                settled = true;
                socket.destroy();
                reject(err);
            };

            socket.setTimeout(10000);
            socket.setEncoding('utf-8');

            socket.on('connect', () => {
                socket.write(
                    `GET ${path} HTTP/1.0\r\n` +
                    `Host: ${this.host}:${this.port}\r\n` +
                    `Connection: close\r\n` +
                    `\r\n`
                );
            });

            socket.on('data', (chunk: string) => { raw += chunk; });

            socket.on('end', () => {
                if (settled) { return; }
                settled = true;

                // Skip HTTP headers, find body after blank line
                let bodyStart = raw.indexOf('\r\n\r\n');
                if (bodyStart !== -1) {
                    bodyStart += 4;
                } else {
                    bodyStart = raw.indexOf('\n\n');
                    bodyStart = bodyStart !== -1 ? bodyStart + 2 : 0;
                }

                resolve(raw.substring(bodyStart));
            });

            socket.on('timeout', () => fail(new Error(`Timeout fetching ${path}`)));
            socket.on('error', (err: Error) => fail(err));
        });
    }
}