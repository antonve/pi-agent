import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { resolveBinary, TOOL_SPECS, type BinaryEnv } from "./src/binaries.ts";

describe("Nix-managed binary resolution", () => {
  it("uses a system binary from PATH", async () => {
    const env: BinaryEnv = {
      probe: (command) => Effect.succeed(command === "fd"),
    };
    await expect(
      Effect.runPromise(
        resolveBinary(TOOL_SPECS.fd, "", { os: "linux", arch: "x64" }, env),
      ),
    ).resolves.toEqual({ tool: "fd", command: "fd", source: "system" });
  });

  it("fails clearly and never downloads", async () => {
    const env: BinaryEnv = { probe: () => Effect.succeed(false) };
    await expect(
      Effect.runPromise(
        resolveBinary(TOOL_SPECS.rg, "", { os: "linux", arch: "x64" }, env),
      ),
    ).rejects.toThrow("unavailable on PATH");
  });
});
