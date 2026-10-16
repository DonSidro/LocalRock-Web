import { useEffect, useRef } from 'react';
import { call } from '../api';
import { toast } from '../store';
import { IconButton, Kbd, Panel, isTypingTarget } from '../ui';

/*
 * Remote control, from LocalRock's RemoteControlScreen: each press moves the robot for 1.5 s.
 * Remote mode starts when the tab opens and ends when it closes. Arrow keys work too.
 */

const MOVES: Record<string, [number, number]> = {
  forward: [0.3, 0],
  back: [-0.3, 0],
  left: [0, 0.3],
  right: [0, -0.3],
};

export function RemoteScreen({ duid }: { duid: string }) {
  const inFlight = useRef(false);

  useEffect(() => {
    void call(duid, 'rcStart').catch((e: Error) => toast(e.message, true));
    return () => { void call(duid, 'rcEnd').catch(() => undefined); };
  }, [duid]);

  const move = (dir: keyof typeof MOVES) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const [velocity, omega] = MOVES[dir]!;
    void call(duid, 'rcMove', { velocity, omega, durationMs: 1500 })
      .catch((e: Error) => toast(e.message, true))
      .finally(() => { inFlight.current = false; });
  };
  const stop = () => void call(duid, 'rcEnd').catch((e: Error) => toast(e.message, true));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const map: Record<string, keyof typeof MOVES> = { ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right' };
      const dir = map[e.key];
      if (dir) { e.preventDefault(); move(dir); }
      if (e.key === ' ') { e.preventDefault(); stop(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="tab-page narrow">
      <Panel title="Remote control">
        <div className="col loose" style={{ alignItems: 'center', padding: '16px 0' }}>
          <div className="dpad">
            <span />
            <IconButton icon="chevronUp" label="Forward" variant="outlined" shortcut="Up arrow" onClick={() => move('forward')} />
            <span />
            <IconButton icon="chevronLeft" label="Turn left" variant="outlined" shortcut="Left arrow" onClick={() => move('left')} />
            <IconButton icon="stop" label="Stop" variant="danger" shortcut="Space" onClick={stop} />
            <IconButton icon="chevronRight" label="Turn right" variant="outlined" shortcut="Right arrow" onClick={() => move('right')} />
            <span />
            <IconButton icon="chevronDown" label="Backward" variant="outlined" shortcut="Down arrow" onClick={() => move('back')} />
            <span />
          </div>
          <p className="muted small center">
            Each press moves the robot for 1.5 seconds. Use <Kbd>↑</Kbd> <Kbd>↓</Kbd> <Kbd>←</Kbd> <Kbd>→</Kbd> to drive and <Kbd>Space</Kbd> to stop.
            Remote mode ends when you leave this tab.
          </p>
        </div>
      </Panel>
    </div>
  );
}
