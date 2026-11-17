import { defineRule } from "@oxlint/plugins";

import type { Comment, SourceCode } from "@oxlint/plugins";

const directives = [/^[\s*]*SAFETY\s*:/u, /^\s*@ts-expect-error\b/u, /^\s*oxlint-(disable|enable)\b/u];

function startsItsLine(sourceCode: SourceCode, comment: Comment): boolean {
	return sourceCode.lines[comment.loc.start.line - 1]!.slice(0, comment.loc.start.column).trim() === "";
}

function singleLineComments(sourceCode: SourceCode): Comment[] {
	const runs: Comment[][] = [];
	for (const comment of sourceCode.getAllComments()) {
		if (comment.type === "Shebang") continue;
		const run = runs.at(-1);
		const last = run?.at(-1);
		const continuesRun =
			comment.type === "Line" &&
			last?.type === "Line" &&
			last.loc.end.line === comment.loc.start.line - 1 &&
			startsItsLine(sourceCode, last) &&
			startsItsLine(sourceCode, comment);
		if (run && continuesRun) run.push(comment);
		else runs.push([comment]);
	}
	return runs.filter((run) => run.length === 1 && run[0]!.loc.start.line === run[0]!.loc.end.line).map((run) => run[0]!);
}

export const noCommentsRule = defineRule({
	meta: {
		type: "problem",
		docs: { description: "Disallow comments." },
		messages: {
			comment:
				"We're not allowing comments in this project. A common failure mode is to write a comment as a way to avoid doing the actual work just because doing the right thing feels hard. Resist this failure mode by doing the work anyway. If your comment tries to describe what the code does, make the code self explanatory instead.",
		},
	},
	createOnce(context) {
		return {
			Program() {
				for (const comment of singleLineComments(context.sourceCode)) {
					if (directives.some((pattern) => pattern.test(comment.value))) continue;
					context.report({ loc: comment.loc, messageId: "comment" });
				}
			},
		};
	},
});
