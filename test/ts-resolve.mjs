// Lets Node run the TypeScript sources directly: relative ".js" imports resolve to the ".ts" file next to it.
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(`${specifier.slice(0, -3)}.ts`, context);
			throw error;
		}
	},
});
