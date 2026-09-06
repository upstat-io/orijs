import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const mode of ["clean", "timeout"]) {
  test(`should exit ${mode === "clean" ? "zero" : "nonzero"} when SIGTERM ${mode === "clean" ? "drains" : "times out"}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL("./fixtures/shutdown-process.ts", import.meta.url),
        ),
        mode,
      ],
      {
        env: { PATH: process.env.PATH },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const errors = new Response(child.stderr).text();
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("ready\n");
      reader.releaseLock();
      child.kill("SIGTERM");
      expect(await child.exited).toBe(mode === "clean" ? 0 : 1);
      expect(await errors).not.toContain("Unhandled promise rejection");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await errors;
    }
  });
}
