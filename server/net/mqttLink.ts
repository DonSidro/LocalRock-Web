import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import mqtt, { type MqttClient } from 'mqtt';
import type { MqttCreds } from '../protocol/mqttCreds.js';
import { log } from '../log.js';

/*
 * One self-healing MQTT connection to the server's broker, shared by every robot session. Port of
 * LocalRock's MqttClient.kt: it owns reconnecting with backoff (1 s to 30 s), re-subscribes every
 * tracked topic on each new connection, counts subscriptions per topic so two users of the same
 * robot don't unsubscribe each other, and asks for fresh credentials after repeated failures,
 * because the server rejects MQTT logins from sessions it has expired.
 */

export interface LinkParams {
  creds: MqttCreds;
  clientId: string;
  rejectUnauthorized: boolean;
  ca?: Buffer;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const RELOGIN_AFTER_ATTEMPTS = 3;

export class MqttLink extends EventEmitter {
  private client: MqttClient | null = null;
  private params: LinkParams | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private failedAttempts = 0;
  private readonly subscriptions = new Map<string, number>();
  private lastMessageAt = 0;
  private lastError: string | null = null;
  private refreshing = false;

  connected = false;

  /**
   * Called after repeated failed attempts. Returning credentials swaps them in for the next attempt;
   * returning null keeps the current ones.
   */
  credentialRefresher: ((attempt: number, error: string | null) => Promise<MqttCreds | null>) | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  get lastConnectError(): string | null {
    return this.lastError;
  }

  /** Milliseconds since anything was received, or Infinity if nothing ever was. */
  millisSinceLastMessage(): number {
    return this.lastMessageAt === 0 ? Infinity : Date.now() - this.lastMessageAt;
  }

  /** Start connecting (and keep trying) unless already running. Returns at once. */
  start(params: LinkParams): void {
    if (this.running) return;
    this.running = true;
    this.params = params;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.failedAttempts = 0;
    this.connectNow();
  }

  /** End the link for good: it carries the credentials of a session that just ended. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.subscriptions.clear();
    this.dropClient();
    this.setConnected(false);
  }

  /** Try now instead of sitting out the rest of the backoff. Does nothing while connected. */
  retryNow(): void {
    if (!this.running || this.connected || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.connectNow();
  }

  /** Tear the connection down and build a new one, for a link that looks stuck. */
  forceReconnect(): void {
    if (!this.running || !this.connected) return;
    log.info('MQTT forceReconnect: tearing the connection down to reconnect');
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.client?.end(true);
  }

  subscribe(topic: string): void {
    this.subscriptions.set(topic, (this.subscriptions.get(topic) ?? 0) + 1);
    // Sent even when another holder already subscribed: idempotent on the broker, and it repairs
    // a first attempt that failed.
    if (this.connected && this.client) {
      this.client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) log.warn(`MQTT subscribe ${topic} failed (retried on reconnect): ${err.message}`);
      });
    }
  }

  unsubscribe(topic: string): void {
    const holders = this.subscriptions.get(topic);
    if (holders === undefined) return;
    if (holders > 1) {
      this.subscriptions.set(topic, holders - 1);
      return;
    }
    this.subscriptions.delete(topic);
    if (this.connected && this.client) this.client.unsubscribe(topic);
  }

  publish(topic: string, payload: Buffer): void {
    const c = this.client;
    if (!c || !this.connected) throw new Error('MQTT not connected (reconnecting)');
    c.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) log.warn(`MQTT publish to ${topic} failed: ${err.message}`);
    });
  }

  private connectNow(): void {
    this.timer = null;
    const p = this.params;
    if (!this.running || !p) return;
    this.dropClient();
    const { host, port, tls, username, password } = p.creds;
    const url = `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`;
    log.info(`MQTT connecting to ${host}:${port} tls=${tls}`);
    let everConnected = false;
    const client = mqtt.connect(url, {
      clientId: p.clientId,
      username,
      password,
      protocolVersion: 4,
      clean: true,
      keepalive: 30,
      connectTimeout: 15_000,
      // This class owns reconnecting, so it can swap in fresh credentials.
      reconnectPeriod: 0,
      rejectUnauthorized: p.rejectUnauthorized,
      ...(p.ca ? { ca: p.ca } : {}),
      // Name the server in the TLS handshake so a reverse proxy can pick its certificate.
      ...(tls && isIP(host) === 0 ? { servername: host } : {}),
    });
    this.client = client;

    client.on('connect', () => {
      if (this.client !== client) return;
      everConnected = true;
      this.failedAttempts = 0;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.lastError = null;
      log.info(`MQTT connected to ${host}:${port}`);
      for (const topic of this.subscriptions.keys()) {
        client.subscribe(topic, { qos: 1 }, (err) => {
          if (err) log.warn(`MQTT resubscribe ${topic} failed: ${err.message}`);
        });
      }
      this.setConnected(true);
    });

    client.on('message', (topic, payload) => {
      if (this.client !== client) return;
      this.lastMessageAt = Date.now();
      this.emit('message', topic, payload);
    });

    client.on('error', (err) => {
      if (this.client !== client) return;
      this.lastError = err.message;
      log.warn(`MQTT error: ${err.message}`);
    });

    client.on('close', () => {
      if (this.client !== client) return;
      this.client = null;
      client.removeAllListeners();
      client.on('error', () => undefined);
      client.end(true);
      this.setConnected(false);
      if (!this.running) return;
      if (everConnected) {
        log.info('MQTT disconnected, reconnecting');
      } else {
        this.failedAttempts++;
        log.warn(`MQTT connect attempt ${this.failedAttempts} failed: ${this.lastError ?? 'connection closed'}`);
      }
      void this.scheduleReconnect();
    });
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.failedAttempts >= RELOGIN_AFTER_ATTEMPTS && this.credentialRefresher && !this.refreshing) {
      this.refreshing = true;
      try {
        const fresh = await this.credentialRefresher(this.failedAttempts, this.lastError);
        if (fresh && this.params) {
          log.info('MQTT credentials refreshed');
          this.params = { ...this.params, creds: fresh };
          // The wait keeps growing: an unreachable broker must not cause a sign-in every few seconds.
          this.failedAttempts = 0;
        }
      } catch (e) {
        log.warn(`MQTT credential refresh failed: ${(e as Error).message}`);
      } finally {
        this.refreshing = false;
      }
    }
    if (!this.running || this.timer || this.client) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.timer = setTimeout(() => this.connectNow(), wait);
  }

  private dropClient(): void {
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners();
      c.on('error', () => undefined);
      c.end(true);
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.emit('connected', value);
  }
}
