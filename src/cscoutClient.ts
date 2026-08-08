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
	UNDEFEDMACRO?: number;
	REDEFEDSAMEMACRO?: number;
	REDEFEDDIFFMACRO?: number;
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

export interface CScoutFileDetail {
	file: CScoutFile;
	metrics: Record<string, number>;
	functions: { ID: number; NAME: string; FANIN: number; FANOUT: number | null; CCYCL1: number | null; LNUM: number | null }[];
	includes: CScoutFile[];
	included_by: CScoutFile[];
}

export interface CScoutAttribute {
	id: string;
	name: string;
}

export interface CScoutFunction {
	ID: number;
	NAME: string;
	ISMACRO: number;
	DEFINED: number;
	DECLARED: number;
	FILESCOPED: number;
	FID: number;
	FILE: string | null;
	FOFFSET: number;
	LNUM: number | null;
	FANIN: number;
	FANOUT: number | null;
	CCYCL1: number | null;
}

export interface CScoutLocation {
	FID: number;
	FILE: string;
	FOFFSET: number;
	LNUM: number | null;
	LINE_START_OFFSET?: number;
	RO: number;
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

export interface CScoutIdentifierDetail {
	identifier: CScoutIdentifier;
	locations: CScoutLocation[];
	occurrences: number;
	projects: CScoutProject[];
	dependent_files: { FID: number; NAME: string; RO: number }[];
	associated_functions: { ID: number; NAME: string; FILE: string; FOFFSET: number }[];
	function_detail: {
		function: CScoutFunction;
		callers_count: number;
		callees_count: number;
		definition: { FUNCTIONID: number; FIDBEGIN: number; FOFFSETBEGIN: number; FIDEND: number; FOFFSETEND: number; FILE: string } | null;
		metrics: CScoutFuncMetric[];
	} | null;
}

export type CScoutIdDetail = CScoutIdentifierDetail;

export interface CScoutRefactorApplyResult {
	old_name: string;
	new_name: string;
	modified_files: string[];
	total_replacements: number;
}

export interface IdentifierFilters {
	query?: string;
	name?: string;
	name_ne?: string;
	limit?: number;
	offset?: number;
}

export interface FunctionFilters {
	query?: string;
	name?: string;
	limit?: number;
	offset?: number;
}

export class CScoutClient {

	constructor(private host: string, private port: number) { }

	getBaseUrl(): string {
		return `http://${this.host}:${this.port}`;
	}

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

	/**
	 * Fetch per-category identifier counts with a single SQL query.
	 * Used by the sidebar to show folder counts without loading all rows.
	 */
	async getIdentifierCounts(): Promise<Record<string, number>> {
		return this.get<Record<string, number>>('/identifiers/counts');
	}

	async getIdentifier(eid: number): Promise<CScoutIdentifierDetail> {
		return this.get<CScoutIdentifierDetail>(`/identifier?eid=${eid}`);
	}

	async getFiles(query?: string): Promise<CScoutFile[]> {
		const q = query ? `?query=${query}` : '';
		return this.get<CScoutFile[]>(`/files${q}`);
	}

	async getFilemetrics(fid: number): Promise<CScoutFileMetric[]> {
		return this.get<CScoutFileMetric[]>(`/filemetrics?fid=${fid}`);
	}

	async getFunctions(filters: FunctionFilters = {}): Promise<CScoutFunction[]> {
		return this.get<CScoutFunction[]>('/functions' + this.buildQuery(filters as Record<string, unknown>));
	}

	/**
	 * Fetch per-category function counts with a single SQL query.
	 * Used by the sidebar to show folder counts without loading all rows.
	 */
	async getFunctionCounts(): Promise<Record<string, number>> {
		return this.get<Record<string, number>>('/functions/counts');
	}

	/**
	 * Fetch a single function by exact name (defined functions only).
	 * Used by hover to get CCYCL1 without fetching all 10,000+ functions.
	 */
	async getFunctionByName(name: string): Promise<CScoutFunction | null> {
		return this.get<CScoutFunction | null>(`/functions/byname?name=${encodeURIComponent(name)}`);
	}

	/**
	 * Fetch per-category file counts with a single SQL query.
	 * Replaces 8 parallel API calls when the Files panel opens.
	 */
	async getFileCounts(): Promise<Record<string, number>> {
		return this.get<Record<string, number>>('/files/counts');
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
			`/rename/preview?eid=${eid}&newname=${encodeURIComponent(newName)}`
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
	async getIdentifierDetail(eid: number): Promise<CScoutIdentifierDetail> {
		return this.get<CScoutIdentifierDetail>(`/identifier/detail?eid=${eid}`);
	}

	async getFilemetricsAggregate(): Promise<CScoutFileMetric[]> {
		return this.get<CScoutFileMetric[]>('/filemetrics/aggregate');
	}

	async getFunmetricsAggregate(): Promise<CScoutFuncMetric[]> {
		return this.get<CScoutFuncMetric[]>('/funmetrics/aggregate');
	}

	async getFileDetail(fid: number): Promise<CScoutFileDetail> {
		return this.get<CScoutFileDetail>(`/file/detail?fid=${fid}`);
	}

	async getIdentifierAttributes(): Promise<CScoutAttribute[]> {
		return this.get<CScoutAttribute[]>('/attributes/identifiers');
	}

	async getFileAttributes(): Promise<CScoutAttribute[]> {
		return this.get<CScoutAttribute[]>('/attributes/files');
	}

	async getProjectFiles(pid: number): Promise<CScoutFile[]> {
		return this.get<CScoutFile[]>(`/project/files?pid=${pid}`);
	}

	async applyRename(eid: number, newName: string): Promise<CScoutRefactorApplyResult> {
		return this.get<CScoutRefactorApplyResult>(
			`/rename/apply?eid=${eid}&newname=${encodeURIComponent(newName)}`
		);
	}
}