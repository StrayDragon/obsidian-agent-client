import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { Platform } from "obsidian";
import { getLoginShell } from "./shell-utils";
import { getEnhancedWindowsEnv } from "./windows-env";

export type LlmanClaudeGroupSelection =
	| { mode: "auto" }
	| { mode: "named"; name: string };

export interface LlmanClaudeEnvResult {
	groupName: string;
	configDir: string;
	configPath: string;
	env: Record<string, string>;
}

export class LlmanClaudeSecretsError extends Error {
	readonly title: string;
	readonly suggestion?: string;

	constructor(title: string, message: string, suggestion?: string) {
		super(message);
		this.name = "LlmanClaudeSecretsError";
		this.title = title;
		this.suggestion = suggestion;
	}
}

export type UseLlmanDirective =
	| { enabled: false }
	| { enabled: true; selection: LlmanClaudeGroupSelection };

let cachedLlmanConfigDir: string | null = null;

export function parseUseLlmanDirective(
	env: Record<string, string> | undefined,
): UseLlmanDirective {
	if (!env) {
		return { enabled: false };
	}

	const directiveKey = findEnvKeyCaseInsensitive(env, "USE_LLMAN");
	if (!directiveKey) {
		return { enabled: false };
	}

	const rawValue = (env[directiveKey] ?? "").trim();
	const normalized = stripMatchingQuotes(rawValue).trim();

	const lower = normalized.toLowerCase();
	const isTruthy =
		normalized === "" || lower === "1" || lower === "true" || lower === "yes";
	const isFalsy =
		lower === "0" || lower === "false" || lower === "no" || lower === "off";

	if (isFalsy) {
		return { enabled: false };
	}

	if (isTruthy) {
		return { enabled: true, selection: { mode: "auto" } };
	}

	return { enabled: true, selection: { mode: "named", name: normalized } };
}

export async function resolveClaudeEnvFromLlman(
	selection: LlmanClaudeGroupSelection,
): Promise<LlmanClaudeEnvResult> {
	const configDir = await resolveLlmanConfigDir();
	const configPath = path.join(configDir, "claude-code.toml");

	let content: string;
	try {
		content = await fs.readFile(configPath, "utf8");
	} catch (error) {
		const message = `Failed to read llman Claude Code config at: ${configPath}`;
		const suggestion =
			'Create/import a group via "llman x claude-code account edit" (or import), or set LLMAN_CONFIG_DIR to your llman config directory.';
		throw new LlmanClaudeSecretsError(
			"llman Config Not Found",
			error instanceof Error ? `${message}\n${error.message}` : message,
			suggestion,
		);
	}

	const groups = parseClaudeCodeTomlGroups(content);
	const groupNames = Object.keys(groups).sort();

	if (groupNames.length === 0) {
		throw new LlmanClaudeSecretsError(
			"No llman Groups",
			`No [groups.<name>] sections found in: ${configPath}`,
			'Add at least one group (e.g. via "llman x claude-code account import") and include ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY.',
		);
	}

	const selectedGroup = selectGroupName(groupNames, selection);
	const groupEnv = groups[selectedGroup] || {};

	const apiKey =
		nonEmpty(groupEnv.ANTHROPIC_API_KEY) ??
		nonEmpty(groupEnv.ANTHROPIC_AUTH_TOKEN);

	const env: Record<string, string> = { ...groupEnv };
	if (apiKey && !nonEmpty(env.ANTHROPIC_API_KEY)) {
		env.ANTHROPIC_API_KEY = apiKey;
	}

	return {
		groupName: selectedGroup,
		configDir,
		configPath,
		env,
	};
}

async function resolveLlmanConfigDir(): Promise<string> {
	if (cachedLlmanConfigDir) {
		return cachedLlmanConfigDir;
	}

	const envOverride = process.env.LLMAN_CONFIG_DIR?.trim();
	if (envOverride) {
		cachedLlmanConfigDir = envOverride;
		return envOverride;
	}

	const baseEnv = Platform.isWin
		? getEnhancedWindowsEnv({ ...process.env })
		: { ...process.env };

	const { stdout, stderr, exitCode } = await execCaptureStdout({
		command: Platform.isMacOS || Platform.isLinux ? getLoginShell() : "llman",
		args:
			Platform.isMacOS || Platform.isLinux
				? ["-l", "-c", "llman --print-config-dir-path"]
				: ["--print-config-dir-path"],
		shell: Platform.isWin,
		env: baseEnv,
	});

	if (exitCode !== 0) {
		const msg = [
			"Failed to resolve llman config directory.",
			"Make sure llman is installed and available in PATH, or set LLMAN_CONFIG_DIR.",
			stderr ? `llman stderr: ${stderr.trim()}` : null,
		]
			.filter(Boolean)
			.join("\n");
		throw new LlmanClaudeSecretsError("llman Not Available", msg);
	}

	const resolved = lastNonEmptyLine(stdout);
	if (!resolved) {
		throw new LlmanClaudeSecretsError(
			"llman Output Invalid",
			'llman returned empty output for "--print-config-dir-path".',
		);
	}

	cachedLlmanConfigDir = resolved;
	return resolved;
}

function execCaptureStdout(opts: {
	command: string;
	args: string[];
	shell: boolean;
	env: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolve) => {
		const child = spawn(opts.command, opts.args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: opts.shell,
			env: opts.env,
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("close", (exitCode) => {
			resolve({ stdout, stderr, exitCode });
		});
		child.on("error", (error) => {
			resolve({ stdout, stderr: String(error), exitCode: 1 });
		});
	});
}

function parseClaudeCodeTomlGroups(
	content: string,
): Record<string, Record<string, string>> {
	const groups: Record<string, Record<string, string>> = {};
	let currentGroup: string | null = null;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = stripTomlComment(rawLine).trim();
		if (!line) {
			continue;
		}

		const headerMatch = line.match(/^\[(.+)\]$/);
		if (headerMatch) {
			const pathParts = parseTomlDottedKey(headerMatch[1].trim());
			if (pathParts.length === 2 && pathParts[0] === "groups") {
				currentGroup = pathParts[1];
				groups[currentGroup] = groups[currentGroup] || {};
			} else {
				currentGroup = null;
			}
			continue;
		}

		if (!currentGroup) {
			continue;
		}

		const eqIndex = indexOfUnquotedEquals(line);
		if (eqIndex === -1) {
			continue;
		}

		const key = line.slice(0, eqIndex).trim();
		if (!key) {
			continue;
		}

		const rawValue = line.slice(eqIndex + 1).trim();
		if (!rawValue) {
			groups[currentGroup][key] = "";
			continue;
		}

		groups[currentGroup][key] = parseTomlValue(rawValue);
	}

	return groups;
}

function selectGroupName(
	groupNames: string[],
	selection: LlmanClaudeGroupSelection,
): string {
	if (selection.mode === "named") {
		if (!groupNames.includes(selection.name)) {
			throw new LlmanClaudeSecretsError(
				"llman Group Not Found",
				`Group "${selection.name}" not found. Available groups: ${groupNames.join(", ")}`,
				"Set USE_LLMAN=<group-name> to one of the available groups.",
			);
		}
		return selection.name;
	}

	if (groupNames.length !== 1) {
		throw new LlmanClaudeSecretsError(
			"Multiple llman Groups",
			`Multiple llman groups found: ${groupNames.join(", ")}`,
			"Set USE_LLMAN=<group-name> to select one explicitly.",
		);
	}

	return groupNames[0];
}

function parseTomlDottedKey(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escapeNext = false;

	for (let i = 0; i < input.length; i += 1) {
		const ch = input[i];
		if (escapeNext) {
			current += ch;
			escapeNext = false;
			continue;
		}
		if (inDouble && ch === "\\") {
			current += ch;
			escapeNext = true;
			continue;
		}
		if (!inSingle && ch === '"') {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		if (!inDouble && ch === "'") {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (!inSingle && !inDouble && ch === ".") {
			parts.push(normalizeTomlKeyPart(current));
			current = "";
			continue;
		}
		current += ch;
	}

	if (current.length > 0) {
		parts.push(normalizeTomlKeyPart(current));
	}

	return parts.filter((p) => p.length > 0);
}

function normalizeTomlKeyPart(part: string): string {
	const trimmed = part.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return unquoteTomlBasicString(trimmed);
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return unquoteTomlLiteralString(trimmed);
	}
	return trimmed;
}

function parseTomlValue(rawValue: string): string {
	const value = rawValue.trim();

	if (value.startsWith('"""') || value.startsWith("'''")) {
		throw new LlmanClaudeSecretsError(
			"Unsupported llman TOML",
			"Multi-line TOML strings are not supported in claude-code.toml parsing.",
			"Use single-line quoted values for environment variables.",
		);
	}

	if (value.startsWith('"') && value.endsWith('"')) {
		return unquoteTomlBasicString(value);
	}
	if (value.startsWith("'") && value.endsWith("'")) {
		return unquoteTomlLiteralString(value);
	}

	// For non-string TOML values (bool/number), keep the textual representation.
	return value;
}

function unquoteTomlBasicString(quoted: string): string {
	// Strip leading and trailing quotes
	let inner = quoted.slice(1, -1);

	// Minimal unescape for common sequences used in keys/tokens
	inner = inner.replace(/\\\\/g, "\\");
	inner = inner.replace(/\\"/g, '"');
	inner = inner.replace(/\\n/g, "\n");
	inner = inner.replace(/\\r/g, "\r");
	inner = inner.replace(/\\t/g, "\t");

	return inner;
}

function unquoteTomlLiteralString(quoted: string): string {
	const inner = quoted.slice(1, -1);
	// TOML literal strings do not support escapes; best-effort handle doubled quotes.
	return inner.replace(/''/g, "'");
}

function stripTomlComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	let escapeNext = false;

	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];

		if (escapeNext) {
			escapeNext = false;
			continue;
		}

		if (inDouble && ch === "\\") {
			escapeNext = true;
			continue;
		}

		if (!inSingle && ch === '"') {
			inDouble = !inDouble;
			continue;
		}

		if (!inDouble && ch === "'") {
			inSingle = !inSingle;
			continue;
		}

		if (!inSingle && !inDouble && ch === "#") {
			return line.slice(0, i);
		}
	}

	return line;
}

function indexOfUnquotedEquals(line: string): number {
	let inSingle = false;
	let inDouble = false;
	let escapeNext = false;

	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];

		if (escapeNext) {
			escapeNext = false;
			continue;
		}

		if (inDouble && ch === "\\") {
			escapeNext = true;
			continue;
		}

		if (!inSingle && ch === '"') {
			inDouble = !inDouble;
			continue;
		}

		if (!inDouble && ch === "'") {
			inSingle = !inSingle;
			continue;
		}

		if (!inSingle && !inDouble && ch === "=") {
			return i;
		}
	}

	return -1;
}

function findEnvKeyCaseInsensitive(
	env: Record<string, string>,
	target: string,
): string | undefined {
	const desired = target.toUpperCase();
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === desired) {
			return key;
		}
	}
	return undefined;
}

function stripMatchingQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function lastNonEmptyLine(text: string): string | null {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	return lines.length > 0 ? lines[lines.length - 1] : null;
}

function nonEmpty(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
