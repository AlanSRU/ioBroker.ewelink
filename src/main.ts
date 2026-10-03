/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * ioBroker adapter for Sonoff / eWeLink single-channel switches in DIY mode,
 * controlled over the local network only (see lib/diy.ts). One instance drives
 * any number of devices, each in its own device folder, each polled on its own.
 */
import * as utils from '@iobroker/adapter-core';
import { DIY_PORT, diyRequest, toInfo, type DiyTarget } from './lib/diy';

/** Object ids that belong to the instance itself and cannot name a device. */
const RESERVED_IDS = ['info'];

/** HTTP request timeout; below the shortest poll interval, so polls never pile up. */
const REQUEST_TIMEOUT_MS = 3000;

/** Consecutive failed polls before a device that was answering counts as unreachable. */
const OFFLINE_AFTER = 2;

/** Successful polls in a row after which a repeated poll error is logged as a warning again. */
const STABLE_POLLS = 10;

/** One row of the device table in the instance configuration. */
interface DeviceConfig {
    enabled?: boolean;
    name?: string;
    host?: string;
    port?: number;
    deviceId?: string;
}

/** A configured switch and its runtime state. */
interface Device {
    /** object-tree id, e.g. "hall_lights" */
    id: string;
    label: string;
    target: DiyTarget;
    reachable: boolean;
    polling: boolean;
    /** a refresh was asked for while a poll was running */
    refreshPending: boolean;
    /** the one pending poll; each poll arms the next when it finishes */
    pollTimer?: ioBroker.Timeout;
    /** the last poll failure, so a repeated one is not logged as a warning again */
    lastPollError?: string;
    failures: number;
    successes: number;
}

class Ewelink extends utils.Adapter {
    private devices = new Map<string, Device>();
    /** ids of disabled devices, whose objects are kept */
    private disabledIds = new Set<string>();
    /** poll interval in ms */
    private pollInterval = 10_000;
    /** set first thing in onUnload, so in-flight work stops writing and re-arming */
    private stopped = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'ewelink',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        this.buildDevices();
        await this.removeStaleObjects();
        for (const d of this.devices.values()) {
            await this.createObjects(d);
        }
        for (const id of this.disabledIds) {
            // not polled while disabled, so do not leave it looking reachable
            if (await this.getObjectAsync(`${id}.info.reachable`)) {
                await this.setState(`${id}.info.reachable`, { val: false, ack: true });
            }
        }
        if (this.stopped) {
            return;
        }
        this.subscribeStates('*.control.power');

        if (!this.devices.size) {
            this.log.warn('No devices configured — open the instance settings and add at least one.');
            return;
        }
        this.pollInterval = Math.min(3600, Math.max(5, Number(this.config.pollInterval) || 10)) * 1000;
        let stagger = 0;
        for (const d of this.devices.values()) {
            // spread the devices out so they are not polled in one burst
            this.schedulePoll(d, stagger);
            stagger += 200;
        }
    }

    /** Turn the configured device table into runtime devices. */
    private buildDevices(): void {
        const rows = (this.config.devices ?? []) as unknown as DeviceConfig[];
        for (const row of rows) {
            const host = (row.host || '').trim();
            if (!host) {
                this.log.warn(`Ignoring device "${row.name || '(unnamed)'}": no IP address configured.`);
                continue;
            }
            const label = (row.name || '').trim() || host;
            const id = this.makeId(label);
            if (row.enabled === false) {
                // keep its objects (and their history/alias settings) for when it is re-enabled
                this.disabledIds.add(id);
                continue;
            }
            const port = Number(row.port);
            this.devices.set(id, {
                id,
                label,
                target: {
                    host,
                    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DIY_PORT,
                    deviceId: (row.deviceId || '').trim(),
                    timeoutMs: REQUEST_TIMEOUT_MS,
                },
                reachable: false,
                polling: false,
                refreshPending: false,
                failures: 0,
                successes: 0,
            });
            this.log.info(
                `Device "${label}" -> ${this.namespace}.${id} (${host}:${this.devices.get(id)!.target.port})`,
            );
        }
    }

    /**
     * Derive a unique object id from a device name. Lower case, so that names
     * differing only in case do not fork into two object trees.
     *
     * @param label - device name or host
     */
    private makeId(label: string): string {
        const base =
            label
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, '_')
                .replace(/^_+|_+$/g, '') || 'device';
        let id = RESERVED_IDS.includes(base) ? `${base}_device` : base;
        for (let suffix = 2; this.devices.has(id) || this.disabledIds.has(id); suffix++) {
            id = `${base}_${suffix}`;
        }
        return id;
    }

    /** Delete device folders of devices that are no longer configured. */
    private async removeStaleObjects(): Promise<void> {
        for (const obj of await this.getDevicesAsync()) {
            const id = obj._id.substring(this.namespace.length + 1);
            if (!id.includes('.') && !this.devices.has(id) && !this.disabledIds.has(id)) {
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
    private async createObjects(d: Device): Promise<void> {
        await this.extendObject(d.id, { type: 'device', common: { name: d.label }, native: {} });
        await this.extendObject(`${d.id}.info`, { type: 'channel', common: { name: 'Information' }, native: {} });
        await this.extendObject(`${d.id}.control`, { type: 'channel', common: { name: 'Control' }, native: {} });

        const states: [string, Partial<ioBroker.StateCommon>][] = [
            ['info.reachable', { name: 'Device reachable', type: 'boolean', role: 'indicator.reachable', def: false }],
            ['info.firmware', { name: 'Firmware version', type: 'string', role: 'info.firmware', def: '' }],
            ['info.deviceId', { name: 'eWeLink device ID', type: 'string', role: 'text', def: '' }],
            // no def: 0 dBm would read as a real (perfect) signal before the first poll
            ['info.signalStrength', { name: 'WiFi signal strength', type: 'number', role: 'value', unit: 'dBm' }],
            ['control.power', { name: 'Power', type: 'boolean', role: 'switch.power', write: true, def: false }],
        ];
        for (const [id, common] of states) {
            await this.extendObject(`${d.id}.${id}`, {
                type: 'state',
                common: { read: true, write: false, ...common } as ioBroker.StateCommon,
                native: {},
            });
        }
    }

    /**
     * Poll one device for its switch state and information.
     *
     * @param d - the device to poll
     */
    private async poll(d: Device): Promise<void> {
        if (d.polling) {
            d.refreshPending = true;
            return;
        }
        d.polling = true;
        try {
            const info = toInfo(await diyRequest(d.target, 'info'));
            if (this.stopped) {
                return;
            }
            if (info.deviceid && !d.target.deviceId) {
                // some firmware insists on the ID in commands; use the one the device reports
                d.target.deviceId = info.deviceid;
            }
            const updates: [string, ioBroker.StateValue][] = [];
            if (info.switch) {
                updates.push(['control.power', info.switch === 'on']);
            }
            if (info.fwVersion !== undefined) {
                updates.push(['info.firmware', info.fwVersion]);
            }
            if (info.deviceid) {
                updates.push(['info.deviceId', info.deviceid]);
            }
            if (info.signalStrength !== undefined) {
                updates.push(['info.signalStrength', info.signalStrength]);
            }
            for (const [id, val] of updates) {
                await this.setState(`${d.id}.${id}`, { val, ack: true });
            }
            d.failures = 0;
            if (++d.successes >= STABLE_POLLS) {
                d.lastPollError = undefined;
            }
            await this.setReachable(d, true);
        } catch (error) {
            if (this.stopped) {
                return;
            }
            // A device that was answering goes offline only after OFFLINE_AFTER failures in a row;
            // WiFi switches drop the odd request. Warn once per reason, not on every poll.
            d.successes = 0;
            const confirmed = ++d.failures >= OFFLINE_AFTER || !d.reachable;
            const message = (error as Error).message;
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
            // re-arm only now, so a slow poll can never overlap the next one
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
    private schedulePoll(d: Device, delayMs: number): void {
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
    private refreshSoon(d: Device): void {
        if (d.polling) {
            d.refreshPending = true; // the running poll schedules it when it finishes
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
    private async setReachable(d: Device, reachable: boolean): Promise<void> {
        if (d.reachable !== reachable) {
            this.log.info(`[${d.label}] ${reachable ? 'reachable' : 'not reachable'}`);
        }
        d.reachable = reachable;
        await this.setState(`${d.id}.info.reachable`, { val: reachable, ack: true });
        const any = [...this.devices.values()].some(x => x.reachable);
        await this.setState('info.connection', { val: any, ack: true });
    }

    /**
     * Is called if a subscribed state changes.
     *
     * @param id - State ID
     * @param state - State object
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        const rel = id.substring(`${this.namespace}.`.length);
        const d = this.devices.get(rel.substring(0, rel.indexOf('.')));
        if (!d || rel !== `${d.id}.control.power`) {
            return;
        }
        const on = Boolean(state.val);
        try {
            await diyRequest(d.target, 'switch', { switch: on ? 'on' : 'off' });
            if (this.stopped) {
                return;
            }
            await this.setState(id, { val: on, ack: true });
        } catch (error) {
            if (this.stopped) {
                return;
            }
            this.log.warn(`[${d.label}] switching ${on ? 'on' : 'off'} failed: ${(error as Error).message}`);
        }
        // read back, so the tree reflects the device rather than the request
        this.refreshSoon(d);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        this.stopped = true;
        try {
            for (const d of this.devices.values()) {
                if (d.pollTimer) {
                    this.clearTimeout(d.pollTimer);
                }
            }
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Ewelink(options);
} else {
    // otherwise start the instance directly
    (() => new Ewelink())();
}
