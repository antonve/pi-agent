import { describe, expect, it } from "vitest";
import { makeBinaryInitializers } from "./index.ts";
import { resolveBinary, TOOL_SPECS, type BinaryEnv } from "./src/binaries.ts";

describe("Nix-managed binary resolution", () => {
  it("uses a system binary from PATH", async () => {
    const env: BinaryEnv = {
      probe: async (command) => command === "fd",
    };
    await expect(
      resolveBinary(TOOL_SPECS.fd, "", { os: "linux", arch: "x64" }, env),
    ).resolves.toEqual({ tool: "fd", command: "fd", source: "system" });
  });

  it("fails clearly and never downloads", async () => {
    const env: BinaryEnv = { probe: async () => false };
    await expect(
      resolveBinary(TOOL_SPECS.rg, "", { os: "linux", arch: "x64" }, env),
    ).rejects.toThrow("unavailable on PATH");
  });

  it("defers and caches probes until the tool is first used", async () => {
    const probes: string[] = [];
    const env: BinaryEnv = {
      probe: async (command) => {
        probes.push(command);
        return true;
      },
    };
    const initializers = makeBinaryInitializers(
      "",
      { os: "linux", arch: "x64" },
      env,
    );

    expect(probes).toEqual([]);
    await Promise.all([initializers.fd(), initializers.fd()]);
    expect(probes).toEqual(["fd"]);
    expect(probes).not.toContain("rg");
  });
});
