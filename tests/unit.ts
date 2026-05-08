import assert from "node:assert/strict";
import {JsonRpcConnection, type JsonRpcPayload} from "../src/acp/jsonRpc";
import {buildPermissionResponse, parseListSessionsResult} from "../src/acp/hermesAcpClient";
import {buildAcpLaunchArgs, buildWslPathArgs, quoteBash} from "../src/acp/wsl";
import {buildPromptText} from "../src/chat/prompt";
import {detectMentionToken, rankMentionCandidates} from "../src/chat/mentions";
import {
	applyAcpSessionUpdate,
	createTranscriptState,
	markAssistantComplete,
	type IdFactory,
} from "../src/chat/reducer";
import type {PromptAttachment} from "../src/types";

await testJsonRpcRequestResponse();
await testJsonRpcIncomingRequest();
testWslArgs();
testPromptAttachments();
testReducer();
testSessionParsing();
testPermissionResponses();
testMentions();

async function testJsonRpcRequestResponse(): Promise<void> {
	const sent: JsonRpcPayload[] = [];
	const rpc = new JsonRpcConnection((payload) => sent.push(payload));
	const promise = rpc.request("initialize", {protocolVersion: 1}, 1000);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.method, "initialize");
	assert.equal(rpc.getPendingCount(), 1);
	await rpc.handleMessage({jsonrpc: "2.0", id: sent[0]?.id, result: {ok: true}});
	assert.deepEqual(await promise, {ok: true});
	assert.equal(rpc.getPendingCount(), 0);
}

async function testJsonRpcIncomingRequest(): Promise<void> {
	const sent: JsonRpcPayload[] = [];
	const rpc = new JsonRpcConnection((payload) => sent.push(payload));
	rpc.onRequest("session/request_permission", () => buildPermissionResponse(null));
	await rpc.handleMessage({
		jsonrpc: "2.0",
		id: 7,
		method: "session/request_permission",
		params: {},
	});
	assert.deepEqual(sent[0], {
		jsonrpc: "2.0",
		id: 7,
		result: {
			outcome: {
				outcome: "cancelled",
			},
		},
	});
}

function testWslArgs(): void {
	const settings = {wslDistro: "Ubuntu", hermesCommand: "hermes"};
	assert.deepEqual(buildWslPathArgs(settings, "F:\\Vault").args, ["-d", "Ubuntu", "-e", "wslpath", "-a", "F:\\Vault"]);
	assert.deepEqual(buildAcpLaunchArgs(settings, "/mnt/f/Vault").args, [
		"-d",
		"Ubuntu",
		"-e",
		"bash",
		"-l",
		"-c",
		"cd '/mnt/f/Vault' && exec hermes acp",
	]);
	assert.equal(quoteBash("/tmp/it's here"), "'/tmp/it'\\''s here'");
}

function testPromptAttachments(): void {
	const attachments: PromptAttachment[] = [{
		id: "a1",
		title: "note.md",
		source: "file",
		content: "# Note\ncontent",
		createdAt: 1,
	}];
	const prompt = buildPromptText("Summarize this.", attachments);
	assert.match(prompt, /Attached context:/);
	assert.match(prompt, /Source: note\.md/);
	assert.match(prompt, /```markdown/);
	assert.match(prompt, /User request:\n\nSummarize this\./);
}

function testReducer(): void {
	let next = 0;
	const idFactory: IdFactory = (prefix) => `${prefix}-${++next}`;
	let state = createTranscriptState();
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_message_chunk",
		content: {type: "text", text: "Hello"},
	}, idFactory);
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_message_chunk",
		content: {type: "text", text: " world"},
	}, idFactory);
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0]?.text, "Hello world");
	assert.equal(state.messages[0]?.thinkingStartedAt, undefined);

	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "tool_call",
		toolCallId: "tc-1",
		title: "terminal: ls",
		kind: "execute",
		content: [{type: "content", content: {type: "text", text: "$ ls"}}],
	}, idFactory);
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "tool_call_update",
		toolCallId: "tc-1",
		status: "completed",
		content: [{type: "content", content: {type: "text", text: "done"}}],
	}, idFactory);
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0]?.role, "assistant");
	assert.equal(state.messages[0]?.toolEvents?.length, 1);
	assert.equal(state.messages[0]?.toolEvents?.[0]?.id, "tc-1");
	assert.equal(state.messages[0]?.toolEvents?.[0]?.title, "terminal: ls");
	assert.equal(state.messages[0]?.toolEvents?.[0]?.text, "done");
	assert.equal(state.messages[0]?.toolEvents?.[0]?.status, "completed");

	state = createTranscriptState();
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "user_message_chunk",
		content: {type: "text", text: "First"},
	}, idFactory);
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_message_chunk",
		content: {type: "text", text: "One"},
	}, idFactory);
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "user_message_chunk",
		content: {type: "text", text: "Second"},
	}, idFactory);
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_message_chunk",
		content: {type: "text", text: "Two"},
	}, idFactory);
	assert.deepEqual(state.messages.map((message) => message.text), ["First", "One", "Second", "Two"]);
	assert.equal(state.messages[1]?.status, "complete");

	state = createTranscriptState();
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "tool_call",
		toolCallId: "tc-alone",
		title: "fetch docs",
		kind: "fetch",
		content: [{type: "content", content: {type: "text", text: "loading"}}],
	}, idFactory);
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0]?.role, "assistant");
	assert.equal(state.messages[0]?.text, "");
	assert.equal(state.messages[0]?.toolEvents?.[0]?.title, "fetch docs");

	let now = 1000;
	state = createTranscriptState();
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_thought_chunk",
		content: {type: "text", text: "I should inspect context."},
	}, idFactory, () => now);
	assert.equal(state.messages[0]?.thinking, "I should inspect context.");
	assert.equal(state.messages[0]?.thinkingStartedAt, 1000);
	assert.equal(state.messages[0]?.thinkingEndedAt, undefined);
	now = 3400;
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_message_chunk",
		content: {type: "text", text: "Answer"},
	}, idFactory, () => now);
	assert.equal(state.messages[0]?.text, "Answer");
	assert.equal(state.messages[0]?.thinkingEndedAt, 3400);
	assert.equal(state.messages[0]?.thinkingDurationMs, 2400);

	now = 5000;
	state = createTranscriptState();
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_thought_chunk",
		content: {type: "text", text: "Need a file."},
	}, idFactory, () => now);
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "tool_call",
		toolCallId: "tc-read",
		title: "read README",
		kind: "read",
		content: [{type: "content", content: {type: "text", text: "README"}}],
	}, idFactory, () => now);
	now = 6200;
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_message_chunk",
		content: {type: "text", text: "Found it."},
	}, idFactory, () => now);
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0]?.thinking, "Need a file.");
	assert.equal(state.messages[0]?.toolEvents?.[0]?.kind, "read");
	assert.equal(state.messages[0]?.text, "Found it.");
	assert.equal(state.messages[0]?.thinkingDurationMs, 1200);
	state = markAssistantComplete(state, () => 6300);
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "tool_call_update",
		toolCallId: "tc-read",
		status: "completed",
		content: [{type: "content", content: {type: "text", text: "README done"}}],
	}, idFactory, () => 6400);
	assert.equal(state.activeAssistantId, undefined);
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0]?.toolEvents?.[0]?.text, "README done");
	assert.equal(state.messages[0]?.toolEvents?.[0]?.status, "completed");

	now = 10000;
	state = createTranscriptState();
	state = applyAcpSessionUpdate(state, {
		sessionUpdate: "agent_thought_chunk",
		content: {type: "text", text: "Still thinking"},
	}, idFactory, () => now);
	now = 14550;
	state = markAssistantComplete(state, () => now);
	assert.equal(state.messages[0]?.status, "complete");
	assert.equal(state.messages[0]?.thinkingEndedAt, 14550);
	assert.equal(state.messages[0]?.thinkingDurationMs, 4550);
}

function testSessionParsing(): void {
	const result = parseListSessionsResult({
		sessions: [
			{sessionId: "camel", cwd: "/vault", title: "Camel", updatedAt: "2026-05-08T00:00:00Z"},
			{session_id: "snake", cwd: "/vault", title: "Snake", updated_at: "2026-05-08T01:00:00Z"},
			{cwd: "/missing-id"},
		],
		next_cursor: "snake",
	});
	assert.equal(result.sessions.length, 2);
	assert.equal(result.sessions[0]?.sessionId, "camel");
	assert.equal(result.sessions[0]?.updatedAt, "2026-05-08T00:00:00Z");
	assert.equal(result.sessions[1]?.sessionId, "snake");
	assert.equal(result.sessions[1]?.updatedAt, "2026-05-08T01:00:00Z");
	assert.equal(result.nextCursor, "snake");
}

function testPermissionResponses(): void {
	assert.deepEqual(buildPermissionResponse("allow_once"), {
		outcome: {
			outcome: "selected",
			optionId: "allow_once",
		},
	});
	assert.deepEqual(buildPermissionResponse(null), {
		outcome: {
			outcome: "cancelled",
		},
	});
}

function testMentions(): void {
	assert.deepEqual(detectMentionToken("Read @foo", 9), {
		from: 5,
		to: 9,
		query: "foo",
	});
	assert.equal(detectMentionToken("email@example.com", 7), null);
	assert.deepEqual(detectMentionToken("Use @folder/my note", 19), {
		from: 4,
		to: 19,
		query: "folder/my note",
	});

	const ranked = rankMentionCandidates([
		{path: "Projects/Hermes plan.md", basename: "Hermes plan"},
		{path: "Archive/other.md", basename: "other"},
		{path: "Hermes.md", basename: "Hermes"},
	], "hermes");
	assert.deepEqual(ranked.map((item) => item.path), ["Hermes.md", "Projects/Hermes plan.md"]);
}
