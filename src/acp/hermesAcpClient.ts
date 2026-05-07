import {execFile, spawn} from "child_process";
import type {ChildProcess} from "child_process";
import type {HermesianSettings} from "../settings";
import {PLUGIN_NAME, PLUGIN_VERSION} from "../constants";
import type {
	AcpPermissionOption,
	AcpPermissionRequest,
	AcpSessionUpdate,
	ConnectionStatus,
	PermissionRequestEvent,
} from "../types";
import {JsonRpcConnection, type JsonRpcResult, errorToMessage} from "./jsonRpc";
import {buildAcpLaunchArgs, buildWslPathArgs, cleanWslOutput} from "./wsl";

export interface HermesAcpClientEvents {
	onStatus?: (status: ConnectionStatus, detail?: string) => void;
	onSessionUpdate?: (sessionId: string, update: AcpSessionUpdate) => void;
	onPermission?: (event: PermissionRequestEvent) => void;
	onError?: (message: string) => void;
}

export class HermesAcpClient {
	private process: ChildProcess | null = null;
	private rpc: JsonRpcConnection | null = null;
	private stdoutBuffer = "";
	private sessionId: string | null = null;
	private wslCwd = "";
	private connecting: Promise<void> | null = null;
	private permissionCounter = 0;
	private lastStderr = "";

	constructor(
		private readonly settings: HermesianSettings,
		private readonly events: HermesAcpClientEvents
	) {
	}

	async connect(windowsCwd: string): Promise<void> {
		if (this.sessionId && this.rpc) {
			return;
		}
		if (this.connecting) {
			return this.connecting;
		}
		if (!this.settings.autoStartAcp) {
			throw new Error("Automatic ACP startup is disabled.");
		}

		this.connecting = this.connectInternal(windowsCwd);
		try {
			await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	async startNewSession(): Promise<string> {
		if (!this.rpc || !this.wslCwd) {
			throw new Error("Hermes ACP is not connected.");
		}
		const result = await this.rpc.request("session/new", {
			cwd: this.wslCwd,
			mcpServers: [],
		}, 30000);
		const sessionId = getStringField(result, "sessionId", "session_id");
		if (!sessionId) {
			throw new Error("Hermes ACP did not return a session id.");
		}
		this.sessionId = sessionId;
		return sessionId;
	}

	async prompt(blocks: unknown[]): Promise<unknown> {
		if (!this.rpc || !this.sessionId) {
			throw new Error("Hermes ACP is not connected.");
		}
		return this.rpc.request("session/prompt", {
			sessionId: this.sessionId,
			messageId: this.makeId("message"),
			prompt: blocks,
		}, 24 * 60 * 60 * 1000);
	}

	cancel(): void {
		if (!this.rpc || !this.sessionId) {
			return;
		}
		this.rpc.notify("session/cancel", {
			sessionId: this.sessionId,
		});
	}

	disconnect(): void {
		this.emitStatus("closed");
		if (this.rpc) {
			this.rpc.dispose("Hermes ACP disconnected.");
			this.rpc = null;
		}
		if (this.process) {
			const child = this.process;
			this.process = null;
			if (child.stdin && !child.stdin.destroyed) {
				child.stdin.end();
			}
			if (!child.killed) {
				child.kill();
			}
		}
		this.sessionId = null;
		this.stdoutBuffer = "";
	}

	private async connectInternal(windowsCwd: string): Promise<void> {
		this.emitStatus("starting", "Resolving WSL vault path");
		this.wslCwd = await resolveWslPath(this.settings, windowsCwd);

		this.emitStatus("starting", "Starting Hermes ACP");
		const launch = buildAcpLaunchArgs(this.settings, this.wslCwd);
		const child = spawn(launch.command, launch.args, {
			stdio: "pipe",
			windowsHide: true,
		});
		this.process = child;

		this.rpc = new JsonRpcConnection((payload) => {
			if (!child.stdin || child.stdin.destroyed) {
				throw new Error("Hermes ACP stdin is closed.");
			}
			child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
		this.rpc.onNotification("session/update", (params) => this.handleSessionUpdate(params));
		this.rpc.onRequest("session/request_permission", (params) => this.handlePermissionRequest(params));

		if (child.stdout) {
			child.stdout.on("data", (chunk: StreamChunk) => this.handleStdout(chunk));
		}
		if (child.stderr) {
			child.stderr.on("data", (chunk: StreamChunk) => this.handleStderr(chunk));
		}
		child.on("error", (error) => {
			this.emitStatus("error", error.message);
			this.events.onError?.(error.message);
		});
		child.on("exit", (code, signal) => {
			const detail = this.lastStderr || `Hermes ACP exited (${code ?? "no code"}${signal ? `, ${signal}` : ""}).`;
			this.rpc?.dispose(detail);
			this.rpc = null;
			this.sessionId = null;
			this.process = null;
			this.emitStatus(code === 0 ? "closed" : "error", detail);
			if (code !== 0) {
				this.events.onError?.(detail);
			}
		});

		await this.initialize();
		await this.startNewSession();
		this.emitStatus("connected", "Connected to Hermes ACP");
	}

	private async initialize(): Promise<void> {
		if (!this.rpc) {
			throw new Error("Hermes ACP is not connected.");
		}
		await this.rpc.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo: {
				name: PLUGIN_NAME,
				version: PLUGIN_VERSION,
			},
		}, 30000);
	}

	private handleStdout(chunk: StreamChunk): void {
		this.stdoutBuffer += chunk.toString("utf8");
		let newlineIndex = this.stdoutBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = this.stdoutBuffer.slice(0, newlineIndex);
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			try {
				this.rpc?.handleLine(line);
			} catch (error) {
				const message = `Could not parse Hermes ACP output: ${errorToMessage(error)}`;
				this.events.onError?.(message);
			}
			newlineIndex = this.stdoutBuffer.indexOf("\n");
		}
	}

	private handleStderr(chunk: StreamChunk): void {
		const text = chunk.toString("utf8").replace(/\0/g, "").trim();
		if (!text) {
			return;
		}
		this.lastStderr = text.length > 2000 ? text.slice(text.length - 2000) : text;
	}

	private handleSessionUpdate(params: unknown): void {
		if (!params || typeof params !== "object") {
			return;
		}
		const record = params as Record<string, unknown>;
		const sessionId = getStringField(record, "sessionId", "session_id");
		const update = record.update;
		if (!sessionId || !update || typeof update !== "object") {
			return;
		}
		this.events.onSessionUpdate?.(sessionId, update as AcpSessionUpdate);
	}

	private handlePermissionRequest(params: unknown): Promise<JsonRpcResult> {
		const request = (params && typeof params === "object" ? params : {}) as AcpPermissionRequest;
		return new Promise((resolve) => {
			let settled = false;
			const id = this.makeId("approval");
			const timeoutSeconds = Math.max(1, this.settings.approvalTimeoutSeconds);
			let timer: ReturnType<typeof setTimeout> | null = null;
			const respond = (optionId?: string | null): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer) {
					clearTimeout(timer);
				}
				resolve(buildPermissionResponse(optionId));
			};
			timer = setTimeout(() => respond(null), timeoutSeconds * 1000);

			if (!this.events.onPermission) {
				respond(null);
				return;
			}

			try {
				this.events.onPermission({id, request, respond});
			} catch {
				respond(null);
			}
		});
	}

	private emitStatus(status: ConnectionStatus, detail?: string): void {
		this.events.onStatus?.(status, detail);
	}

	private makeId(prefix: string): string {
		this.permissionCounter++;
		return `${prefix}-${Date.now()}-${this.permissionCounter}`;
	}
}

export async function resolveWslPath(settings: Pick<HermesianSettings, "wslDistro">, windowsPath: string): Promise<string> {
	const spec = buildWslPathArgs(settings, windowsPath);
	return new Promise((resolve, reject) => {
		execFile(spec.command, spec.args, {
			windowsHide: true,
			timeout: 10000,
		}, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(cleanWslOutput(stderr.toString()) || error.message));
				return;
			}
			const output = cleanWslOutput(stdout.toString());
			if (!output) {
				reject(new Error("wslpath returned an empty path."));
				return;
			}
			resolve(output);
		});
	});
}

export function buildPermissionResponse(optionId?: string | null): JsonRpcResult {
	if (!optionId) {
		return {
			outcome: {
				outcome: "cancelled",
			},
		};
	}
	return {
		outcome: {
			outcome: "selected",
			optionId,
		},
	};
}

export function getOptionId(option: AcpPermissionOption): string {
	return option.optionId ?? option.option_id ?? "";
}

function getStringField(value: unknown, camel: string, snake: string): string {
	if (!value || typeof value !== "object") {
		return "";
	}
	const record = value as Record<string, unknown>;
	const result = record[camel] ?? record[snake];
	return typeof result === "string" ? result : "";
}

interface StreamChunk {
	toString(encoding?: string): string;
}
