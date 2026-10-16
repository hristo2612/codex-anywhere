#!/usr/bin/env node
// Lists and revokes the devices paired with this codex-anywhere server.
//
//   node scripts/devices.mjs list
//   node scripts/devices.mjs revoke <id or name>
//   node scripts/devices.mjs revoke --all
//   node scripts/devices.mjs local-token [--hours 12]
//
// A running server notices within a second: the device's open sockets close
// and its next request is refused. New devices: scripts/pair.mjs.
//
// local-token pairs a "local-tools" device for test harnesses on this machine
// (test/measure-load.mjs and friends): its token goes to
// ~/.codex-anywhere/local-token (mode 600), never to the terminal, and
// expires after --hours (default 12, at most 168). Running it again replaces
// the previous one; revoke it like any device.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadDeviceAuth } from "./lib/device-auth.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean" },
    hours: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const usage = () =>
  console.log(
    [
      "usage:",
      "  node scripts/devices.mjs list",
      "  node scripts/devices.mjs revoke <id or name>",
      "  node scripts/devices.mjs revoke --all",
      "  node scripts/devices.mjs local-token [--hours 12]",
    ].join("\n"),
  );
const [command, target] = positionals;
if (values.help || !command) {
  usage();
  process.exit(values.help ? 0 : 64);
}

const { DeviceStore, localTokenFile } = loadDeviceAuth();
const store = new DeviceStore();
store.refresh();

try {
  if (command === "list") {
    if (store.error) throw new Error(store.error);
    const seen = store.readSeen();
    const devices = store.devices();
    if (devices.length === 0) console.log("No paired devices.");
    for (const device of devices) {
      const lastSeen = seen[device.id] ? new Date(seen[device.id]).toLocaleString() : "never";
      const expiry = device.expiresAt ? `  expires ${new Date(device.expiresAt).toLocaleString()}` : "";
      console.log(`${device.id}  ${device.name.padEnd(16)}  paired ${new Date(device.createdAt).toLocaleString()}  last seen ${lastSeen}${expiry}`);
      if (device.userAgent) console.log(`${" ".repeat(device.id.length)}  ${device.userAgent}`);
    }
    for (const pending of store.pendingCodes()) {
      console.log(`pending code for "${pending.name}" until ${new Date(pending.expiresAt).toLocaleTimeString()}`);
    }
  } else if (command === "revoke") {
    if (!values.all && !target) {
      usage();
      process.exit(64);
    }
    const revoked = values.all ? store.revokeAll() : store.revoke(target);
    if (revoked.length === 0) {
      console.error(`no device "${target}"; see \`node scripts/devices.mjs list\``);
      process.exit(1);
    }
    for (const device of revoked) console.log(`revoked ${device.id} (${device.name})`);
  } else if (command === "local-token") {
    const name = "local-tools";
    const hours = Number(values.hours ?? 12);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("--hours must be between 0 and 168");
    for (const old of store.devices().filter((device) => device.name === name)) store.revoke(old.id);
    const { token, device } = store.addDevice(name, hours * 3_600_000);
    const file = localTokenFile(store.dir);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    console.log(`paired ${device.id} (${name}) until ${new Date(device.expiresAt).toLocaleString()}; its token is in ${file}`);
  } else {
    usage();
    process.exit(64);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
