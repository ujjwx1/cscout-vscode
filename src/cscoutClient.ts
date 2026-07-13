/*
 * cscoutClient.ts — HTTP client for the csapi REST server.
 *
 * csapi is a standard HTTP/1.1 server exposing the CScout SQLite
 * database as JSON.  Field names come directly from SQL column names
 * (uppercase) — we mirror them here to avoid ambiguity.
 */

import * as http from 'http';

/*
 * Field naming: csapi returns SQL column names verbatim (EID, NAME,
 * FUN, UNUSED, etc.).  We do not translate — what you see in the API
 * matches what the extension code accesses.
 */

export interface CScoutIdentifier {
	EID: number;
	NAME: string;
	READONLY: number;
	UNDEFMACRO: number;
	MACRO: number;
	FUNMACRO: number;
	MACROARG: number;
	CPPCONST: number;
	CPPSTRVAL: number;
	DEFCCONSTVAL: number;
	NOTDEFCCONSTVAL: number;
	EXPCCONSTVAL: number;
	NOTEXPCCONSTVAL: number;
	ORDINARY: number;
	SUETAG: number;
	SUMEMBER: number;
	LABEL: number;
	TYPEDEF: number;
	ENUM: number;
	YACC: number;
	FUN: number;
	CSCOPE: number;
	LSCOPE: number;
	UNUSED: number;
}

export interface CScoutFile {
	FID: number;
	NAME: string;
	RO: number;
}

export interface CScoutFunction {
	ID: number;
	NAME: string;
	ISMACRO: number;
	DEFINED: number;
	DECLARED: number;
	FILESCOPED: number;
	FID: number;
	FOFFSET: number;
	FANIN: number;
	FANOUT: number | null;
	CCYCL1: number | null;
}

export interface CScoutLocation {
	FID: number;
	FILE: string;
	FOFFSET: number;
	LNUM: number | null;
}

export interface CScoutIdDetail {
	identifier: CScoutIdentifier;
	locations: CScoutLocation[];
}

export interface CScoutCallEntry {
	ID: number;
	NAME: string;
	FID: number;
	FOFFSET: number;
	FILE: string;
}

export interface CScoutFileMetric {
	FID: number;
	PRECPP: number;
	[key: string]: number | null;
}

export interface CScoutFuncMetric {
	FUNCTIONID: number;
	PRECPP: number;
	[key: string]: number | null;
}

export interface CScoutRefactorPreview {
	eid: number;
	old_name: string;
	new_name: string;
	total_replacements: number;
	locations: CScoutLocation[];
}

export interface CScoutStatus {
	status: string;
	indexes_ready: boolean;
}

export interface CScoutProject {
	PID: number;
	NAME: string;
}

export interface IdentifierFilters {
	unused?: boolean;
	macro?: boolean;
	fun?: boolean;
	readonly?: boolean;
	should_be_static?: boolean;
	name?: string;
	limit?: number;
	offset?: number;
}

export interface FunctionFilters {
	defined?: boolean;
	filescoped?: boolean;
	limit?: number;
	offset?: number;
}

export class CScoutClient {

	constructor(private host: string, private port: number) { }

	/*
	 * Basic GET returning parsed JSON.  Rejects on network error,
	 * non-2xx status, or unparseable body.
	 */
	private get<T>(path: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const req = http.get(
				{
					host: this.host,
					port: this.port,
					path,
					timeout: 30_000,
				},
				(res) => {
					let body = '';
					res.setEncoding('utf-8');
					res.on('data', (chunk) => (body += chunk));
					res.on('end', () => {
						if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
							reject(new Error(`csapi ${path}: HTTP ${res.statusCode}`));
							return;
						}
						try {
							resolve(JSON.parse(body) as T);
						} catch {
							reject(new Error(`csapi ${path}: invalid JSON response`));
						}
					});
				}
			);
			req.on('timeout', () => {
				req.destroy();
				reject(new Error(`csapi ${path}: timeout`));
			});
			req.on('error', reject);
		});
	}

	private buildQuery(params: Record<string, unknown>): string {
		const parts: string[] = [];
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined || value === null) {
				continue;
			}
			parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		}
		return parts.length ? `?${parts.join('&')}` : '';
	}

	async getStatus(): Promise<CScoutStatus> {
		return this.get<CScoutStatus>('/status');
	}

	async isAlive(): Promise<boolean> {
		try {
			const status = await this.getStatus();
			return status.status === 'ok';
		} catch {
			return false;
		}
	}

	async getIdentifiers(filters: IdentifierFilters = {}): Promise<CScoutIdentifier[]> {
		return this.get<CScoutIdentifier[]>('/identifiers' + this.buildQuery(filters as Record<string, unknown>));
	}

	async getIdentifier(eid: number): Promise<CScoutIdDetail> {
		return this.get<CScoutIdDetail>(`/identifier?eid=${eid}`);
	}

	async getFiles(): Promise<CScoutFile[]> {
		return this.get<CScoutFile[]>('/files');
	}

	async getFilemetrics(fid: number): Promise<CScoutFileMetric[]> {
		return this.get<CScoutFileMetric[]>(`/filemetrics?fid=${fid}`);
	}

	async getFunctions(filters: FunctionFilters = {}): Promise<CScoutFunction[]> {
		return this.get<CScoutFunction[]>('/functions' + this.buildQuery(filters as Record<string, unknown>));
	}

	async getFunmetrics(fnid: number): Promise<CScoutFuncMetric[]> {
		return this.get<CScoutFuncMetric[]>(`/funmetrics?fnid=${fnid}`);
	}

	async getCallers(eid: number): Promise<CScoutCallEntry[]> {
		return this.get<CScoutCallEntry[]>(`/callers?fnid=${eid}`);
	}

	async getCallees(eid: number): Promise<CScoutCallEntry[]> {
		return this.get<CScoutCallEntry[]>(`/callees?fnid=${eid}`);
	}

	async getProjects(): Promise<CScoutProject[]> {
		return this.get<CScoutProject[]>('/projects');
	}

	async previewRename(eid: number, newName: string): Promise<CScoutRefactorPreview> {
		return this.get<CScoutRefactorPreview>(
			`/refactor/preview?eid=${eid}&newname=${encodeURIComponent(newName)}`
		);
	}

	/*
	 * Ask csapi to shut down gracefully.  Called before killing the
	 * process so listeners can clean up.  Errors are ignored — the
	 * server may already be gone.
	 */
	async quit(): Promise<void> {
		try {
			await this.get<unknown>('/quit');
		} catch {
			/* server is gone or was never running — expected */
		}
	}

	getBaseUrl(): string {
		return `http://${this.host}:${this.port}`;
	}
}