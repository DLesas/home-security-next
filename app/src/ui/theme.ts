/**
 * The app's look, plainly (m2-design.md section 8 leaves the component set open): one type scale,
 * one spacing scale, and colours that pass WCAG AA contrast on their backgrounds. Colour never
 * carries meaning alone: every state is also said in words, and warnings carry a marked border and
 * a heading as well as their colour.
 */
import { StyleSheet } from "react-native";

export const colour = {
  text: "#1b1f24",
  muted: "#4a5361",
  background: "#ffffff",
  surface: "#f3f5f8",
  border: "#c5ccd6",
  accent: "#0b5cad",
  onAccent: "#ffffff",
  focus: "#b35c00",
  danger: "#a4161a",
  onDanger: "#ffffff",
  dangerSurface: "#fdecec",
  warningSurface: "#fff4d6",
  okSurface: "#e7f5ea",
} as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colour.background },
  main: { padding: space.l, gap: space.l, maxWidth: 760, width: "100%", alignSelf: "center" },
  h1: { fontSize: 26, fontWeight: "700", color: colour.text },
  h2: { fontSize: 20, fontWeight: "700", color: colour.text },
  h3: { fontSize: 17, fontWeight: "700", color: colour.text },
  body: { fontSize: 16, lineHeight: 24, color: colour.text },
  muted: { fontSize: 15, lineHeight: 22, color: colour.muted },
  section: { gap: space.m, padding: space.l, borderRadius: 8, backgroundColor: colour.surface },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.s, alignItems: "center" },
  button: {
    paddingVertical: space.s,
    paddingHorizontal: space.l,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colour.accent,
    backgroundColor: colour.accent,
    minHeight: 44,
    justifyContent: "center",
  },
  buttonText: { fontSize: 16, fontWeight: "600", color: colour.onAccent },
  buttonQuiet: { backgroundColor: colour.background },
  buttonQuietText: { color: colour.accent },
  buttonDanger: { backgroundColor: colour.danger, borderColor: colour.danger },
  buttonDangerText: { color: colour.onDanger },
  focused: { outlineColor: colour.focus, outlineStyle: "solid", outlineWidth: 3, outlineOffset: 2 },
  disabled: { opacity: 0.6 },
  input: {
    fontSize: 16,
    padding: space.s,
    borderWidth: 2,
    borderColor: colour.border,
    borderRadius: 6,
    backgroundColor: colour.background,
    color: colour.text,
    minHeight: 44,
  },
  notice: { padding: space.m, borderRadius: 6, borderLeftWidth: 6, gap: space.xs },
  noticeInfo: { backgroundColor: colour.surface, borderLeftColor: colour.accent },
  noticeOk: { backgroundColor: colour.okSurface, borderLeftColor: "#1d6b32" },
  noticeWarning: { backgroundColor: colour.warningSurface, borderLeftColor: "#8a5a00" },
  noticeDanger: { backgroundColor: colour.dangerSurface, borderLeftColor: colour.danger },
  banner: { padding: space.l, gap: space.s, backgroundColor: colour.danger },
  bannerText: { fontSize: 18, fontWeight: "700", color: colour.onDanger },
  item: {
    paddingVertical: space.s,
    borderBottomWidth: 1,
    borderBottomColor: colour.border,
    gap: space.xs,
  },
  nav: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.m,
    padding: space.m,
    borderBottomWidth: 1,
    borderBottomColor: colour.border,
  },
  navLink: {
    fontSize: 16,
    color: colour.accent,
    textDecorationLine: "underline",
    padding: space.xs,
  },
});
