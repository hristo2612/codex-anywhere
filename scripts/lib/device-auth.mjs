// The CLIs share the server's compiled device store, so both read and write
// devices.json the same way.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function loadDeviceAuth() {
  try {
    return require("../../src/server/device-auth.js");
  } catch (error) {
    console.error(`cannot load src/server/device-auth.js (${error.code ?? error.message}); run \`npm run build:server\` first`);
    process.exit(1);
  }
}
