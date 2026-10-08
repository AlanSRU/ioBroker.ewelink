"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var crypto = __toESM(require("node:crypto"));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_cloud = require("./lib/cloud");
var import_diy = require("./lib/diy");
var import_mdns = require("./lib/mdns");
const RESERVED_IDS = ["info"];
const REQUEST_TIMEOUT_MS = 3e3;
const OFFLINE_AFTER = 2;
const STABLE_POLLS = 10;
const SIGN_IN_VALID_MS = 15 * 6e4;
class Ewelink extends utils.Adapter {
  devices = /* @__PURE__ */ new Map();
  /** ids of disabled devices, whose objects are kept */
  disabledIds = /* @__PURE__ */ new Set();
  /** poll interval in ms */
  pollInterval = 1e4;
  browser;
  mdnsTimer;
  mdnsError;
  startedAt = Date.now();
  /** the eWeLink sign-in in progress */
  signIn;
  /** set first thing in onUnload, so in-flight work stops writing and re-arming */
  stopped = false;
  constructor(options = {}) {
    super({
      ...options,
      name: "ewelink"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    this.buildDevices();
    await this.removeStaleObjects();
    for (const d of this.devices.values()) {
      await this.createObjects(d);
    }
    for (const id of this.disabledIds) {
      if (await this.getObjectAsync(`${id}.info.reachable`)) {
        await this.setState(`${id}.info.reachable`, { val: false, ack: true });
      }
    }
    if (this.stopped) {
      return;
    }
    this.subscribeStates("*.control.power");
    if (!this.devices.size) {
      this.log.warn("No devices configured \u2014 open the instance settings and add at least one.");
      return;
    }
    this.pollInterval = Math.min(3600, Math.max(5, Number(this.config.pollInterval) || 10)) * 1e3;
    this.browser = new import_mdns.EwelinkBrowser(
      (a) => void this.onAnnouncement(a),
      (error) => {
        if (error.message !== this.mdnsError) {
          this.log.warn(`mDNS: ${error.message} \u2014 device state updates and address discovery may not work`);
          this.mdnsError = error.message;
        }
      }
    );
    this.browser.start();
    this.startedAt = Date.now();
    this.mdnsTick();
    let stagger = 0;
    for (const d of this.devices.values()) {
      if (!d.encrypted) {
        this.schedulePoll(d, stagger);
        stagger += 200;
      }
    }
  }
  /** Turn the configured device table into runtime devices. */
  buildDevices() {
    var _a;
    const keys = this.deviceKeys();
    const rows = (_a = this.config.devices) != null ? _a : [];
    for (const row of rows) {
      const host = (row.host || "").trim();
      const deviceId = (row.deviceId || "").trim();
      if (!host && !deviceId) {
        this.log.warn(`Ignoring device "${row.name || "(unnamed)"}": it needs an IP address or a device ID.`);
        continue;
      }
      const label = (row.name || "").trim() || host || deviceId;
      const id = this.makeId(label);
      if (row.enabled === false) {
        this.disabledIds.add(id);
        continue;
      }
      const port = Number(row.port);
      const deviceKey = deviceId ? keys[deviceId] : void 0;
      this.devices.set(id, {
        id,
        label,
        target: {
          host,
          port: Number.isInteger(port) && port > 0 && port < 65536 ? port : import_diy.DIY_PORT,
          deviceId,
          deviceKey,
          timeoutMs: REQUEST_TIMEOUT_MS
        },
        encrypted: !!deviceKey,
        outlets: false,
        reachable: false,
        polling: false,
        refreshPending: false,
        lastSeen: 0,
        failures: 0,
        successes: 0
      });
      this.log.info(
        `Device "${label}" -> ${this.namespace}.${id} (${host || "address from mDNS"}, ${deviceKey ? "eWeLink LAN control" : "DIY mode"})`
      );
    }
  }
  /** The device keys fetched from eWeLink, by device ID. */
  deviceKeys() {
    const text = this.config.deviceKeys || "";
    if (!text) {
      return {};
    }
    try {
      const keys = JSON.parse(text);
      if (typeof keys === "object" && keys !== null && !Array.isArray(keys)) {
        return Object.fromEntries(
          Object.entries(keys).filter((e) => typeof e[1] === "string")
        );
      }
    } catch {
    }
    this.log.warn("The stored device keys are unreadable \u2014 fetch the devices from eWeLink again.");
    return {};
  }
  /**
   * Derive a unique object id from a device name. Lower case, so that names
   * differing only in case do not fork into two object trees.
   *
   * @param label - device name, host or device ID
   */
  makeId(label) {
    const base = label.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "device";
    let id = RESERVED_IDS.includes(base) ? `${base}_device` : base;
    for (let suffix = 2; this.devices.has(id) || this.disabledIds.has(id); suffix++) {
      id = `${base}_${suffix}`;
    }
    return id;
  }
  /** Delete device folders of devices that are no longer configured. */
  async removeStaleObjects() {
    for (const obj of await this.getDevicesAsync()) {
      const id = obj._id.substring(this.namespace.length + 1);
      if (!id.includes(".") && !this.devices.has(id) && !this.disabledIds.has(id)) {
        this.log.info(`Removing objects of device "${id}", which is no longer configured.`);
        await this.delObjectAsync(id, { recursive: true });
      }
    }
  }
  /**
   * Create (or update the metadata of) the object tree of one device.
   *
   * @param d - the device
   */
  async createObjects(d) {
    await this.extendObject(d.id, { type: "device", common: { name: d.label }, native: {} });
    await this.extendObject(`${d.id}.info`, { type: "channel", common: { name: "Information" }, native: {} });
    await this.extendObject(`${d.id}.control`, { type: "channel", common: { name: "Control" }, native: {} });
    const states = [
      ["info.reachable", { name: "Device reachable", type: "boolean", role: "indicator.reachable", def: false }],
      ["info.firmware", { name: "Firmware version", type: "string", role: "info.firmware", def: "" }],
      ["info.deviceId", { name: "eWeLink device ID", type: "string", role: "text", def: "" }],
      // no def: 0 dBm would read as a real (perfect) signal before the first poll
      ["info.signalStrength", { name: "WiFi signal strength", type: "number", role: "value", unit: "dBm" }],
      ["control.power", { name: "Power", type: "boolean", role: "switch.power", write: true, def: false }]
    ];
    for (const [id, common] of states) {
      await this.extendObject(`${d.id}.${id}`, {
        type: "state",
        common: { read: true, write: false, ...common },
        native: {}
      });
    }
    if (d.target.deviceId) {
      await this.setState(`${d.id}.info.deviceId`, { val: d.target.deviceId, ack: true });
    }
  }
  /**
   * Write what a device reported to its states.
   *
   * @param d - the device
   * @param info - the reported values
   */
  async applyInfo(d, info) {
    const updates = [];
    if (info.outlets) {
      d.outlets = true;
    }
    if (info.switch) {
      updates.push(["control.power", info.switch === "on"]);
    }
    if (info.fwVersion !== void 0) {
      updates.push(["info.firmware", info.fwVersion]);
    }
    if (info.deviceid) {
      updates.push(["info.deviceId", info.deviceid]);
    }
    if (info.signalStrength !== void 0) {
      updates.push(["info.signalStrength", info.signalStrength]);
    }
    for (const [id, val] of updates) {
      await this.setState(`${d.id}.${id}`, { val, ack: true });
    }
  }
  /**
   * Poll one DIY device for its switch state and information.
   *
   * @param d - the device to poll
   */
  async poll(d) {
    if (d.polling) {
      d.refreshPending = true;
      return;
    }
    d.polling = true;
    try {
      if (!d.target.host) {
        throw new Error("IP address not known yet \u2014 waiting for the device to announce itself over mDNS");
      }
      const info = (0, import_diy.toInfo)(await (0, import_diy.diyRequest)(d.target, "info"));
      if (this.stopped) {
        return;
      }
      if (info.deviceid && !d.target.deviceId) {
        d.target.deviceId = info.deviceid;
      }
      await this.applyInfo(d, info);
      await this.succeeded(d);
    } catch (error) {
      if (this.stopped) {
        return;
      }
      await this.failed(d, `poll failed: ${error.message}`);
    } finally {
      d.polling = false;
      this.schedulePoll(d, d.refreshPending ? 0 : this.pollInterval);
      d.refreshPending = false;
    }
  }
  /**
   * A device answered (DIY poll) or announced itself (encrypted device).
   *
   * @param d - the device
   */
  async succeeded(d) {
    d.failures = 0;
    if (++d.successes >= STABLE_POLLS) {
      d.lastPollError = void 0;
    }
    await this.setReachable(d, true);
  }
  /**
   * A device failed a poll or stayed silent for an interval. It goes offline only
   * after OFFLINE_AFTER failures in a row, as WiFi switches drop the odd request.
   * Warn once per reason, not on every poll.
   *
   * @param d - the device
   * @param message - what went wrong
   */
  async failed(d, message) {
    d.successes = 0;
    const confirmed = ++d.failures >= OFFLINE_AFTER || !d.reachable;
    if (confirmed && message !== d.lastPollError) {
      this.log.warn(`[${d.label}] ${message}`);
      d.lastPollError = message;
    } else {
      this.log.debug(`[${d.label}] ${message}`);
    }
    if (confirmed) {
      await this.setReachable(d, false);
    }
  }
  /**
   * Replace the device's pending poll with one after the given delay.
   *
   * @param d - the device
   * @param delayMs - delay before polling
   */
  schedulePoll(d, delayMs) {
    if (this.stopped) {
      return;
    }
    if (d.pollTimer) {
      this.clearTimeout(d.pollTimer);
    }
    d.pollTimer = this.setTimeout(() => void this.poll(d), delayMs);
  }
  /**
   * Poll a DIY device shortly, e.g. after a command.
   *
   * @param d - the device
   */
  refreshSoon(d) {
    if (d.polling) {
      d.refreshPending = true;
    } else {
      this.schedulePoll(d, 0);
    }
  }
  /**
   * Once per poll interval: ask all devices to announce themselves, and count an
   * encrypted device that has stayed silent for a whole interval as a failure.
   */
  mdnsTick() {
    var _a;
    if (this.stopped) {
      return;
    }
    const now = Date.now();
    for (const d of this.devices.values()) {
      if (d.encrypted && now - (d.lastSeen || this.startedAt) >= this.pollInterval) {
        void this.failed(d, "no mDNS announcement \u2014 is the device online and on the same network?");
      }
    }
    (_a = this.browser) == null ? void 0 : _a.query();
    this.mdnsTimer = this.setTimeout(() => this.mdnsTick(), this.pollInterval);
  }
  /**
   * Apply an mDNS announcement to the device it came from.
   *
   * @param a - the announcement
   */
  async onAnnouncement(a) {
    var _a, _b;
    if (this.stopped) {
      return;
    }
    const d = [...this.devices.values()].find((x) => x.target.deviceId === a.deviceId);
    if (!d) {
      this.log.debug(`mDNS: unconfigured eWeLink device ${a.deviceId} at ${a.address}`);
      return;
    }
    d.lastSeen = Date.now();
    if (a.address !== d.target.host) {
      this.log.info(`[${d.label}] address ${a.address}${d.target.host ? ` (was ${d.target.host})` : ""}`);
      d.target.host = a.address;
    }
    if (a.port) {
      d.target.port = a.port;
    }
    if (a.data && (a.seq === void 0 || a.seq !== d.lastSeq)) {
      try {
        if (a.encrypted && !d.target.deviceKey) {
          throw new Error("the device sends encrypted data \u2014 fetch the devices from eWeLink");
        }
        const text = a.encrypted ? (0, import_diy.decrypt)(a.data, (_a = a.iv) != null ? _a : "", (_b = d.target.deviceKey) != null ? _b : "") : a.data;
        const data = JSON.parse(text);
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          throw new Error("the announcement carries no state");
        }
        await this.applyInfo(d, (0, import_diy.toInfo)(data));
        d.lastSeq = a.seq;
      } catch (error) {
        await this.failed(d, `mDNS announcement unreadable: ${error.message}`);
        return;
      }
    }
    if (d.encrypted && !this.stopped) {
      await this.succeeded(d);
    }
  }
  /**
   * Track the reachability of one device; info.connection of the instance
   * reports whether any device is answering.
   *
   * @param d - the device
   * @param reachable - whether it just answered
   */
  async setReachable(d, reachable) {
    if (d.reachable !== reachable) {
      this.log.info(`[${d.label}] ${reachable ? "reachable" : "not reachable"}`);
    }
    d.reachable = reachable;
    await this.setState(`${d.id}.info.reachable`, { val: reachable, ack: true });
    const any = [...this.devices.values()].some((x) => x.reachable);
    await this.setState("info.connection", { val: any, ack: true });
  }
  /**
   * Is called if a subscribed state changes.
   *
   * @param id - State ID
   * @param state - State object
   */
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const rel = id.substring(`${this.namespace}.`.length);
    const d = this.devices.get(rel.substring(0, rel.indexOf(".")));
    if (!d || rel !== `${d.id}.control.power`) {
      return;
    }
    const on = Boolean(state.val);
    try {
      if (!d.target.host) {
        throw new Error("IP address not known yet \u2014 waiting for the device to announce itself over mDNS");
      }
      const value = on ? "on" : "off";
      await (d.outlets ? (0, import_diy.diyRequest)(d.target, "switches", { switches: [{ switch: value, outlet: 0 }] }) : (0, import_diy.diyRequest)(d.target, "switch", { switch: value }));
      if (this.stopped) {
        return;
      }
      await this.setState(id, { val: on, ack: true });
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.log.warn(`[${d.label}] switching ${on ? "on" : "off"} failed: ${error.message}`);
    }
    if (!d.encrypted) {
      this.refreshSoon(d);
    }
  }
  /**
   * Serve the eWeLink sign-in buttons of the admin UI.
   *
   * @param obj - the incoming message
   */
  async onMessage(obj) {
    var _a;
    if (typeof obj !== "object" || !obj.command) {
      return;
    }
    const reply = (response) => {
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, response, obj.callback);
      }
    };
    try {
      const message = (_a = obj.message) != null ? _a : {};
      const text = (value) => typeof value === "string" ? value.trim() : "";
      const app = {
        appId: text(message.appId),
        appSecret: text(message.appSecret),
        redirectUrl: text(message.redirectUrl)
      };
      if (obj.command === "signIn") {
        reply(this.startSignIn(app));
      } else if (obj.command === "fetchDevices") {
        reply(await this.finishSignIn(app, text(message.address)));
      } else {
        reply({ error: `unknown command "${obj.command}"` });
      }
    } catch (error) {
      this.log.warn(`eWeLink sign-in: ${error.message}`);
      reply({ error: error.message });
    }
  }
  /**
   * Step 1: open eWeLink's sign-in page.
   *
   * @param app - the developer-centre app from the form
   */
  startSignIn(app) {
    if (!app.appId || !app.appSecret || !app.redirectUrl) {
      throw new Error("enter the App ID, App Secret and redirect URL first");
    }
    const state = crypto.randomBytes(8).toString("hex");
    this.signIn = { state, expires: Date.now() + SIGN_IN_VALID_MS };
    this.log.info("eWeLink sign-in started");
    return { openUrl: (0, import_cloud.loginUrl)(app, state), window: "_blank" };
  }
  /**
   * Step 2: take the address eWeLink redirected to, read the account's devices and
   * merge them (and their keys) into the device table, which the admin UI then saves.
   *
   * @param app - the developer-centre app from the form
   * @param address - the pasted redirect address
   */
  async finishSignIn(app, address) {
    var _a;
    const redirect = (0, import_cloud.parseRedirect)(address);
    if (!this.signIn || redirect.state !== this.signIn.state || Date.now() > this.signIn.expires) {
      throw new Error('this address does not belong to the current sign-in \u2014 click "Sign in" again');
    }
    this.signIn = void 0;
    const cloudDevices = await (0, import_cloud.fetchDevices)(app, redirect);
    const rows = [...(_a = this.config.devices) != null ? _a : []];
    const keys = this.deviceKeys();
    let added = 0;
    let updated = 0;
    const skipped = [];
    for (const c of cloudDevices) {
      const row = rows.find((r) => (r.deviceId || "").trim() === c.deviceId);
      if (row) {
        keys[c.deviceId] = c.deviceKey;
        updated++;
      } else if (c.singleSwitch) {
        keys[c.deviceId] = c.deviceKey;
        rows.push({ enabled: true, name: c.name, host: "", port: import_diy.DIY_PORT, deviceId: c.deviceId });
        added++;
      } else {
        skipped.push(c.name);
      }
    }
    const notSupported = skipped.length ? `, not supported yet: ${skipped.join(", ")}` : "";
    const result = `${cloudDevices.length} device(s) in the account: ${added} added, ${updated} key(s) updated${notSupported}`;
    this.log.info(`eWeLink sign-in: ${result}`);
    return {
      native: {
        ...this.config,
        appId: app.appId,
        appSecret: app.appSecret,
        redirectUrl: app.redirectUrl,
        signInAddress: "",
        devices: rows,
        deviceKeys: JSON.stringify(keys)
      },
      saveConfig: true,
      result
    };
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    var _a;
    this.stopped = true;
    try {
      for (const d of this.devices.values()) {
        if (d.pollTimer) {
          this.clearTimeout(d.pollTimer);
        }
      }
      if (this.mdnsTimer) {
        this.clearTimeout(this.mdnsTimer);
      }
      (_a = this.browser) == null ? void 0 : _a.close();
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Ewelink(options);
} else {
  (() => new Ewelink())();
}
//# sourceMappingURL=main.js.map
