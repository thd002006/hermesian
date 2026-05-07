export interface JsonRpcPayload {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: JsonRpcErrorObject;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

type PendingRequest = {
	method: string;
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
};

export type JsonRpcResult = null | string | number | boolean | Record<string, unknown> | unknown[];
export type JsonRpcRequestHandler = (params: unknown, method: string) => JsonRpcResult | Promise<JsonRpcResult>;
export type JsonRpcNotificationHandler = (params: unknown, method: string) => void;

export class JsonRpcError extends Error {
	code: number;
	data?: unknown;

	constructor(error: JsonRpcErrorObject) {
		super(error.message);
		this.name = "JsonRpcError";
		this.code = error.code;
		this.data = error.data;
	}
}

export class JsonRpcConnection {
	private nextId = 1;
	private pending = new Map<number | string, PendingRequest>();
	private requestHandlers = new Map<string, JsonRpcRequestHandler>();
	private notificationHandlers = new Map<string, JsonRpcNotificationHandler>();

	constructor(private readonly sendPayload: (payload: JsonRpcPayload) => void) {
	}

	onRequest(method: string, handler: JsonRpcRequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	onNotification(method: string, handler: JsonRpcNotificationHandler): void {
		this.notificationHandlers.set(method, handler);
	}

	request(method: string, params?: unknown, timeoutMs = 120000): Promise<unknown> {
		const id = this.nextId++;
		const payload: JsonRpcPayload = {
			jsonrpc: "2.0",
			id,
			method,
			params,
		};

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`JSON-RPC request timed out: ${method}`));
			}, timeoutMs);

			this.pending.set(id, {method, resolve, reject, timer});

			try {
				this.sendPayload(payload);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(errorToMessage(error)));
			}
		});
	}

	notify(method: string, params?: unknown): void {
		this.sendPayload({
			jsonrpc: "2.0",
			method,
			params,
		});
	}

	handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		const payload = JSON.parse(trimmed) as JsonRpcPayload;
		void this.handleMessage(payload);
	}

	async handleMessage(payload: JsonRpcPayload): Promise<void> {
		if (payload.method && payload.id !== undefined) {
			await this.handleIncomingRequest(payload);
			return;
		}

		if (payload.method) {
			const handler = this.notificationHandlers.get(payload.method);
			if (handler) {
				handler(payload.params, payload.method);
			}
			return;
		}

		if (payload.id !== undefined) {
			this.handleIncomingResponse(payload);
		}
	}

	dispose(reason = "JSON-RPC connection closed"): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
			this.pending.delete(id);
		}
	}

	getPendingCount(): number {
		return this.pending.size;
	}

	private handleIncomingResponse(payload: JsonRpcPayload): void {
		if (payload.id === undefined) {
			return;
		}
		const pending = this.pending.get(payload.id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(payload.id);

		if (payload.error) {
			pending.reject(new JsonRpcError(payload.error));
			return;
		}
		pending.resolve(payload.result);
	}

	private async handleIncomingRequest(payload: JsonRpcPayload): Promise<void> {
		if (!payload.method || payload.id === undefined) {
			return;
		}

		const handler = this.requestHandlers.get(payload.method);
		if (!handler) {
			this.sendPayload({
				jsonrpc: "2.0",
				id: payload.id,
				error: {
					code: -32601,
					message: `Method not found: ${payload.method}`,
				},
			});
			return;
		}

		try {
			const result = await handler(payload.params, payload.method);
			this.sendPayload({
				jsonrpc: "2.0",
				id: payload.id,
				result: result === undefined ? null : result,
			});
		} catch (error) {
			this.sendPayload({
				jsonrpc: "2.0",
				id: payload.id,
				error: {
					code: -32603,
					message: errorToMessage(error),
				},
			});
		}
	}
}

export function errorToMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "Unknown error";
}
