import { expect } from 'chai';
import type { Packet } from 'dns-packet';
import { parseResponse } from './mdns';

const NAME = 'eWeLink_100118cdd1._ewelink._tcp.local';
const SENDER = { address: '192.168.123.200' };

describe('parseResponse', () => {
    it('reads an encrypted announcement with SRV and A records', () => {
        const packet: Packet = {
            type: 'response',
            answers: [
                { type: 'PTR', name: '_ewelink._tcp.local', data: NAME },
                {
                    type: 'TXT',
                    name: NAME,
                    data: [
                        Buffer.from('txtvers=1'),
                        Buffer.from('id=100118cdd1'),
                        Buffer.from('type=plug'),
                        Buffer.from('apivers=1'),
                        Buffer.from('seq=17'),
                        Buffer.from('encrypt=true'),
                        Buffer.from('iv=AAECAwQFBgcICQoLDA0ODw=='),
                        Buffer.from('data1=QGlQlzek'),
                        Buffer.from('data2=K+t5KWyCuciaJg=='),
                    ],
                },
            ],
            additionals: [
                { type: 'SRV', name: NAME, data: { port: 8081, target: 'eWeLink_100118cdd1.local' } },
                { type: 'A', name: 'eWeLink_100118cdd1.local', data: '192.168.123.127' },
            ],
        };
        expect(parseResponse(packet, SENDER)).to.deep.equal([
            {
                deviceId: '100118cdd1',
                address: '192.168.123.127',
                port: 8081,
                seq: 17,
                encrypted: true,
                iv: 'AAECAwQFBgcICQoLDA0ODw==',
                data: 'QGlQlzekK+t5KWyCuciaJg==',
            },
        ]);
    });

    it('falls back to the instance name and the sender address', () => {
        const packet: Packet = {
            type: 'response',
            answers: [{ type: 'TXT', name: NAME, data: ['encrypt=false', 'data1={"switch":"on"}'] }],
        };
        const [a] = parseResponse(packet, SENDER);
        expect(a).to.include({ deviceId: '100118cdd1', address: '192.168.123.200', encrypted: false });
        expect(a.data).to.equal('{"switch":"on"}');
        expect(a.seq).to.equal(undefined);
        expect(a.port).to.equal(undefined);
    });

    it('keeps "=" inside values', () => {
        const packet: Packet = {
            type: 'response',
            answers: [{ type: 'TXT', name: NAME, data: ['id=100118cdd1', 'iv=abc==', 'data1=xyz='] }],
        };
        expect(parseResponse(packet, SENDER)[0]).to.include({ iv: 'abc==', data: 'xyz=' });
    });

    it('ignores other services', () => {
        const packet: Packet = {
            type: 'response',
            answers: [{ type: 'TXT', name: 'printer._ipp._tcp.local', data: ['id=1'] }],
        };
        expect(parseResponse(packet, SENDER)).to.deep.equal([]);
    });
});
