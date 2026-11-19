/**
 * React Native as the tests load it: React Native Web, as the web build does, with the one export
 * the phone's Bluetooth file needs that the web has none of (`PermissionsAndroid`, refusing). Bun
 * keeps one module record for `react-native` across a run's files and a later `mock.module` patches
 * that record's exports in place, so every file that stands in for React Native gives the same
 * names: `support/render.ts` this object, and `ble-native.test.ts` its own values over it.
 */
const web = (await import(Bun.resolveSync("react-native-web", import.meta.dir))) as Record<
  string,
  unknown
>;

/** React Native Web, with Android's permissions refused. */
export const nativeWeb: Record<string, unknown> = {
  ...web,
  PermissionsAndroid: {
    PERMISSIONS: {},
    /** No Android permission is held on the web. */
    check: () => Promise.resolve(false),
    /** None is granted on the web. */
    requestMultiple: () => Promise.resolve({}),
  },
};
