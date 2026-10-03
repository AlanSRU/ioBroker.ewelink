/*
 * Client for the Sonoff / eWeLink "DIY mode" LAN API: JSON over HTTP POST to
 * port 8081, paths /zeroconf/<command>. Every reply looks like
 * { "seq": 1, "error": 0, "data": {...} }; firmware 3.3 and older send "data"
 * as a JSON-encoded string instead of an object.
 *
 * Devices in the normal eWeLink "LAN control" mode take the same commands,
 * but the "data" of requests (and of replies that carry any) is AES-128-CBC
 * encrypted with the MD5 of the device key, which only the eWeLink cloud knows.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';

/** Default DIY mode HTTP port. */
export const DIY_PORT = 8081;

/** Meaning of the non-zero "error" codes of the DIY API. */
const ERROR_TEXT: Record<number, string> = {
    400: 'the device rejected the request format',
    401: 'unauthorized — the device key is wrong, or the device needs one (fetch the devices from eWeLink)',
    404: 'device ID not recognised — check the device ID in the settings or leave it empty',
    422: 'the device rejected the request parameters',
};

/** A reply whose "error" field was not 0. */
export class DiyError extends Error {
    /**
     * @param code - the reply's "error" field
     */
    public constructor(public readonly code: number) {
        super(`DIY error ${code}: ${ERROR_TEXT[code] ?? 'unknown error'}`);
        this.name = 'DiyError';
    }
}

/** The fields of /zeroconf/info that the adapter uses; all optional, firmware differs. */
export interface DiyInfo {
    /** relay state, "on" or "off" */
    switch?: string;
    /** firmware version */
    fwVersion?: string;
    /** eWeLink device ID */
    deviceid?: string;
    /** WiFi signal strength in dBm */
    signalStrength?: number;
}

/** Where and how to reach one device. */
export interface DiyTarget {
    /** IP address or host name */
    host: string;
    /** HTTP port, DIY_PORT by default */
    port?: number;
    /** device ID; may be empty for a DIY device, the DIY API accepts "" on the LAN */
    deviceId: string;
    /** eWeLink device key; set for devices in encrypted LAN mode, empty for DIY mode */
    deviceKey?: string;
    /** request timeout in ms */
    timeoutMs: number;
}

/**
 * Send one DIY command and return the reply's "data" object.
 *
 * @param target - device address and request timeout
 * @param command - path below /zeroconf/, e.g. "info" or "switch"
 * @param data - command parameters
 */
export function diyRequest(
    target: DiyTarget,
    command: string,
    data: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
    const body = JSON.stringify(
        target.deviceKey
            ? {
                  sequence: String(Date.now()),
                  deviceid: target.deviceId,
                  selfApikey: '123',
                  encrypt: true,
                  ...encrypt(data, target.deviceKey),
              }
            : { deviceid: target.deviceId, data },
    );
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: target.host,
                port: target.port ?? DIY_PORT,
                path: `/zeroconf/${command}`,
                method: 'POST',
                // a fresh connection per request: the ESP web server handles keep-alive badly
                agent: false,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    Connection: 'close',
                },
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(parseReply(Buffer.concat(chunks).toString('utf8'), target.deviceKey));
                    } catch (error) {
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                });
                res.on('error', reject);
            },
        );
        // socket timeout, covers connect and an unanswered request
        req.setTimeout(target.timeoutMs, () => req.destroy(new Error(`no answer within ${target.timeoutMs} ms`)));
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * Parse a reply body into its "data" object.
 *
 * @param text - the HTTP response body
 * @param deviceKey - device key, to decrypt an encrypted reply
 */
export function parseReply(text: string, deviceKey?: string): Record<string, unknown> {
    let reply: unknown;
    try {
        reply = JSON.parse(text);
    } catch {
        throw new Error('the device did not answer with JSON');
    }
    if (!isObject(reply)) {
        throw new Error('the device did not answer with a JSON object');
    }
    const code = Number(reply.error ?? 0);
    if (code !== 0) {
        throw new DiyError(code);
    }
    let data = reply.data ?? {};
    if (typeof data === 'string' && typeof reply.iv === 'string' && data) {
        if (!deviceKey) {
            throw new Error('the device sent encrypted data, but no device key is configured');
        }
        data = decrypt(data, reply.iv, deviceKey);
    }
    if (typeof data === 'string') {
        // firmware 3.3 and older
        try {
            data = data ? JSON.parse(data) : {};
        } catch {
            throw new Error('the device sent malformed data');
        }
    }
    if (!isObject(data)) {
        throw new Error('the device sent malformed data');
    }
    return data;
}

/**
 * Pick the fields the adapter uses from a /zeroconf/info reply, dropping any of the wrong type.
 *
 * @param data - the reply's data object
 */
export function toInfo(data: Record<string, unknown>): DiyInfo {
    const info: DiyInfo = {};
    if (data.switch === 'on' || data.switch === 'off') {
        info.switch = data.switch;
    }
    if (typeof data.fwVersion === 'string') {
        info.fwVersion = data.fwVersion;
    }
    if (typeof data.deviceid === 'string' && data.deviceid) {
        info.deviceid = data.deviceid;
    }
    if (typeof data.signalStrength === 'number' && Number.isFinite(data.signalStrength)) {
        info.signalStrength = data.signalStrength;
    }
    return info;
}

/**
 * Encrypt command parameters for a device in encrypted LAN mode.
 *
 * @param data - command parameters
 * @param deviceKey - eWeLink device key
 */
export function encrypt(data: Record<string, unknown>, deviceKey: string): { iv: string; data: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', aesKey(deviceKey), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), data: encrypted.toString('base64') };
}

/**
 * Decrypt the base64 "data" of an encrypted reply or mDNS announcement to its JSON text.
 *
 * @param data - base64 cipher text
 * @param iv - base64 initialisation vector
 * @param deviceKey - eWeLink device key
 */
export function decrypt(data: string, iv: string, deviceKey: string): string {
    try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey(deviceKey), Buffer.from(iv, 'base64'));
        const text = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
        // some firmware pads with extra 0x02 bytes after the JSON
        let end = text.length;
        while (end > 0 && text.charCodeAt(end - 1) === 2) {
            end--;
        }
        return text.substring(0, end);
    } catch {
        // a wrong key fails the padding check
        throw new Error('cannot decrypt the device data — is the device key right?');
    }
}

function aesKey(deviceKey: string): Buffer {
    return crypto.createHash('md5').update(deviceKey, 'utf8').digest();
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
