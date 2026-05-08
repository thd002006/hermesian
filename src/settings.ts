import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import type HermesianPlugin from "./main";
import {DEFAULT_DASHBOARD_BAT_PATH} from "./constants";

export interface HermesianSettings {
	wslDistro: string;
	hermesCommand: string;
	autoStartAcp: boolean;
	approvalTimeoutSeconds: number;
	dashboardBatPath: string;
	lastSessionId?: string;
}

export const DEFAULT_SETTINGS: HermesianSettings = {
	wslDistro: "Ubuntu",
	hermesCommand: "hermes",
	autoStartAcp: true,
	approvalTimeoutSeconds: 60,
	dashboardBatPath: DEFAULT_DASHBOARD_BAT_PATH,
	lastSessionId: undefined,
};

export class HermesianSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: HermesianPlugin) {
		super(app, plugin);
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Connection")
			.setHeading();

		new Setting(containerEl)
			.setName("Distro")
			.setDesc("The Linux distribution that contains the agent.")
			.addText((text) => text
				.setPlaceholder("Ubuntu")
				.setValue(this.plugin.settings.wslDistro)
				.onChange(async (value) => {
					this.plugin.settings.wslDistro = value.trim() || DEFAULT_SETTINGS.wslDistro;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Command")
			.setDesc("Command executed inside WSL as '<command> acp'.")
			.addText((text) => text
				.setPlaceholder("Hermes")
				.setValue(this.plugin.settings.hermesCommand)
				.onChange(async (value) => {
					this.plugin.settings.hermesCommand = value.trim() || DEFAULT_SETTINGS.hermesCommand;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Auto start")
			.setDesc("Start the agent automatically before the first chat message.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoStartAcp)
				.onChange(async (value) => {
					this.plugin.settings.autoStartAcp = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Approval timeout")
			.setDesc("Seconds to wait before denying an agent permission request.")
			.addText((text) => text
				.setPlaceholder("60")
				.setValue(String(this.plugin.settings.approvalTimeoutSeconds))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.approvalTimeoutSeconds = Number.isFinite(parsed) && parsed > 0
						? parsed
						: DEFAULT_SETTINGS.approvalTimeoutSeconds;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Dashboard launcher")
			.setDesc("Optional helper for opening the dashboard; chat still uses the protocol.")
			.addText((text) => text
				.setPlaceholder("C:\\Path\\To\\Hermes Dashboard.bat")
				.setValue(this.plugin.settings.dashboardBatPath)
				.onChange(async (value) => {
					this.plugin.settings.dashboardBatPath = value.trim() || DEFAULT_SETTINGS.dashboardBatPath;
					await this.plugin.saveSettings();
				}))
			.addButton((button) => button
				.setButtonText("Open")
				.onClick(() => {
					try {
						this.plugin.openDashboard();
					} catch (error) {
						new Notice(error instanceof Error ? error.message : "Could not open Dashboard.");
					}
				}));
	}
}
