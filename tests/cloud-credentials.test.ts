import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultCloudPath,
  deleteCloudCredential,
  getCloudCredential,
  getCloudCredentialOpt,
  readCloudCredential,
  resolveCloudPath,
  saveCloudCredential,
} from "../src/cloud-credentials";

function mockPath(): string {
  const dir = join(tmpdir(), `sf-cred-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function createValidCred(): Record<string, unknown> {
  const base = randomUUID().replace(/-/g, "");
  return {
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
}

describe("defaultCloudPath", () => {
  test("uses XDG_CONFIG_HOME when absolute", () => {
    const path = defaultCloudPath({ XDG_CONFIG_HOME: "/home/user/.config" });
    expect(path).toBe("/home/user/.config/swarmforge/cloud-credentials.json");
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME not set", () => {
    const path = defaultCloudPath({});
    expect(path).toMatch(/\.config\/swarmforge\/cloud-credentials\.json$/);
  });
});

describe("resolveCloudPath", () => {
  test("uses provided absolute path", () => {
    const path = resolveCloudPath("/absolute/path.json", {});
    expect(path).toBe("/absolute/path.json");
  });

  test("returns default when no path provided", () => {
    const path = resolveCloudPath(undefined, {
      XDG_CONFIG_HOME: "/home/user/.config",
    });
    expect(path).toBe("/home/user/.config/swarmforge/cloud-credentials.json");
  });
});

describe("readCloudCredential", () => {
  test("throws on missing file", () => {
    const dir = mockPath();
    try {
      expect(() => readCloudCredential(join(dir, "missing.json"))).toThrow(
        /missing|invalid|corrupted/,
      );
    } finally {
      cleanup(dir);
    }
  });

  test("rejects non-JSON content", () => {
    const dir = mockPath();
    try {
      const file = join(dir, "creds.json");
      writeFileSync(file, "not json");
      expect(() => readCloudCredential(file)).toThrow(/invalid|corrupted/);
    } finally {
      cleanup(dir);
    }
  });

  test("rejects missing required fields", () => {
    const dir = mockPath();
    try {
      const file = join(dir, "creds.json");
      writeFileSync(file, JSON.stringify({ version: 1 }));
      expect(() => readCloudCredential(file)).toThrow(/invalid|corrupted/);
    } finally {
      cleanup(dir);
    }
  });
});

describe("saveCloudCredential", () => {
  test("writes with secure permissions", async () => {
    const dir = mockPath();
    try {
      const file = join(dir, "creds.json");
      saveCloudCredential(file, createValidCred() as any, {});
      const { statSync } = await import("node:fs");
      const stat = statSync(file);
      expect(stat.mode & 0o077).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  test("creates directory with secure permissions", async () => {
    const dir = mockPath();
    try {
      const nested = join(dir, "nested", "creds.json");
      saveCloudCredential(nested, createValidCred() as any, {});
      const { statSync } = await import("node:fs");
      const stat = statSync(join(dir, "nested"));
      expect(stat.mode & 0o077).toBe(0);
    } finally {
      cleanup(dir);
    }
  });
});

describe("getCloudCredential", () => {
  test("reads from environment-specified path", () => {
    const dir = mockPath();
    try {
      const file = join(dir, "creds.json");
      const cred = createValidCred();
      saveCloudCredential(file, cred as any, {});
      const result = getCloudCredential({
        SWARMFORGE_CLOUD_CREDENTIALS_PATH: file,
      });
      expect(result.credential).toBe((cred as any).credential);
    } finally {
      cleanup(dir);
    }
  });
});

describe("getCloudCredentialOpt", () => {
  test("returns null when credential missing", () => {
    const result = getCloudCredentialOpt({
      SWARMFORGE_CLOUD_CREDENTIALS_PATH: "/nonexistent/path.json",
    });
    expect(result).toBeNull();
  });

  test("returns credential when present", () => {
    const dir = mockPath();
    try {
      const file = join(dir, "creds.json");
      const cred = createValidCred();
      saveCloudCredential(file, cred as any, {});
      const result = getCloudCredentialOpt({
        SWARMFORGE_CLOUD_CREDENTIALS_PATH: file,
      });
      expect(result).not.toBeNull();
      expect((result as any).credential).toBe((cred as any).credential);
    } finally {
      cleanup(dir);
    }
  });
});

describe("deleteCloudCredential", () => {
  test("silently ignores missing file", () => {
    expect(() =>
      deleteCloudCredential("/nonexistent/path.json", {}),
    ).not.toThrow();
  });
});
