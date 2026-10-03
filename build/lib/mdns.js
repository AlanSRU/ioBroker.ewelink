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
var mdns_exports = {};
__export(mdns_exports, {
  EwelinkBrowser: () => EwelinkBrowser,
  SERVICE: () => SERVICE,
  parseResponse: () => parseResponse
});
module.exports = __toCommonJS(mdns_exports);
var import_multicast_dns = __toESM(require("multicast-dns"));
const SERVICE = "_ewelink._tcp.local";
function parseResponse(packet, rinfo) {
  var _a, _b, _c;
  const records = [...(_a = packet.answers) != null ? _a : [], ...(_b = packet.additionals) != null ? _b : []];
  const addresses = /* @__PURE__ */ new Map();
  const ports = /* @__PURE__ */ new Map();
  for (const r of records) {
    if (r.type === "A") {
      addresses.set(r.name.toLowerCase(), r.data);
    } else if (r.type === "SRV") {
      ports.set(r.name.toLowerCase(), { port: r.data.port, target: r.data.target.toLowerCase() });
    }
  }
  const result = [];
  for (const r of records) {
    if (r.type !== "TXT" || !r.name.toLowerCase().endsWith(`.${SERVICE}`)) {
      continue;
    }
    const txt = parseTxt(r.data);
    const deviceId = txt.id || ((_c = /^ewelink_([^.]+)\./i.exec(r.name)) == null ? void 0 : _c[1]);
    if (!deviceId) {
      continue;
    }
    const srv = ports.get(r.name.toLowerCase());
    const seq = Number(txt.seq);
    result.push({
      deviceId,
      address: srv && addresses.get(srv.target) || rinfo.address,
      port: srv == null ? void 0 : srv.port,
      seq: txt.seq && Number.isInteger(seq) ? seq : void 0,
      encrypted: txt.encrypt === "true",
      iv: txt.iv,
      data: ["data1", "data2", "data3", "data4"].map((k) => {
        var _a2;
        return (_a2 = txt[k]) != null ? _a2 : "";
      }).join("")
    });
  }
  return result;
}
function parseTxt(data) {
  const txt = {};
  for (const entry of Array.isArray(data) ? data : [data]) {
    const text = entry.toString();
    const eq = text.indexOf("=");
    if (eq > 0) {
      txt[text.substring(0, eq)] = text.substring(eq + 1);
    }
  }
  return txt;
}
class EwelinkBrowser {
  /**
   * @param onAnnouncement - called for every device announcement received
   * @param onError - called when the mDNS socket fails
   */
  constructor(onAnnouncement, onError) {
    this.onAnnouncement = onAnnouncement;
    this.onError = onError;
  }
  mdns;
  /** Open the mDNS socket (UDP 5353, shared with other mDNS users on the host). */
  start() {
    const mdns = (0, import_multicast_dns.default)();
    mdns.on("response", (packet, rinfo) => {
      for (const a of parseResponse(packet, rinfo)) {
        this.onAnnouncement(a);
      }
    });
    mdns.on("error", (error) => this.onError(error));
    this.mdns = mdns;
  }
  /** Ask every eWeLink device on the LAN to announce itself. */
  query() {
    var _a;
    (_a = this.mdns) == null ? void 0 : _a.query({ questions: [{ name: SERVICE, type: "PTR" }] });
  }
  /** Close the mDNS socket. */
  close() {
    var _a;
    (_a = this.mdns) == null ? void 0 : _a.destroy();
    this.mdns = void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EwelinkBrowser,
  SERVICE,
  parseResponse
});
//# sourceMappingURL=mdns.js.map
