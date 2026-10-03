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
var diy_exports = {};
__export(diy_exports, {
  DIY_PORT: () => DIY_PORT,
  DiyError: () => DiyError,
  diyRequest: () => diyRequest,
  parseReply: () => parseReply,
  toInfo: () => toInfo
});
module.exports = __toCommonJS(diy_exports);
var http = __toESM(require("node:http"));
const DIY_PORT = 8081;
const ERROR_TEXT = {
  400: "the device rejected the request format",
  401: "unauthorized \u2014 is the device really in DIY mode (not encrypted LAN mode)?",
  404: "device ID not recognised \u2014 check the device ID in the settings or leave it empty",
  422: "the device rejected the request parameters"
};
class DiyError extends Error {
  /**
   * @param code - the reply's "error" field
   */
  constructor(code) {
    var _a;
    super(`DIY error ${code}: ${(_a = ERROR_TEXT[code]) != null ? _a : "unknown error"}`);
    this.code = code;
    this.name = "DiyError";
  }
}
function diyRequest(target, command, data = {}) {
  const body = JSON.stringify({ deviceid: target.deviceId, data });
  return new Promise((resolve, reject) => {
    var _a;
    const req = http.request(
      {
        host: target.host,
        port: (_a = target.port) != null ? _a : DIY_PORT,
        path: `/zeroconf/${command}`,
        method: "POST",
        // a fresh connection per request: the ESP web server handles keep-alive badly
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close"
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(parseReply(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(target.timeoutMs, () => req.destroy(new Error(`no answer within ${target.timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}
function parseReply(text) {
  var _a, _b;
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new Error("the device did not answer with JSON");
  }
  if (!isObject(reply)) {
    throw new Error("the device did not answer with a JSON object");
  }
  const code = Number((_a = reply.error) != null ? _a : 0);
  if (code !== 0) {
    throw new DiyError(code);
  }
  let data = (_b = reply.data) != null ? _b : {};
  if (typeof data === "string") {
    try {
      data = data ? JSON.parse(data) : {};
    } catch {
      throw new Error("the device sent malformed data");
    }
  }
  if (!isObject(data)) {
    throw new Error("the device sent malformed data");
  }
  return data;
}
function toInfo(data) {
  const info = {};
  if (data.switch === "on" || data.switch === "off") {
    info.switch = data.switch;
  }
  if (typeof data.fwVersion === "string") {
    info.fwVersion = data.fwVersion;
  }
  if (typeof data.deviceid === "string" && data.deviceid) {
    info.deviceid = data.deviceid;
  }
  if (typeof data.signalStrength === "number" && Number.isFinite(data.signalStrength)) {
    info.signalStrength = data.signalStrength;
  }
  return info;
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DIY_PORT,
  DiyError,
  diyRequest,
  parseReply,
  toInfo
});
//# sourceMappingURL=diy.js.map
