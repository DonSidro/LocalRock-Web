import { md5Hex } from './crypto.js';

/*
 * MQTT broker address and credentials from a login session, ported from LocalRock's MqttCreds.kt
 * and MqttTopics.kt. The server accepts username md5(u:k)[2:10] and password md5(s:k)[16:].
 */

export interface Rriot {
  u: string;
  s: string;
  h: string;
  k: string;
  r: { r: string; a: string; m: string; l: string };
}

export interface MqttCreds {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}

export class MqttCredsError extends Error {}

export function deriveMqttCreds(rriot: Rriot): MqttCreds {
  const parsed = parseMqttUrl(rriot.r.m);
  return {
    ...parsed,
    username: md5Hex(`${rriot.u}:${rriot.k}`).substring(2, 10),
    password: md5Hex(`${rriot.s}:${rriot.k}`).substring(16),
  };
}

function parseMqttUrl(url: string): { host: string; port: number; tls: boolean } {
  const schemeSep = url.indexOf('://');
  if (schemeSep < 0) throw new MqttCredsError(`MQTT URL missing scheme: ${url}`);
  const scheme = url.substring(0, schemeSep).toLowerCase();
  const rest = url.substring(schemeSep + 3);
  const pathStart = rest.search(/[/?#]/);
  const authority = pathStart < 0 ? rest : rest.substring(0, pathStart);
  const portSep = authority.lastIndexOf(':');
  if (portSep < 0) throw new MqttCredsError(`MQTT URL missing port: ${url}`);
  const host = authority.substring(0, portSep);
  if (host.length === 0) throw new MqttCredsError(`MQTT URL has empty host: ${url}`);
  const portText = authority.substring(portSep + 1);
  if (!/^\d+$/.test(portText)) throw new MqttCredsError(`MQTT URL has invalid port: ${url}`);
  return { host, port: Number(portText), tls: scheme === 'ssl' };
}

export interface MqttTopics {
  publishTopic: string;
  subscribeTopic: string;
}

export function mqttTopicsFor(userU: string, mqttUsername: string, duid: string): MqttTopics {
  return {
    publishTopic: `rr/m/i/${userU}/${mqttUsername}/${duid}`,
    subscribeTopic: `rr/m/o/${userU}/${mqttUsername}/${duid}`,
  };
}
