import { randomInt } from 'node:crypto';
import { Protocol, RoborockProtocolError, decodeMessages, encodeMessage } from '../protocol/codec.js';
import {
  DPS_REQUEST, DPS_RESPONSE, decodeDpsPush, decodeResponse, encodeRequest, isProvisionalRetry,
  type V1Response,
} from '../protocol/envelope.js';
import type { JsonValue } from '../protocol/json.js';
import { decodeMapResponse, type MapResponse, type SecurityData } from '../protocol/mapResponse.js';
import type { MqttTopics } from '../protocol/mqttCreds.js';
import type { MqttLink } from '../net/mqttLink.js';
import { log } from '../log.js';
import { RobotSilentError, RobotTimeoutError } from './errors.js';

/*
 * RPC over MQTT with one robot, ported from LocalRock's VacuumSession.kt. Requests go out on
 * rr/m/i/<u>/<user>/<duid>, replies come back on rr/m/o/... and are matched by id. Commands sent
 * with need_retry get a provisional ["retry"] first and the real answer later under the same id.
 */

/** Ids the robot is known to accept (10000..32767). */
export const REQUEST_IDS: [number, number] = [10000, 32767];

const SEQ_MIN = 100000, SEQ_MAX = 999999;
const RANDOM_MIN = 10000, RANDOM_MAX = 99999;

interface PendingRequest {
  method: string;
  resolve: (r: V1Response) => void;
  reject: (e: Error) => void;
  heard: () => void;
}

export interface SendOptions {
  timeoutMs?: number;
  /** The robot must answer within this time, the provisional ["retry"] counts, or RobotSilentError. */
  firstReplyTimeoutMs?: number;
}

/** The params shape a robot takes for the commands sent through sendDataCommand. */
export interface DataParamsFormat {
  plain: boolean;
}

export class VacuumSession {
  private nextId: number;
  private readonly pending = new Map<number, PendingRequest>();
  private subscribedTopic: string | null = null;
  private listener: ((topic: string, payload: Buffer) => void) | null = null;
  private pendingMap: { security: SecurityData; resolve: (m: MapResponse) => void } | null = null;
  private readonly pushListeners = new Set<(push: Map<number, unknown>) => void>();

  readonly dataParamsFormat: DataParamsFormat = { plain: false };

  constructor(
    private readonly localKey: string,
    private readonly link: MqttLink,
    private readonly topicsProvider: () => MqttTopics,
    private readonly ids: [number, number] = REQUEST_IDS,
  ) {
    this.nextId = randomInt(ids[0], ids[1] + 1);
  }

  get started(): boolean {
    return this.listener !== null;
  }

  start(): void {
    if (this.listener) return;
    const topic = this.topicsProvider().subscribeTopic;
    this.link.subscribe(topic);
    this.subscribedTopic = topic;
    this.listener = (t, payload) => {
      if (t === this.subscribedTopic) this.handleIncoming(payload);
    };
    this.link.on('message', this.listener);
  }

  /** Move to the current session's topics if a re-login changed them. Cheap; called from the poll loop. */
  ensureSubscribed(): void {
    if (!this.listener) return;
    const wanted = this.topicsProvider().subscribeTopic;
    if (wanted === this.subscribedTopic) return;
    log.info('Session topics changed, resubscribing');
    if (this.subscribedTopic) this.link.unsubscribe(this.subscribedTopic);
    this.link.subscribe(wanted);
    this.subscribedTopic = wanted;
  }

  close(): void {
    if (this.listener) this.link.off('message', this.listener);
    this.listener = null;
    if (this.subscribedTopic) this.link.unsubscribe(this.subscribedTopic);
    this.subscribedTopic = null;
    for (const p of this.pending.values()) p.reject(new Error('Session closed'));
    this.pending.clear();
    this.pendingMap = null;
  }

  onPush(fn: (push: Map<number, unknown>) => void): () => void {
    this.pushListeners.add(fn);
    return () => this.pushListeners.delete(fn);
  }

  sendCommand(method: string, params: JsonValue = [], opts: SendOptions = {}): Promise<V1Response> {
    return this.sendCommandRaw(method, params, opts);
  }

  async sendCommandRaw(method: string, params: JsonValue, opts: SendOptions = {}): Promise<V1Response> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const id = this.takeId();
    const ts = Math.floor(Date.now() / 1000);
    let heardResolve!: () => void;
    const heard = new Promise<void>((r) => { heardResolve = r; });
    const answer = new Promise<V1Response>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject, heard: heardResolve });
    });
    answer.catch(() => undefined);
    const timers: NodeJS.Timeout[] = [];
    const failAfter = (ms: number, error: () => Error) => {
      const p = new Promise<never>((_, reject) => { timers.push(setTimeout(() => reject(error()), ms)); });
      // A timer that outlives its race must not become an unhandled rejection.
      p.catch(() => undefined);
      return p;
    };
    try {
      const payload = encodeRequest(id, method, params, ts);
      const frame = encodeMessage(this.localKey, {
        protocol: Protocol.RPC_REQUEST,
        payload,
        seq: randomInt(SEQ_MIN, SEQ_MAX + 1),
        random: randomInt(RANDOM_MIN, RANDOM_MAX + 1),
        timestamp: ts,
      });
      log.debug(`publish ${method} id=${id}`);
      this.link.publish(this.topicsProvider().publishTopic, frame);
      if (opts.firstReplyTimeoutMs !== undefined) {
        await Promise.race([heard, failAfter(opts.firstReplyTimeoutMs, () => new RobotSilentError(method))]);
      }
      return await Promise.race([answer, failAfter(timeoutMs, () => new RobotTimeoutError(method))]);
    } finally {
      for (const t of timers) clearTimeout(t);
      this.pending.delete(id);
    }
  }

  /** Ask for the map. Only one map request is outstanding at a time; callers serialise. */
  async fetchMap(security: SecurityData, timeoutMs = 30_000): Promise<MapResponse> {
    if (!this.listener) throw new Error('Session must be started before fetchMap');
    let timer: NodeJS.Timeout | null = null;
    const result = new Promise<MapResponse>((resolve, reject) => {
      this.pendingMap = { security, resolve };
      timer = setTimeout(() => reject(new RobotTimeoutError('get_map_v1')), timeoutMs);
    });
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = encodeRequest(this.takeId(), 'get_map_v1', [], ts, {
        security: { endpoint: security.endpoint, nonce: security.nonce.toString('hex') },
      });
      const frame = encodeMessage(this.localKey, {
        protocol: Protocol.RPC_REQUEST,
        payload,
        seq: randomInt(SEQ_MIN, SEQ_MAX + 1),
        random: randomInt(RANDOM_MIN, RANDOM_MAX + 1),
        timestamp: ts,
      });
      this.link.publish(this.topicsProvider().publishTopic, frame);
      return await result;
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingMap = null;
      result.catch(() => undefined);
    }
  }

  private handleIncoming(bytes: Buffer): void {
    let messages;
    try {
      messages = decodeMessages(this.localKey, bytes);
    } catch (e) {
      if (e instanceof RoborockProtocolError) {
        log.warn(`Robot message could not be decoded (local key mismatch?): ${e.message}`);
        return;
      }
      throw e;
    }
    for (const m of messages) {
      try {
        const resp = decodeResponse(m.payload);
        if (resp.id !== null) {
          const request = this.pending.get(resp.id);
          if (request) {
            request.heard();
            if (!isProvisionalRetry(resp)) {
              this.pending.delete(resp.id);
              request.resolve(resp);
            }
          }
        }
      } catch {
        // Not an RPC reply (a map, or an unsolicited message).
      }
      const dps = decodeDpsPush(m.payload);
      if (dps) {
        dps.delete(Number(DPS_REQUEST));
        dps.delete(Number(DPS_RESPONSE));
        if (dps.size > 0) for (const fn of this.pushListeners) fn(dps);
      }
      const wanted = this.pendingMap;
      if (wanted) {
        try {
          const map = decodeMapResponse(m, wanted.security);
          if (map) {
            this.pendingMap = null;
            wanted.resolve(map);
          }
        } catch {
          // Not a map reply.
        }
      }
    }
  }

  private takeId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= this.ids[1] ? this.ids[0] : this.nextId + 1;
    return id;
  }
}
