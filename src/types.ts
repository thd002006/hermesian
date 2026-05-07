export type ConnectionStatus = "idle" | "starting" | "connected" | "closed" | "error";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
	id: string;
	role: ChatRole;
	text: string;
	createdAt: number;
	thinking?: string;
	status?: "running" | "complete" | "completed" | "error" | "pending" | "in_progress" | "failed";
	toolCallId?: string;
	toolTitle?: string;
	toolKind?: string;
}

export interface PromptAttachment {
	id: string;
	title: string;
	source: "file" | "selection" | "external";
	content: string;
	createdAt: number;
}

export interface AcpTextContentBlock {
	type: "text";
	text: string;
}

export interface AcpSessionUpdate {
	sessionUpdate?: string;
	session_update?: string;
	content?: unknown;
	messageId?: string;
	message_id?: string;
	toolCallId?: string;
	tool_call_id?: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: unknown;
	raw_input?: unknown;
	rawOutput?: unknown;
	raw_output?: unknown;
	size?: number;
	used?: number;
}

export interface AcpPermissionOption {
	optionId?: string;
	option_id?: string;
	kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
	name: string;
}

export interface AcpPermissionRequest {
	sessionId?: string;
	session_id?: string;
	toolCall?: unknown;
	tool_call?: unknown;
	options?: AcpPermissionOption[];
}

export interface PermissionRequestEvent {
	id: string;
	request: AcpPermissionRequest;
	respond: (optionId?: string | null) => void;
}

export interface UsageInfo {
	used: number;
	size: number;
}
