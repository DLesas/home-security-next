/** Routes system links without passing their code or query to Expo Router. */
import { receivePairingCode } from "../pairing/code-arrival";
import { systemPath } from "../ui/system-path";

/** Sends a board link directly to its flow, avoiding a second navigation from the shell. */
export function redirectSystemPath({ path }: { readonly path: string; readonly initial: boolean }) {
  return receivePairingCode(path.trim()) ? "/device/add" : systemPath(path);
}
