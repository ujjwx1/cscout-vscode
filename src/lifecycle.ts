// (C) Copyright 2026 Ujjwal Aggarwal
//
// This file is part of CScout.
//
// CScout is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// CScout is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with CScout.  If not, see <http://www.gnu.org/licenses/>.


import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';
import { CScoutClient } from './cscoutClient';
import { BuildResult, CScoutSettings, generateCsFile } from './buildSystem';
import {
	commandRunsInWsl,
	describeEnvironment,
	pathForCommand,
	resolveCommand,
	resolveScriptPath,
	checkDependency,
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
	async start(workspaceRoot: string, forceRebuild = false): Promise<void> {
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
					let buildResult = this.lastBuildResult;
					if (!forceRebuild || !buildResult) {
						progress.report({ message: 'Detecting build system...' });
						buildResult = await generateCsFile(
							workspaceRoot,
							this.settings,
							this.channel,
							progress,
							undefined
						);
						this.lastBuildResult = buildResult;
					}
					this.csFilePath = buildResult.csFilePath;

					this.dbPath = path.join(workspaceRoot, `${buildResult.projectName}.db`);

					let dbIsValid = false;
					let identifierCount = 0;

					if (!forceRebuild && buildResult.buildSystem === 'existing-cs' && fs.existsSync(this.dbPath)) {
						try {
							const inWsl = commandRunsInWsl(this.settings.sqlite3Path);
							const resolved = resolveCommand(this.settings.sqlite3Path, [
								pathForCommand(this.dbPath, inWsl),
								'"SELECT COUNT(*) FROM IDS;"'
							]);
							
							const { stdout } = await util.promisify(cp.exec)(`${resolved.command} ${resolved.args.join(' ')}`);
							identifierCount = parseInt(stdout.trim());
							dbIsValid = !isNaN(identifierCount) && identifierCount > 0;
						} catch (e) {
							this.channel.appendLine(`Failed to validate existing database: ${String(e)}`);
							dbIsValid = false;
						}
					}

					if (dbIsValid) {
						this.channel.appendLine(`Found existing populated database (${identifierCount} identifiers). Skipping analysis step.`);
					} else {
						if (fs.existsSync(this.dbPath)) {
							this.channel.appendLine(`Existing database is empty or invalid. Deleting and re-analyzing...`);
							fs.unlinkSync(this.dbPath);
						}
						// 2 & 3. Run cscout -s sqlite | sqlite3 project.db
						progress.report({ message: 'Checking dependencies...' });
						await checkDependency(this.settings.cscoutBinaryPath, 'cscout not found. Please ensure it is installed and configured in settings.', commandRunsInWsl(this.settings.cscoutBinaryPath));
						await checkDependency(this.settings.sqlite3Path, 'sqlite3 not found. Please install it (e.g., sudo apt install sqlite3 or brew install sqlite3).', commandRunsInWsl(this.settings.sqlite3Path));
						progress.report({ message: 'Analyzing source code (this may take a while)...' });
						await this.runAnalysisPipeline(workspaceRoot, progress);
					}

					// 4. Start csapi
					this.setState('indexing');
					progress.report({ message: 'Checking Python...' });
					await checkDependency(this.settings.pythonPath, 'python3 not found. Please install Python 3.', commandRunsInWsl(this.settings.pythonPath));
					progress.report({ message: 'Starting query server...' });
					await this.startCsapi(workspaceRoot);

					// 5. Poll until indexes ready
					progress.report({ message: 'Building search indexes...' });
					await this.waitForCsapi();

					// 6. Verify that the DB actually contains data (catches missing standard headers)
					const client = this.getClient();
					if (client) {
						const counts = await client.getIdentifierCounts();
						if (!counts['all'] || counts['all'] === 0) {
							throw new Error('CScout analysis completed but no identifiers were found in the database. This usually means CScout could not find standard header files or the include paths were wrong. Please check the Output panel for details.');
						}
					}

					// Ready!
					this.setState('ready');
					this.setupFileWatcher(workspaceRoot);
					this.events.onReady(buildResult);
				}
			);
		} catch (err: unknown) {
			let message = err instanceof Error ? err.message : String(err);
			if (/ENOENT|No such file or directory|not found|can't open file/i.test(message)) {
				message += '\n\nThis usually means one of the CScout tool paths in your settings is wrong. Run "CScout: Verify Setup" to check.';
			}
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

		let unlinked = false;
		for (let i = 0; i < 10; i++) {
			try {
				if (!fs.existsSync(this.dbPath)) {
					unlinked = true;
					break;
				}
				fs.unlinkSync(this.dbPath);
				unlinked = true;
				break;
			} catch (err) {
				await new Promise(r => setTimeout(r, 500));
			}
		}
		if (!unlinked) {
			throw new Error(`Failed to delete old database at ${this.dbPath}. The file is likely locked by another process.`);
		}

		const cscoutInWsl = commandRunsInWsl(this.settings.cscoutBinaryPath);
		const csFilePath = pathForCommand(this.csFilePath, cscoutInWsl);
		const dbPath = pathForCommand(this.dbPath, cscoutInWsl);

		const cmd = `${this.settings.cscoutBinaryPath} -s sqlite -q '${csFilePath}' | ${this.settings.sqlite3Path} '${dbPath}'`;

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
			// sqlite3Process not needed - same process
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

	private async getAvailablePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = net.createServer();
			server.unref();
			server.on('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (address && typeof address !== 'string') {
					const port = address.port;
					server.close(() => resolve(port));
				} else {
					server.close(() => reject(new Error('Failed to get dynamic port')));
				}
			});
		});
	}

	private async startCsapi(workspaceRoot: string): Promise<void> {
		if (!this.dbPath) {
			throw new Error('Internal error: dbPath not set');
		}

		const pidFilePath = path.join(workspaceRoot, `${this.lastBuildResult?.projectName || 'cscout'}.pid.json`);

		// Pre-flight cleanup
		if (fs.existsSync(pidFilePath)) {
			try {
				this.channel.appendLine('Found stale PID file. Attempting pre-flight cleanup...');
				const pidData = JSON.parse(fs.readFileSync(pidFilePath, 'utf-8'));
				if (pidData.port && pidData.pid) {
					// 1. Try graceful HTTP quit
					try {
						const tempClient = new CScoutClient(this.settings.host, pidData.port);
						await tempClient.quit();
					} catch (e) {
						// Ignored, might already be dead
					}
					// Wait a moment for it to exit
					await new Promise((r) => setTimeout(r, 200));
					
					// 2. Hard kill by PID
					const inWsl = commandRunsInWsl(this.settings.pythonPath);
					if (inWsl) {
						this.channel.appendLine(`Killing WSL process ${pidData.pid}`);
						try { cp.execSync(`wsl.exe kill -9 ${pidData.pid}`, { stdio: 'ignore' }); } catch (e) { /* ignored */ }
					} else {
						this.channel.appendLine(`Killing native process ${pidData.pid}`);
						try { process.kill(pidData.pid, 'SIGKILL'); } catch (e) { /* ignored */ }
					}
				}
				// 3. Delete file
				fs.unlinkSync(pidFilePath);
			} catch (e) {
				this.channel.appendLine(`Pre-flight cleanup failed: ${e}`);
			}
		}

		let activePort = this.settings.port;
		if (!activePort || activePort === 0) {
			this.channel.appendLine('Dynamic port requested (0). Fetching available port...');
			activePort = await this.getAvailablePort();
		}
		
		this.channel.appendLine(`Starting csapi.py on port ${activePort}`);

		const pythonInWsl = commandRunsInWsl(this.settings.pythonPath);
		const resolvedCsapi = await resolveScriptPath(this.settings.csapiPyPath, this.settings.cscoutBinaryPath, pythonInWsl);
		const resolved = resolveCommand(this.settings.pythonPath, [
			pathForCommand(resolvedCsapi, pythonInWsl),
			pathForCommand(this.dbPath, pythonInWsl),
			'-p',
			String(activePort),
			'--monitor-stdin',
			'--pid-file',
			pathForCommand(pidFilePath, pythonInWsl)
		]);

		this.channel.appendLine(`$ ${resolved.command} ${resolved.args.join(' ')}`);

		this.csapiProcess = cp.spawn(resolved.command, resolved.args, {
			cwd: workspaceRoot,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe']
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

		this.client = new CScoutClient(this.settings.host, activePort);
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
				/* server not up yet - keep polling */
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
				'Project structure changed - a .c file was added or removed. CScout analysis may be stale.',
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
		await this.start(workspaceRoot, true);
	}

	async stop(): Promise<void> {
		if (this.state === 'stopped') {
			return;
		}
		this.channel.appendLine('Stopping CScout.');

		// Ask csapi to shut down gracefully before clearing the reference.
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