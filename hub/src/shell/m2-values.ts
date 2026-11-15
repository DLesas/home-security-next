/**
 * The shell's and the installer's values of M2 (m2-design.md sections 2, 5, 8 and 9), in one
 * place, as `HubRules` holds the core's and `@hsn/protocol/app` the channel's. Values marked ‡
 * are the design's own choices, to be tried on each platform in step 3. Owners A2 (listeners),
 * A5 (the zone), A8 (packaging, launcher, backups, updates) and A11 (Windows) read them here.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** How often the shell looks at the computer's time zone, to give `timeZone` when it changed ‡. */
export const TIME_ZONE_CHECK_MS = HOUR;

/** The launcher (section 9, "Starts at boot"). */
export const LAUNCHER = {
  /** Restarts after 1 s, then 10 s, 30 s and every 5 minutes ‡ ... */
  restartDelaysMs: [1 * SECOND, 10 * SECOND, 30 * SECOND, 5 * MINUTE],
  /** ... while the hub keeps failing within a minute of starting ‡. */
  failingWithinMs: MINUTE,
  /** The hub's own request to be restarted (HD 10); every other non-zero exit is a failure. */
  restartMeExitCode: 70,
  /** A crash: an uncaught exception or a fatal error (`FATAL_EXIT_CODE`). */
  crashExitCode: 71,
  /** At most two versions are kept in `<prefix>/versions/` (section 9). */
  versionsKept: 2,
} as const;

/** What each platform's service manager is told (section 9's table) ‡. */
export const SERVICE = {
  macos: {
    user: "_hsnhub",
    dataFolder: "/Library/Application Support/HSN Hub/",
    sleep: ["caffeinate", "-s", "-w"],
  },
  linux: {
    user: "hsn",
    group: "dialout",
    dataFolder: "/var/lib/hsn-hub/",
    restartSec: 5,
    sleep: ["systemd-inhibit", "--what=sleep:idle"],
  },
  windows: {
    account: "NT SERVICE\\HSNHub",
    dataFolder: "%ProgramData%\\HSN Hub\\",
    /** WinSW's `<onfailure action="restart" delay="5 sec"/>` ‡. */
    restartDelayS: 5,
    /** WinSW's release, pinned by `hub/packaging/windows/winsw.sha256` (section 9, W3). */
    winswVersion: "2.12.0",
  },
} as const;

/** Updates (section 9, "Hub updates"). */
export const UPDATES = {
  /** The new version must record `update_healthy` within 60 s ‡, or it is rolled back. */
  healthyWithinMs: MINUTE,
} as const;

/** The web app's files, served from the install folder (section 3) ‡. */
export const WEB_APP_BYTES_ABOUT = 5 * 1024 * 1024;

/** A backup file, about 200 KB ‡ (section 9), for the size guard's share. */
export const BACKUP_BYTES_ABOUT = 200 * 1024;
