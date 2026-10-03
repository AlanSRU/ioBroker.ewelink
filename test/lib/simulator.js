'use strict';
// A Sonoff device (single relay) for the integration tests: DIY mode, or with a
// deviceKey the encrypted eWeLink LAN control mode, which announces its state over mDNS.
const crypto = require('node:crypto');
const http = require('node:http');
const makeMdns = require('multicast-dns');

function aesKey(deviceKey) {
    return crypto.createHash('md5').update(deviceKey).digest();
}

function encrypt(text, deviceKey) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-128-cbc', aesKey(deviceKey), iv);
    return { iv: iv.toString('base64'), data: Buffer.concat([c.update(text), c.final()]).toString('base64') };
}

function decrypt(data, iv, deviceKey) {
    const d = crypto.createDecipheriv('aes-128-cbc', aesKey(deviceKey), Buffer.from(iv, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

class DiySimulator {
    constructor({ deviceId = '1000abcdef', legacy = false, deviceKey } = {}) {
        this.deviceId = deviceId;
        this.deviceKey = deviceKey;
        this.seq = 0;
        /** firmware 3.3 and older send "data" as a JSON string */
        this.legacy = legacy;
        this.state = { switch: 'off' };
        this.requests = [];
        this.server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', () => this.handle(req, body, res));
        });
    }

    async listen() {
        await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
        this.port = this.server.address().port;
        if (this.deviceKey) {
            // answer the adapter's mDNS queries, as a device does
            this.mdns = makeMdns();
            this.mdns.on('query', query => {
                if (query.questions.some(q => q.name === '_ewelink._tcp.local')) {
                    this.announce();
                }
            });
        }
        return this.port;
    }

    /** Publish the current state over mDNS (devices do this on every change). */
    announce() {
        if (!this.mdns) {
            return;
        }
        const name = `eWeLink_${this.deviceId}._ewelink._tcp.local`;
        const { iv, data } = encrypt(JSON.stringify({ switch: this.state.switch, startup: 'off' }), this.deviceKey);
        this.mdns.respond({
            answers: [
                { type: 'PTR', name: '_ewelink._tcp.local', data: name },
                {
                    type: 'TXT',
                    name,
                    data: [
                        `txtvers=1`,
                        `id=${this.deviceId}`,
                        'type=plug',
                        'apivers=1',
                        `seq=${++this.seq}`,
                        'encrypt=true',
                        `iv=${iv}`,
                        `data1=${data}`,
                    ],
                },
            ],
            additionals: [
                { type: 'SRV', name, data: { port: this.port, target: `eWeLink_${this.deviceId}.local` } },
                { type: 'A', name: `eWeLink_${this.deviceId}.local`, data: '127.0.0.1' },
            ],
        });
    }

    close() {
        this.mdns?.destroy();
        this.mdns = undefined;
        this.server.closeAllConnections();
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    handle(req, body, res) {
        let request;
        try {
            request = JSON.parse(body);
        } catch {
            return this.reply(res, { seq: 1, error: 400 });
        }
        this.requests.push({ path: req.url, body: request });
        if (request.deviceid && request.deviceid !== this.deviceId) {
            return this.reply(res, { seq: 1, error: 404 });
        }
        if (this.deviceKey) {
            return this.handleEncrypted(req, request, res);
        }
        if (req.url === '/zeroconf/info') {
            const data = {
                switch: this.state.switch,
                startup: 'off',
                fwVersion: '3.6.0',
                deviceid: this.deviceId,
                ssid: 'test',
                signalStrength: -58,
            };
            return this.reply(res, { seq: 1, error: 0, data: this.legacy ? JSON.stringify(data) : data });
        }
        if (req.url === '/zeroconf/switch') {
            const value = request.data && request.data.switch;
            if (value !== 'on' && value !== 'off') {
                return this.reply(res, { seq: 1, error: 422 });
            }
            this.state.switch = value;
            return this.reply(res, { seq: 1, error: 0 });
        }
        res.statusCode = 404;
        res.end();
    }

    handleEncrypted(req, request, res) {
        // a device in LAN control mode accepts only encrypted requests (and stays silent otherwise)
        if (!request.encrypt || !request.iv) {
            return;
        }
        let data;
        try {
            data = JSON.parse(decrypt(request.data, request.iv, this.deviceKey));
        } catch {
            return this.reply(res, { seq: this.seq, sequence: request.sequence, error: 400 });
        }
        request.decrypted = data;
        if (req.url === '/zeroconf/switch' && (data.switch === 'on' || data.switch === 'off')) {
            this.state.switch = data.switch;
            this.reply(res, { seq: this.seq, sequence: request.sequence, error: 0 });
            this.announce();
            return;
        }
        this.reply(res, { seq: this.seq, sequence: request.sequence, error: 422 });
    }

    reply(res, json) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(json));
    }
}

module.exports = { DiySimulator };
