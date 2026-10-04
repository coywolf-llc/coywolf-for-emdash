// Test-only resolve hook: source files import "./x.js" (bundler style); under
// `node --test` with type stripping, map those to the sibling .ts file.
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
			throw error;
		}
	},
});
