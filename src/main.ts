import {Notice, Plugin} from "obsidian";
import {spawn} from "child_process";
import {HermesianSettingTab, DEFAULT_SETTINGS, type HermesianSettings} from "./settings";
import {VIEW_TYPE_CHAT} from "./constants";
import {HermesianChatView} from "./ui/chatView";

export default class HermesianPlugin extends Plugin {
	settings: HermesianSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_CHAT, (leaf) => new HermesianChatView(leaf, this));

		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.addRibbonIcon("bot", "Open Hermesian", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "new-session",
			name: "New session",
			callback: () => void this.withChatView((view) => view.newSession()),
		});

		this.addCommand({
			id: "stop-current-response",
			name: "Stop current response",
			callback: () => void this.withChatView((view) => {
				view.cancelCurrentTurn();
			}),
		});

		this.addCommand({
			id: "restart-acp",
			name: "Restart agent",
			callback: () => void this.withChatView((view) => view.restartConnection()),
		});

		this.addCommand({
			id: "attach-current-file",
			name: "Attach current file",
			callback: () => void this.withChatView((view) => view.attachCurrentFile()),
		});

		this.addCommand({
			id: "attach-selection",
			name: "Attach selected text",
			callback: () => void this.withChatView((view) => {
				view.attachSelection();
			}),
		});

		this.addSettingTab(new HermesianSettingTab(this.app, this));
	}

	onunload(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
			const view = leaf.view;
			if (view instanceof HermesianChatView) {
				view.disposeClient();
			}
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<HermesianSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async activateView(): Promise<HermesianChatView | null> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
		if (existing) {
			void this.app.workspace.revealLeaf(existing);
			return existing.view instanceof HermesianChatView ? existing.view : null;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("Could not open chat view.");
			return null;
		}
		await leaf.setViewState({type: VIEW_TYPE_CHAT, active: true});
		void this.app.workspace.revealLeaf(leaf);
		return leaf.view instanceof HermesianChatView ? leaf.view : null;
	}

	async withChatView(callback: (view: HermesianChatView) => void | Promise<void>): Promise<void> {
		const view = await this.activateView();
		if (!view) {
			return;
		}
		await callback(view);
	}

	getVaultBasePath(): string {
		const adapter = this.app.vault.adapter as {getBasePath?: () => string};
		if (typeof adapter.getBasePath !== "function") {
			throw new Error("Hermesian requires the Obsidian desktop file-system adapter.");
		}
		return adapter.getBasePath();
	}

	openDashboard(): void {
		const batPath = this.settings.dashboardBatPath.trim();
		if (!batPath) {
			throw new Error("Dashboard launcher path is empty.");
		}
		const child = spawn("cmd.exe", ["/c", "start", "", batPath], {
			detached: true,
			stdio: "ignore",
			windowsHide: false,
		});
		child.unref();
	}
}
