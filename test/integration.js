const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');
const { DiySimulator } = require('./lib/simulator');

const NS = 'ewelink.0';

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Against a simulated switch in encrypted LAN control mode', getHarness => {
            const KEY = '6d2c6b1a-0f3e-4b7a-9c55-1f2e3d4c5b6a';
            let harness;
            let sim;

            const getState = id =>
                new Promise((resolve, reject) =>
                    harness.states.getState(`${NS}.${id}`, (err, state) => (err ? reject(err) : resolve(state))),
                );
            const setState = (id, val) =>
                new Promise((resolve, reject) =>
                    harness.states.setState(`${NS}.${id}`, { val, ack: false }, err => (err ? reject(err) : resolve())),
                );
            const waitFor = async (id, predicate, timeoutMs = 15000) => {
                const end = Date.now() + timeoutMs;
                let state;
                while (Date.now() < end) {
                    state = await getState(id);
                    if (state && state.ack && predicate(state.val)) {
                        return state.val;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error(`${id} is ${JSON.stringify(state && state.val)} after ${timeoutMs} ms`);
            };

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                sim = new DiySimulator({ deviceId: '100118cdd1', deviceKey: KEY });
                await sim.listen();
                await harness.changeAdapterConfig('ewelink', {
                    native: {
                        // no IP address: it is learned from the mDNS announcement
                        devices: [{ enabled: true, name: 'Desk USB', host: '', port: 8081, deviceId: '100118cdd1' }],
                        deviceKeys: JSON.stringify({ '100118cdd1': KEY }),
                        pollInterval: 5,
                    },
                });
                await harness.startAdapterAndWait(true);
            });

            after(async () => {
                await sim?.close();
            });

            it('finds the device over mDNS and reads its encrypted state', async function () {
                this.timeout(20000);
                expect(await waitFor('desk_usb.info.reachable', v => v === true)).to.equal(true);
                expect(await waitFor('desk_usb.control.power', v => v === false)).to.equal(false);
                expect((await getState('desk_usb.info.deviceId')).val).to.equal('100118cdd1');
            });

            it('switches with encrypted commands', async function () {
                this.timeout(20000);
                await setState('desk_usb.control.power', true);
                await waitFor('desk_usb.control.power', v => v === true);
                expect(sim.state.switch).to.equal('on');
                const command = sim.requests.filter(r => r.path === '/zeroconf/switch').pop();
                expect(command.body).to.include({ deviceid: '100118cdd1', encrypt: true });
                expect(command.body.decrypted).to.deep.equal({ switch: 'on' });
            });

            it('applies a state change the device announces', async function () {
                this.timeout(20000);
                sim.state.switch = 'off';
                sim.announce();
                expect(await waitFor('desk_usb.control.power', v => v === false)).to.equal(false);
            });
        });

        suite('Against a simulated DIY mode switch', getHarness => {
            let harness;
            let sim;
            let legacy;

            const getState = id =>
                new Promise((resolve, reject) =>
                    harness.states.getState(`${NS}.${id}`, (err, state) => (err ? reject(err) : resolve(state))),
                );
            const getObject = id =>
                new Promise((resolve, reject) =>
                    harness.objects.getObject(`${NS}.${id}`, (err, obj) => (err ? reject(err) : resolve(obj))),
                );
            const setState = (id, val) =>
                new Promise((resolve, reject) =>
                    harness.states.setState(`${NS}.${id}`, { val, ack: false }, err => (err ? reject(err) : resolve())),
                );
            /** Wait until a state has been acknowledged with the expected value. */
            const waitFor = async (id, predicate, timeoutMs = 10000) => {
                const end = Date.now() + timeoutMs;
                let state;
                while (Date.now() < end) {
                    state = await getState(id);
                    if (state && state.ack && predicate(state.val)) {
                        return state.val;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error(`${id} is ${JSON.stringify(state && state.val)} after ${timeoutMs} ms`);
            };

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                sim = new DiySimulator();
                legacy = new DiySimulator({ deviceId: '1000legacy', legacy: true });
                const port = await sim.listen();
                const legacyPort = await legacy.listen();
                await harness.changeAdapterConfig('ewelink', {
                    native: {
                        devices: [
                            // the device ID is learned from the device
                            { enabled: true, name: 'Hall Lights', host: '127.0.0.1', port, deviceId: '' },
                            { enabled: true, name: 'Old Plug', host: '127.0.0.1', port: legacyPort, deviceId: '' },
                            { enabled: false, name: 'Spare', host: '127.0.0.2', deviceId: '' },
                        ],
                        pollInterval: 5,
                    },
                });
                await harness.startAdapterAndWait(true);
            });

            after(async () => {
                await sim?.close();
                await legacy?.close();
            });

            it('reads the device and builds the object tree', async function () {
                this.timeout(20000);
                expect(await waitFor('hall_lights.info.reachable', v => v === true)).to.equal(true);
                expect(await waitFor('info.connection', v => v === true)).to.equal(true);
                expect(await waitFor('hall_lights.info.firmware', v => !!v)).to.equal('3.6.0');
                expect(await waitFor('hall_lights.info.deviceId', v => !!v)).to.equal('1000abcdef');
                expect(await waitFor('hall_lights.info.signalStrength', v => v === -58)).to.equal(-58);
                expect(await waitFor('hall_lights.control.power', v => v === false)).to.equal(false);
                expect((await getObject('hall_lights')).type).to.equal('device');
                expect((await getObject('hall_lights.info')).type).to.equal('channel');
                expect((await getObject('hall_lights.control.power')).common.role).to.equal('switch.power');
                // disabled rows get no objects until enabled
                expect(await getObject('spare')).to.equal(null);
            });

            it('reads firmware 3.3 replies (data as a string)', async function () {
                this.timeout(20000);
                expect(await waitFor('old_plug.info.reachable', v => v === true)).to.equal(true);
                expect(await waitFor('old_plug.info.deviceId', v => !!v)).to.equal('1000legacy');
            });

            it('switches on and off, using the learned device ID', async function () {
                this.timeout(20000);
                await setState('hall_lights.control.power', true);
                await waitFor('hall_lights.control.power', v => v === true);
                expect(sim.state.switch).to.equal('on');
                const command = sim.requests.filter(r => r.path === '/zeroconf/switch').pop();
                expect(command.body).to.deep.equal({ deviceid: '1000abcdef', data: { switch: 'on' } });

                await setState('hall_lights.control.power', false);
                await waitFor('hall_lights.control.power', v => v === false);
                expect(sim.state.switch).to.equal('off');
            });

            it('picks up a change made at the device', async function () {
                this.timeout(20000);
                sim.state.switch = 'on';
                expect(await waitFor('hall_lights.control.power', v => v === true)).to.equal(true);
            });

            it('marks a device unreachable after it stops answering', async function () {
                this.timeout(30000);
                await sim.close();
                sim = undefined;
                expect(await waitFor('hall_lights.info.reachable', v => v === false, 20000)).to.equal(false);
                // the other device still answers
                expect((await getState('info.connection')).val).to.equal(true);
            });
        });
    },
});
