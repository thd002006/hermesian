import {mkdir} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import esbuild from "esbuild";

await mkdir(".test-tmp", {recursive: true});

await esbuild.build({
	entryPoints: ["tests/unit.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node18",
	outfile: ".test-tmp/unit.mjs",
	external: ["obsidian"],
	logLevel: "silent",
});

await import(pathToFileURL(`${process.cwd()}\\.test-tmp\\unit.mjs`).href);

console.log("Hermesian tests passed.");
