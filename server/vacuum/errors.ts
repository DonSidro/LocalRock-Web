import { asInt } from '../protocol/envelope.js';

/** The robot answered a command with an error object. */
export class RobotCommandError extends Error {
  constructor(readonly method: string, readonly error: Record<string, unknown>) {
    super(robotErrorText(method, error));
  }

  get code(): number | null {
    return asInt(this.error['code']);
  }
}

function robotErrorText(method: string, error: Record<string, unknown>): string {
  const message = typeof error['message'] === 'string' ? error['message'] : error['message'] != null ? String(error['message']) : null;
  const code = error['code'] != null ? String(error['code']) : null;
  return `The robot refused ${method}` + (message ? `: ${message}` : '') + (code ? ` (code ${code})` : '');
}

/** A problem the user can fix, reported as it is (HTTP 400). */
export class UserError extends Error {}

/** Invalid edit caught before anything is sent to the robot, or a change the robot did not confirm. */
export class MapEditError extends UserError {}

/** The robot did not answer within the time allowed. */
export class RobotTimeoutError extends Error {
  constructor(readonly method: string) {
    super("The robot didn't answer in time");
  }
}

/** The robot sent nothing at all for a command, not even the ["retry"] it sends while it works. */
export class RobotSilentError extends Error {
  constructor(readonly method: string) {
    super(`The robot didn't answer ${method}`);
  }
}

/** Something the user can act on, without class names. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
