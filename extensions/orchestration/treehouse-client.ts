import type { CliRunner } from "./cli.ts";
import { decodeJson, findString } from "./cli.ts";
import type { LeaseRecord } from "./domain.ts";

export class TreehouseClient {
  private readonly runner: CliRunner;

  constructor(runner: CliRunner) {
    this.runner = runner;
  }

  async repositoryRoot(cwd: string, signal?: AbortSignal) {
    const result = await this.runner.run(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, signal, timeoutMs: 5_000 },
    );
    if (result.code !== 0 || !result.stdout.trim())
      throw new Error(`Treehouse isolation requires a Git repository: ${cwd}`);
    return result.stdout.trim();
  }

  async acquire(
    cwd: string,
    holder: string,
    signal?: AbortSignal,
  ): Promise<LeaseRecord> {
    const repositoryRoot = await this.repositoryRoot(cwd, signal);
    let result = await this.runner.run(
      "treehouse",
      ["get", "--lease", "--json", "--lease-holder", holder],
      { cwd: repositoryRoot, signal, timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      const init = await this.runner.run("treehouse", ["init"], {
        cwd: repositoryRoot,
        signal,
        timeoutMs: 15_000,
      });
      if (init.code !== 0)
        throw new Error(
          `treehouse init failed in ${repositoryRoot}: ${init.stderr || init.stdout}`,
        );
      result = await this.runner.run(
        "treehouse",
        ["get", "--lease", "--json", "--lease-holder", holder],
        { cwd: repositoryRoot, signal, timeoutMs: 30_000 },
      );
    }
    if (result.code !== 0)
      throw new Error(
        `treehouse lease acquisition failed in ${repositoryRoot}: ${result.stderr || result.stdout}`,
      );
    const value = decodeJson(result.stdout, "treehouse get --lease --json");
    const leaseId = findString(value, ["lease_id", "leaseId"]);
    const path = findString(value, ["path"]);
    if (!leaseId || !path)
      throw new Error("Treehouse returned a lease without lease_id/path.");
    return { leaseId, holder, path, repositoryRoot, returnState: "held" };
  }

  async returnLease(lease: LeaseRecord): Promise<LeaseRecord> {
    const result = await this.runner.run(
      "treehouse",
      [
        "return",
        lease.path,
        "--if-lease-id",
        lease.leaseId,
        "--if-lease-holder",
        lease.holder,
      ],
      { cwd: lease.repositoryRoot, timeoutMs: 30_000 },
    );
    if (result.code === 0)
      return { ...lease, returnState: "returned", returnError: undefined };
    const message = (result.stderr || result.stdout).trim();
    const dirty = /dirty|uncommitted|modified|changes/i.test(message);
    return {
      ...lease,
      returnState: dirty ? "dirty" : "error",
      returnError: message || "Treehouse return failed",
    };
  }
}
