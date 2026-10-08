import { expect } from 'chai';
import * as crypto from 'node:crypto';
import { fetchDevices, loginUrl, parseRedirect, toDevices, type CloudApp } from './cloud';

const APP: CloudApp = { appId: 'myAppId', appSecret: 'mySecret', redirectUrl: 'http://127.0.0.1:8000/callback' };
const hmac = (message: string): string => crypto.createHmac('sha256', APP.appSecret).update(message).digest('base64');

describe('loginUrl', () => {
    it('builds a signed address of the eWeLink sign-in page', () => {
        const url = new URL(loginUrl(APP, 'abc123'));
        expect(`${url.origin}${url.pathname}`).to.equal('https://c2ccdn.coolkit.cc/oauth/index.html');
        const p = url.searchParams;
        expect(p.get('clientId')).to.equal('myAppId');
        expect(p.get('redirectUrl')).to.equal(APP.redirectUrl);
        expect(p.get('grantType')).to.equal('authorization_code');
        expect(p.get('state')).to.equal('abc123');
        expect(p.get('authorization')).to.equal(hmac(`myAppId_${p.get('seq')}`));
    });
});

describe('parseRedirect', () => {
    it('reads code, region and state', () => {
        expect(parseRedirect(' http://127.0.0.1:8000/callback?code=C0DE&region=eu&state=abc123 ')).to.deep.equal({
            code: 'C0DE',
            region: 'eu',
            state: 'abc123',
        });
    });

    it('rejects anything else', () => {
        expect(() => parseRedirect('C0DE')).to.throw('complete address');
        expect(() => parseRedirect('http://127.0.0.1:8000/callback?code=C0DE')).to.throw('no code, region or state');
        expect(() => parseRedirect('http://x/?code=C&region=mars&state=s')).to.throw('unknown eWeLink region');
    });
});

describe('toDevices', () => {
    it('keeps devices with a key, skips groups', () => {
        const list = [
            {
                itemType: 1,
                itemData: { deviceid: '100118cdd1', name: 'Desk USB', devicekey: 'k1', params: { switch: 'off' } },
            },
            {
                itemType: 1,
                itemData: { deviceid: '1000aaaaaa', name: '4CH', devicekey: 'k2', params: { switches: [] } },
            },
            {
                itemType: 1,
                itemData: {
                    deviceid: '1000bbbbbb',
                    name: 'MICRO',
                    devicekey: 'k3',
                    extra: { uiid: 77 },
                    params: { switches: [{ switch: 'off', outlet: 0 }] },
                },
            },
            { itemType: 3, itemData: { id: 'group1', name: 'Group' } },
            null,
        ];
        expect(toDevices(list)).to.deep.equal([
            { deviceId: '100118cdd1', name: 'Desk USB', deviceKey: 'k1', singleSwitch: true },
            { deviceId: '1000aaaaaa', name: '4CH', deviceKey: 'k2', singleSwitch: false },
            { deviceId: '1000bbbbbb', name: 'MICRO', deviceKey: 'k3', singleSwitch: true },
        ]);
        expect(toDevices(undefined)).to.deep.equal([]);
    });
});

describe('fetchDevices', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => (globalThis.fetch = realFetch));

    it('exchanges the code with a signed request, then reads the devices', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        globalThis.fetch = ((url: string, init: RequestInit) => {
            calls.push({ url, init });
            const data = url.includes('/oauth/token')
                ? { accessToken: 'AT', refreshToken: 'RT' }
                : {
                      thingList: [
                          { itemData: { deviceid: 'd1', name: 'One', devicekey: 'k', params: { switch: 'on' } } },
                      ],
                  };
            return Promise.resolve(new Response(JSON.stringify({ error: 0, msg: '', data })));
        }) as typeof fetch;

        const devices = await fetchDevices(APP, { code: 'C0DE', region: 'eu', state: 's' });
        expect(devices).to.deep.equal([{ deviceId: 'd1', name: 'One', deviceKey: 'k', singleSwitch: true }]);

        const [token, list] = calls;
        expect(token.url).to.equal('https://eu-apia.coolkit.cc/v2/user/oauth/token');
        const headers = token.init.headers as Record<string, string>;
        expect(headers['X-CK-Appid']).to.equal('myAppId');
        expect(headers.Authorization).to.equal(`Sign ${hmac(token.init.body as string)}`);
        expect(JSON.parse(token.init.body as string)).to.deep.equal({
            code: 'C0DE',
            redirectUrl: APP.redirectUrl,
            grantType: 'authorization_code',
        });
        expect(list.url).to.equal('https://eu-apia.coolkit.cc/v2/device/thing?num=0');
        expect((list.init.headers as Record<string, string>).Authorization).to.equal('Bearer AT');
    });

    it('reports an eWeLink error', async () => {
        globalThis.fetch = () =>
            Promise.resolve(new Response(JSON.stringify({ error: 407, msg: 'path permission error' })));
        await expect(fetchDevices(APP, { code: 'C', region: 'eu', state: 's' })).to.be.rejectedWith(
            'eWeLink error 407: path permission error',
        );
    });
});
