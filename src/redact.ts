// Redaction and safety rules - non-negotiable.
// - never open .env, keys.env, or files matching *secret* or *credential*
// - skip lines containing api_key, Authorization, Bearer, sk-
// - store only numeric fields, model, provider, timestamps, project folder
//   name and file offset; never message content.

const FORBIDDEN_FILE_RE = /(?:^|[/\\])\.env$|(?:^|[/\\])keys\.env$|secret|credential/i;
const FORBIDDEN_LINE_RE = /api[_-]?key|authorization|bearer|sk-[A-Za-z0-9]/i;

/** True when the file must never be opened. */
export function shouldSkipFile(path: string): boolean {
  return FORBIDDEN_FILE_RE.test(path);
}

/** True when the line may carry a secret and must be skipped unread. */
export function shouldSkipLine(line: string): boolean {
  return FORBIDDEN_LINE_RE.test(line);
}

/** Last path segment only, sanitized. Never a full path, never content. */
export function projectFolderName(cwd: string | null | undefined): string | null {
  if (!cwd || typeof cwd !== "string") return null;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  const clean = last.replace(/[^\w. -]/g, "").trim().slice(0, 128);
  return clean || null;
}
