import {ItemView, MarkdownRenderer, MarkdownView, Notice, TFile, WorkspaceLeaf, setIcon} from "obsidian";
import type HermesianPlugin from "../main";
import {HermesAcpClient, getOptionId} from "../acp/hermesAcpClient";
import {VIEW_TYPE_CHAT} from "../constants";
import {buildPromptBlocks} from "../chat/prompt";
import {detectMentionToken, rankMentionCandidates, type MentionToken} from "../chat/mentions";
import {
	applyAcpSessionUpdate,
	createChatId,
	createTranscriptState,
	type ChatTranscriptState,
	markAssistantComplete,
	startAssistantMessage,
} from "../chat/reducer";
import type {
	AcpPermissionOption,
	AcpPermissionRequest,
	AcpSessionInfo,
	AcpSessionUpdate,
	ChatMessage,
	ConnectionStatus,
	PermissionRequestEvent,
	PromptAttachment,
	ToolEvent,
} from "../types";

export class HermesianChatView extends ItemView {
	private client: HermesAcpClient | null = null;
	private state: ChatTranscriptState = createTranscriptState();
	private attachments: PromptAttachment[] = [];
	private pendingPermissions: PermissionRequestEvent[] = [];
	private permissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private status: ConnectionStatus = "idle";
	private statusDetail = "Idle";
	private mentionToken: MentionToken | null = null;
	private mentionMatches: TFile[] = [];
	private mentionIndex = 0;

	private rootEl!: HTMLElement;
	private messageListEl!: HTMLElement;
	private attachmentListEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButtonEl!: HTMLButtonElement;
	private externalFileInputEl!: HTMLInputElement;
	private mentionMenuEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private usageEl!: HTMLElement;
	private historyPanelEl!: HTMLElement;
	private historyListEl!: HTMLElement;
	private statusBarOffsetFrame: number | null = null;
	private renderFrame: number | null = null;
	private renderGeneration = 0;
	private initialSessionPromise: Promise<void> | null = null;
	private historyReplayTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: HermesianPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return "Hermesian";
	}

	getIcon(): string {
		return "feather";
	}

	async onOpen(): Promise<void> {
		this.renderShell();
		this.initialSessionPromise = this.restoreInitialSession();
		void this.initialSessionPromise.finally(() => {
			this.initialSessionPromise = null;
		});
	}

	async onClose(): Promise<void> {
		this.disposeClient();
		this.clearPermissionTimers();
		this.cancelStatusBarOffsetFrame();
		this.cancelRenderFrame();
		this.cancelHistoryReplayTimer();
	}

	disposeClient(): void {
		if (this.client) {
			this.client.disconnect();
			this.client = null;
		}
	}

	async newSession(): Promise<void> {
		this.cancelHistoryReplayTimer();
		this.state = createTranscriptState();
		this.attachments = [];
		this.pendingPermissions = [];
		this.clearPermissionTimers();
		this.closeHistoryPanel();
		try {
			const client = await this.ensureClient(false);
			const sessionId = await client.startNewSession();
			await this.rememberSession(sessionId);
		} catch (error) {
			this.addSystemMessage(error instanceof Error ? error.message : "Could not start a new session.");
		}
		this.render();
	}

	cancelCurrentTurn(): void {
		this.client?.cancel();
		this.addSystemMessage("Stop requested.");
	}

	async restartConnection(): Promise<void> {
		this.disposeClient();
		const client = await this.ensureClient(true);
		await this.ensureActiveSession(client);
		this.addSystemMessage("Hermes ACP restarted.");
	}

	async attachCurrentFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file to attach.");
			return;
		}
		await this.attachVaultFile(file);
	}

	async attachExternalFiles(files: FileList | File[]): Promise<void> {
		const selected = Array.from(files);
		if (selected.length === 0) {
			return;
		}
		for (const file of selected) {
			const content = await file.text();
			this.addAttachment({
				id: createChatId("attachment"),
				title: file.name,
				source: "external",
				content,
				createdAt: Date.now(),
			});
		}
		new Notice(`Attached ${selected.length} external file${selected.length === 1 ? "" : "s"}.`);
	}

	private async attachVaultFile(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		this.addAttachment({
			id: createChatId("attachment"),
			title: file.path,
			source: "file",
			content,
			createdAt: Date.now(),
		});
		new Notice(`Attached ${file.path}`);
	}

	attachSelection(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const selection = view?.editor.getSelection() ?? "";
		if (!selection.trim()) {
			new Notice("No selected text to attach.");
			return;
		}
		const filePath = view?.file?.path ?? "Current selection";
		this.addAttachment({
			id: createChatId("attachment"),
			title: `${filePath} selection`,
			source: "selection",
			content: selection,
			createdAt: Date.now(),
		});
		new Notice("Attached selected text.");
	}

	private renderShell(): void {
		this.containerEl.empty();
		this.containerEl.addClass("hermesian-container");
		this.rootEl = this.containerEl.createDiv({cls: "hermesian-view"});
		this.updateStatusBarOffset();
		this.registerDomEvent(window, "resize", () => this.scheduleStatusBarOffsetUpdate());

		const header = this.rootEl.createDiv({cls: "hermesian-header"});
		const titleWrap = header.createDiv({cls: "hermesian-title-wrap"});
		titleWrap.createDiv({cls: "hermesian-title", text: "Hermesian"});
		this.statusEl = titleWrap.createDiv({cls: "hermesian-status"});

		this.messageListEl = this.rootEl.createDiv({cls: "hermesian-messages"});
		const toolbar = this.rootEl.createDiv({cls: "hermesian-output-toolbar"});
		this.usageEl = toolbar.createDiv({cls: "hermesian-usage"});
		const actions = toolbar.createDiv({cls: "hermesian-actions"});
		this.addIconButton(actions, "plus", "New session", () => void this.newSession());
		this.addIconButton(actions, "rotate-cw", "Restart ACP", () => void this.restartConnection());
		this.addIconButton(actions, "history", "Chat history", () => void this.toggleHistoryPanel());
		this.historyPanelEl = toolbar.createDiv({cls: "hermesian-history-panel"});
		this.historyListEl = this.historyPanelEl.createDiv({cls: "hermesian-history-list"});

		const composer = this.rootEl.createDiv({cls: "hermesian-composer"});
		this.mentionMenuEl = composer.createDiv({cls: "hermesian-mention-menu"});
		const inputWrapper = composer.createDiv({cls: "hermesian-input-wrapper"});
		this.attachmentListEl = inputWrapper.createDiv({cls: "hermesian-attachments"});
		this.inputEl = composer.createEl("textarea", {
			cls: "hermesian-input",
			attr: {
				placeholder: "Message, or type @ to attach a vault file",
				rows: "3",
			},
		});
		inputWrapper.appendChild(this.inputEl);
		this.registerDomEvent(this.inputEl, "keydown", (event: KeyboardEvent) => {
			if (this.handleMentionKeydown(event)) {
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				void this.sendCurrentMessage();
			}
		});
		this.registerDomEvent(this.inputEl, "input", () => this.updateMentionMenu());
		this.registerDomEvent(this.inputEl, "click", () => this.updateMentionMenu());

		const composerActions = inputWrapper.createDiv({cls: "hermesian-composer-actions"});
		this.addIconButton(composerActions, "at-sign", "Insert mention", () => this.insertMentionTrigger());
		this.addIconButton(composerActions, "paperclip", "Attach current file", () => void this.attachCurrentFile());
		this.addIconButton(composerActions, "text-select", "Attach selection", () => this.attachSelection());
		this.addIconButton(composerActions, "folder-open", "Attach external file", () => this.externalFileInputEl.click());
		this.sendButtonEl = this.addIconButton(composerActions, "send", "Send", () => this.handleSendStopClick(), "mod-cta");

		this.externalFileInputEl = composer.createEl("input", {
			cls: "hermesian-external-input",
			attr: {
				type: "file",
				multiple: "true",
			},
		});
		this.registerDomEvent(this.externalFileInputEl, "change", () => {
			const files = this.externalFileInputEl.files;
			if (files) {
				void this.attachExternalFiles(files);
			}
			this.externalFileInputEl.value = "";
		});

		this.render();
		this.scheduleStatusBarOffsetUpdate();
	}

	private addActionButton(parent: HTMLElement, text: string, onClick: () => void, extraClass?: string): HTMLButtonElement {
		const button = parent.createEl("button", {text, cls: extraClass ? `hermesian-button ${extraClass}` : "hermesian-button"});
		this.registerDomEvent(button, "click", () => onClick());
		return button;
	}

	private addIconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, extraClass?: string): HTMLButtonElement {
		const button = parent.createEl("button", {cls: extraClass ? `hermesian-icon-button ${extraClass}` : "hermesian-icon-button"});
		button.setAttr("aria-label", label);
		button.setAttr("title", label);
		setIcon(button, icon);
		this.registerDomEvent(button, "click", () => onClick());
		return button;
	}

	private handleSendStopClick(): void {
		if (this.isResponseRunning()) {
			this.cancelCurrentTurn();
			return;
		}
		void this.sendCurrentMessage();
	}

	private async sendCurrentMessage(): Promise<void> {
		this.cancelHistoryReplayTimer();
		const input = this.inputEl.value.trim();
		if (!input && this.attachments.length === 0) {
			return;
		}

		const attachments = [...this.attachments];
		const blocks = buildPromptBlocks(input || "Use the attached context.", attachments);
		const userPreview = attachments.length > 0
			? `${input || "Use the attached context."}\n\nAttached: ${attachments.map((item) => item.title).join(", ")}`
			: input;

		this.inputEl.value = "";
		this.attachments = [];
		this.closeMentionMenu();
		this.addUserMessage(userPreview);
		if (!this.isResponseRunning()) {
			this.state = startAssistantMessage(this.state);
		}
		this.render();

		try {
			const client = await this.ensureClient(false);
			await this.ensureActiveSession(client);
			await client.prompt(blocks);
			this.state = markAssistantComplete(this.state);
		} catch (error) {
			this.state = markAssistantComplete(this.state);
			this.addSystemMessage(error instanceof Error ? error.message : "Hermes request failed.");
		}
		this.render();
	}

	private async ensureClient(restart: boolean): Promise<HermesAcpClient> {
		if (restart) {
			this.disposeClient();
		}
		if (this.client) {
			return this.client;
		}

		const client = new HermesAcpClient(this.plugin.settings, {
			onStatus: (status, detail) => {
				this.status = status;
				this.statusDetail = detail ?? status;
				this.renderStatus();
			},
			onSessionUpdate: (_sessionId: string, update: AcpSessionUpdate) => {
				this.state = applyAcpSessionUpdate(this.state, update);
				this.scheduleRender();
			},
			onPermission: (event) => this.handlePermission(event),
			onError: (message) => {
				this.addSystemMessage(message);
			},
		});
		this.client = client;
		try {
			await client.connect(this.plugin.getVaultBasePath());
		} catch (error) {
			this.client = null;
			this.status = "error";
			this.statusDetail = error instanceof Error ? error.message : "Could not connect to Hermes ACP.";
			this.renderStatus();
			throw error;
		}
		return client;
	}

	private async restoreInitialSession(): Promise<void> {
		try {
			const client = await this.ensureClient(false);
			const lastSessionId = this.plugin.settings.lastSessionId?.trim();
			if (lastSessionId) {
				this.state = createTranscriptState();
				this.render();
				await client.loadSession(lastSessionId);
				await this.rememberSession(lastSessionId);
				this.scheduleHistoryReplayCompletion();
				return;
			}
			const sessionId = await client.startNewSession();
			await this.rememberSession(sessionId);
		} catch (error) {
			this.state = createTranscriptState();
			this.render();
			try {
				const client = await this.ensureClient(false);
				const sessionId = await client.startNewSession();
				await this.rememberSession(sessionId);
				this.addSystemMessage("Previous Hermes session could not be restored; started a new session.");
			} catch {
				this.addSystemMessage(error instanceof Error ? error.message : "Could not restore Hermes session.");
			}
		}
	}

	private async ensureActiveSession(client: HermesAcpClient): Promise<void> {
		if (this.initialSessionPromise) {
			await this.initialSessionPromise;
		}
		if (client.hasSession()) {
			return;
		}
		const sessionId = await client.startNewSession();
		await this.rememberSession(sessionId);
	}

	private async rememberSession(sessionId: string): Promise<void> {
		this.plugin.settings.lastSessionId = sessionId;
		await this.plugin.saveSettings();
	}

	private async toggleHistoryPanel(): Promise<void> {
		if (this.historyPanelEl.hasClass("is-visible")) {
			this.closeHistoryPanel();
			return;
		}
		await this.openHistoryPanel();
	}

	private async openHistoryPanel(): Promise<void> {
		this.historyPanelEl.addClass("is-visible");
		this.historyListEl.empty();
		this.historyListEl.createDiv({cls: "hermesian-history-empty", text: "Loading sessions..."});
		try {
			const client = await this.ensureClient(false);
			const result = await client.listSessions();
			this.renderHistorySessions(result.sessions, result.nextCursor);
		} catch (error) {
			this.historyListEl.empty();
			this.historyListEl.createDiv({
				cls: "hermesian-history-empty",
				text: error instanceof Error ? error.message : "Could not load chat history.",
			});
		}
	}

	private closeHistoryPanel(): void {
		if (!this.historyPanelEl) {
			return;
		}
		this.historyPanelEl.removeClass("is-visible");
		this.historyListEl?.empty();
	}

	private renderHistorySessions(sessions: AcpSessionInfo[], nextCursor?: string): void {
		this.historyListEl.empty();
		if (sessions.length === 0) {
			this.historyListEl.createDiv({cls: "hermesian-history-empty", text: "No sessions for this vault."});
			return;
		}
		for (const session of sessions) {
			const item = this.historyListEl.createDiv({cls: "hermesian-history-item"});
			item.setAttr("role", "button");
			item.setAttr("tabindex", "0");
			item.createDiv({cls: "hermesian-history-title", text: session.title || "Untitled session"});
			const meta = item.createDiv({cls: "hermesian-history-meta"});
			meta.createSpan({text: formatSessionUpdatedAt(session.updatedAt)});
			if (session.cwd) {
				meta.createSpan({text: session.cwd});
			}
			this.registerDomEvent(item, "click", () => void this.loadHistorySession(session.sessionId));
			this.registerDomEvent(item, "keydown", (event: KeyboardEvent) => {
				if (event.key !== "Enter" && event.key !== " ") {
					return;
				}
				event.preventDefault();
				void this.loadHistorySession(session.sessionId);
			});
		}
		if (nextCursor) {
			this.historyListEl.createDiv({cls: "hermesian-history-empty", text: "More sessions are available in Hermes."});
		}
	}

	private async loadHistorySession(sessionId: string): Promise<void> {
		this.cancelHistoryReplayTimer();
		this.closeHistoryPanel();
		this.state = createTranscriptState();
		this.render();
		try {
			const client = await this.ensureClient(false);
			await client.loadSession(sessionId);
			await this.rememberSession(sessionId);
			this.scheduleHistoryReplayCompletion();
		} catch (error) {
			this.addSystemMessage(error instanceof Error ? error.message : "Could not load Hermes session.");
		}
	}

	private handlePermission(event: PermissionRequestEvent): void {
		this.pendingPermissions = [...this.pendingPermissions, event];
		const timeoutMs = Math.max(1, this.plugin.settings.approvalTimeoutSeconds) * 1000;
		const timer = setTimeout(() => {
			this.resolvePermission(event.id, null);
		}, timeoutMs + 250);
		this.permissionTimers.set(event.id, timer);
		this.render();
	}

	private resolvePermission(id: string, optionId: string | null): void {
		const event = this.pendingPermissions.find((item) => item.id === id);
		if (!event) {
			return;
		}
		const timer = this.permissionTimers.get(id);
		if (timer) {
			clearTimeout(timer);
		}
		this.permissionTimers.delete(id);
		this.pendingPermissions = this.pendingPermissions.filter((item) => item.id !== id);
		event.respond(optionId);
		this.render();
	}

	private addUserMessage(text: string): void {
		this.state = {
			...this.state,
			messages: [
				...this.state.messages,
				{
					id: createChatId("user"),
					role: "user",
					text,
					createdAt: Date.now(),
				},
			],
		};
	}

	private addSystemMessage(text: string): void {
		this.state = {
			...this.state,
			messages: [
				...this.state.messages,
				{
					id: createChatId("system"),
					role: "system",
					text,
					createdAt: Date.now(),
				},
			],
		};
		this.render();
	}

	private addAttachment(attachment: PromptAttachment): void {
		const existing = this.attachments.find((item) => item.title === attachment.title && item.source === attachment.source);
		this.attachments = existing
			? this.attachments.map((item) => item === existing ? attachment : item)
			: [...this.attachments, attachment];
		this.renderAttachments();
	}

	private removeAttachment(id: string): void {
		this.attachments = this.attachments.filter((attachment) => attachment.id !== id);
		this.renderAttachments();
	}

	private render(): void {
		if (!this.messageListEl) {
			return;
		}
		this.renderStatus();
		this.renderMessages();
		this.renderAttachments();
		this.renderUsage();
		this.renderSendStopButton();
	}

	private isResponseRunning(): boolean {
		return Boolean(this.state.activeAssistantId);
	}

	private renderSendStopButton(): void {
		if (!this.sendButtonEl) {
			return;
		}
		const isRunning = this.isResponseRunning();
		this.sendButtonEl.toggleClass("mod-stop", isRunning);
		this.sendButtonEl.setAttr("aria-label", isRunning ? "Stop response" : "Send");
		this.sendButtonEl.setAttr("title", isRunning ? "Stop response" : "Send");
		this.sendButtonEl.empty();
		setIcon(this.sendButtonEl, isRunning ? "square" : "send");
	}

	private scheduleRender(): void {
		if (!this.messageListEl || this.renderFrame !== null) {
			return;
		}
		this.renderFrame = window.requestAnimationFrame(() => {
			this.renderFrame = null;
			this.render();
		});
	}

	private updateMentionMenu(): void {
		if (!this.inputEl || !this.mentionMenuEl) {
			return;
		}
		this.mentionToken = detectMentionToken(this.inputEl.value, this.inputEl.selectionStart);
		if (!this.mentionToken) {
			this.closeMentionMenu();
			return;
		}

		const configDir = this.app.vault.configDir;
		this.mentionMatches = rankMentionCandidates(
			this.app.vault.getFiles().filter((file) => !file.path.startsWith(`${configDir}/`)),
			this.mentionToken.query,
			8
		);
		this.mentionIndex = Math.min(this.mentionIndex, Math.max(0, this.mentionMatches.length - 1));
		this.renderMentionMenu();
	}

	private renderMentionMenu(): void {
		this.mentionMenuEl.empty();
		this.mentionMenuEl.addClass("is-visible");
		if (this.mentionMatches.length === 0) {
			this.mentionMenuEl.createDiv({cls: "hermesian-mention-empty", text: "No matching files"});
			return;
		}
		for (const [index, file] of this.mentionMatches.entries()) {
			const item = this.mentionMenuEl.createDiv({
				cls: index === this.mentionIndex ? "hermesian-mention-item is-selected" : "hermesian-mention-item",
			});
			const icon = item.createSpan({cls: "hermesian-mention-icon"});
			setIcon(icon, "file-text");
			const text = item.createDiv({cls: "hermesian-mention-text"});
			text.createDiv({cls: "hermesian-mention-name", text: file.basename});
			text.createDiv({cls: "hermesian-mention-path", text: file.path});
			this.registerDomEvent(item, "mousedown", (event: MouseEvent) => {
				event.preventDefault();
				void this.selectMention(file);
			});
		}
	}

	private closeMentionMenu(): void {
		this.mentionToken = null;
		this.mentionMatches = [];
		this.mentionIndex = 0;
		if (this.mentionMenuEl) {
			this.mentionMenuEl.removeClass("is-visible");
			this.mentionMenuEl.empty();
		}
	}

	private handleMentionKeydown(event: KeyboardEvent): boolean {
		if (!this.mentionToken || this.mentionMatches.length === 0) {
			if (event.key === "Escape" && this.mentionToken) {
				this.closeMentionMenu();
				event.preventDefault();
				return true;
			}
			return false;
		}
		if (event.key === "ArrowDown") {
			this.mentionIndex = (this.mentionIndex + 1) % this.mentionMatches.length;
			this.renderMentionMenu();
			event.preventDefault();
			return true;
		}
		if (event.key === "ArrowUp") {
			this.mentionIndex = (this.mentionIndex - 1 + this.mentionMatches.length) % this.mentionMatches.length;
			this.renderMentionMenu();
			event.preventDefault();
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			const file = this.mentionMatches[this.mentionIndex];
			if (file) {
				event.preventDefault();
				void this.selectMention(file);
				return true;
			}
		}
		if (event.key === "Escape") {
			this.closeMentionMenu();
			event.preventDefault();
			return true;
		}
		return false;
	}

	private async selectMention(file: TFile): Promise<void> {
		if (!this.mentionToken) {
			return;
		}
		const replacement = `@${file.path} `;
		const value = this.inputEl.value;
		this.inputEl.value = value.slice(0, this.mentionToken.from) + replacement + value.slice(this.mentionToken.to);
		const cursor = this.mentionToken.from + replacement.length;
		this.inputEl.setSelectionRange(cursor, cursor);
		await this.attachVaultFile(file);
		this.closeMentionMenu();
		this.inputEl.focus();
	}

	private insertMentionTrigger(): void {
		const cursor = this.inputEl.selectionStart;
		const prefix = cursor > 0 && !/\s/.test(this.inputEl.value.charAt(cursor - 1)) ? " @" : "@";
		this.inputEl.value = this.inputEl.value.slice(0, cursor) + prefix + this.inputEl.value.slice(this.inputEl.selectionEnd);
		const nextCursor = cursor + prefix.length;
		this.inputEl.setSelectionRange(nextCursor, nextCursor);
		this.inputEl.focus();
		this.updateMentionMenu();
	}

	private renderStatus(): void {
		if (!this.statusEl) {
			return;
		}
		this.statusEl.setText(`${this.status}: ${this.statusDetail}`);
	}

	private scheduleStatusBarOffsetUpdate(): void {
		this.cancelStatusBarOffsetFrame();
		this.statusBarOffsetFrame = window.requestAnimationFrame(() => {
			this.statusBarOffsetFrame = null;
			this.updateStatusBarOffset();
		});
	}

	private updateStatusBarOffset(): void {
		if (!this.rootEl) {
			return;
		}
		const statusBar = document.querySelector(".status-bar");
		if (!(statusBar instanceof HTMLElement) || !isVisible(statusBar)) {
			this.rootEl.setCssProps({"--hermesian-statusbar-offset": "0px"});
			return;
		}
		const measuredHeight = statusBar.getBoundingClientRect().height;
		const offset = measuredHeight > 4 ? measuredHeight : 24;
		this.rootEl.setCssProps({"--hermesian-statusbar-offset": `${Math.ceil(offset)}px`});
	}

	private cancelStatusBarOffsetFrame(): void {
		if (this.statusBarOffsetFrame === null) {
			return;
		}
		window.cancelAnimationFrame(this.statusBarOffsetFrame);
		this.statusBarOffsetFrame = null;
	}

	private cancelRenderFrame(): void {
		if (this.renderFrame === null) {
			return;
		}
		window.cancelAnimationFrame(this.renderFrame);
		this.renderFrame = null;
	}

	private scheduleHistoryReplayCompletion(): void {
		this.cancelHistoryReplayTimer();
		this.historyReplayTimer = setTimeout(() => {
			this.historyReplayTimer = null;
			this.state = markAssistantComplete(this.state);
			this.render();
		}, 500);
	}

	private cancelHistoryReplayTimer(): void {
		if (this.historyReplayTimer === null) {
			return;
		}
		clearTimeout(this.historyReplayTimer);
		this.historyReplayTimer = null;
	}

	private renderUsage(): void {
		if (!this.usageEl) {
			return;
		}
		if (!this.state.usage) {
			this.usageEl.setText("");
			return;
		}
		this.usageEl.setText(`Context: ${this.state.usage.used} / ${this.state.usage.size}`);
	}

	private renderMessages(): void {
		this.renderGeneration++;
		const generation = this.renderGeneration;
		this.messageListEl.empty();
		for (const message of this.state.messages) {
			this.renderMessage(message, generation);
		}
		for (const permission of this.pendingPermissions) {
			this.renderPermission(permission);
		}
		this.scrollMessagesToBottom();
	}

	private renderMessage(message: ChatMessage, generation: number): void {
		const wrapper = this.messageListEl.createDiv({cls: `hermesian-message hermesian-message-${message.role}`});
		const meta = wrapper.createDiv({cls: "hermesian-message-meta"});
		meta.createSpan({text: renderRole(message)});
		if (message.status) {
			meta.createSpan({cls: "hermesian-message-status", text: message.status});
		}
		if (message.toolTitle) {
			wrapper.createDiv({cls: "hermesian-tool-title", text: message.toolTitle});
		}
		const hasTrace = hasThinkingTrace(message);
		if (hasTrace) {
			this.renderThinking(wrapper, message, generation);
		}
		const text = message.text || (message.role === "assistant" && message.status === "running" && !hasTrace ? "Waiting for Hermes..." : "");
		if (text) {
			const textEl = wrapper.createDiv({cls: "hermesian-message-text hermesian-markdown"});
			this.renderMarkdown(text, textEl, generation);
		}
	}

	private renderThinking(parent: HTMLElement, message: ChatMessage, generation: number): void {
		const details = parent.createEl("details", {cls: "hermesian-thinking"});
		details.setAttr("open", "true");
		const summary = details.createEl("summary", {cls: "hermesian-thinking-summary"});
		summary.createSpan({
			cls: "hermesian-thinking-label",
			text: getThinkingLabel(message),
		});
		summary.createSpan({
			cls: "hermesian-thinking-duration",
			text: formatThinkingSummaryMeta(message),
		});
		const body = details.createDiv({cls: "hermesian-thinking-body"});
		if (message.thinking) {
			const thoughtEl = body.createDiv({cls: "hermesian-thinking-text hermesian-markdown"});
			this.renderMarkdown(message.thinking, thoughtEl, generation);
		}
		if (message.toolEvents?.length) {
			this.renderToolEvents(body, message.toolEvents, generation);
		}
	}

	private renderToolEvents(parent: HTMLElement, toolEvents: ToolEvent[], generation: number): void {
		const list = parent.createDiv({cls: "hermesian-tool-events"});
		for (const toolEvent of toolEvents) {
			const details = list.createEl("details", {cls: "hermesian-tool-event"});
			const summary = details.createEl("summary", {cls: "hermesian-tool-event-summary"});
			summary.createSpan({
				cls: "hermesian-tool-event-title",
				text: formatToolEventTitle(toolEvent),
			});
			if (toolEvent.status) {
				summary.createSpan({
					cls: `hermesian-tool-event-status ${toolEvent.status === "failed" ? "is-failed" : ""}`,
					text: toolEvent.status,
				});
			}
			const text = toolEvent.text || "No output.";
			const output = details.createDiv({cls: "hermesian-tool-event-output hermesian-markdown"});
			this.renderMarkdown(text, output, generation);
		}
	}

	private renderMarkdown(markdown: string, el: HTMLElement, generation: number): void {
		void MarkdownRenderer.render(this.app, markdown, el, this.getMarkdownSourcePath(), this).then(
			() => {
				if (this.renderGeneration === generation) {
					this.scrollMessagesToBottom();
				}
			},
			() => {
				el.setText(markdown);
				if (this.renderGeneration === generation) {
					this.scrollMessagesToBottom();
				}
			}
		);
	}

	private getMarkdownSourcePath(): string {
		return this.app.workspace.getActiveFile()?.path ?? "";
	}

	private scrollMessagesToBottom(): void {
		this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
	}

	private renderPermission(permission: PermissionRequestEvent): void {
		const wrapper = this.messageListEl.createDiv({cls: "hermesian-message hermesian-permission"});
		wrapper.createDiv({cls: "hermesian-message-meta", text: "Permission request"});
		wrapper.createDiv({cls: "hermesian-tool-title", text: permissionTitle(permission.request)});
		const actions = wrapper.createDiv({cls: "hermesian-permission-actions"});
		const options = permission.request.options ?? [];
		if (options.length === 0) {
			this.addPermissionButton(actions, permission.id, "Deny", null);
			return;
		}
		for (const option of options) {
			this.addPermissionButton(actions, permission.id, option.name, getOptionId(option));
		}
		if (!hasRejectOption(options)) {
			this.addPermissionButton(actions, permission.id, "Deny", null);
		}
	}

	private addPermissionButton(parent: HTMLElement, id: string, label: string, optionId: string | null): void {
		const button = parent.createEl("button", {text: label, cls: "hermesian-button"});
		this.registerDomEvent(button, "click", () => this.resolvePermission(id, optionId));
	}

	private renderAttachments(): void {
		if (!this.attachmentListEl) {
			return;
		}
		this.attachmentListEl.empty();
		for (const attachment of this.attachments) {
			const chip = this.attachmentListEl.createDiv({cls: "hermesian-attachment"});
			const icon = chip.createSpan({cls: "hermesian-attachment-icon"});
			setIcon(icon, attachment.source === "external" ? "folder-open" : "file-text");
			chip.createSpan({cls: "hermesian-attachment-name", text: attachment.title});
			const remove = chip.createEl("button", {cls: "hermesian-attachment-remove"});
			remove.setAttr("aria-label", "Remove attachment");
			remove.setAttr("title", "Remove attachment");
			setIcon(remove, "x");
			this.registerDomEvent(remove, "click", () => this.removeAttachment(attachment.id));
		}
	}

	private clearPermissionTimers(): void {
		for (const timer of this.permissionTimers.values()) {
			clearTimeout(timer);
		}
		this.permissionTimers.clear();
	}
}

function renderRole(message: ChatMessage): string {
	if (message.role === "assistant") {
		return "Hermes";
	}
	if (message.role === "tool") {
		return message.toolKind ? `Tool: ${message.toolKind}` : "Tool";
	}
	return message.role;
}

function formatThinkingDuration(message: ChatMessage): string {
	const duration = message.thinkingDurationMs ?? (
		message.thinkingStartedAt !== undefined ? Math.max(0, Date.now() - message.thinkingStartedAt) : 0
	);
	const seconds = duration / 1000;
	if (seconds < 10) {
		return `${seconds.toFixed(1)}s`;
	}
	if (seconds < 60) {
		return `${Math.round(seconds)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remaining = Math.round(seconds % 60);
	const remainingSeconds = remaining < 10 ? `0${remaining}` : String(remaining);
	return `${minutes}m ${remainingSeconds}s`;
}

function hasThinkingTrace(message: ChatMessage): boolean {
	return Boolean(message.thinking || message.toolEvents?.length);
}

function getThinkingLabel(message: ChatMessage): string {
	if (!message.thinking) {
		return "工具调用";
	}
	return message.thinkingEndedAt ? "思考完成" : "思考中";
}

function formatThinkingSummaryMeta(message: ChatMessage): string {
	const parts: string[] = [];
	if (message.thinkingStartedAt !== undefined || message.thinkingDurationMs !== undefined) {
		parts.push(formatThinkingDuration(message));
	}
	const toolCount = message.toolEvents?.length ?? 0;
	if (toolCount > 0) {
		parts.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
	}
	return parts.join(" · ");
}

function formatToolEventTitle(toolEvent: ToolEvent): string {
	const title = toolEvent.title || toolEvent.id;
	return toolEvent.kind ? `Tool: ${toolEvent.kind} · ${title}` : `Tool: ${title}`;
}

function formatSessionUpdatedAt(value: string | undefined): string {
	if (!value) {
		return "Unknown time";
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		return value;
	}
	const elapsedMs = Date.now() - timestamp;
	if (elapsedMs < 60 * 1000) {
		return "Just now";
	}
	if (elapsedMs < 60 * 60 * 1000) {
		return `${Math.max(1, Math.round(elapsedMs / (60 * 1000)))}m ago`;
	}
	if (elapsedMs < 24 * 60 * 60 * 1000) {
		return `${Math.round(elapsedMs / (60 * 60 * 1000))}h ago`;
	}
	return new Date(timestamp).toLocaleDateString();
}

function permissionTitle(request: AcpPermissionRequest): string {
	const toolCall = request.toolCall ?? request.tool_call;
	if (toolCall && typeof toolCall === "object") {
		const record = toolCall as Record<string, unknown>;
		if (typeof record.title === "string" && record.title) {
			return record.title;
		}
		const rawInput = record.rawInput ?? record.raw_input;
		if (typeof rawInput === "string" && rawInput) {
			return rawInput;
		}
	}
	return "Hermes wants permission to continue.";
}

function hasRejectOption(options: AcpPermissionOption[]): boolean {
	return options.some((option) => option.kind === "reject_once" || option.kind === "reject_always");
}

function isVisible(element: HTMLElement): boolean {
	const style = window.getComputedStyle(element);
	return style.display !== "none" && style.visibility !== "hidden";
}
