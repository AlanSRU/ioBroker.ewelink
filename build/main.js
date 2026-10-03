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
var utils = __toESM(require("@iobroker/adapter-core"));
var import_diy = require("./lib/diy");
const RESERVED_IDS = ["info"];
const REQUEST_TIMEOUT_MS = 3e3;
const OFFLINE_AFTER = 2;
const STABLE_POLLS = 10;
class Ewelink extends utils.Adapter {
  devices = /* @__PURE__ */ new Map();
  /** ids of disabled devices, whose objects are kept */
  disabledIds = /* @__PURE__ */ new Set();
  /** poll interval in ms */
  pollInterval = 1e4;
  /** set first thing in onUnload, so in-flight work stops writing and re-arming */
  stopped = false;
  constructor(options = {}) {
    super({
      ...options,
      name: "ewelink"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
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
    let stagger = 0;
    for (const d of this.devices.values()) {
      this.schedulePoll(d, stagger);
      stagger += 200;
    }
  }
  /** Turn the configured device table into runtime devices. */
  buildDevices() {
    var _a;
    const rows = (_a = this.config.devices) != null ? _a : [];
    for (const row of rows) {
      const host = (row.host || "").trim();
      if (!host) {
        this.log.warn(`Ignoring device "${row.name || "(unnamed)"}": no IP address configured.`);
        continue;
      }
      const label = (row.name || "").trim() || host;
      const id = this.makeId(label);
      if (row.enabled === false) {
        this.disabledIds.add(id);
        continue;
      }
      const port = Number(row.port);
      this.devices.set(id, {
        id,
        label,
        target: {
          host,
          port: Number.isInteger(port) && port > 0 && port < 65536 ? port : import_diy.DIY_PORT,
          deviceId: (row.deviceId || "").trim(),
          timeoutMs: REQUEST_TIMEOUT_MS
        },
        reachable: false,
        polling: false,
        refreshPending: false,
        failures: 0,
        successes: 0
      });
      this.log.info(
        `Device "${label}" -> ${this.namespace}.${id} (${host}:${this.devices.get(id).target.port})`
      );
    }
  }
  /**
   * Derive a unique object id from a device name. Lower case, so that names
   * differing only in case do not fork into two object trees.
   *
   * @param label - device name or host
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
  }
  /**
   * Poll one device for its switch state and information.
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
      const info = (0, import_diy.toInfo)(await (0, import_diy.diyRequest)(d.target, "info"));
      if (this.stopped) {
        return;
      }
      if (info.deviceid && !d.target.deviceId) {
        d.target.deviceId = info.deviceid;
      }
      const updates = [];
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
      d.failures = 0;
      if (++d.successes >= STABLE_POLLS) {
        d.lastPollError = void 0;
      }
      await this.setReachable(d, true);
    } catch (error) {
      if (this.stopped) {
        return;
      }
      d.successes = 0;
      const confirmed = ++d.failures >= OFFLINE_AFTER || !d.reachable;
      const message = error.message;
      if (confirmed && message !== d.lastPollError) {
        this.log.warn(`[${d.label}] poll failed: ${message}`);
        d.lastPollError = message;
      } else {
        this.log.debug(`[${d.label}] poll failed: ${message}`);
      }
      if (confirmed) {
        await this.setReachable(d, false);
      }
    } finally {
      d.polling = false;
      this.schedulePoll(d, d.refreshPending ? 0 : this.pollInterval);
      d.refreshPending = false;
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
   * Poll a device shortly, e.g. after a command.
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
      await (0, import_diy.diyRequest)(d.target, "switch", { switch: on ? "on" : "off" });
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
    this.refreshSoon(d);
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    this.stopped = true;
    try {
      for (const d of this.devices.values()) {
        if (d.pollTimer) {
          this.clearTimeout(d.pollTimer);
        }
      }
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
