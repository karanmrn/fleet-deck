#!/usr/bin/env node
// fleet-deck CLI - scan | serve | export | quota | doctor
import process from "node:process";
import { homedir } from "node:os";

import { ADAPTERS } from "./adapters/index.js";
import { runScan } from "./scan.js";
import { Ledger, defaultDbPath } from "./ledger.js";
import { exportJson, exportToon } from "./export.js";
import { runQuotaAxi } from "./quota.js";

const HELP = `fleet-deck - local ledger and dashboard of agents, models, tokens and cost.

Usage:
  fleet-deck scan              Scan local agent logs into the ledger
  fleet-deck serve [--port N]  Open the dashboard on localhost (default 4173)
  fleet-deck export [--json|--toon]   Print the ledger for agents
  fleet-deck quota             Show provider quota windows (via quota-axi)
  fleet-deck doctor            List which data sources were found
  fleet-deck                   Runs scan, then serve

Options:
  --json          export as JSON (default)
  --toon          export as TOON (quota-axi house shape)
  --port N        dashboard port (default 4173)
  --db PATH       ledger path (default ~/.fleet-deck/ledger.db)
`;

const args = process.argv.slice(2);
const cmd = args[0] ?? "";

function flagValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

async function cmdScan(): Promise<void> {
  console.log("fleet-deck scan - read-only pass over local sources...\n");
  const report = await runScan({
    adapters: ADAPTERS,
    logger: (m) => console.log(`  ${m}`),
  });
  console.log("");
  for (const s of report.sources) {
    const mark = s.found ? "[ok]" : "[--]";
    console.log(`${mark} ${s.label} - ${s.detail}`);
    if (s.found) {
      console.log(
        `     files: ${s.filesScanned} scanned / ${s.filesSkipped} skipped | events: ${s.eventsSeen} seen, ${s.eventsInserted} new`,
      );
    }
    for (const n of s.notes) console.log(`     note: ${n}`);
  }
  console.log(`\n${report.totalInserted} new events -> ${report.dbPath}`);
}

async function cmdDoctor(): Promise<void> {
  console.log("fleet-deck doctor - data source check:\n");
  const home = homedir();
  for (const a of ADAPTERS) {
    try {
      const s = await a.detect(home);
      console.log(`  [${s.found ? "found  " : "missing"}] ${s.label} (${s.id}, ${s.trust})`);
      console.log(`            ${s.detail}`);
    } catch (err) {
      console.log(`  [error  ] ${a.label} (${a.id}) - ${String(err)}`);
    }
  }
  const quota = await runQuotaAxi(3000);
  console.log(`\n  [${quota.available ? "found  " : "missing"}] quota-axi (provider quota windows)`);
}

async function cmdExport(): Promise<void> {
  const dbPath = flagValue("--db") ?? defaultDbPath();
  const ledger = new Ledger(dbPath);
  try {
    if (hasFlag("--toon")) {
      process.stdout.write(exportToon(ledger) + "\n");
    } else {
      process.stdout.write(exportJson(ledger) + "\n");
    }
  } finally {
    ledger.close();
  }
}

async function cmdQuota(): Promise<void> {
  const q = await runQuotaAxi();
  console.log(q.output);
}

async function cmdServe(): Promise<void> {
  const port = Number(flagValue("--port") ?? 4173) || 4173;
  const { startServer } = await import("./server.js");
  const actual = await startServer({ port });
  console.log(`fleet-deck dashboard: http://localhost:${actual}`);
  console.log("press ctrl+c to stop");
  await new Promise(() => {});
}

switch (cmd) {
  case "scan":
    await cmdScan();
    break;
  case "serve":
    await cmdServe();
    break;
  case "export":
    await cmdExport();
    break;
  case "quota":
    await cmdQuota();
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "":
    await cmdScan();
    console.log("");
    await cmdServe();
    break;
  case "--help":
  case "-h":
    process.stdout.write(HELP);
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    process.stdout.write(HELP);
    process.exitCode = 1;
}
