import assert from "node:assert/strict";
import {JsonRpcConnection, type JsonRpcPayload} from "../src/acp/jsonRpc";
import {buildPermissionResponse} from "../src/acp/hermesAcpClient";
import {buildAcpLaunchArgs, buildWslPathArgs, quoteBash} from "../src/acp/wsl";
import {buildPromptText} from "../src/chat/prompt";
import {detectMentionToken, rankMentionCandidates} from "../src/chat/mentions";
import {
	applyAcpSessionUpdate,
	createTranscriptState,
	type IdFactory,
} from "../src/chat/reducer";
import type {PromptAttachment} from "../src/types";

await testJsonRpcRequestResponse();
await testJsonRpcIncomingRequest();
testWslArgs();
testPromptAttachments();
testReducer();
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
	const tool = state.messages.find((message) => message.toolCallId === "tc-1");
	assert.equal(tool?.text, "done");
	assert.equal(tool?.status, "completed");
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
