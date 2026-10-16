#!/usr/bin/env node
// Makes a one-time code that pairs a new device (phone browser, home-screen
// app, the iOS app) with this codex-anywhere server.
//
//   node scripts/pair.mjs --name iphone [--minutes 10] [--url https://your-server:8200]
//
// Open the server's URL on the device and enter the code. Each code works
// once, for one device. It also comes in a long form that is never
// rate-limited (paste it if someone floods the pairing page with wrong
// codes). With --url, both are also printed as links that pair on open.
// `node scripts/devices.mjs` lists and revokes devices.
import { parseArgs } from "node:util";
import { loadDeviceAuth } from "./lib/device-auth.mjs";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    minutes: { type: "string" },
    url: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.name) {
  console.log("usage: node scripts/pair.mjs --name <device name> [--minutes 10] [--url <server url>]");
  process.exit(values.help ? 0 : 64);
}
const minutes = Number(values.minutes ?? 10);
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
  console.error("--minutes must be between 1 and 60");
  process.exit(64);
}

const { DeviceStore } = loadDeviceAuth();
const store = new DeviceStore();
try {
  const { code, longCode, name, expiresAt } = store.createPairingCode(values.name, minutes * 60_000);
  console.log(`Pairing code for "${name}": ${code}`);
  console.log(`Long form (same code, never rate-limited): ${longCode}`);
  console.log(`Works once, until ${new Date(expiresAt).toLocaleTimeString()} (${minutes} min).`);
  console.log("On the device, open the codex-anywhere URL and enter the code.");
  if (values.url) {
    const base = new URL("/__auth/pair", values.url);
    console.log(`Link: ${base.href}#code=${code}`);
    console.log(`Long link: ${base.href}#code=${longCode}`);
  }
} catch (error) {
  console.error(`could not make a pairing code: ${error.message}`);
  process.exit(1);
}
