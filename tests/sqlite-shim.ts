// Vite's static builtin list does not know node:sqlite (Node 26 exposes it
// only under the prefixed name). This shim loads it through createRequire
// with a non-literal specifier so Vite cannot statically resolve it, and the
// native Node runtime satisfies the require at run time.
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const SQLITE_ID = "node:" + "sqlite";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqlite = req(SQLITE_ID) as any;

export const DatabaseSync = sqlite.DatabaseSync;
