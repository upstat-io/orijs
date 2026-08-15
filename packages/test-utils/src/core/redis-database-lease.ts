import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface RedisLeaseClient {
  set(key: string, value: string, mode: "NX"): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    numberOfKeys: 1,
    key: string,
    ...args: string[]
  ): Promise<unknown>;
}

const RELEASE_OWNED_LEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const REPLACE_STALE_LEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

export class RedisDatabaseLease {
  private database: number | null = null;
  private readonly token: string;

  constructor(
    private readonly client: RedisLeaseClient,
    owner: string,
    private readonly databaseCount: number,
    private readonly isProcessOwnerAlive: (
      pid: number,
      identity: string,
    ) => boolean = RedisDatabaseLease.isProcessOwnerAlive,
  ) {
    this.token = JSON.stringify({
      owner,
      pid: process.pid,
      identity: RedisDatabaseLease.processIdentity(process.pid),
      nonce: randomUUID(),
    });
  }

  async acquire(): Promise<number> {
    if (this.database !== null) return this.database;

    for (let database = 1; database <= this.databaseCount; database++) {
      const acquired = await this.client.set(
        this.key(database),
        this.token,
        "NX",
      );
      if (acquired === "OK") {
        this.database = database;
        return database;
      }

      const existingToken = await this.client.get(this.key(database));
      if (existingToken && !this.ownerIsAlive(existingToken)) {
        const replaced = await this.client.eval(
          REPLACE_STALE_LEASE,
          1,
          this.key(database),
          existingToken,
          this.token,
        );
        if (replaced === 1) {
          this.database = database;
          return database;
        }
      }
    }

    throw new Error(
      `No isolated Redis test database is available (${this.databaseCount} leased)`,
    );
  }

  async release(): Promise<void> {
    if (this.database === null) return;
    await this.client.eval(
      RELEASE_OWNED_LEASE,
      1,
      this.key(this.database),
      this.token,
    );
    this.database = null;
  }

  private key(database: number): string {
    return `__orijs_test_database_lease__:${database}`;
  }

  private ownerIsAlive(token: string): boolean {
    try {
      const value = JSON.parse(token) as { pid?: unknown; identity?: unknown };
      if (typeof value.pid !== "number") return true;
      if (typeof value.identity !== "string")
        return RedisDatabaseLease.pidExists(value.pid);
      return this.isProcessOwnerAlive(value.pid, value.identity);
    } catch {
      return true;
    }
  }

  private static isProcessOwnerAlive(pid: number, identity: string): boolean {
    try {
      return RedisDatabaseLease.processIdentity(pid) === identity;
    } catch {
      return false;
    }
  }

  private static processIdentity(pid: number): string {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fieldsAfterCommand = stat
        .slice(stat.lastIndexOf(") ") + 2)
        .split(" ");
      const startTime = fieldsAfterCommand[19];
      if (!startTime)
        throw new Error(`Cannot resolve process start identity for PID ${pid}`);
      return `${pid}:linux:${startTime}`;
    }
    if (process.platform === "win32") {
      const startTime = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8" },
      ).trim();
      return `${pid}:windows:${startTime}`;
    }
    const startTime = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    if (!startTime)
      throw new Error(`Cannot resolve process start identity for PID ${pid}`);
    return `${pid}:unix:${startTime}`;
  }

  private static pidExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
