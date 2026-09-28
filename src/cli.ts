#!/usr/bin/env bun

import { connectSwarmForge } from "./cli/client";
import { renderOverview } from "./cli/overview";
import { runDashboard } from "./cli/tui";

const usage = `SwarmForge worker overview

Usage: swarmforge status [--url URL] [--json] [--no-interactive]

Options:
  --url URL          MCP endpoint (default: http://127.0.0.1:8787/mcp)
  --json             Print structured overview JSON and exit
  --no-interactive   Print a snapshot and exit
  --help             Show this help

Set SWARMFORGE_API_TOKEN when the server requires bearer authentication.`;

function argumentsFor(args: string[]) {
  let url = process.env.SWARMFORGE_URL ?? "http://127.0.0.1:8787/mcp";
  let json = false;
  let interactive = true;
  const rest = [...args];
  if (rest[0] === "status") rest.shift();
  if (rest.includes("--help") || rest.includes("-h"))
    return { help: true } as const;
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--json") json = true;
    else if (arg === "--no-interactive") interactive = false;
    else if (arg === "--url") {
      const value = rest.shift();
      if (!value) throw new Error("--url requires an endpoint");
      url = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("MCP endpoint must use http or https");
  if (parsed.pathname === "/") parsed.pathname = "/mcp";
  return { help: false, url: parsed.toString(), json, interactive } as const;
}

export async function runCli(args = process.argv.slice(2)) {
  try {
    const options = argumentsFor(args);
    if (options.help) {
      process.stdout.write(`${usage}\n`);
      return 0;
    }
    const client = await connectSwarmForge(
      options.url,
      process.env.SWARMFORGE_API_TOKEN,
    );
    try {
      const data = await client.overview();
      if (options.json) process.stdout.write(`${JSON.stringify(data)}\n`);
      else if (
        options.interactive &&
        process.stdin.isTTY &&
        process.stdout.isTTY
      )
        await runDashboard(client, data);
      else
        process.stdout.write(
          `${renderOverview(data, { color: false, width: process.stdout.columns || 100 })}\n`,
        );
    } finally {
      await client.close();
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `SwarmForge: ${error instanceof Error ? error.message : "Unexpected error"}\n`,
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli();
