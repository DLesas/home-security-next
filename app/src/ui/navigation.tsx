/**
 * Navigation (docs/app-design.md "Layout"): four destinations, each a word. Below 768 px they sit
 * in a bar at the bottom of the screen; from 768 px in a 240 px column at the left. Devices and
 * Activity list their few pages at the top of the content; Settings, with eight, opens an index of
 * them, and each of its pages has a "Settings" link back above its title. The selected item is
 * `sage`.
 */
import { Link, usePathname } from "expo-router";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { RING_PALE, TextLink } from "./parts";

interface Destination {
  readonly label: string;
  /** Where the destination leads, when it is an index of its pages rather than its first page. */
  readonly index?: string;
  readonly pages: readonly (readonly [href: string, label: string])[];
}

const HOME: Destination = { label: "nav.home", pages: [["/", "nav.home"]] };

/** Each destination and its pages, the first page being where the destination leads. */
export const DESTINATIONS: readonly Destination[] = [
  HOME,
  {
    label: "nav.devices",
    pages: [
      ["/devices", "nav.devices"],
      ["/groups", "nav.groups"],
      ["/modes", "nav.modes"],
    ],
  },
  {
    label: "nav.activity",
    pages: [
      ["/history", "nav.history"],
      ["/notifications", "nav.notifications"],
    ],
  },
  {
    label: "nav.settings",
    index: "/settings",
    pages: [
      ["/people", "nav.people"],
      ["/schedules", "nav.schedules"],
      ["/site", "nav.site"],
      ["/backup", "nav.backup"],
      ["/updates", "nav.updates"],
      ["/link", "nav.link"],
      ["/status", "nav.status"],
      ["/setup", "nav.setup"],
    ],
  },
];

/** Where a path belongs: its destination, and the page within it (a device's page is Devices'). */
export function placeOf(path: string): {
  readonly destination: Destination;
  readonly page: string;
} {
  const page = path.startsWith("/device/") ? "/devices" : path;
  const destination =
    DESTINATIONS.find((d) => d.index === page || d.pages.some(([href]) => href === page)) ?? HOME;
  return { destination, page };
}

/** Where a destination's own item leads. */
function leadsTo(d: Destination): string {
  return d.index ?? d.pages[0]?.[0] ?? "/";
}

/** One item: a word, at least 48 px high, `sage` when it is where the person is. */
function Item({
  href,
  label,
  here,
  fill,
}: {
  readonly href: string;
  readonly label: string;
  readonly here: boolean;
  /** Shares the bar's width with the others (the phone's bottom bar). */
  readonly fill?: boolean;
}) {
  return (
    <Link
      href={href}
      {...(here ? { "aria-current": "page" } : {})}
      className={`min-h-target rounded-button py-3 font-strong text-body text-ink ${RING_PALE} ${here ? "bg-sage" : ""} ${fill === true ? "flex-1 px-1 text-center" : "px-4"}`}
    >
      {label}
    </Link>
  );
}

/** The four destinations: a column at the left from 768 px. */
export function Rail() {
  const { t } = useTranslation();
  const here = placeOf(usePathname()).destination;
  return (
    <View
      role="navigation"
      aria-label={t("nav.label")}
      className="hidden w-rail gap-1 px-6 py-12 md:flex"
    >
      {DESTINATIONS.map((d) => (
        <Item key={d.label} href={leadsTo(d)} label={t(d.label)} here={d === here} />
      ))}
    </View>
  );
}

/** The four destinations: a bar at the bottom below 768 px. */
export function BottomBar() {
  const { t } = useTranslation();
  const here = placeOf(usePathname()).destination;
  return (
    <View
      role="navigation"
      aria-label={t("nav.label")}
      className="flex-row gap-1 border-t border-line bg-limewash px-2 py-2 md:hidden"
    >
      {DESTINATIONS.map((d) => (
        <Item key={d.label} href={leadsTo(d)} label={t(d.label)} here={d === here} fill />
      ))}
    </View>
  );
}

/** The pages of the destination the person is in, when it has more than one. */
export function Pages() {
  const { t } = useTranslation();
  const { destination, page } = placeOf(usePathname());
  if (destination.index !== undefined) {
    return page === destination.index ? null : (
      <View role="navigation" aria-label={t("nav.within", { destination: t(destination.label) })}>
        <TextLink href={destination.index} label={t(destination.label)} testID="back-to-index" />
      </View>
    );
  }
  if (destination.pages.length < 2) return null;
  return (
    <View
      role="navigation"
      aria-label={t("nav.within", { destination: t(destination.label) })}
      className="flex-row flex-wrap gap-1"
    >
      {destination.pages.map(([href, label]) => (
        <Item key={href} href={href} label={t(label)} here={href === page} />
      ))}
    </View>
  );
}
