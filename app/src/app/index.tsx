/**
 * The home screen (docs/app-design.md "Layout"; m2-design.md section 8): the state field, then
 * the notices every screen shows, first-time setup, what needs attention, the doors, and news.
 */
import { ShellNotices, useAlarmRunning } from "../ui/banners";
import { NewList } from "../ui/devices";
import { Doors, NeedsAttention } from "../ui/arming";
import { Page } from "../ui/parts";
import { SetupPrompt } from "../ui/setup";
import { StateField } from "../ui/state-field";

export default function Screen() {
  // News waits while a countdown runs or the alarm sounds.
  const running = useAlarmRunning();
  return (
    <Page top={<StateField />}>
      <ShellNotices />
      <SetupPrompt />
      <NeedsAttention />
      <Doors />
      {running ? null : <NewList />}
    </Page>
  );
}
