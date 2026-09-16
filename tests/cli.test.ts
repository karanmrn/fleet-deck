import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length) children.pop()!.kill();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleetdeck-cli-"));
  tmpDirs.push(dir);
  return dir;
}

function cli(args: string[], home: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function get(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/summary", headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await get(port, `127.0.0.1:${port}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start");
}

describe("cli", () => {
  it("scan writes to the --db path", () => {
    const home = tmp();
    const db = join(tmp(), "custom.db");
    const out = cli(["scan", "--db", db], home);
    expect(out.status).toBe(0);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(join(home, ".fleet-deck", "ledger.db"))).toBe(false);
  });

  it("serve reads the --db path and rejects a foreign Host header", async () => {
    const home = tmp();
    const db = join(tmp(), "custom.db");
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--db", db],
      { env: { ...process.env, HOME: home }, stdio: "ignore" },
    );
    children.push(child);
    await waitForServer(port);

    const ok = await get(port, `localhost:${port}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).totals.events).toBe(0);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(join(home, ".fleet-deck", "ledger.db"))).toBe(false);

    const rebound = await get(port, `attacker.example:${port}`);
    expect(rebound.status).toBe(403);
  }, 20_000);
});
