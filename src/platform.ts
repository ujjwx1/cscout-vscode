/*
 * platform.ts — cross-platform command execution layer.
 *
 * The extension can be running on native Linux, macOS, Windows-with-WSL,
 * Windows-native, or Windows-with-Cygwin.  The CScout binaries may live
 * anywhere: system PATH, WSL filesystem, a custom install, etc.
 *
 * This module resolves how to invoke a binary regardless of environment
 * by combining runtime OS detection with user-provided settings.  Every
 * spawn in the extension goes through resolveCommand() so callers never
 * need to know about wsl, cygwin, or PATH lookups.
 */

import * as cp from 'child_process';
import * as os from 'os';

export type Platform = 'linux' | 'darwin' | 'win32-wsl' | 'win32-native' | 'cygwin';

export interface ResolvedCommand {
	command: string;
	args: string[];
}

/*
 * Detect the runtime platform.  WSL detection matters because Windows
 * VS Code cannot execute Linux ELF binaries directly — everything must
 * be routed through 'wsl' when Linux binaries are in play.
 */
export function detectPlatform(): Platform {
	if (process.platform === 'linux') {
		// Running inside WSL counts as linux for our purposes because
		// binaries live natively and no wrapping is needed.
		return 'linux';
	}
	if (process.platform === 'darwin') {
		return 'darwin';
	}
	if (process.platform === 'win32') {
		// Cygwin sets specific env vars; check before assuming native win32.
		if (process.env.CYGWIN || process.env.TERM === 'cygwin') {
			return 'cygwin';
		}
		// If WSL is available, prefer routing through it since CScout is
		// primarily a Unix tool.  We probe for wsl in main() at startup.
		return 'win32-native';
	}
	return 'linux';
}

/*
 * Best-effort check for WSL availability on Windows.  Called once at
 * activation; result is cached.  We keep this synchronous because it
 * only runs on Windows and only once per session.
 */
let wslAvailable: boolean | undefined;
export function isWslAvailable(): boolean {
	if (wslAvailable !== undefined) {
		return wslAvailable;
	}
	if (process.platform !== 'win32') {
		wslAvailable = false;
		return false;
	}
	try {
		cp.execSync('C:\\Windows\\System32\\wsl.exe --status', { stdio: 'ignore', timeout: 3000 });
		wslAvailable = true;
	} catch {
		wslAvailable = false;
	}
	return wslAvailable;
}

/*
 * Determine whether a given path looks like a Linux/WSL path that would
 * require routing through wsl.  We use this to decide per-command whether
 * to wrap: a user with all-native Windows tools does not want wsl added.
 */
function isLinuxPath(p: string): boolean {
	// Absolute POSIX paths and /mnt/ style WSL mounts.
	if (p.startsWith('/')) {
		return true;
	}
	// Windows drive letters are not Linux paths.
	if (/^[a-zA-Z]:[\\/]/.test(p)) {
		return false;
	}
	return false;
}

/*
 * Wrap a command for execution on the current platform.  If the caller
 * passes a bare command name (e.g. 'python3'), it is looked up in PATH
 * as normal.  If the caller passes an absolute Linux path on Windows,
 * we route through 'wsl -e'.
 */
export function resolveCommand(command: string, args: string[]): ResolvedCommand {
	const platform = detectPlatform();

	if (platform === 'win32-native' && isWslAvailable() && isLinuxPath(command)) {
		return {
			command: 'C:\\Windows\\System32\\wsl.exe',
			args: ['-e', command, ...args],
		};
	}

	return { command, args };
}

/*
 * Translate a Windows path to a WSL path for passing as an argument to
 * a wsl-wrapped command.  C:\Users\foo becomes /mnt/c/Users/foo.
 * Only applied when we know we are running the command through wsl.
 */
export function toWslPath(winPath: string): string {
	if (!winPath) {
		return winPath;
	}
	const match = /^([a-zA-Z]):[\\/](.*)$/.exec(winPath);
	if (!match) {
		return winPath;
	}
	const drive = match[1].toLowerCase();
	const rest = match[2].replace(/\\/g, '/');
	return `/mnt/${drive}/${rest}`;
}

/*
 * Translate a WSL path back to a Windows path for use in VS Code APIs
 * that expect native paths (e.g. showTextDocument).  /mnt/c/foo becomes
 * C:\foo.
 */
export function fromWslPath(wslPath: string): string {
	if (!wslPath) {
		return wslPath;
	}
	const match = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(wslPath);
	if (!match) {
		return wslPath;
	}
	const drive = match[1].toUpperCase();
	const rest = match[2].replace(/\//g, '\\');
	return `${drive}:\\${rest}`;
}

/*
 * Normalize a path for the current platform.  When passing paths to a
 * command that will run through wsl, we need WSL-format paths; when
 * passing to a native command, we need native format.
 */
export function pathForCommand(p: string, commandRunsInWsl: boolean): string {
	if (!p) {
		return p;
	}
	if (commandRunsInWsl && /^[a-zA-Z]:[\\/]/.test(p)) {
		return toWslPath(p);
	}
	if (!commandRunsInWsl && p.startsWith('/mnt/') && process.platform === 'win32') {
		return fromWslPath(p);
	}
	return p;
}

/*
 * Does a command, once resolved, ultimately run inside WSL?  Used by
 * callers to know whether path arguments need conversion.
 */
export function commandRunsInWsl(command: string): boolean {
	if (detectPlatform() !== 'win32-native') {
		return false;
	}
	if (!isWslAvailable()) {
		return false;
	}
	return isLinuxPath(command);
}

/*
 * Return a human-readable environment summary for the CScout output
 * channel.  Helps users understand what path resolution is happening.
 */
export function describeEnvironment(): string {
	const platform = detectPlatform();
	const wsl = platform === 'win32-native' ? isWslAvailable() : false;
	return `Platform: ${platform}${wsl ? ' (WSL available)' : ''} | Node ${process.version} | ${os.arch()}`;
}
