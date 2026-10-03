/*
 * Listener for the mDNS (DNS-SD) announcements of eWeLink devices.
 *
 * Every device on the LAN publishes the service eWeLink_<deviceid>._ewelink._tcp.local
 * and re-announces it whenever its state changes. The TXT record carries the
 * state: "data1".."data4" (one JSON text split into 249-byte chunks), encrypted
 * with the device key when "encrypt" is "true", with its "iv" alongside.
 */
import type { RemoteInfo } from 'node:dgram';
import makeMdns from 'multicast-dns';
import type { Answer, Packet } from 'dns-packet';

/** The DNS-SD service type of eWeLink devices. */
export const SERVICE = '_ewelink._tcp.local';

/** One device's announcement, taken from an mDNS response. */
export interface Announcement {
    /** eWeLink device ID */
    deviceId: string;
    /** IPv4 address, from the A record or else the packet's sender */
    address: string;
    /** HTTP port from the SRV record, if present */
    port?: number;
    /** TXT "seq", increments on every state change */
    seq?: number;
    /** TXT "encrypt" is "true": data is encrypted with the device key */
    encrypted: boolean;
    /** TXT "iv", for encrypted data */
    iv?: string;
    /** "data1".."data4" joined; empty when the record has none */
    data: string;
}

/**
 * Extract the eWeLink device announcements from an mDNS response packet.
 *
 * @param packet - the decoded mDNS response
 * @param rinfo - sender of the packet
 */
export function parseResponse(packet: Packet, rinfo: Pick<RemoteInfo, 'address'>): Announcement[] {
    const records: Answer[] = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
    const addresses = new Map<string, string>();
    const ports = new Map<string, { port: number; target: string }>();
    for (const r of records) {
        if (r.type === 'A') {
            addresses.set(r.name.toLowerCase(), r.data);
        } else if (r.type === 'SRV') {
            ports.set(r.name.toLowerCase(), { port: r.data.port, target: r.data.target.toLowerCase() });
        }
    }

    const result: Announcement[] = [];
    for (const r of records) {
        if (r.type !== 'TXT' || !r.name.toLowerCase().endsWith(`.${SERVICE}`)) {
            continue;
        }
        const txt = parseTxt(r.data);
        // the TXT "id", else the instance name eWeLink_<deviceid>
        const deviceId = txt.id || /^ewelink_([^.]+)\./i.exec(r.name)?.[1];
        if (!deviceId) {
            continue;
        }
        const srv = ports.get(r.name.toLowerCase());
        const seq = Number(txt.seq);
        result.push({
            deviceId,
            address: (srv && addresses.get(srv.target)) || rinfo.address,
            port: srv?.port,
            seq: txt.seq && Number.isInteger(seq) ? seq : undefined,
            encrypted: txt.encrypt === 'true',
            iv: txt.iv,
            data: ['data1', 'data2', 'data3', 'data4'].map(k => txt[k] ?? '').join(''),
        });
    }
    return result;
}

/**
 * Turn TXT record strings ("key=value") into an object.
 *
 * @param data - the TXT record data
 */
function parseTxt(data: string | Buffer | (string | Buffer)[]): Record<string, string> {
    const txt: Record<string, string> = {};
    for (const entry of Array.isArray(data) ? data : [data]) {
        const text = entry.toString();
        const eq = text.indexOf('=');
        if (eq > 0) {
            txt[text.substring(0, eq)] = text.substring(eq + 1);
        }
    }
    return txt;
}

/** Listens for eWeLink announcements and asks devices to announce themselves. */
export class EwelinkBrowser {
    private mdns?: makeMdns.MulticastDNS;

    /**
     * @param onAnnouncement - called for every device announcement received
     * @param onError - called when the mDNS socket fails
     */
    public constructor(
        private readonly onAnnouncement: (a: Announcement) => void,
        private readonly onError: (error: Error) => void,
    ) {}

    /** Open the mDNS socket (UDP 5353, shared with other mDNS users on the host). */
    public start(): void {
        const mdns = makeMdns();
        mdns.on('response', (packet, rinfo) => {
            for (const a of parseResponse(packet, rinfo)) {
                this.onAnnouncement(a);
            }
        });
        mdns.on('error', (error: Error) => this.onError(error));
        this.mdns = mdns;
    }

    /** Ask every eWeLink device on the LAN to announce itself. */
    public query(): void {
        this.mdns?.query({ questions: [{ name: SERVICE, type: 'PTR' }] });
    }

    /** Close the mDNS socket. */
    public close(): void {
        this.mdns?.destroy();
        this.mdns = undefined;
    }
}
