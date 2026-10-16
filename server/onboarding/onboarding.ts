import { createSocket } from 'node:dgram';
import type { OnboardingDevice, OnboardingState } from '../../shared/api.js';
import { randomHex } from '../protocol/crypto.js';
import type { ServerApi } from '../net/serverApi.js';
import { log } from '../log.js';
import { sleep } from '../util.js';
import { UserError } from '../vacuum/errors.js';
import {
  RsaKeyPair, VACUUM_PAIRING_HOST, VACUUM_PAIRING_PORT, buildHelloPacket, buildWifiConfigPacket, countryDomainFromIana,
  parseHelloResponse, posixTzFromIana, sanitizeStackServer,
} from './packets.js';

/*
 * Add vacuum, ported from LocalRock's AddVacuumScreen.kt (AddVacuumModel) and VacuumOnboarder.kt.
 * A computer can't join the robot's hotspot on its own the way the phone app does, so the flow is
 * split where the network has to change:
 *   1. prepare: sign in to the server's admin API and start an onboarding session (home network)
 *   2. send:    the user has joined this computer to the robot's Wi-Fi; send hello + Wi-Fi config
 *   3. then the session is polled for ~5 minutes while the user rejoins the home network
 */

const HELLO_TIMEOUT_MS = 5_000;
const WIFI_ACK_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_ATTEMPTS = 60;

function udpExchange(packet: Buffer, waitMs: number, sock = createSocket('udp4')): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(null), waitMs);
    const finish = (v: Buffer | null, err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners('message');
      if (err) reject(err); else resolve(v);
    };
    sock.once('message', (msg) => finish(msg));
    sock.once('error', (e) => finish(null, e));
    sock.send(packet, VACUUM_PAIRING_PORT, VACUUM_PAIRING_HOST, (err) => {
      if (err) finish(null, new UserError(`Could not reach the robot at ${VACUUM_PAIRING_HOST}: ${err.message}. Is this computer connected to the robot's Wi-Fi?`));
    });
  });
}

export class Onboarding {
  private state: OnboardingState = { running: false, step: 'idle', serverStatus: null, result: null, error: null };
  private sessionId: string | null = null;
  private pollToken = 0;

  constructor(
    private readonly api: ServerApi,
    private readonly serverBaseUrl: () => string | null,
    private readonly onChange: () => void,
  ) {}

  current(): OnboardingState {
    return { ...this.state };
  }

  private set(change: Partial<OnboardingState>): void {
    this.state = { ...this.state, ...change };
    this.onChange();
  }

  async listDevices(adminPassword: string): Promise<OnboardingDevice[]> {
    await this.api.adminLogin(adminPassword);
    const list = await this.api.onboardingDevices();
    return list.flatMap((d) => {
      if (typeof d !== 'object' || d === null) return [];
      const o = d as Record<string, unknown>;
      if (typeof o['duid'] !== 'string') return [];
      const info = (o['onboarding'] ?? {}) as Record<string, unknown>;
      const name = typeof o['name'] === 'string' && o['name'].trim() ? o['name'] : o['duid'];
      return [{ duid: o['duid'], name, connected: o['connected'] === true, hasPublicKey: info['has_public_key'] === true }];
    });
  }

  /** Step 1, on the home network: start the server session that recovers the vacuum's key. */
  async prepare(adminPassword: string, duid: string): Promise<void> {
    if (this.state.running) throw new UserError('Pairing is already running');
    this.pollToken++;
    this.set({ running: false, step: 'preparing', serverStatus: null, result: null, error: null });
    try {
      await this.api.adminLogin(adminPassword);
      const session = await this.api.startOnboardingSession(duid);
      const id = session['session_id'];
      if (typeof id !== 'string' || !id) throw new UserError('Server did not return a session id');
      this.sessionId = id;
      this.set({ step: 'prepared' });
    } catch (e) {
      this.set({ step: 'idle', error: (e as Error).message });
      throw e;
    }
  }

  /** Step 2, joined to the robot's hotspot: hello, then the Wi-Fi details. Polling starts after. */
  async send(ssid: string, password: string, timezone: string): Promise<void> {
    if (this.state.running) throw new UserError('Pairing is already running');
    const sessionId = this.sessionId;
    if (!sessionId) throw new UserError('Start the pairing session first');
    const baseUrl = this.serverBaseUrl();
    if (!baseUrl) throw new UserError('Server URL not set');
    this.set({ running: true, step: 'sending-hello', error: null, result: null, serverStatus: null });
    const sock = createSocket('udp4');
    try {
      const keys = RsaKeyPair.generate();
      const helloReply = await udpExchange(buildHelloPacket(keys.publicKeyPem), HELLO_TIMEOUT_MS, sock);
      if (!helloReply) throw new UserError(`The vacuum did not reply to hello within ${HELLO_TIMEOUT_MS / 1000} s. Is this computer connected to the robot's Wi-Fi (roborock-vacuum-...) and is the robot in pairing mode?`);
      const sessionKey = parseHelloResponse(helloReply, keys);
      this.set({ step: 'sending-wifi' });
      const packet = buildWifiConfigPacket(sessionKey, {
        ssid,
        password,
        serverStack: sanitizeStackServer(baseUrl),
        timezone,
        posixTz: posixTzFromIana(timezone),
        countryDomain: countryDomainFromIana(timezone),
        tokenS: `S_TOKEN_${randomHex(16)}`,
        tokenT: `T_TOKEN_${randomHex(16)}`,
      });
      await udpExchange(packet, WIFI_ACK_TIMEOUT_MS, sock);
      this.set({ step: 'waiting', serverStatus: 'Wi-Fi sent. Reconnect this computer to your home network. Waiting for the vacuum to reach the server...' });
    } catch (e) {
      this.set({ running: false, step: 'prepared', error: (e as Error).message });
      throw e instanceof UserError ? e : new UserError((e as Error).message);
    } finally {
      sock.close();
    }
    void this.poll(sessionId);
  }

  cancel(): void {
    this.pollToken++;
    this.set({ running: false, step: this.sessionId ? 'prepared' : 'idle' });
  }

  private async poll(sessionId: string): Promise<void> {
    const token = ++this.pollToken;
    let last: Record<string, unknown> | null = null;
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      if (token !== this.pollToken) return;
      try {
        const snap = await this.api.onboardingSession(sessionId);
        last = snap;
        const samples = typeof snap['query_samples'] === 'number' ? snap['query_samples'] : 0;
        const hasKey = snap['has_public_key'] === true;
        const connected = snap['connected'] === true;
        const keyState = typeof snap['public_key_state'] === 'string' && snap['public_key_state'] ? ` (${snap['public_key_state']})` : '';
        const status = typeof snap['status'] === 'string' && snap['status'] ? ` - ${snap['status']}` : '';
        this.set({ serverStatus: `Samples ${samples} - public key ${hasKey ? 'recovered' : 'pending'}${keyState} - ${connected ? 'connected' : 'waiting'}${status}` });
        if (snap['status'] === 'conflict') {
          this.finish(null, 'The server reported an identity conflict: this vacuum is already registered under different credentials. Remove it on the server, then retry.' + suffix(snap['guidance']));
          return;
        }
        if (snap['complete'] === true || (connected && hasKey)) {
          this.finish('Vacuum connected and its public key was recovered. It should now appear in your device list.', null);
          return;
        }
      } catch (e) {
        // The network is probably still switching back; keep asking.
        log.debug(`Onboarding poll failed: ${(e as Error).message}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (token !== this.pollToken) return;
    const connected = last?.['connected'] === true;
    const hasKey = last?.['has_public_key'] === true;
    const samples = typeof last?.['query_samples'] === 'number' ? last['query_samples'] : 0;
    const guidance = suffix(last?.['guidance']);
    if (connected) {
      this.finish(null, 'The vacuum reached the server, but its public key was never recovered, so it will appear in the list with no data. Factory-reset the vacuum and run Add vacuum again, keeping it next to the dock.' + guidance);
    } else if (hasKey) {
      this.finish("The server has the vacuum's public key, but the vacuum is not connected yet. Run Add vacuum once more to finish." + guidance, null);
    } else if (samples > 0) {
      this.finish('The vacuum reached the server, which does not have its public key yet. That usually takes two or three rounds: run Add vacuum again.' + guidance, null);
    } else {
      this.finish("Wi-Fi was sent, but the vacuum hasn't reported to the server within the wait window. Keep it powered near the dock; it can take a few minutes. If it never shows up, check that the vacuum can reach the server from its network. Some older models also reject the server's certificate without any error and need one from another authority (see the server's tested vacuums list)." + guidance, null);
    }
  }

  private finish(result: string | null, error: string | null): void {
    this.set({ running: false, step: 'done', result, error });
  }
}

function suffix(guidance: unknown): string {
  return typeof guidance === 'string' && guidance.trim() ? ` ${guidance}` : '';
}
