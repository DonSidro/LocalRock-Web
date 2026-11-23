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
import { RobotCommandError, RobotSilentError, RobotTimeoutError } from './errors.js';
import {
  BLOB_PROTOCOL, CIPHER_SUITE_PLAIN, CIPHER_SUITE_RSA, OFFICIAL_HEADER_SIZE, OFFICIAL_PARAMS_ENDPOINT, PATROL_TYPE_THUMBNAILS,
  decodeBlobStart, decryptHeaderlessBody, decryptOfficialBody, generateRsaKeys, getPatrolPhotoParams, getPhotoParams, gunzip,
  type BlobStart, type RsaKeys,
} from '../protocol/blob.js';

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
  /** Fields next to method and params, such as a photo request's security. */
  extraInner?: Record<string, JsonValue>;
  /** Called with the request id before the request goes out. */
  onId?: (id: number) => void;
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
  /** Photo requests waiting for their blob frame, by request id; keys is set for a cipher_suite 1 request. */
  private readonly pendingBlobs = new Map<number, { keys: RsaKeys | null; resolve: (b: Buffer) => void; reject: (e: Error) => void; done: boolean }>();
  /** A large photo whose body is still arriving in headerless frames. */
  private splitBlob: BlobStart | null = null;
  /** Which cipher_suite get_patrol_photo worked with on this robot, once one has. */
  private patrolCipher: number | null = null;
  private rsaKeys: RsaKeys | null = null;
  private pendingMap: { security: SecurityData; id: number; resolve: (m: MapResponse) => void; reject: (e: Error) => void } | null = null;
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
      opts.onId?.(id);
      const payload = encodeRequest(id, method, params, ts, opts.extraInner ?? {});
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
  fetchMap(security: SecurityData, timeoutMs = 30_000): Promise<MapResponse> {
    return this.requestMap(security, 'get_map_v1', [], timeoutMs);
  }

  /** A past run's map: get_clean_record_map {"start_time": <begin>}, answered like a saved map (captured 2026-11-01). */
  fetchCleanRecordMap(security: SecurityData, startTime: number, timeoutMs = 30_000): Promise<MapResponse> {
    return this.requestMap(security, 'get_clean_record_map', { start_time: startTime }, timeoutMs);
  }

  /**
   * A map-returning request: the robot answers ["ok"] (or an error, which ends the wait) and then sends
   * the map as a frame for the request. Callers serialise.
   */
  async requestMap(security: SecurityData, method: string, params: JsonValue, timeoutMs: number): Promise<MapResponse> {
    if (!this.listener) throw new Error('Session must be started before fetchMap');
    let timer: NodeJS.Timeout | null = null;
    const id = this.takeId();
    const result = new Promise<MapResponse>((resolve, reject) => {
      this.pendingMap = { security, id, resolve, reject };
      timer = setTimeout(() => reject(new RobotTimeoutError(method)), timeoutMs);
    });
    try {
      const ts = Math.floor(Date.now() / 1000);
      const payload = encodeRequest(id, method, params, ts, {
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

  /** An obstacle photo: the full frame, unzipped (see obstaclePhotoFromData). */
  fetchPhoto(security: SecurityData, photoId: string, timeoutMs = 15_000): Promise<Buffer> {
    return this.requestBlob('get_photo', security, timeoutMs, null, (pub) => getPhotoParams(pub, security, photoId));
  }

  /**
   * One cruise point's photo data (thumbnails, or one original with photoId and type 0). Plain is tried
   * first with a short wait unless cipher_suite 1 is known to work; whichever worked is remembered.
   */
  async fetchPatrolPhotoData(security: SecurityData, taskId: number, x: number, y: number, photoId: string | null = null, type = PATROL_TYPE_THUMBNAILS, timeoutMs = 20_000): Promise<Buffer> {
    const known = this.patrolCipher;
    const order = known === CIPHER_SUITE_RSA ? [CIPHER_SUITE_RSA, CIPHER_SUITE_PLAIN] : [CIPHER_SUITE_PLAIN, CIPHER_SUITE_RSA];
    let failure: Error | null = null;
    for (const cipher of order) {
      const wait = known === null && cipher === CIPHER_SUITE_PLAIN ? Math.min(timeoutMs, 5_000) : timeoutMs;
      try {
        let data: Buffer;
        if (cipher === CIPHER_SUITE_RSA) {
          const keys = this.rsaKeys ?? (this.rsaKeys = generateRsaKeys());
          data = await this.requestBlob('get_patrol_photo', security, wait, keys, (pub) => getPatrolPhotoParams(pub, security, taskId, x, y, photoId, type, CIPHER_SUITE_RSA, OFFICIAL_PARAMS_ENDPOINT));
        } else {
          data = await this.requestBlob('get_patrol_photo', security, wait, null, (pub) => getPatrolPhotoParams(pub, security, taskId, x, y, photoId, type));
        }
        this.patrolCipher = cipher;
        return data;
      } catch (e) {
        log.debug(`get_patrol_photo cipher_suite ${cipher} failed: ${(e as Error).message}`);
        failure = failure ?? (e as Error);
      }
    }
    throw failure ?? new Error("The robot didn't send the photo");
  }

  private async requestBlob(method: string, security: SecurityData, timeoutMs: number, keys: RsaKeys | null, params: (publicKey: JsonValue) => JsonValue): Promise<Buffer> {
    let publicKey: JsonValue;
    if (keys) {
      publicKey = keys.publicJson;
    } else {
      const answer = await this.sendCommand('get_random_pkey');
      if (answer.error) throw new RobotCommandError('get_random_pkey', answer.error);
      const first = Array.isArray(answer.result) ? answer.result[0] : answer.result;
      const pub = typeof first === 'object' && first !== null ? (first as Record<string, unknown>)['pub_key'] : undefined;
      if (typeof pub !== 'object' || pub === null) throw new RoborockProtocolError('get_random_pkey did not return a public key');
      publicKey = pub as JsonValue;
    }
    let id = -1;
    let timer: NodeJS.Timeout | null = null;
    const blob = new Promise<Buffer>((resolve, reject) => {
      timer = setTimeout(() => reject(new RobotTimeoutError(method)), timeoutMs);
      this.blobWaiter = { keys, resolve, reject, done: false };
    });
    blob.catch(() => undefined);
    try {
      const resp = await this.sendCommandRaw(method, params(publicKey), {
        timeoutMs,
        extraInner: { security: { endpoint: security.endpoint, nonce: security.nonce.toString('hex') } },
        onId: (requestId) => { id = requestId; if (this.blobWaiter) this.pendingBlobs.set(requestId, this.blobWaiter); this.blobWaiter = null; },
      });
      if (resp.error) throw new RobotCommandError(method, resp.error);
      return await blob;
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingBlobs.delete(id);
    }
  }

  private blobWaiter: { keys: RsaKeys | null; resolve: (b: Buffer) => void; reject: (e: Error) => void; done: boolean } | null = null;

  /** True when the frame was a photo (or part of one) and has been taken. */
  private handleBlobFrame(protocol: number, payload: Buffer): boolean {
    let start: BlobStart | null = null;
    try { start = decodeBlobStart(protocol, payload); } catch { return false; }
    if (start) {
      if (start.body.length < start.bodyLength) {
        // The first part of a split photo; only kept for a request that is waiting.
        this.splitBlob = this.pendingBlobs.has(start.requestId) ? start : null;
        return true;
      }
      this.splitBlob = null;
      return this.deliverBlob(start.requestId, start.header, start.body);
    }
    const part = this.splitBlob;
    if (part && protocol === BLOB_PROTOCOL) {
      const joined = Buffer.concat([part.body, payload]);
      if (joined.length > part.bodyLength) { this.splitBlob = null; return false; }
      if (joined.length < part.bodyLength) { this.splitBlob = { ...part, body: joined }; return true; }
      this.splitBlob = null;
      return this.deliverBlob(part.requestId, part.header, joined);
    }
    // No header: an original cruise photo, which carries no request id; the oldest waiting cipher request whose key unwraps it gets it.
    if (protocol === BLOB_PROTOCOL && payload.length >= OFFICIAL_HEADER_SIZE) {
      for (const w of this.pendingBlobs.values()) {
        if (!w.keys || w.done) continue;
        const data = decryptHeaderlessBody(payload, w.keys);
        if (data) { w.done = true; w.resolve(data); return true; }
      }
    }
    return false;
  }

  private deliverBlob(requestId: number, header: Buffer, body: Buffer): boolean {
    const w = this.pendingBlobs.get(requestId);
    if (!w) return false;
    try {
      const data = w.keys ? decryptOfficialBody(header, body, w.keys) : gunzip(body);
      w.done = true;
      w.resolve(data);
    } catch (e) {
      w.done = true;
      w.reject(e as Error);
    }
    return true;
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
      if (this.pendingBlobs.size > 0 && this.handleBlobFrame(m.protocol, m.payload)) continue;
      try {
        const resp = decodeResponse(m.payload);
        const mapWait = this.pendingMap;
        if (mapWait && resp.id === mapWait.id && resp.error) {
          this.pendingMap = null;
          mapWait.reject(new RobotCommandError('map request', resp.error));
        }
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
