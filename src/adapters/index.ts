import type { Adapter } from "../types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { primeAdapter } from "./prime.js";
import { noMistakesAdapter } from "./no-mistakes.js";
import { gnhfAdapter } from "./gnhf.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { openrouterAdapter } from "./openrouter.js";

export const ADAPTERS: Adapter[] = [
  claudeCodeAdapter,
  primeAdapter,
  noMistakesAdapter,
  gnhfAdapter,
  codexAdapter,
  cursorAdapter,
  openrouterAdapter,
];
