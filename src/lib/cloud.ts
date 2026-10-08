/*
 * The one-off eWeLink cloud part: sign in with OAuth 2.0 and read the user's
 * devices, to learn the device keys that encrypted LAN control needs.
 * Apps created in the eWeLink developer centre may only use OAuth 2.0 (the
 * password login answers error 407), so the user signs in on eWeLink's own page
 * and pastes the address it redirects to; the token is used once and dropped.
 */
import * as crypto from 'node:crypto';

/** API host per region, as reported by the OAuth redirect. */
const API: Record<string, string> = {
    cn: 'https://cn-apia.coolkit.cn',
    as: 'https://as-apia.coolkit.cc',
    us: 'https://us-apia.coolkit.cc',
    eu: 'https://eu-apia.coolkit.cc',
};

const LOGIN_PAGE = 'https://c2ccdn.coolkit.cc/oauth/index.html';

const REQUEST_TIMEOUT_MS = 15_000;

/** The developer-centre app the user signs in through. */
export interface CloudApp {
    /** App ID from the eWeLink developer centre */
    appId: string;
    /** App Secret from the eWeLink developer centre */
    appSecret: string;
    /** must equal the redirect URL registered for the app */
    redirectUrl: string;
}

/**
 * Device types (eWeLink uiid) with one relay that report it as outlet 0 of a
 * multi-channel "switches" list: 77 = Sonoff MICRO.
 */
const SINGLE_RELAY_OUTLET_UIIDS = [77];

/** A device from the user's eWeLink account. */
export interface CloudDevice {
    /** eWeLink device ID */
    deviceId: string;
    /** name given in the eWeLink app */
    name: string;
    /** key for encrypted LAN control */
    deviceKey: string;
    /** whether the device has a single relay, the only kind supported so far */
    singleSwitch: boolean;
}

/** What the redirect after sign-in carries. */
export interface Redirect {
    /** one-time authorisation code */
    code: string;
    /** the account's region: cn, as, us or eu */
    region: string;
    /** the value passed to the sign-in page */
    state: string;
}

function sign(message: string, appSecret: string): string {
    return crypto.createHmac('sha256', appSecret).update(message).digest('base64');
}

/**
 * Build the address of eWeLink's sign-in page.
 *
 * @param app - the developer-centre app
 * @param state - random value, returned in the redirect to tie it to this request
 */
export function loginUrl(app: CloudApp, state: string): string {
    const seq = String(Date.now());
    const params = new URLSearchParams({
        clientId: app.appId,
        redirectUrl: app.redirectUrl,
        grantType: 'authorization_code',
        state,
        nonce: crypto.randomBytes(4).toString('hex'),
        seq,
        authorization: sign(`${app.appId}_${seq}`, app.appSecret),
    });
    return `${LOGIN_PAGE}?${params.toString()}`;
}

/**
 * Read code, region and state from the address the browser was redirected to.
 *
 * @param address - the pasted address
 */
export function parseRedirect(address: string): Redirect {
    let url: URL;
    try {
        url = new URL(address.trim());
    } catch {
        throw new Error('paste the complete address from the browser, starting with http');
    }
    const code = url.searchParams.get('code');
    const region = url.searchParams.get('region');
    const state = url.searchParams.get('state');
    if (!code || !region || !state) {
        throw new Error('the address has no code, region or state — paste the address shown after signing in');
    }
    if (!API[region]) {
        throw new Error(`unknown eWeLink region "${region}"`);
    }
    return { code, region, state };
}

/**
 * Exchange the code for an access token and read the account's devices.
 *
 * @param app - the developer-centre app
 * @param redirect - what the sign-in redirect carried
 */
export async function fetchDevices(app: CloudApp, redirect: Redirect): Promise<CloudDevice[]> {
    const api = API[redirect.region];
    const body = JSON.stringify({ code: redirect.code, redirectUrl: app.redirectUrl, grantType: 'authorization_code' });
    const token = await call(`${api}/v2/user/oauth/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CK-Appid': app.appId,
            Authorization: `Sign ${sign(body, app.appSecret)}`,
        },
        body,
    });
    const accessToken = token.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) {
        throw new Error('eWeLink returned no access token');
    }

    const list = await call(`${api}/v2/device/thing?num=0`, {
        headers: { 'X-CK-Appid': app.appId, Authorization: `Bearer ${accessToken}` },
    });
    return toDevices(list.thingList);
}

/**
 * Pick the devices out of a /v2/device/thing "thingList" (which also holds groups).
 *
 * @param thingList - the list as returned by the API
 */
export function toDevices(thingList: unknown): CloudDevice[] {
    const devices: CloudDevice[] = [];
    for (const thing of Array.isArray(thingList) ? thingList : []) {
        const item = (thing as { itemData?: Record<string, unknown> } | null)?.itemData;
        if (!item || typeof item.deviceid !== 'string' || typeof item.devicekey !== 'string') {
            continue;
        }
        const params = (item.params ?? {}) as Record<string, unknown>;
        const uiid = (item.extra as { uiid?: unknown } | undefined)?.uiid;
        devices.push({
            deviceId: item.deviceid,
            name: typeof item.name === 'string' ? item.name : item.deviceid,
            deviceKey: item.devicekey,
            singleSwitch:
                params.switch === 'on' || params.switch === 'off' || SINGLE_RELAY_OUTLET_UIIDS.includes(uiid as number),
        });
    }
    return devices;
}

/**
 * Send one API request and return its "data", or throw with eWeLink's error.
 *
 * @param url - request URL
 * @param init - fetch options
 */
async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`eWeLink answered HTTP ${res.status}`);
    }
    const reply = (await res.json()) as { error?: number; msg?: string; data?: Record<string, unknown> };
    if (reply.error !== 0) {
        throw new Error(`eWeLink error ${reply.error}: ${reply.msg || 'unknown'}`);
    }
    return reply.data ?? {};
}
