"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var cloud_exports = {};
__export(cloud_exports, {
  fetchDevices: () => fetchDevices,
  loginUrl: () => loginUrl,
  parseRedirect: () => parseRedirect,
  toDevices: () => toDevices
});
module.exports = __toCommonJS(cloud_exports);
var crypto = __toESM(require("node:crypto"));
const API = {
  cn: "https://cn-apia.coolkit.cn",
  as: "https://as-apia.coolkit.cc",
  us: "https://us-apia.coolkit.cc",
  eu: "https://eu-apia.coolkit.cc"
};
const LOGIN_PAGE = "https://c2ccdn.coolkit.cc/oauth/index.html";
const REQUEST_TIMEOUT_MS = 15e3;
function sign(message, appSecret) {
  return crypto.createHmac("sha256", appSecret).update(message).digest("base64");
}
function loginUrl(app, state) {
  const seq = String(Date.now());
  const params = new URLSearchParams({
    clientId: app.appId,
    redirectUrl: app.redirectUrl,
    grantType: "authorization_code",
    state,
    nonce: crypto.randomBytes(4).toString("hex"),
    seq,
    authorization: sign(`${app.appId}_${seq}`, app.appSecret)
  });
  return `${LOGIN_PAGE}?${params.toString()}`;
}
function parseRedirect(address) {
  let url;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error("paste the complete address from the browser, starting with http");
  }
  const code = url.searchParams.get("code");
  const region = url.searchParams.get("region");
  const state = url.searchParams.get("state");
  if (!code || !region || !state) {
    throw new Error("the address has no code, region or state \u2014 paste the address shown after signing in");
  }
  if (!API[region]) {
    throw new Error(`unknown eWeLink region "${region}"`);
  }
  return { code, region, state };
}
async function fetchDevices(app, redirect) {
  const api = API[redirect.region];
  const body = JSON.stringify({ code: redirect.code, redirectUrl: app.redirectUrl, grantType: "authorization_code" });
  const token = await call(`${api}/v2/user/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CK-Appid": app.appId,
      Authorization: `Sign ${sign(body, app.appSecret)}`
    },
    body
  });
  const accessToken = token.accessToken;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("eWeLink returned no access token");
  }
  const list = await call(`${api}/v2/device/thing?num=0`, {
    headers: { "X-CK-Appid": app.appId, Authorization: `Bearer ${accessToken}` }
  });
  return toDevices(list.thingList);
}
function toDevices(thingList) {
  var _a;
  const devices = [];
  for (const thing of Array.isArray(thingList) ? thingList : []) {
    const item = thing == null ? void 0 : thing.itemData;
    if (!item || typeof item.deviceid !== "string" || typeof item.devicekey !== "string") {
      continue;
    }
    const params = (_a = item.params) != null ? _a : {};
    devices.push({
      deviceId: item.deviceid,
      name: typeof item.name === "string" ? item.name : item.deviceid,
      deviceKey: item.devicekey,
      singleSwitch: params.switch === "on" || params.switch === "off"
    });
  }
  return devices;
}
async function call(url, init) {
  var _a;
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`eWeLink answered HTTP ${res.status}`);
  }
  const reply = await res.json();
  if (reply.error !== 0) {
    throw new Error(`eWeLink error ${reply.error}: ${reply.msg || "unknown"}`);
  }
  return (_a = reply.data) != null ? _a : {};
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  fetchDevices,
  loginUrl,
  parseRedirect,
  toDevices
});
//# sourceMappingURL=cloud.js.map
