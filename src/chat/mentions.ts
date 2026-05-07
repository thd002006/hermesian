export interface MentionToken {
	from: number;
	to: number;
	query: string;
}

export interface MentionCandidate {
	path: string;
	basename: string;
}

export function detectMentionToken(value: string, cursor: number): MentionToken | null {
	if (cursor < 0 || cursor > value.length) {
		return null;
	}

	const beforeCursor = value.slice(0, cursor);
	const lineStart = beforeCursor.lastIndexOf("\n") + 1;
	const lineFragment = value.slice(lineStart, cursor);
	const atIndex = lineFragment.lastIndexOf("@");
	if (atIndex < 0) {
		return null;
	}

	if (atIndex > 0 && !isMentionBoundary(lineFragment.charAt(atIndex - 1))) {
		return null;
	}

	const query = lineFragment.slice(atIndex + 1);
	if (query.length > 120) {
		return null;
	}

	return {
		from: lineStart + atIndex,
		to: cursor,
		query,
	};
}

export function rankMentionCandidates<T extends MentionCandidate>(
	candidates: T[],
	query: string,
	limit = 8
): T[] {
	const normalizedQuery = normalize(query);
	const scored: Array<{candidate: T; score: number}> = [];

	for (const candidate of candidates) {
		const path = normalize(candidate.path);
		const basename = normalize(candidate.basename);
		let score: number | null = null;

		if (!normalizedQuery) {
			score = 4;
		} else if (basename.startsWith(normalizedQuery)) {
			score = 0;
		} else if (path.startsWith(normalizedQuery)) {
			score = 1;
		} else if (basename.includes(normalizedQuery)) {
			score = 2;
		} else if (path.includes(normalizedQuery)) {
			score = 3;
		}

		if (score !== null) {
			scored.push({candidate, score});
		}
	}

	return scored
		.sort((left, right) => {
			if (left.score !== right.score) {
				return left.score - right.score;
			}
			if (left.candidate.path.length !== right.candidate.path.length) {
				return left.candidate.path.length - right.candidate.path.length;
			}
			return left.candidate.path.localeCompare(right.candidate.path);
		})
		.slice(0, limit)
		.map((item) => item.candidate);
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function isMentionBoundary(value: string): boolean {
	return /\s|\(|\[|\{/.test(value);
}
