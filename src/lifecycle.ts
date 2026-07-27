/*
 * lifecycle.ts — orchestrates the full analysis pipeline.
 *
 * State machine:
 *   stopped   → analyzing (user starts)
 *   analyzing → indexing  (cscout + sqlite3 finished; csapi is booting)
 *   indexing  → ready     (csapi reports indexes_ready)
 *   any       → error     (something failed)
 *   ready     → stopped   (user stops or window closes)
 *
 * The pipeline itself is:
 *   1. buildSystem.generateCsFile()  → produces project.cs
 *   2. cscout -s sqlite project.cs   → SQL dump on stdout
 *   3. sqlite3 project.db            → consumes the dump, builds the DB
 *   4. csapi project.db              → HTTP server on the DB
 *   5. Poll /status until indexes_ready
 *
 * Steps 2 and 3 are chained by a Node stream pipe.  Progress feedback
 * during (2) comes from parsing cscout's stderr, which prints
 * "Processing <file>" lines as it works.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CScoutClient } from './cscoutClient';
import { BuildResult, CScoutSettings, generateCsFile } from './buildSystem';
import {
	commandRunsInWsl,
	describeEnvironment,
	pathForCommand,
	resolveCommand,
} from './platform';

export type CScoutState = 'stopped' | 'analyzing' | 'indexing' | 'ready' | 'error';

export interface LifecycleEvents {
	onStateChange: (state: CScoutState, detail?: string) => void;
	onReady: (buildResult: BuildResult) => void;
	onError: (message: string) => void;
	onProgress: (message: string) => void;
}

export class CScoutLifecycle {
	private state: CScoutState = 'stopped';
	private cscoutProcess?: cp.ChildProcess;
	private sqlite3Process?: cp.ChildProcess;
	private csapiProcess?: cp.ChildProcess;
	private dbPath?: string;
	private csFilePath?: string;
	private fileWatcher?: vscode.FileSystemWatcher;
	private client?: CScoutClient;
	private lastBuildResult?: BuildResult;

	constructor(
		private settings: CScoutSettings,
		private channel: vscode.OutputChannel,
		private events: LifecycleEvents
	) { }

	getState(): CScoutState {
		return this.state;
	}

	getClient(): CScoutClient | undefined {
		return this.client;
	}

	getBuildResult(): BuildResult | undefined {
		return this.lastBuildResult;
	}

	private setState(state: CScoutState, detail?: string): void {
		this.state = state;
		this.events.onStateChange(state, detail);
	}

	/*
	 * Start the whole pipeline.  Wrapped in withProgress so the user
	 * sees a proper progress notification with a spinner.
	 */
	async start(workspaceRoot: string): Promise<void> {
		if (this.state !== 'stopped' && this.state !== 'error') {
			vscode.window.showWarningMessage(
				`CScout is already ${this.state}. Stop it first if you want to restart.`
			);
			return;
		}

		this.channel.clear();
		this.channel.appendLine(`CScout starting.  ${describeEnvironment()}`);
		this.channel.appendLine(`Workspace: ${workspaceRoot}`);

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'CScout',
					cancellable: false,
				},
				async (progress) => {
					this.setState('analyzing');

					// 1. Generate .cs
					progress.report({ message: 'Detecting build system...' });
					const buildResult = await generateCsFile(
						workspaceRoot,
						this.settings,
						this.channel,
						progress
					);
					this.csFilePath = buildResult.csFilePath;
					this.lastBuildResult = buildResult;

					this.dbPath = path.join(workspaceRoot, `${buildResult.projectName}.db`);

					// 2 & 3. Run cscout -s sqlite | sqlite3 project.db
					progress.report({ message: 'Analyzing source code (this may take a while)...' });
					await this.runAnalysisPipeline(workspaceRoot, progress);

					// 4. Start csapi
					this.setState('indexing');
					progress.report({ message: 'Starting query server...' });
					await this.startCsapi(workspaceRoot);

					// 5. Poll until indexes ready
					progress.report({ message: 'Building search indexes...' });
					await this.waitForCsapi();

					// Ready!
					this.setState('ready');
					this.setupFileWatcher(workspaceRoot);
					this.events.onReady(buildResult);
				}
			);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.channel.appendLine(`ERROR: ${message}`);
			this.setState('error', message);
			this.events.onError(message);
			// Attempt cleanup of anything we started.
			await this.stopProcesses();
		}
	}

	/*
	 * Run cscout piping to sqlite3.  Parses cscout stderr for progress.
	 */
	private async runAnalysisPipeline(
		workspaceRoot: string,
		progress: vscode.Progress<{ message?: string }>
	): Promise<void> {
		if (!this.csFilePath || !this.dbPath) {
			throw new Error('Internal error: paths not set');
		}

		try { fs.unlinkSync(this.dbPath); } catch { /* did not exist */ }

		const cscoutInWsl = commandRunsInWsl(this.settings.cscoutBinaryPath);
		const csFilePath = pathForCommand(this.csFilePath, cscoutInWsl);
		const dbPath = pathForCommand(this.dbPath, cscoutInWsl);

		// On Windows+WSL run the whole pipeline inside a single WSL sh invocation
		// to avoid Windows pipe buffer truncation between two wsl.exe processes.
		const wslExe = ['C:', 'Windows', 'System32', 'wsl.exe'].join(path.win32.sep);
		const cmd = `${this.settings.cscoutBinaryPath} -s sqlite -q '${csFilePath}' | ${this.settings.sqlite3Path} '${dbPath}'`;

		this.channel.appendLine(`$ wsl.exe -e sh -c "${cmd}"`);

		return new Promise<void>((resolve, reject) => {
			if (cscoutInWsl) {
				// On Windows+WSL run the whole pipeline inside a single WSL sh invocation
				// to avoid Windows pipe buffer truncation between two wsl.exe processes.
				const wslExe = ['C:', 'Windows', 'System32', 'wsl.exe'].join(path.win32.sep);
				this.channel.appendLine(`$ wsl.exe -e sh -c "${cmd}"`);
				this.cscoutProcess = cp.spawn(wslExe, ['-e', 'sh', '-c', cmd], {
					cwd: undefined,
					shell: false,
				});
			} else {
				// Native Linux, macOS, or Cygwin
				this.channel.appendLine(`$ sh -c "${cmd}"`);
				this.cscoutProcess = cp.spawn('sh', ['-c', cmd], {
					cwd: undefined,
					shell: false,
				});
			}
			// sqlite3Process not needed — same process
			this.sqlite3Process = undefined;

			let stderr = '';
			let lineBuf = '';

			this.cscoutProcess.stderr?.on('data', (data: Buffer) => {
				const text = data.toString();
				stderr += text;
				this.channel.append(text);
				lineBuf += text;
				const lines = lineBuf.split('\n');
				lineBuf = lines.pop() || '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith('Processing ')) {
						progress.report({ message: `Analyzing: ${trimmed.substring(11)}` });
					} else if (trimmed.startsWith('Post-processing ')) {
						progress.report({ message: 'Finalizing analysis...' });
					}
				}
			});

			this.cscoutProcess.on('error', (err) => reject(err));
			this.cscoutProcess.on('exit', (code) => {
				if (code !== 0) {
					if (this.isPosixHeaderError(stderr)) {
						reject(new Error(
							"CScout analysis could not complete. Some files depend on system headers " +
							"outside CScout's standard C analysis scope."
						));
					} else {
						reject(new Error(`Pipeline failed with code ${code}: ${stderr.trim()}`));
					}
				} else {
					resolve();
				}
			});
		});
	}


	private isPosixHeaderError(stderr: string): boolean {
		return /Unable to open include file (pthread|sys\/|netinet|arpa\/|semaphore|libgen)/.test(
			stderr
		);
	}

	private async startCsapi(workspaceRoot: string): Promise<void> {
		if (!this.dbPath) {
			throw new Error('Internal error: dbPath not set');
		}

		const pythonInWsl = commandRunsInWsl(this.settings.pythonPath);
		const resolved = resolveCommand(this.settings.pythonPath, [
			pathForCommand(this.settings.csapiPyPath, pythonInWsl),
			pathForCommand(this.dbPath, pythonInWsl),
			'-p',
			String(this.settings.port),
		]);

		this.channel.appendLine(`$ ${resolved.command} ${resolved.args.join(' ')}`);

		this.csapiProcess = cp.spawn(resolved.command, resolved.args, {
			cwd: workspaceRoot,
			shell: false,
		});

		this.csapiProcess.stderr?.on('data', (data: Buffer) => this.channel.append(data.toString()));
		this.csapiProcess.stdout?.on('data', (data: Buffer) => this.channel.append(data.toString()));
		this.csapiProcess.on('exit', (code) => {
			this.channel.appendLine(`csapi exited with code ${code}`);
			if (this.state === 'ready' || this.state === 'indexing') {
				this.setState('error', `csapi exited unexpectedly with code ${code}`);
				this.events.onError(`csapi server stopped (exit ${code}).`);
			}
		});

		this.client = new CScoutClient(this.settings.host, this.settings.port);
	}

	/*
	 * Poll csapi's /status until it reports indexes_ready or we time out.
	 */
	private async waitForCsapi(timeoutMs = 60_000, intervalMs = 500): Promise<void> {
		if (!this.client) {
			throw new Error('Internal error: client not created');
		}
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			try {
				const status = await this.client.getStatus();
				if (status.status === 'ok' && status.indexes_ready) {
					return;
				}
			} catch {
				/* server not up yet — keep polling */
			}
			await new Promise((r) => setTimeout(r, intervalMs));
		}
		throw new Error('csapi server did not become ready within the timeout.');
	}

	/*
	 * Watch the workspace for .c file additions/deletions.  Content
	 * changes only mark the analysis stale; structural changes prompt
	 * the user to re-analyze.
	 */
	private setupFileWatcher(workspaceRoot: string): void {
		this.fileWatcher?.dispose();
		this.fileWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, '**/*.c')
		);
		const notify = async () => {
			const answer = await vscode.window.showInformationMessage(
				'Project structure changed — a .c file was added or removed. CScout analysis may be stale.',
				'Re-analyze Now',
				'Dismiss'
			);
			if (answer === 'Re-analyze Now') {
				await this.reanalyze(workspaceRoot);
			}
		};
		this.fileWatcher.onDidCreate(notify);
		this.fileWatcher.onDidDelete(notify);
	}

	async reanalyze(workspaceRoot: string): Promise<void> {
		await this.stop();
		await this.start(workspaceRoot);
	}

	async stop(): Promise<void> {
		if (this.state === 'stopped') {
			return;
		}
		this.channel.appendLine('Stopping CScout.');

		// Ask csapi to shut down gracefully.
		if (this.client) {
			await this.client.quit();
		}
		await new Promise((r) => setTimeout(r, 500));

		await this.stopProcesses();
		this.setState('stopped');
	}

	private async stopProcesses(): Promise<void> {
		this.fileWatcher?.dispose();
		this.fileWatcher = undefined;

		for (const proc of [this.csapiProcess, this.sqlite3Process, this.cscoutProcess]) {
			if (!proc) {
				continue;
			}
			try {
				if (proc.exitCode === null && !proc.killed) {
					proc.kill();
				}
			} catch {
				/* already dead */
			}
		}
		this.csapiProcess = undefined;
		this.sqlite3Process = undefined;
		this.cscoutProcess = undefined;
		this.client = undefined;
	}

	dispose(): void {
		void this.stop();
	}
}