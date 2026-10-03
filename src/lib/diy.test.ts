import { expect } from 'chai';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DiyError, decrypt, diyRequest, encrypt, parseReply, toInfo, type DiyTarget } from './diy';

// test vectors made with openssl enc -aes-128-cbc, key = MD5(KEY), iv = 00 01 .. 0f
const KEY = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const IV = 'AAECAwQFBgcICQoLDA0ODw==';

describe('parseReply', () => {
    it('returns the data object of a v2 reply', () => {
        expect(parseReply('{"seq":3,"error":0,"data":{"switch":"on"}}')).to.deep.equal({ switch: 'on' });
    });

    it('decodes the string data of a v1 (firmware 3.3) reply', () => {
        expect(parseReply('{"seq":3,"error":0,"data":"{\\"switch\\":\\"off\\"}"}')).to.deep.equal({ switch: 'off' });
    });

    it('accepts a reply without data', () => {
        expect(parseReply('{"seq":4,"error":0}')).to.deep.equal({});
    });

    it('throws a DiyError for a non-zero error code', () => {
        expect(() => parseReply('{"seq":1,"error":404}'))
            .to.throw(DiyError)
            .with.property('code', 404);
    });

    it('rejects non-JSON and malformed data', () => {
        expect(() => parseReply('<html>')).to.throw('did not answer with JSON');
        expect(() => parseReply('[1]')).to.throw('JSON object');
        expect(() => parseReply('{"error":0,"data":"{broken"}')).to.throw('malformed');
        expect(() => parseReply('{"error":0,"data":[1]}')).to.throw('malformed');
    });
});

describe('encrypt / decrypt', () => {
    it('decrypts data encrypted by openssl', () => {
        expect(decrypt('QGlQlzekK+t5KWyCuciaJg==', IV, KEY)).to.equal('{"switch":"on"}');
    });

    it('strips the 0x02 padding some firmware leaves after the JSON', () => {
        const data = 'MYFRhBcV3cPGENek/6wUal/TcSkYLUytPb4tmtJ9reBG2uQhh3euiQ+gTPudM+15';
        expect(decrypt(data, IV, KEY)).to.equal('{"switch":"off","startup":"stay"}');
    });

    it('round-trips with a fresh IV each time', () => {
        const a = encrypt({ switch: 'on' }, KEY);
        const b = encrypt({ switch: 'on' }, KEY);
        expect(a.iv).to.not.equal(b.iv);
        expect(JSON.parse(decrypt(a.data, a.iv, KEY))).to.deep.equal({ switch: 'on' });
    });

    it('reports a wrong key', () => {
        expect(() => decrypt('QGlQlzekK+t5KWyCuciaJg==', IV, 'wrong')).to.throw('device key');
    });
});

describe('parseReply with encrypted data', () => {
    it('decrypts the data of an encrypted reply', () => {
        const reply = JSON.stringify({ seq: 5, error: 0, encrypt: true, iv: IV, data: 'QGlQlzekK+t5KWyCuciaJg==' });
        expect(parseReply(reply, KEY)).to.deep.equal({ switch: 'on' });
    });

    it('asks for a device key when there is none', () => {
        const reply = JSON.stringify({ seq: 5, error: 0, iv: IV, data: 'QGlQlzekK+t5KWyCuciaJg==' });
        expect(() => parseReply(reply)).to.throw('no device key');
    });

    it('accepts an encrypted command reply without data', () => {
        expect(parseReply('{"seq":6,"sequence":"1","error":0}', KEY)).to.deep.equal({});
    });
});

describe('toInfo', () => {
    it('keeps the fields of the right type', () => {
        expect(
            toInfo({ switch: 'on', fwVersion: '3.6.0', deviceid: '1000abcdef', signalStrength: -61, ssid: 'x' }),
        ).to.deep.equal({ switch: 'on', fwVersion: '3.6.0', deviceid: '1000abcdef', signalStrength: -61 });
    });

    it('drops values that are missing or of the wrong type, so they never become real values', () => {
        expect(toInfo({ switch: '', fwVersion: 3, deviceid: '', signalStrength: '-61' })).to.deep.equal({});
        expect(toInfo({ switch: 'stay', signalStrength: NaN })).to.deep.equal({});
    });

    it('keeps a genuine zero signal strength', () => {
        expect(toInfo({ signalStrength: 0 })).to.deep.equal({ signalStrength: 0 });
    });
});

describe('diyRequest', () => {
    let server: http.Server;
    let target: DiyTarget;
    let handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

    beforeEach(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', () => handler(req, body, res));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        target = {
            host: '127.0.0.1',
            port: (server.address() as AddressInfo).port,
            deviceId: '1000abcdef',
            timeoutMs: 300,
        };
    });

    afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('posts the command with the device ID and returns the data', async () => {
        let seen: { url?: string; method?: string; body?: unknown } = {};
        handler = (req, body, res) => {
            seen = { url: req.url, method: req.method, body: JSON.parse(body) };
            res.end('{"seq":1,"error":0,"data":{"switch":"on"}}');
        };
        const data = await diyRequest(target, 'switch', { switch: 'on' });
        expect(data).to.deep.equal({ switch: 'on' });
        expect(seen).to.deep.equal({
            url: '/zeroconf/switch',
            method: 'POST',
            body: { deviceid: '1000abcdef', data: { switch: 'on' } },
        });
    });

    it('sends an encrypted command when the device has a key', async () => {
        let body: Record<string, unknown> = {};
        handler = (_req, text, res) => {
            body = JSON.parse(text);
            res.end(JSON.stringify({ seq: 2, sequence: body.sequence, error: 0 }));
        };
        await diyRequest({ ...target, deviceKey: KEY }, 'switch', { switch: 'off' });
        expect(body).to.include({ deviceid: '1000abcdef', selfApikey: '123', encrypt: true });
        expect(body.sequence).to.match(/^\d+$/);
        expect(JSON.parse(decrypt(body.data as string, body.iv as string, KEY))).to.deep.equal({ switch: 'off' });
    });

    it('rejects with the DIY error code', async () => {
        handler = (_req, _body, res) => res.end('{"seq":1,"error":401}');
        await expect(diyRequest(target, 'info')).to.be.rejectedWith(DiyError, 'DIY error 401');
    });

    it('rejects on an HTTP error status', async () => {
        handler = (_req, _body, res) => {
            res.statusCode = 500;
            res.end();
        };
        await expect(diyRequest(target, 'info')).to.be.rejectedWith('HTTP 500');
    });

    it('rejects when the device does not answer in time', async () => {
        handler = () => undefined; // never answers
        await expect(diyRequest(target, 'info')).to.be.rejectedWith('no answer within 300 ms');
    });

    it('rejects when nothing listens', async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        server = http.createServer(); // so afterEach can close something
        server.listen(0, '127.0.0.1');
        await expect(diyRequest(target, 'info')).to.be.rejected;
    });
});
