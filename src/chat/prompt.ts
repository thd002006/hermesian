import type {AcpTextContentBlock, PromptAttachment} from "../types";

export function buildPromptBlocks(input: string, attachments: PromptAttachment[]): AcpTextContentBlock[] {
	return [{
		type: "text",
		text: buildPromptText(input, attachments),
	}];
}

export function buildPromptText(input: string, attachments: PromptAttachment[]): string {
	const text = input.trim();
	if (attachments.length === 0) {
		return text;
	}

	const sections = ["Attached context:"];
	for (const attachment of attachments) {
		sections.push(
			`Source: ${attachment.title}`,
			fenceText(attachment.content, attachment.title.endsWith(".md") ? "markdown" : "")
		);
	}
	sections.push("User request:", text);
	return sections.join("\n\n");
}

export function fenceText(text: string, language: string): string {
	const fence = longestBacktickRun(text) >= 3 ? "`".repeat(longestBacktickRun(text) + 1) : "```";
	const suffix = language ? language : "";
	return `${fence}${suffix}\n${text}\n${fence}`;
}

function longestBacktickRun(text: string): number {
	let longest = 0;
	let current = 0;
	for (const char of text) {
		if (char === "`") {
			current++;
			if (current > longest) {
				longest = current;
			}
		} else {
			current = 0;
		}
	}
	return longest;
}
