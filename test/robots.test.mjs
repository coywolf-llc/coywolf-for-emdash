// Robots.txt Rules unit tests live next to the module (src/robots/*.test.ts); this pulls them into `node --test test/*.test.mjs`.
import "./ts-resolve.mjs";

await import("../src/robots/rep.test.ts");
await import("../src/robots/rules.test.ts");
