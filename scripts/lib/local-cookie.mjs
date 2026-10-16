// The cookie that lets a local test harness (Playwright against this
// machine's server) through the device gate, from the token that
// `node scripts/devices.mjs local-token` wrote. Empty, with a hint, if none.
import fs from "node:fs";
import { loadDeviceAuth } from "./device-auth.mjs";

export function localDeviceCookies(baseUrl) {
  const { localTokenFile, SECURE_COOKIE, PLAIN_COOKIE } = loadDeviceAuth();
  const file = localTokenFile();
  let token;
  try {
    token = fs.readFileSync(file, "utf8").trim();
  } catch {
    console.warn(`[auth] no ${file}; run \`node scripts/devices.mjs local-token\` or the server will show its pairing page`);
    return [];
  }
  const url = new URL(baseUrl);
  const secure = url.protocol === "https:";
  return [{ name: secure ? SECURE_COOKIE : PLAIN_COOKIE, value: token, url: url.origin, httpOnly: true, secure, sameSite: "Strict" }];
}
