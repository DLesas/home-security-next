/** Routes system links without passing their code or query to Expo Router. */
import { receivePairingCode } from "../pairing/code-arrival";
import { systemPath } from "../ui/system-path";

/** Routes board links directly and leaves running-app link and restore codes to the phone client. */
export function redirectSystemPath({
  path,
  initial,
}: {
  readonly path: string;
  readonly initial: boolean;
}) {
  return receivePairingCode(path.trim()) ? "/device/add" : systemPath(path, initial);
}
