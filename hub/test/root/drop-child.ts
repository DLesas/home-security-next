/**
 * Run as root by `privilege-drop.test.ts`: becomes the account named in argv[2] by `hsn`'s own
 * drop (`cli/elevated.ts`), then tries `setuid(0)` itself and prints what that gave and what the
 * system says of its ids afterwards, as one JSON line.
 */
import { Result } from "neverthrow";
import { currentIds, dropTo, lookupAccount, unixPlatform } from "../../cli/elevated.ts";

const platform = unixPlatform(process.platform);
const name = process.argv[2] ?? "";
if (platform === undefined) process.exit(2);
const account = lookupAccount(name);
if (account.isErr()) {
  process.stdout.write(`${JSON.stringify({ error: account.error })}\n`);
  process.exit(1);
}
const dropped = dropTo(account.value, platform);
const ids = currentIds(platform).unwrapOr(undefined);
// Root taken back in this very process: it must fail, and the ids must not have moved.
const setuid = process.setuid?.bind(process);
const regained =
  setuid === undefined
    ? "no setuid"
    : Result.fromThrowable(
        () => {
          setuid(0);
        },
        (thrown) => (thrown instanceof Error ? thrown.message : String(thrown)),
      )().match(
        () => "regained",
        (message) => `refused: ${message}`,
      );
process.stdout.write(
  `${JSON.stringify({
    account: account.value,
    dropped: dropped.isOk() ? "ok" : dropped.error,
    ids,
    regained,
    idsAfter: currentIds(platform).unwrapOr(undefined),
  })}\n`,
);
