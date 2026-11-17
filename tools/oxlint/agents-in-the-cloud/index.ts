import { eslintCompatPlugin } from "@oxlint/plugins";

import { noCommentsRule } from "./rules/no-comments.ts";
import { noDockerExecRule } from "./rules/no-docker-exec.ts";

/** Rules specific to AgentsInTheCloud's architecture. */
const agentsInTheCloudPlugin = eslintCompatPlugin({
	meta: { name: "agents-in-the-cloud" },
	rules: {
		"no-comments": noCommentsRule,
		"no-docker-exec": noDockerExecRule,
	},
});

export default agentsInTheCloudPlugin;
