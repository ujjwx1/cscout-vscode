/*
 * buildSystem.ts — detect the project's build system and produce a
 * CScout .cs workspace file.
 *
 * We support five paths:
 *   1. Existing .cs file — use directly
 *   2. Existing compile_commands.json — feed to cscoco
 *   3. Makefile — run csmake
 *   4. CMakeLists.txt — run cmake, then cscoco
 *   5. meson.build — run meson setup, then cscoco
 *   6. configure.ac (Autotools) — run ./configure, then csmake
 *
 * Detection is presented to the user as a choice, never done silently.
 * Every external command goes through the platform layer so it works
 * on native Linux, macOS, Windows-WSL, and Cygwin.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	commandRunsInWsl,
	pathForCommand,
	resolveCommand,
} from './platform';

export type BuildSystem =
	| 'existing-cs'
	| 'compile-commands'
	| 'makefile'
	| 'cmake'
	| 'meson'
	| 'autotools'
	| 'unknown';

export interface BuildResult {
	csFilePath: string;
	projectName: string;
	buildSystem: BuildSystem;
	fileCount: number;
}

export interface CScoutSettings {
	host: string;
	port: number;
	cscoutBinaryPath: string;
	cscocoPyPath: string;
	csapiPyPath: string;
	csmakePath: string;
	pythonPath: string;
	sqlite3Path: string;
	autoStart: boolean;
	projectName?: string;
}

export interface DetectedBuildSystems {
	hasCs: boolean;
	hasCompileCommands: boolean;
	compileCommandsPath?: string;
	hasMakefile: boolean;
	hasCMake: boolean;
	hasMeson: boolean;
	hasAutotools: boolean;
	existingCsFiles: string[];
}

/*
 * Look for build descriptor files in the workspace root.  We use fs
 * directly rather than vscode.workspace.findFiles to avoid path-scheme
 * ambiguity across platforms — findFiles behaves differently for WSL
 * mounts vs native filesystem.
 */
export function detectAll(workspaceRoot: string): DetectedBuildSystems {
	const exists = (name: string): boolean => {
		try {
			return fs.existsSync(path.join(workspaceRoot, name));
		} catch {
			return false;
		}
	};

	let existingCsFiles: string[] = [];
	try {
		existingCsFiles = fs
			.readdirSync(workspaceRoot)
			.filter((f) => f.endsWith('.cs'))
			.map((f) => path.join(workspaceRoot, f));
	} catch {
		/* directory unreadable — leave list empty */
	}

	let compileCommandsPath: string | undefined;
	if (exists('compile_commands.json')) {
		compileCommandsPath = path.join(workspaceRoot, 'compile_commands.json');
	} else if (exists(path.join('build', 'compile_commands.json'))) {
		compileCommandsPath = path.join(workspaceRoot, 'build', 'compile_commands.json');
	}

	return {
		hasCs: existingCsFiles.length > 0,
		hasCompileCommands: compileCommandsPath !== undefined,
		compileCommandsPath,
		hasMakefile: exists('Makefile') || exists('makefile'),
		hasCMake: exists('CMakeLists.txt'),
		hasMeson: exists('meson.build'),
		hasAutotools: exists('configure.ac') || exists('configure'),
		existingCsFiles,
	};
}

/*
 * Count '#pragma process' directives in a .cs file — reflects the number
 * of translation units CScout will analyze.  Used for the post-generation
 * notification so the user sees what was captured.
 */
function countProcessedFiles(csFilePath: string): number {
	try {
		const content = fs.readFileSync(csFilePath, 'utf-8');
		return (content.match(/#pragma\s+process/g) || []).length;
	} catch {
		return 0;
	}
}

/*
 * Spawn a command and stream its output to the channel.  Resolves on
 * exit code 0, rejects otherwise with the collected stderr.
 */
function spawnStreaming(
	command: string,
	args: string[],
	cwd: string,
	channel: vscode.OutputChannel,
	onStdoutLine?: (line: string) => void
): Promise<string> {
	return new Promise((resolve, reject) => {
		const resolved = resolveCommand(command, args);
		channel.appendLine(`$ ${resolved.command} ${resolved.args.join(' ')}`);
		channel.appendLine(`  (cwd: ${cwd})`);

		const proc = cp.spawn(resolved.command, resolved.args, {
			cwd,
			shell: false,
		});

		let stderr = '';
		let stdout = '';
		let lineBuffer = '';

		proc.stdout?.on('data', (data: Buffer) => {
			const text = data.toString();
			stdout += text;
			if (onStdoutLine) {
				lineBuffer += text;
				const lines = lineBuffer.split('\n');
				lineBuffer = lines.pop() || '';
				for (const line of lines) {
					onStdoutLine(line);
				}
			}
		});

		proc.stderr?.on('data', (data: Buffer) => {
			const text = data.toString();
			stderr += text;
			channel.append(text);
		});

		proc.on('error', (err) => {
			channel.appendLine(`  error: ${err.message}`);
			reject(err);
		});

		proc.on('exit', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`${command} exited with code ${code}\n${stderr}`));
			}
		});
	});
}

/*
 * Present a choice to the user when a build system is detected.  We never
 * run configuration commands silently — the user must confirm.
 */
async function askUserAboutBuildSystem(
	detected: DetectedBuildSystems
): Promise<{ choice: BuildSystem; existingCs?: string } | undefined> {
	// Priority: existing .cs first, then compile_commands, then build systems.
	if (detected.hasCs) {
		const message =
			detected.existingCsFiles.length === 1
				? `Found existing workspace file ${path.basename(detected.existingCsFiles[0])}. Use it?`
				: `Found ${detected.existingCsFiles.length} existing .cs workspace files.`;
		const useExisting = 'Use existing';
		const generateNew = 'Generate new';
		const choice = await vscode.window.showInformationMessage(
			message,
			{ modal: false },
			useExisting,
			generateNew
		);
		if (choice === useExisting) {
			const file =
				detected.existingCsFiles.length === 1
					? detected.existingCsFiles[0]
					: await pickCsFile(detected.existingCsFiles);
			if (file) {
				return { choice: 'existing-cs', existingCs: file };
			}
			return undefined;
		}
		if (choice !== generateNew) {
			return undefined;
		}
	}

	const options: { label: string; value: BuildSystem; description: string }[] = [];

	if (detected.hasCompileCommands) {
		options.push({
			label: 'compile_commands.json',
			value: 'compile-commands',
			description: 'Feed existing compilation database to cscoco',
		});
	}
	if (detected.hasCMake) {
		options.push({
			label: 'CMakeLists.txt',
			value: 'cmake',
			description: 'Run cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON, then cscoco',
		});
	}
	if (detected.hasMeson) {
		options.push({
			label: 'meson.build',
			value: 'meson',
			description: 'Run meson setup build, then cscoco',
		});
	}
	if (detected.hasMakefile) {
		options.push({
			label: 'Makefile',
			value: 'makefile',
			description: 'Run csmake to intercept the build',
		});
	}
	if (detected.hasAutotools) {
		options.push({
			label: 'configure.ac (Autotools)',
			value: 'autotools',
			description: 'Run ./configure to generate a Makefile, then csmake',
		});
	}
	options.push({
		label: 'Browse for existing .cs file',
		value: 'existing-cs',
		description: 'Locate a workspace file elsewhere on disk',
	});

	if (options.length === 1 && options[0].value === 'existing-cs') {
		vscode.window.showErrorMessage(
			'CScout could not detect your build system. Supported: existing .cs file, ' +
			'Makefile (via csmake), CMake, Meson, and Autotools. If your build system is not supported, ' +
			'you can generate compile_commands.json with Bear and CScout will use that.'
		);
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(
		options.map((o) => ({ label: o.label, description: o.description, value: o.value })),
		{
			title: 'CScout: Choose how to analyze this project',
			placeHolder: 'How would you like to generate the CScout workspace file?',
		}
	);

	if (!picked) {
		return undefined;
	}

	if (picked.value === 'existing-cs') {
		const file = await pickCsFile();
		if (file) {
			return { choice: 'existing-cs', existingCs: file };
		}
		return undefined;
	}

	return { choice: picked.value };
}

async function pickCsFile(candidates?: string[]): Promise<string | undefined> {
	if (candidates && candidates.length > 1) {
		const picked = await vscode.window.showQuickPick(
			candidates.map((c) => ({ label: path.basename(c), description: c, value: c })),
			{ title: 'Select .cs workspace file' }
		);
		return picked?.value;
	}

	const uris = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { 'CScout workspace': ['cs'] },
		openLabel: 'Use this workspace file',
	});
	return uris?.[0]?.fsPath;
}

/*
 * Given a chosen build system, run the necessary commands and return the
 * path to the resulting .cs file.  Progress and log output stream into
 * the CScout output channel.
 */
export async function generateCsFile(
	workspaceRoot: string,
	settings: CScoutSettings,
	channel: vscode.OutputChannel,
	progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<BuildResult> {
	const detected = detectAll(workspaceRoot);
	const projectName =
		settings.projectName || path.basename(workspaceRoot) || 'project';

	const answer = await askUserAboutBuildSystem(detected);
	if (!answer) {
		throw new Error('User cancelled build system selection.');
	}

	if (answer.choice === 'existing-cs' && answer.existingCs) {
		const fileCount = countProcessedFiles(answer.existingCs);
		vscode.window.showInformationMessage(
			`Using existing workspace file. ${fileCount} translation units will be analyzed.`
		);
		return {
			csFilePath: answer.existingCs,
			projectName,
			buildSystem: 'existing-cs',
			fileCount,
		};
	}

	const csFilePath = path.join(workspaceRoot, `${projectName}.cs`);

	progress?.report({ message: 'Preparing compilation database...' });

	let compileCommandsPath: string | undefined;

	switch (answer.choice) {
		case 'compile-commands':
			compileCommandsPath = detected.compileCommandsPath;
			break;

		case 'cmake':
			channel.appendLine('--- Running CMake configure ---');
			await spawnStreaming(
				'cmake',
				['-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', '-B', 'build', '.'],
				workspaceRoot,
				channel
			);
			compileCommandsPath = path.join(workspaceRoot, 'build', 'compile_commands.json');
			break;

		case 'meson':
			channel.appendLine('--- Running Meson setup ---');
			await spawnStreaming('meson', ['setup', 'build'], workspaceRoot, channel);
			compileCommandsPath = path.join(workspaceRoot, 'build', 'compile_commands.json');
			break;

		case 'makefile':
			channel.appendLine('--- Running csmake ---');
			await spawnStreaming(settings.csmakePath, [], workspaceRoot, channel);
			// csmake writes make.cs — rename it to <projectName>.cs.
			try {
				fs.renameSync(path.join(workspaceRoot, 'make.cs'), csFilePath);
			} catch {
				// If rename fails, fall back to the file csmake created.
				const fileCount = countProcessedFiles(path.join(workspaceRoot, 'make.cs'));
				return {
					csFilePath: path.join(workspaceRoot, 'make.cs'),
					projectName,
					buildSystem: 'makefile',
					fileCount,
				};
			}
			return {
				csFilePath,
				projectName,
				buildSystem: 'makefile',
				fileCount: countProcessedFiles(csFilePath),
			};

		case 'autotools':
			channel.appendLine('--- Running ./configure ---');
			// Try autogen.sh first if present.
			if (fs.existsSync(path.join(workspaceRoot, 'autogen.sh'))) {
				await spawnStreaming('sh', ['autogen.sh'], workspaceRoot, channel);
			}
			await spawnStreaming('sh', ['configure'], workspaceRoot, channel);
			channel.appendLine('--- Running csmake ---');
			await spawnStreaming(settings.csmakePath, [], workspaceRoot, channel);
			try {
				fs.renameSync(path.join(workspaceRoot, 'make.cs'), csFilePath);
			} catch {
				return {
					csFilePath: path.join(workspaceRoot, 'make.cs'),
					projectName,
					buildSystem: 'autotools',
					fileCount: countProcessedFiles(path.join(workspaceRoot, 'make.cs')),
				};
			}
			return {
				csFilePath,
				projectName,
				buildSystem: 'autotools',
				fileCount: countProcessedFiles(csFilePath),
			};

		default:
			throw new Error(`Unhandled build system: ${answer.choice}`);
	}

	if (!compileCommandsPath || !fs.existsSync(compileCommandsPath)) {
		throw new Error('compile_commands.json was not produced.');
	}

	progress?.report({ message: 'Generating workspace file with cscoco...' });
	channel.appendLine('--- Running cscoco ---');

	const inWsl = commandRunsInWsl(settings.pythonPath);
	const cscocoArg = pathForCommand(settings.cscocoPyPath, inWsl);
	const ccArg = pathForCommand(compileCommandsPath, inWsl);

	const cscocoOutput = await spawnStreaming(
		settings.pythonPath,
		[cscocoArg, '-n', projectName, ccArg],
		workspaceRoot,
		channel
	);
	fs.writeFileSync(csFilePath, cscocoOutput);

	const fileCount = countProcessedFiles(csFilePath);

	vscode.window.showInformationMessage(
		`Generated workspace file from ${answer.choice}. ${fileCount} C files will be analyzed. ` +
		'Note: files excluded from your build configuration are not included in the analysis.'
	);

	return {
		csFilePath,
		projectName,
		buildSystem: answer.choice,
		fileCount,
	};
}