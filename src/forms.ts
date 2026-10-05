/**
 * The EmDash Forms plugin with Coywolf Pack's private form uploads. Not
 * imported directly: privateFormUploads() (from "@coywolf/emdash") points the
 * Forms plugin's descriptor here, and EmDash calls createPlugin() with the
 * Forms options plus the pack's. Needs @emdash-cms/plugin-forms installed.
 */
import { createPlugin as createFormsPlugin } from "@emdash-cms/plugin-forms";

import { WRAP_OPTION, defaultDeps, wrapFormsPlugin, type PrivateFormUploadsOptions } from "./formUploads/wrap.js";

export function createPlugin(options: Record<string, unknown> = {}) {
	const { [WRAP_OPTION]: ours, ...formsOptions } = options;
	return wrapFormsPlugin(createFormsPlugin(formsOptions), defaultDeps((ours ?? {}) as PrivateFormUploadsOptions));
}

export default createPlugin;
