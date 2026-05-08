import type {AcpSessionUpdate, ChatMessage, ToolEvent, UsageInfo} from "../types";

export interface ChatTranscriptState {
	messages: ChatMessage[];
	activeAssistantId?: string;
	usage?: UsageInfo;
}

export type IdFactory = (prefix: string) => string;
export type NowFactory = () => number;

let fallbackId = 0;

export function createTranscriptState(): ChatTranscriptState {
	return {messages: []};
}

export function createChatId(prefix: string): string {
	fallbackId++;
	return `${prefix}-${Date.now()}-${fallbackId}`;
}

export function addLocalMessage(
	state: ChatTranscriptState,
	role: ChatMessage["role"],
	text: string,
	idFactory: IdFactory = createChatId
): ChatTranscriptState {
	const id = idFactory(role);
	return {
		...state,
		messages: [
			...state.messages,
			{
				id,
				role,
				text,
				createdAt: Date.now(),
				status: role === "assistant" ? "running" : undefined,
			},
		],
		activeAssistantId: role === "assistant" ? id : state.activeAssistantId,
	};
}

export function startAssistantMessage(
	state: ChatTranscriptState,
	idFactory: IdFactory = createChatId
): ChatTranscriptState {
	const id = idFactory("assistant");
	return {
		...state,
		activeAssistantId: id,
		messages: [
			...state.messages,
			{
				id,
				role: "assistant",
				text: "",
				createdAt: Date.now(),
				status: "running",
			},
		],
	};
}

export function markAssistantComplete(
	state: ChatTranscriptState,
	nowFactory: NowFactory = Date.now
): ChatTranscriptState {
	if (!state.activeAssistantId) {
		return state;
	}
	const now = nowFactory();
	return {
		...state,
		activeAssistantId: undefined,
		messages: state.messages.map((message) => {
			if (message.id !== state.activeAssistantId) {
				return message;
			}
			return {...completeThinking(message, now), status: "complete"};
		}),
	};
}

export function applyAcpSessionUpdate(
	state: ChatTranscriptState,
	update: AcpSessionUpdate,
	idFactory: IdFactory = createChatId,
	nowFactory: NowFactory = Date.now
): ChatTranscriptState {
	const kind = getUpdateKind(update);
	if (kind === "agent_message_chunk") {
		return appendAssistantText(state, extractContentText(update.content), false, idFactory, nowFactory);
	}
	if (kind === "agent_thought_chunk") {
		return appendAssistantText(state, extractContentText(update.content), true, idFactory, nowFactory);
	}
	if (kind === "user_message_chunk") {
		const now = nowFactory();
		const baseState = state.activeAssistantId
			? {
				...state,
				activeAssistantId: undefined,
				messages: state.messages.map((message) => {
					if (message.id !== state.activeAssistantId) {
						return message;
					}
					return {...completeThinking(message, now), status: "complete" as const};
				}),
			}
			: state;
		return {
			...baseState,
			messages: [
				...baseState.messages,
				{
					id: idFactory("user"),
					role: "user",
					text: extractContentText(update.content),
					createdAt: Date.now(),
				},
			],
		};
	}
	if (kind === "tool_call" || kind === "tool_call_update") {
		return applyToolUpdate(state, update, idFactory, nowFactory);
	}
	if (kind === "usage_update" && typeof update.used === "number" && typeof update.size === "number") {
		return {
			...state,
			usage: {
				used: update.used,
				size: update.size,
			},
		};
	}
	return state;
}

export function getUpdateKind(update: AcpSessionUpdate): string {
	return update.sessionUpdate ?? update.session_update ?? "";
}

export function extractContentText(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => extractContentText(item)).filter((text) => text.length > 0).join("\n");
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") {
			return record.text;
		}
		if (record.content !== undefined) {
			return extractContentText(record.content);
		}
	}
	return "";
}

function appendAssistantText(
	state: ChatTranscriptState,
	text: string,
	isThinking: boolean,
	idFactory: IdFactory,
	nowFactory: NowFactory
): ChatTranscriptState {
	let activeId = state.activeAssistantId;
	let messages = state.messages;
	const now = nowFactory();
	({activeId, messages} = ensureAssistantMessage(activeId, messages, idFactory));

	return {
		...state,
		activeAssistantId: activeId,
		messages: messages.map((message) => {
			if (message.id !== activeId) {
				return message;
			}
			if (isThinking) {
				return {
					...message,
					thinking: (message.thinking ?? "") + text,
					thinkingStartedAt: message.thinkingStartedAt ?? now,
				};
			}
			return {...completeThinking(message, now), text: message.text + text};
		}),
	};
}

function completeThinking(message: ChatMessage, now: number): ChatMessage {
	if (message.thinkingStartedAt === undefined || message.thinkingEndedAt !== undefined) {
		return message;
	}
	return {
		...message,
		thinkingEndedAt: now,
		thinkingDurationMs: Math.max(0, now - message.thinkingStartedAt),
	};
}

function applyToolUpdate(
	state: ChatTranscriptState,
	update: AcpSessionUpdate,
	idFactory: IdFactory,
	nowFactory: NowFactory
): ChatTranscriptState {
	const toolCallId = update.toolCallId ?? update.tool_call_id ?? idFactory("tool-call");
	const text = extractContentText(update.content) || extractContentText(update.rawOutput ?? update.raw_output);
	const status = normalizeToolStatus(update.status, getUpdateKind(update));
	const title = update.title;
	const toolKind = update.kind;
	const now = nowFactory();
	const existingMessageId = state.messages.find((message) =>
		message.toolEvents?.some((event) => event.id === toolCallId)
	)?.id;
	const shouldPreserveActiveAssistant = Boolean(existingMessageId);
	let activeId = state.activeAssistantId;
	let messages = state.messages;
	if (existingMessageId) {
		activeId = existingMessageId;
	} else {
		({activeId, messages} = ensureAssistantMessage(activeId, messages, idFactory));
	}

	return {
		...state,
		activeAssistantId: shouldPreserveActiveAssistant ? state.activeAssistantId : activeId,
		messages: messages.map((message) => {
			if (message.id !== activeId) {
				return message;
			}
			return {
				...message,
				toolEvents: upsertToolEvent(message.toolEvents ?? [], {
					id: toolCallId,
					title,
					fallbackTitle: toolCallId,
					kind: toolKind,
					status,
					text,
					createdAt: now,
					updatedAt: now,
				}),
			};
		}),
	};
}

function ensureAssistantMessage(
	activeId: string | undefined,
	messages: ChatMessage[],
	idFactory: IdFactory
): {activeId: string; messages: ChatMessage[]} {
	if (activeId && messages.some((message) => message.id === activeId)) {
		return {activeId, messages};
	}
	const nextActiveId = idFactory("assistant");
	return {
		activeId: nextActiveId,
		messages: [
			...messages,
			{
				id: nextActiveId,
				role: "assistant",
				text: "",
				createdAt: Date.now(),
				status: "running",
			},
		],
	};
}

function upsertToolEvent(
	events: ToolEvent[],
	next: ToolEventDraft
): ToolEvent[] {
	const existingIndex = events.findIndex((event) => event.id === next.id);
	if (existingIndex === -1) {
		return [...events, {
			id: next.id,
			title: next.title ?? next.fallbackTitle,
			kind: next.kind,
			status: next.status,
			text: next.text,
			createdAt: next.createdAt,
			updatedAt: next.updatedAt,
		}];
	}
	return events.map((event, index) => {
		if (index !== existingIndex) {
			return event;
		}
		return {
			...event,
			title: next.title ?? event.title,
			kind: next.kind ?? event.kind,
			status: next.status,
			text: next.text || event.text,
			updatedAt: next.updatedAt,
		};
	});
}

interface ToolEventDraft {
	id: string;
	title?: string;
	fallbackTitle: string;
	kind?: string;
	status?: ChatMessage["status"];
	text: string;
	createdAt: number;
	updatedAt: number;
}

function normalizeToolStatus(
	status: string | undefined,
	kind: string
): ChatMessage["status"] {
	if (status === "completed" || status === "failed" || status === "pending" || status === "in_progress") {
		return status;
	}
	if (kind === "tool_call") {
		return "in_progress";
	}
	return "complete";
}
