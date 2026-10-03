'use strict';
// A Sonoff DIY mode device (single relay) for the integration tests.
const http = require('node:http');

class DiySimulator {
    constructor({ deviceId = '1000abcdef', legacy = false } = {}) {
        this.deviceId = deviceId;
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

    listen() {
        return new Promise(resolve => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)));
    }

    close() {
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

    reply(res, json) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(json));
    }
}

module.exports = { DiySimulator };
