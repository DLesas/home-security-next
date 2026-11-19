/**
 * The phone's `Intl`, the phone's side of `intl.ts`: an English `Intl.ListFormat` where Hermes has
 * none (`intl-types.ts`).
 */
import { installListFormat, type IntlStart } from "./intl-types";

export const installIntl: IntlStart["installIntl"] = (scope = Intl) => installListFormat(scope);
