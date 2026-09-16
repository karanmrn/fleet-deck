// quota-axi passthrough. fleet-deck never reimplements quota logic - it shells
// out to quota-axi when the binary is present and reports honestly when not.

import { execFile } from "node:child_process";

export interface QuotaResult {
  available: boolean;
  output: string;
}

export function runQuotaAxi(timeoutMs = 5000): Promise<QuotaResult> {
  return new Promise((resolve) => {
    execFile(
      "quota-axi",
      [],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            resolve({
              available: false,
              output: "quota-axi not found in PATH - install it to see provider quota windows",
            });
            return;
          }
          resolve({
            available: false,
            output: `quota-axi failed: ${stderr || err.message}`,
          });
          return;
        }
        resolve({ available: true, output: stdout.trim() });
      },
    );
  });
}
