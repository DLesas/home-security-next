/**
 * Restoring a hub from this phone (m3-design.md section 4), under Settings on a phone that holds a
 * backup key: see `ui/phone-restore.tsx`. A browser has no key, and says where a restore is done.
 */
import { PhoneRestore } from "../ui/phone-restore";

export default function Screen() {
  return <PhoneRestore code={null} />;
}
