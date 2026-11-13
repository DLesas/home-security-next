/**
 * `hsn`'s exit codes (hub-design.md section 9), for scripts. They follow BSD's sysexits where one
 * fits, so a script can tell a refusal from a hub that is not running from a typing error.
 */
export const ExitCode = {
  /** The hub did what was asked. */
  Ok: 0,
  /** The hub refused the command: the message says why. */
  Refused: 1,
  /** `hsn arm` stopped because a door is open (D50); `--continue` arms anyway. */
  DoorsOpen: 3,
  /** The command line is not one `hsn` knows (EX_USAGE). */
  Usage: 64,
  /** The hub is not running: no control socket, or nothing listening on it (EX_UNAVAILABLE). */
  HubNotRunning: 69,
  /** The hub took the command but gave no answer in time, or a board did not (EX_TEMPFAIL). */
  NoAnswer: 75,
  /** The hub answered something that is not a reply (EX_PROTOCOL). */
  BadReply: 76,
  /** The socket is there but this account may not open it: run as the hub's account (EX_NOPERM). */
  NoPermission: 77,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** The help text's table of exit codes. */
export const EXIT_CODE_HELP = `exit codes:
  0   done
  1   refused by the hub; the message says why
  3   arm stopped: a door is open (use --continue)
  64  not a command hsn knows
  69  the hub is not running
  75  no answer in time (from the hub or a board): try again
  76  the hub's answer could not be read
  77  not allowed to open the hub's socket: run as the hub's account`;
