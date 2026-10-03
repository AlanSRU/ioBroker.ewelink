import { expect } from 'chai';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DiyError, diyRequest, parseReply, toInfo, type DiyTarget } from './diy';

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
