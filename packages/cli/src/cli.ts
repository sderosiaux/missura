#!/usr/bin/env tsx
import { defaultIo, run } from "./index";

const result = await run(process.argv.slice(2), defaultIo());

if (result.servers === undefined) {
  process.exitCode = result.code;
} else {
  const servers = result.servers;
  const stop = (): void => {
    void servers.close().then(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
