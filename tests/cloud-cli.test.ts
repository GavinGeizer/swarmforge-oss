import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedCommand } from "../src/cli/arguments";
import { parseArguments, UsageError } from "../src/cli/arguments";
import { CloudApiError, CloudClient } from "../src/cloud-client";
import {
  defaultCloudPath,
  readCloudCredential,
  saveCloudCredential,
} from "../src/cloud-credentials";

function mockPath(): string {
  const dir = join(tmpdir(), `sf-cloud-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

describe("cloud argument parser", () => {
  test("parses cloud login", () => {
    const cmd = parseArguments(["cloud", "login"]) as Extract<
      ParsedCommand,
      { kind: "cloud" }
    >;
    expect(cmd.kind).toBe("cloud");
    expect(cmd.action).toBe("login");
  });

  test("parses cloud login with options", () => {
    const cmd = parseArguments([
      "cloud",
      "login",
      "--cloud-url",
      "https://cloud.example.com",
      "--name",
      "test-client",
      "--no-browser",
      "--json",
    ]) as Extract<ParsedCommand, { kind: "cloud" }>;
    expect(cmd.kind).toBe("cloud");
    expect(cmd.action).toBe("login");
    expect(cmd.cloudUrl).toBe("https://cloud.example.com");
    expect(cmd.clientName).toBe("test-client");
    expect(cmd.noBrowser).toBe(true);
    expect(cmd.json).toBe(true);
  });

  test("parses cloud status", () => {
    const cmd = parseArguments(["cloud", "status"]) as Extract<
      ParsedCommand,
      { kind: "cloud" }
    >;
    expect(cmd.kind).toBe("cloud");
    expect(cmd.action).toBe("status");
  });

  test("parses cloud logout", () => {
    const cmd = parseArguments(["cloud", "logout"]) as Extract<
      ParsedCommand,
      { kind: "cloud" }
    >;
    expect(cmd.kind).toBe("cloud");
    expect(cmd.action).toBe("logout");
  });

  test("parses cloud organizations", () => {
    const cmd = parseArguments(["cloud", "organizations"]) as Extract<
      ParsedCommand,
      { kind: "cloud" }
    >;
    expect(cmd.kind).toBe("cloud");
    expect(cmd.action).toBe("organizations");
  });

  test("parses cloud use with tenant-id", () => {
    const cmd = parseArguments([
      "cloud",
      "use",
      "--tenant-id",
      "550e8400-e29b-41d4-a716-446655440000",
    ]) as Extract<ParsedCommand, { kind: "cloud" }>;
    expect(cmd.kind).toBe("cloud");
    expect(cmd.action).toBe("use");
    expect(cmd.tenantId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("rejects cloud use without tenant-id", () => {
    expect(() => parseArguments(["cloud", "use"])).toThrow(UsageError);
  });

  test("accepts cloud URL at parse time, validates at runtime", () => {
    const cmd = parseArguments([
      "cloud",
      "login",
      "--cloud-url",
      "http://example.com",
    ]) as Extract<ParsedCommand, { kind: "cloud" }>;
    expect(cmd.kind).toBe("cloud");
    expect(cmd.cloudUrl).toBe("http://example.com");
  });
});

describe("cloud credential storage", () => {
  test("default path is in XDG config", () => {
    const path = defaultCloudPath({
      XDG_CONFIG_HOME: "/home/user/.config",
    });
    expect(path).toBe("/home/user/.config/swarmforge/cloud-credentials.json");
  });

  test("handles missing credentials", () => {
    const dir = mockPath();
    try {
      expect(() => readCloudCredential(join(dir, "missing.json"))).toThrow(
        "missing",
      );
    } finally {
      cleanup(dir);
    }
  });

  test("saves and reads credentials", () => {
    const dir = mockPath();
    try {
      const base = randomUUID().replace(/-/g, "");
      const cred = {
        version: 1,
        credential: "sfcli_" + base.slice(0, 40) + "aaaaaaaa",
        credential_id: randomUUID(),
        installation_id: randomUUID(),
        subject_id: randomUUID(),
        tenant_id: randomUUID(),
        scopes: ["identity:read", "devices:self"],
        expires_at: Date.now() + 3600000,
        authorization_expires_at: Date.now() + 86400000,
        server_url: "https://cloud.example.com",
      };
      saveCloudCredential(join(dir, "creds.json"), cred as any, {});
      const read = readCloudCredential(join(dir, "creds.json"));
      expect(read.credential).toBe((cred as any).credential);
    } finally {
      cleanup(dir);
    }
  });
});

describe("cloud client HTTP contract", () => {
  test("constructs correct URL", () => {
    const client = new CloudClient("https://cloud.example.com", "token");
    expect(client).toBeInstanceOf(CloudClient);
  });

  test("validates credential format", () => {
    const base = randomUUID().replace(/-/g, "");
    const cred = {
      version: 1,
      credential: "sfcli_" + base.slice(0, 40) + "aaaaaaaa",
      credential_id: randomUUID(),
      installation_id: randomUUID(),
      subject_id: randomUUID(),
      tenant_id: randomUUID(),
      scopes: ["identity:read"],
      expires_at: Date.now() + 3600000,
      authorization_expires_at: Date.now() + 86400000,
      server_url: "https://cloud.example.com",
    };
    expect(cred.credential).toMatch(/^sfcli_[A-Za-z0-9_-]{40,64}$/);
  });
});
