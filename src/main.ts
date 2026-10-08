/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * ioBroker adapter for Sonoff / eWeLink single-channel switches, controlled over
 * the local network (see lib/diy.ts). One instance drives any number of devices,
 * each in its own device folder.
 *
 * Two kinds of device:
 * - DIY mode: plain JSON API, polled over HTTP.
 * - eWeLink LAN control: the same API encrypted with a device key that only the
 *   eWeLink cloud knows (fetched once via OAuth sign-in, lib/cloud.ts). These
 *   devices are not polled; they announce every state change over mDNS
 *   (lib/mdns.ts), and an mDNS query each interval checks that they are alive.
 * All devices also learn their current IP address from their announcements.
 */
import * as crypto from 'node:crypto';
import * as utils from '@iobroker/adapter-core';
import { fetchDevices, loginUrl, parseRedirect, type CloudApp } from './lib/cloud';
import { DIY_PORT, decrypt, diyRequest, toInfo, type DiyInfo, type DiyTarget } from './lib/diy';
import { EwelinkBrowser, type Announcement } from './lib/mdns';

/** Object ids that belong to the instance itself and cannot name a device. */
const RESERVED_IDS = ['info'];

/** HTTP request timeout; below the shortest poll interval, so polls never pile up. */
const REQUEST_TIMEOUT_MS = 3000;

/** Consecutive failed polls (or silent intervals) before a device counts as unreachable. */
const OFFLINE_AFTER = 2;

/** Successful polls in a row after which a repeated poll error is logged as a warning again. */
const STABLE_POLLS = 10;

/** How long a started eWeLink sign-in stays valid. */
const SIGN_IN_VALID_MS = 15 * 60_000;

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
    /** host is '' until configured or learned from an mDNS announcement */
    target: DiyTarget;
    /** has a device key: state comes from mDNS, not from HTTP polls */
    encrypted: boolean;
    /** reports its relay as outlet 0 of "switches"; it ignores the plain "switch" command */
    outlets: boolean;
    reachable: boolean;
    polling: boolean;
    /** a refresh was asked for while a poll was running */
    refreshPending: boolean;
    /** the one pending poll of a DIY device; each poll arms the next when it finishes */
    pollTimer?: ioBroker.Timeout;
    /** time of the last mDNS announcement */
    lastSeen: number;
    /** TXT seq of the last announcement applied */
    lastSeq?: number;
    /** the last failure, so a repeated one is not logged as a warning again */
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
    private browser?: EwelinkBrowser;
    private mdnsTimer?: ioBroker.Timeout;
    private mdnsError?: string;
    private startedAt = Date.now();
    /** the eWeLink sign-in in progress */
    private signIn?: { state: string; expires: number };
    /** set first thing in onUnload, so in-flight work stops writing and re-arming */
    private stopped = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'ewelink',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
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

        this.browser = new EwelinkBrowser(
            a => void this.onAnnouncement(a),
            error => {
                // log a lasting socket problem once, not on every packet
                if (error.message !== this.mdnsError) {
                    this.log.warn(`mDNS: ${error.message} — device state updates and address discovery may not work`);
                    this.mdnsError = error.message;
                }
            },
        );
        this.browser.start();
        this.startedAt = Date.now();
        this.mdnsTick();

        let stagger = 0;
        for (const d of this.devices.values()) {
            if (!d.encrypted) {
                // spread the devices out so they are not polled in one burst
                this.schedulePoll(d, stagger);
                stagger += 200;
            }
        }
    }

    /** Turn the configured device table into runtime devices. */
    private buildDevices(): void {
        const keys = this.deviceKeys();
        const rows = (this.config.devices ?? []) as unknown as DeviceConfig[];
        for (const row of rows) {
            const host = (row.host || '').trim();
            const deviceId = (row.deviceId || '').trim();
            if (!host && !deviceId) {
                this.log.warn(`Ignoring device "${row.name || '(unnamed)'}": it needs an IP address or a device ID.`);
                continue;
            }
            const label = (row.name || '').trim() || host || deviceId;
            const id = this.makeId(label);
            if (row.enabled === false) {
                // keep its objects (and their history/alias settings) for when it is re-enabled
                this.disabledIds.add(id);
                continue;
            }
            const port = Number(row.port);
            const deviceKey = deviceId ? keys[deviceId] : undefined;
            this.devices.set(id, {
                id,
                label,
                target: {
                    host,
                    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DIY_PORT,
                    deviceId,
                    deviceKey,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                },
                encrypted: !!deviceKey,
                outlets: false,
                reachable: false,
                polling: false,
                refreshPending: false,
                lastSeen: 0,
                failures: 0,
                successes: 0,
            });
            this.log.info(
                `Device "${label}" -> ${this.namespace}.${id} (${host || 'address from mDNS'}, ` +
                    `${deviceKey ? 'eWeLink LAN control' : 'DIY mode'})`,
            );
        }
    }

    /** The device keys fetched from eWeLink, by device ID. */
    private deviceKeys(): Record<string, string> {
        const text = this.config.deviceKeys || '';
        if (!text) {
            return {};
        }
        try {
            const keys = JSON.parse(text) as unknown;
            if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
                return Object.fromEntries(
                    Object.entries(keys).filter((e): e is [string, string] => typeof e[1] === 'string'),
                );
            }
        } catch {
            // fall through
        }
        this.log.warn('The stored device keys are unreadable — fetch the devices from eWeLink again.');
        return {};
    }

    /**
     * Derive a unique object id from a device name. Lower case, so that names
     * differing only in case do not fork into two object trees.
     *
     * @param label - device name, host or device ID
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
    private async applyInfo(d: Device, info: DiyInfo): Promise<void> {
        const updates: [string, ioBroker.StateValue][] = [];
        if (info.outlets) {
            d.outlets = true;
        }
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
    }

    /**
     * Poll one DIY device for its switch state and information.
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
            if (!d.target.host) {
                throw new Error('IP address not known yet — waiting for the device to announce itself over mDNS');
            }
            const info = toInfo(await diyRequest(d.target, 'info'));
            if (this.stopped) {
                return;
            }
            if (info.deviceid && !d.target.deviceId) {
                // some firmware insists on the ID in commands; use the one the device reports
                d.target.deviceId = info.deviceid;
            }
            await this.applyInfo(d, info);
            await this.succeeded(d);
        } catch (error) {
            if (this.stopped) {
                return;
            }
            await this.failed(d, `poll failed: ${(error as Error).message}`);
        } finally {
            d.polling = false;
            // re-arm only now, so a slow poll can never overlap the next one
            this.schedulePoll(d, d.refreshPending ? 0 : this.pollInterval);
            d.refreshPending = false;
        }
    }

    /**
     * A device answered (DIY poll) or announced itself (encrypted device).
     *
     * @param d - the device
     */
    private async succeeded(d: Device): Promise<void> {
        d.failures = 0;
        if (++d.successes >= STABLE_POLLS) {
            d.lastPollError = undefined;
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
    private async failed(d: Device, message: string): Promise<void> {
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
     * Poll a DIY device shortly, e.g. after a command.
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
     * Once per poll interval: ask all devices to announce themselves, and count an
     * encrypted device that has stayed silent for a whole interval as a failure.
     */
    private mdnsTick(): void {
        if (this.stopped) {
            return;
        }
        const now = Date.now();
        for (const d of this.devices.values()) {
            if (d.encrypted && now - (d.lastSeen || this.startedAt) >= this.pollInterval) {
                void this.failed(d, 'no mDNS announcement — is the device online and on the same network?');
            }
        }
        this.browser?.query();
        this.mdnsTimer = this.setTimeout(() => this.mdnsTick(), this.pollInterval);
    }

    /**
     * Apply an mDNS announcement to the device it came from.
     *
     * @param a - the announcement
     */
    private async onAnnouncement(a: Announcement): Promise<void> {
        if (this.stopped) {
            return;
        }
        const d = [...this.devices.values()].find(x => x.target.deviceId === a.deviceId);
        if (!d) {
            this.log.debug(`mDNS: unconfigured eWeLink device ${a.deviceId} at ${a.address}`);
            return;
        }
        d.lastSeen = Date.now();
        if (a.address !== d.target.host) {
            // DHCP may hand out a new address; the announcement is the device itself
            this.log.info(`[${d.label}] address ${a.address}${d.target.host ? ` (was ${d.target.host})` : ''}`);
            d.target.host = a.address;
        }
        if (a.port) {
            d.target.port = a.port;
        }
        // a repeated announcement (same seq) carries nothing new
        if (a.data && (a.seq === undefined || a.seq !== d.lastSeq)) {
            try {
                if (a.encrypted && !d.target.deviceKey) {
                    throw new Error('the device sends encrypted data — fetch the devices from eWeLink');
                }
                const text = a.encrypted ? decrypt(a.data, a.iv ?? '', d.target.deviceKey ?? '') : a.data;
                const data = JSON.parse(text) as unknown;
                if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                    throw new Error('the announcement carries no state');
                }
                await this.applyInfo(d, toInfo(data as Record<string, unknown>));
                d.lastSeq = a.seq;
            } catch (error) {
                await this.failed(d, `mDNS announcement unreadable: ${(error as Error).message}`);
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
            if (!d.target.host) {
                throw new Error('IP address not known yet — waiting for the device to announce itself over mDNS');
            }
            const value = on ? 'on' : 'off';
            await (d.outlets
                ? diyRequest(d.target, 'switches', { switches: [{ switch: value, outlet: 0 }] })
                : diyRequest(d.target, 'switch', { switch: value }));
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
        // read back, so the tree reflects the device rather than the request;
        // an encrypted device announces its new state over mDNS by itself
        if (!d.encrypted) {
            this.refreshSoon(d);
        }
    }

    /**
     * Serve the eWeLink sign-in buttons of the admin UI.
     *
     * @param obj - the incoming message
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (typeof obj !== 'object' || !obj.command) {
            return;
        }
        const reply = (response: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, response as ioBroker.MessagePayload, obj.callback);
            }
        };
        try {
            const message = (obj.message ?? {}) as Record<string, unknown>;
            const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
            const app: CloudApp = {
                appId: text(message.appId),
                appSecret: text(message.appSecret),
                redirectUrl: text(message.redirectUrl),
            };
            if (obj.command === 'signIn') {
                reply(this.startSignIn(app));
            } else if (obj.command === 'fetchDevices') {
                reply(await this.finishSignIn(app, text(message.address)));
            } else {
                reply({ error: `unknown command "${obj.command}"` });
            }
        } catch (error) {
            this.log.warn(`eWeLink sign-in: ${(error as Error).message}`);
            reply({ error: (error as Error).message });
        }
    }

    /**
     * Step 1: open eWeLink's sign-in page.
     *
     * @param app - the developer-centre app from the form
     */
    private startSignIn(app: CloudApp): Record<string, unknown> {
        if (!app.appId || !app.appSecret || !app.redirectUrl) {
            throw new Error('enter the App ID, App Secret and redirect URL first');
        }
        const state = crypto.randomBytes(8).toString('hex');
        this.signIn = { state, expires: Date.now() + SIGN_IN_VALID_MS };
        this.log.info('eWeLink sign-in started');
        return { openUrl: loginUrl(app, state), window: '_blank' };
    }

    /**
     * Step 2: take the address eWeLink redirected to, read the account's devices and
     * merge them (and their keys) into the device table, which the admin UI then saves.
     *
     * @param app - the developer-centre app from the form
     * @param address - the pasted redirect address
     */
    private async finishSignIn(app: CloudApp, address: string): Promise<Record<string, unknown>> {
        const redirect = parseRedirect(address);
        if (!this.signIn || redirect.state !== this.signIn.state || Date.now() > this.signIn.expires) {
            throw new Error('this address does not belong to the current sign-in — click "Sign in" again');
        }
        this.signIn = undefined;
        const cloudDevices = await fetchDevices(app, redirect);

        const rows = [...((this.config.devices ?? []) as unknown as DeviceConfig[])];
        const keys = this.deviceKeys();
        let added = 0;
        let updated = 0;
        const skipped: string[] = [];
        for (const c of cloudDevices) {
            const row = rows.find(r => (r.deviceId || '').trim() === c.deviceId);
            if (row) {
                keys[c.deviceId] = c.deviceKey;
                updated++;
            } else if (c.singleSwitch) {
                keys[c.deviceId] = c.deviceKey;
                rows.push({ enabled: true, name: c.name, host: '', port: DIY_PORT, deviceId: c.deviceId });
                added++;
            } else {
                skipped.push(c.name);
            }
        }
        const notSupported = skipped.length ? `, not supported yet: ${skipped.join(', ')}` : '';
        const result = `${cloudDevices.length} device(s) in the account: ${added} added, ${updated} key(s) updated${notSupported}`;
        this.log.info(`eWeLink sign-in: ${result}`);
        return {
            native: {
                ...this.config,
                appId: app.appId,
                appSecret: app.appSecret,
                redirectUrl: app.redirectUrl,
                signInAddress: '',
                devices: rows,
                deviceKeys: JSON.stringify(keys),
            },
            saveConfig: true,
            result,
        };
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
            if (this.mdnsTimer) {
                this.clearTimeout(this.mdnsTimer);
            }
            this.browser?.close();
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
