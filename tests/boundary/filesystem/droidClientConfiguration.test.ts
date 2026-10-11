import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { systemSetupHost } from "../../../src/application/SetupHost.js";
import { MANAGED_SKILL_FILES } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";

const command = npxRegistrationCommand();

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const droidPath = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "droid");

describe("Factory Droid configuration paths", () => {
  it("resolves the user mcp file and marker directory", () => {
    expect(droidPath("/home/a", "linux")).toEqual({
      name: "droid",
      displayName: "Factory Droid",
      configPath: join("/home/a", ".factory", "mcp.json"),
      markerPath: join("/home/a", ".factory"),
      format: "json",
    });
    expect(droidPath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".factory", "mcp.json"),
    );
    expect(droidPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".factory", "mcp.json"),
    );
  });
});

describe("Factory Droid client lifecycle", () => {
  const droidClient = async () => {
    const home = await createTestTempDirectory("rea-droid-");
    const client = droidPath(home, process.platform, {});
    if (client?.markerPath === undefined)
      throw new Error("missing Factory Droid client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("registers rea in mcpServers while preserving unrelated settings and comments", async () => {
    const { home, client } = await droidClient();
    await writeFile(
      client.configPath,
      `{
  // Keep this note.
  "mcpServers": { "other": { "command": "other-server" } }
}
`,
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("// Keep this note.");
    expect(parseJsonc(text)).toEqual({
      mcpServers: {
        other: { command: "other-server" },
        rea: { command: command[0], args: command.slice(1) },
      },
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const removedText = await readFile(client.configPath, "utf8");
    const removed = parseJsonc(removedText);
    expect(removed).toEqual({
      mcpServers: { other: { command: "other-server" } },
    });
    expect(removedText).toContain("// Keep this note.");
  });

  it("reports a package-runner registration as aligned", async () => {
    const { home, client } = await droidClient();
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const entry = resolve("scripts/rea.mjs");
    const status = (
      await readClientRegistrationStatuses(home, entry, { environment: {} })
    ).find(({ client: name }) => name === "droid");
    expect(status).toMatchObject({ state: "aligned" });
  });

  it("reports a disabled registration as stale", async () => {
    const { home, client } = await droidClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: command.slice(1),
            disabled: true,
          },
        },
      }),
    );
    const entry = resolve("scripts/rea.mjs");
    const status = (
      await readClientRegistrationStatuses(home, entry, { environment: {} })
    ).find(({ client: name }) => name === "droid");
    expect(status).toMatchObject({ state: "stale" });
  });
});

describe("Factory Droid profile setup", () => {
  it("installs and removes the personal skill under .factory/skills", async () => {
    const home = await createTestTempDirectory("rea-droid-profile-");
    const profile = join(home, ".factory");
    const environment = {
      HOME: home,
      USERPROFILE: home,
    };
    await mkdir(profile);
    const setup = systemSetupHost(undefined, environment);
    const client = (await setup.detectedClients()).find(
      ({ name }) => name === "droid",
    );
    if (client === undefined) throw new Error("missing Factory Droid client");
    expect(client.configPath).toBe(join(profile, "mcp.json"));
    expect(await setup.configureClient(client, {}, command)).toEqual({
      status: "configured",
    });
    expect(await setup.installSkill([client.name])).toBe("installed");
    const skill = join(home, ".factory", "skills", PRODUCT_IDENTITY.skillName);
    await writeFile(join(skill, "user-notes.txt"), "user-authored");
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toContain(
      "reverse-engineer-anything",
    );
    expect(await setup.clientNeedsConfigure(client, {}, command)).toBe(false);
    expect(await setup.skillNeedsInstall([client.name])).toBe(false);
    expect(await setup.installSkill([client.name])).toBe("unchanged");
    expect(
      (
        await readClientRegistrationStatuses(home, resolve("scripts/rea.mjs"), {
          environment,
        })
      ).find(({ client: name }) => name === "droid"),
    ).toMatchObject({ state: "aligned" });
    const uninstall = systemUninstallHost(home, undefined, environment);
    const registered = (await uninstall.clients()).find(
      ({ name }) => name === "droid",
    );
    expect(registered).toEqual(client);
    expect((await uninstall.removeClient(client)).status).toBe("removed");
    expect((await uninstall.removeSkill()).status).toBe("removed");
    for (const relativePath of MANAGED_SKILL_FILES)
      await expect(access(join(skill, relativePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(await readFile(join(skill, "user-notes.txt"), "utf8")).toBe(
      "user-authored",
    );
    await expect(access(join(home, ".agents", "skills"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });
});
