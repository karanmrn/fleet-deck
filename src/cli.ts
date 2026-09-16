#!/usr/bin/env node
// fleet-deck CLI - scan | serve | export | quota | doctor
import process from "node:process";

const HELP = `fleet-deck - local ledger and dashboard of agents, models, tokens and cost.

Usage:
  fleet-deck scan       Scan local agent logs into the ledger
  fleet-deck serve      Open the dashboard on localhost
  fleet-deck export     Print the ledger (--json | --toon)
  fleet-deck quota      Show provider quota windows (via quota-axi)
  fleet-deck doctor     List which data sources were found
  fleet-deck            Runs scan, then serve
`;

const cmd = process.argv[2] ?? "";

function todo(name: string): void {
  console.log(`fleet-deck ${name}: scaffold ready, implementation coming next.`);
}

switch (cmd) {
  case "scan":
    todo("scan");
    break;
  case "serve":
    todo("serve");
    break;
  case "export":
    todo("export");
    break;
  case "quota":
    todo("quota");
    break;
  case "doctor":
    todo("doctor");
    break;
  case "":
    todo("default (scan + serve)");
    break;
  case "--help":
  case "-h":
    process.stdout.write(HELP);
    break;
  default:
    console.error(`Unknown command: ${cmd}
`);
    process.stdout.write(HELP);
    process.exitCode = 1;
}
