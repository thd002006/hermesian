import type {HermesianSettings} from "../settings";

export interface SpawnSpec {
	command: string;
	args: string[];
}

export function buildWslArgs(distro: string, linuxArgs: string[]): string[] {
	const args: string[] = [];
	const trimmedDistro = distro.trim();
	if (trimmedDistro) {
		args.push("-d", trimmedDistro);
	}
	args.push("-e");
	for (const arg of linuxArgs) {
		args.push(arg);
	}
	return args;
}

export function buildWslPathArgs(settings: Pick<HermesianSettings, "wslDistro">, windowsPath: string): SpawnSpec {
	return {
		command: "wsl.exe",
		args: buildWslArgs(settings.wslDistro, ["wslpath", "-a", windowsPath]),
	};
}

export function buildAcpLaunchArgs(
	settings: Pick<HermesianSettings, "wslDistro" | "hermesCommand">,
	wslCwd: string
): SpawnSpec {
	const command = `cd ${quoteBash(wslCwd)} && exec ${settings.hermesCommand.trim() || "hermes"} acp`;
	return {
		command: "wsl.exe",
		args: buildWslArgs(settings.wslDistro, ["bash", "-l", "-c", command]),
	};
}

export function quoteBash(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function cleanWslOutput(output: string): string {
	return output.replace(/\0/g, "").trim();
}
