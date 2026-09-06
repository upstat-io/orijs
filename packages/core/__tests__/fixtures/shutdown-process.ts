import { Ori } from "../../src/application";

const app = Ori.create().logger({ level: "error" }).setShutdownTimeout(30);
if (Bun.argv[2] === "timeout")
  app.context.onShutdown(() => new Promise<void>(() => {}));
await app.listen(0);
process.stdout.write("ready\n");
