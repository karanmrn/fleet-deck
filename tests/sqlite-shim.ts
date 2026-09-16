// Vite's builtin check strips the "node:" prefix and looks up "sqlite" in
// node:module.builtinModules, but Node 26 lists it only as "node:sqlite",
// so the SSR transform fails to resolve it. This shim loads it through
// createRequire with a computed specifier so Vite cannot statically
// resolve it; the native Node runtime satisfies the require at run time.
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const SQLITE_ID = "node:" + "sqlite";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqlite = req(SQLITE_ID) as any;

export const DatabaseSync = sqlite.DatabaseSync;
