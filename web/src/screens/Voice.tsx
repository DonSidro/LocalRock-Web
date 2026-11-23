import { useEffect, useState } from 'react';
import type { VacuumSnapshot } from '../../../shared/api';
import { VOICE_COMMAND_GROUPS, VOICE_INSTALL_TEXT, voiceLanguageName, type VoiceMessage, type VoicePack } from '../../../shared/voice';
import { call } from '../api';
import { Modal, SettingRow, Spinner, Switch } from '../ui';
import { useRobotActions } from '../useRobot';

/* The official Voice Assistant page: switch, language packs, chat history and the command list, from LocalRock's VoiceAssistantScreen. */

type Actions = ReturnType<typeof useRobotActions>;

export function VoicePanel({ snap, actions }: { snap: VacuumSnapshot; actions: Actions }) {
  const [open, setOpen] = useState<'language' | 'history' | 'commands' | null>(null);
  useEffect(() => { void actions.read('fetchVoice'); }, [actions.read]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = snap.voice;
  return (
    <div className="setting-list">
      <SettingRow title="Voice Assistant" sub="The robot will respond to your voice commands.">
        <Switch label="Voice Assistant" checked={v.enabled === true} disabled={actions.busy || v.enabled === null} onChange={(on) => void actions.run('setVoiceSwitch', { on })} />
      </SettingRow>
      <p className="muted tiny">* Once enabled, the device will collect and use your voice data to recognize voice commands and perform corresponding functions.</p>
      <SettingRow title="Voice Commands" sub='Say "Hello Rocky", then a command.'>
        <button type="button" className="btn secondary sm" onClick={() => setOpen('commands')}>Show</button>
      </SettingRow>
      <SettingRow title="Language" sub={v.languageCode ? voiceLanguageName(v.languageCode) : 'Unknown'}>
        <button type="button" className="btn secondary sm" onClick={() => setOpen('language')}>Change</button>
      </SettingRow>
      <SettingRow title="Chat History" sub={v.historyCount !== null ? `${v.historyCount} message${v.historyCount === 1 ? '' : 's'}` : 'What you said to the robot and its replies'}>
        <button type="button" className="btn secondary sm" onClick={() => setOpen('history')}>Open</button>
      </SettingRow>
      {open === 'language' && <VoicePacksDialog snap={snap} onClose={() => setOpen(null)} />}
      {open === 'history' && <ChatHistoryDialog duid={snap.duid} onClose={() => setOpen(null)} />}
      {open === 'commands' && <CommandsDialog onClose={() => setOpen(null)} />}
    </div>
  );
}

function VoicePacksDialog({ snap, onClose }: { snap: VacuumSnapshot; onClose: () => void }) {
  const [packs, setPacks] = useState<VoicePack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    setPacks(null);
    call<VoicePack[]>(snap.duid, 'voicePacks').then(setPacks).catch((e: Error) => setError(e.message || 'Voice packs unavailable'));
  };
  useEffect(load, [snap.duid]); // eslint-disable-line react-hooks/exhaustive-deps
  const install = snap.voiceInstall;
  const running = install !== null && install.failure === null && !install.done;
  return (
    <Modal title="Language" onClose={onClose} footer={<button type="button" className="btn secondary" onClick={onClose}>Close</button>}>
      {error ? (
        <div className="col">
          <strong>Voice packs unavailable</strong>
          <span className="muted small">{error} It needs local_roborock_server with voice pack support (#261).</span>
          <button type="button" className="btn secondary sm" onClick={load}>Retry</button>
        </div>
      ) : !packs ? (
        <div className="row"><Spinner /><span>Loading voice packs...</span></div>
      ) : packs.length === 0 ? (
        <p className="muted">No voice packs for this robot.</p>
      ) : (
        <div className="setting-list">
          {packs.map((p) => {
            const current = snap.voice.currentSid === p.id;
            const mine = install?.sid === p.id;
            return (
              <SettingRow
                key={p.id}
                title={p.title}
                sub={mine && running ? (install.percent !== null ? `Downloading: ${install.percent}%` : 'Downloading. This may take 30 seconds to 1 minute.')
                  : mine && install.failure ? VOICE_INSTALL_TEXT[install.failure]
                    : p.subTitle ?? undefined}
              >
                {current ? <span className="tag">Current</span>
                  : <button type="button" className="btn secondary sm" disabled={running} onClick={() => { void call(snap.duid, 'installVoicePack', { sid: p.id }).catch((e: Error) => setError(e.message)); }}>{mine && running ? <span className="spinner" /> : null}Use</button>}
              </SettingRow>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/** The official chat stamp, 2026/11/12 09:03, shown on user lines only: the first and any more than 60 s after the last shown. */
function stamps(messages: VoiceMessage[]): boolean[] {
  let last = -1;
  return messages.map((m, i) => {
    const due = i === 0 || m.ts - last > 60;
    if (due) last = m.ts;
    return m.speaker === 1 && due;
  });
}

function stamp(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ChatHistoryDialog({ duid, onClose }: { duid: string; onClose: () => void }) {
  const [messages, setMessages] = useState<VoiceMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { call<VoiceMessage[]>(duid, 'voiceHistory').then(setMessages).catch((e: Error) => setError(e.message)); }, [duid]);
  const shown = messages ? stamps(messages) : [];
  return (
    <Modal title="Chat History" onClose={onClose} footer={<button type="button" className="btn secondary" onClick={onClose}>Close</button>}>
      {error ? <p className="error-text">{error}</p> : !messages ? <div className="row"><Spinner /><span>Reading the chat history...</span></div>
        : messages.length === 0 ? <p className="muted">No Chat History</p> : (
          <div className="col" style={{ gap: 6 }}>
            {messages.map((m, i) => (
              <div key={m.id} className="col tight" style={{ alignItems: m.speaker === 1 ? 'flex-end' : 'flex-start' }}>
                {shown[i] && <span className="muted tiny" style={{ alignSelf: 'center' }}>{stamp(m.ts)}</span>}
                <span className="chat-bubble" style={{
                  background: m.speaker === 1 ? 'var(--primary)' : 'var(--surface-variant, rgba(127,127,127,.15))',
                  color: m.speaker === 1 ? 'var(--on-primary, #fff)' : 'inherit',
                  padding: '6px 10px', borderRadius: 12, maxWidth: '80%',
                }}>{m.text}</span>
              </div>
            ))}
          </div>
        )}
    </Modal>
  );
}

function CommandsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Voice Commands" onClose={onClose} footer={<button type="button" className="btn secondary" onClick={onClose}>Close</button>}>
      <p>Wake up the robot and say <strong style={{ color: 'var(--primary)' }}>Hello Rocky</strong>, then:</p>
      {VOICE_COMMAND_GROUPS.map((g) => (
        <div key={g.title} className="col tight" style={{ marginTop: 8 }}>
          <strong>{g.title}</strong>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {g.commands.map((c) => <li key={c.name}>{c.phrases.map((p) => `"${p}"`).join(' or ')}</li>)}
          </ul>
        </div>
      ))}
    </Modal>
  );
}
