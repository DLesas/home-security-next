# App design: how the app looks and reads

This document sets the visual design of the app: the web build in M2 and the phone app in M3, which share one codebase. It covers colour, type, spacing, layout and wording. It does not cover what the screens do; that is `m2-design.md` section 8.

The product owner's brief, in their words: "clean and easy to use and things should be clear but also airy i.e. spacious". Styling uses NativeWind, with no raw CSS.

## Who uses it, and for what

The people of one household, most of them not technical, on a phone or a computer at home. The app's first job is to answer one question at a glance: is the house protected right now? Its second job is to let a person arm or disarm with confidence. Everything else (devices, people, schedules, backup) is visited rarely, mostly by one administrator.

## The one bold thing: day and night

The top of the home screen is a **state field** that says the state of the house in one plain sentence, set large. The field has two looks, taken from the house itself:

- **Day** (disarmed): a pale field with dark text. The house is open and lived in.
- **Night** (armed, and while a countdown runs): a deep, dark field with pale text. The lights are off and the house is locked.

A third look, **alarm**, fills the field with signal red.

This is the only place in the app with strong colour. Every other screen is quiet: dark text on a pale page, with space doing the work that boxes usually do.

## Principles

1. **Say the state in words, large.** The sentence in the state field is the most important thing the app shows. Colour supports it and never replaces it.
2. **Space separates, not boxes.** Sections are set apart by empty space. There are no card grids and no shadows anywhere. A filled surface is used for four things only: the state field, notices, form inputs, and the camera's view.
3. **One column, left aligned.** Text and controls share one left edge. Nothing is centred except the content column itself on a wide screen.
4. **Colour never carries meaning alone.** Every state is also said in words. This rule is already in force and stays.
5. **Words, not icons.** Navigation and buttons are labelled with words. The app ships no icon set.
6. **Big targets.** Anything a person presses is at least 48 px high.

## Colour

All colours are tokens in the Tailwind theme, used by name. No hex value appears in a component.

| Token | Value | Used for |
| --- | --- | --- |
| `limewash` | `#F4F6F3` | The page background |
| `chalk` | `#FFFFFF` | Inputs and the sheet behind a dialog |
| `sage` | `#E3EBE5` | The day field; the selected navigation item |
| `ink` | `#16292A` | Text on pale surfaces |
| `stone` | `#536462` | Secondary text on pale surfaces |
| `line` | `#D5DCD7` | Hairlines between rows of a list; input borders use `stone` |
| `spruce` | `#17383A` | The night field; primary buttons |
| `lamp` | `#F2B441` | On the night field only: the countdown number and the armed mark |
| `signal` | `#B3261E` | The alarm field; destructive buttons |
| `ochre` | `#7A4E00` on `#FBF1D3` | Warning notices (text and left edge on the pale ochre surface) |
| `fern` | `#1F6B3A` on `#E6F2E8` | Confirmation notices |

Rules:

- The armed mark is a short `lamp` bar above the state sentence on the night field.
- A refusal (the hub said no) is an ochre notice; red is kept for the alarm and for destructive buttons.
- `lamp` is never used on a pale surface. It fails contrast there, and on a pale surface amber means a warning.
- Text on `spruce` and `signal` is `limewash`.
- The focus ring is 3 px with a 3 px gap: `ink` on pale surfaces, `limewash` on `spruce` and `signal`.
- Every pairing must pass WCAG AA (4.5:1 for text, 3:1 for the focus ring and input borders). The automated accessibility check stays in force.
- There is one colour scheme for now. Because every colour is a token, a dark scheme can be added later without touching components.

## Type

One family: **Atkinson Hyperlegible Next**. It was drawn so that letters and figures are hard to mistake for one another, which is the right reason for a product where misreading "armed" or a code matters. The font files are bundled with the app and served by the hub; nothing is fetched from the internet.

**Atkinson Hyperlegible Mono** is used in one case only: characters a person must copy exactly (a link code, a certificate fingerprint).

| Role | Size / line height (px) | Weight |
| --- | --- | --- |
| State sentence | 44 / 48 on a phone, 64 / 68 from 768 px wide | 700, letter spacing −0.02 em |
| Page title | 32 / 40 | 700 |
| Section heading | 22 / 30 | 600 |
| Body, buttons, inputs | 17 / 26 | 400 (buttons 600) |
| Secondary text | 15 / 22 | 400 |

Text is sentence case everywhere. No capitals-only labels. A line of body text is at most about 65 characters wide.

## Spacing and shape

- Spacing steps: 4, 8, 12, 16, 24, 32, 48, 64, 96 px.
- Page gutter: 24 px on a phone, 48 px from 768 px wide.
- Between sections: 48 px on a phone, 64 px from 768 px wide. Between a heading and its content: 16 px.
- A list row is at least 56 px high, with 16 px above and below its text.
- The content column is at most 640 px wide.
- Corners: buttons 12 px, inputs 10 px, notices 12 px. The state field is square and edge to edge on a phone, and has 24 px corners from 768 px wide.
- No shadows.

## Layout

**Navigation.** Four destinations, each a word. Routes do not change; only how they are grouped.

| Destination | Holds |
| --- | --- |
| Home | The state field, arming and disarming, what needs attention, doors |
| Devices | Devices, groups, modes |
| Activity | History, notifications |
| Settings | People, schedules, this home, backup, updates, link a device, hub status, first-time setup |

Below 768 px wide the four sit in a bar at the bottom of the screen. From 768 px wide they sit in a column at the left, 240 px wide, with the content column directly beside it (not centred in the space that remains).

**Home, on a phone:**

```
┌────────────────────────────┐
│                            │
│  Disarmed                  │  state sentence
│  Every door is closed.     │  one line of detail
│                            │
│  [ Arm away ]              │  primary button, full width
│  [ Arm home ]              │  quiet button, full width
│                            │
├────────────────────────────┤
│                            │
│  Needs attention           │  shown only when there is something
│  Back door: battery low    │
│                            │
│                            │
│  Doors                     │
│  Front door        Closed  │
│  ────────────────────────  │
│  Back door   Open, 14:02   │
│                            │
├────────────────────────────┤
│ Home Devices Activity Settings │
└────────────────────────────┘
```

**Any other screen:** the page title, then sections separated by space. A list is rows with a hairline between them, the name at the left and the state at the right. A form is one field per row, its label above it, with the action that saves at the bottom left.

**An empty list** says what belongs there and offers the action that adds the first one.

**Settings** has eight pages, too many for a row of links. The Settings destination opens a plain list of them, one row each with a line saying what the page is for. Each page under it has a "Settings" link above its title that leads back. Devices and Activity have three pages or fewer and keep a row of links above the title.

**A list of devices** shows, per row, the name with its kind and battery beneath it at the left, and its state in words at the right ("No problems", "Battery low"). The whole row opens the device's page, which holds everything else (signal, temperature, firmware, when it was last heard).

**Notices.** A filled notice is for something a person must act on or has just been refused: a warning, an error, a confirmation of what they just did. News that needs no action ("the hall siren was added") is not boxed: it is a plain list under the heading "New", one row each, with "Dismiss" as a text link at the right. On Home that list comes after Doors, and it is hidden while a countdown runs or the alarm sounds.

**The alarm sentence** is the one word "Alarm", and while the entry countdown runs it is "Countdown", with the time left beneath it in `lamp`. The time left is shown once, in the state field, not repeated in the door's row. What set it off and which sirens are sounding follow as lines of detail. A name the household typed never goes into the state sentence, where a long one would break across lines.

**A tick box** is drawn: a 24 px square with a `stone` border, filled `spruce` with a `limewash` tick when on, inside a 48 px target with its label. Its label says what being on means ("Run this entry"), not "On".

**An introduction** under a page title sits 16 px below it, as part of the title, not as a section of its own.

## On a phone

What the phone build needs beyond the rules above ([m3-design.md](m3-design.md) section 2). Nothing above is restyled. ‡ marks a fact about a library stated from memory, to be checked before anything depends on it.

1. **Safe areas.** The state field fills the space behind the status bar in its own colour; its text starts below it. The bottom bar sits above the home indicator, its `limewash` reaching the screen's edge. In landscape the gutters grow by the side insets. Written with NativeWind's safe-area utilities (`pt-safe`, `pb-safe`, from `tailwindcss-safe-area` 1.3.0, which NativeWind 5's theme imports), never as numbers; Expo Router already provides the inset provider.
2. **The status bar.** Dark text on the day field and on every other page; light text on the night and alarm fields (expo-status-bar).
3. **Back.** Android's back button goes from a page to its destination's first page or index, from there to Home, and from Home out of the app. iOS has no swipe back: the "Settings" link above each settings page (Layout) is the way back, as on the web. Routes stay in Expo Router's `Slot`.
4. **Text size.** The app follows the phone's text size up to twice its own sizes (200%), and no further (React Native's `maxFontSizeMultiplier` ‡). The bottom bar's words never shrink; its height grows.
5. **The keyboard.** While a person types, the field and the action that saves it stay visible above the keyboard.
6. **Announcements.** A countdown or an alarm is announced at once ([m2-design.md](m2-design.md) section 8). Android reads the live region; iOS needs `AccessibilityInfo.announceForAccessibility` ‡, which the alarm banner calls.
7. **Asking for a permission.** Never at start. At the moment it is needed, a page says in one sentence what the phone will ask and why, with one button that names it ("Allow the camera"); the system's question follows. If the answer is no, the page says what will not work, offers "Open settings", and offers the way that needs no permission where there is one ("Type the code instead"). The system's own question (iOS's purpose strings) uses the same sentence. The permissions: camera (scanning), Bluetooth (pairing, updates), local network (reaching the hub), notifications (M3 and M5), location always (presence, M5), Face ID (app lock, M5).
8. **The camera screen.** The page title "Scan the code", one line saying what to point at, then the camera's view: a square the width of the content column, 12 px corners, nothing drawn over it. Under it a quiet button "Type the code instead" and, where the phone has a light, "Light on" or "Light off". When a code is read, the view stops at once and the next page says what was found. A code that is not one of ours gets an ochre notice: "This is not a code from your home system." The camera's view is the fourth filled surface (Principles, rule 2).
9. **Notifications and their one action** (M5). The title is the state's word as the state field says it ("Countdown", "Alarm"); the body says what happened, one sentence ("Front door opened at 14:02."). At most one action, named by the push's `actions` ([m4-design.md](m4-design.md) section 5): "Disarm" (D51) where the person may disarm, or "Arm away" for a presence offer. With several homes, the body starts with the home's name. No app name, no symbols. The texts come from the translation files by `n.kind`; the relay's own two alerts use the wording of [m4-design.md](m4-design.md) section 5. When a device's alarm arrives, the phone removes that device's countdown notification, so one replaces the other on the phone and nothing on the wire says so.
10. **Orientation.** Phones in portrait; tablets either way, since the layout already works from 768 px.
11. **One colour scheme.** The app declares itself light (`userInterfaceStyle`), so the keyboard and system dialogs stay pale while the app has one scheme (Colour).

## Motion

One: when the house changes between disarmed and armed, the state field's colour fades from one look to the other over 400 ms. With reduced motion set, it changes at once. Nothing else moves on its own.

## Wording

- A button says what happens when it is pressed: "Arm away", "Disarm", "Save changes", "Remove this phone".
- An action keeps its name through the flow: the button "Arm away" leads to the sentence "Armed, away".
- An error says what happened and what to do next. It does not apologise.
- Things are named as the household knows them (door, siren, phone, person), not as the system does (sensor node, client, session).

## What was considered and dropped

- **Amber as the accent everywhere.** Dropped: on a pale page it reads as a warning and fails contrast as a focus ring. It is kept for the night field alone.
- **Cards for each device.** Dropped: a household has a handful of doors, and a plain list with space around it is easier to scan than a grid of boxes.
- **Icons in navigation.** Dropped: four words fit at every width, and words are never ambiguous.
