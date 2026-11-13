/**
 * Splits `tsc --pretty false` output into the errors inside the owner's folders and the rest,
 * so one engineer's half-finished edit does not fail another's check (hub/README.md).
 */

/** One diagnostic: its first line names the file, any indented lines that follow belong to it. */
export interface TypeError {
  readonly file: string;
  readonly text: string;
}

/** `path(line,col): error TSnnnn: message`, as tsc prints it without `--pretty`. */
const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+:/;

export function parseTypeErrors(output: string): readonly TypeError[] {
  const errors: { file: string; lines: string[] }[] = [];
  for (const line of output.split("\n")) {
    const match = DIAGNOSTIC.exec(line);
    if (match?.[1] !== undefined) errors.push({ file: match[1], lines: [line] });
    else if (line.startsWith(" ") && errors.length > 0) errors.at(-1)?.lines.push(line);
  }
  return errors.map(({ file, lines }) => ({ file, text: lines.join("\n") }));
}

/** A folder as given, without a leading "./" or a trailing "/". */
export function normalizeFolder(folder: string): string {
  return folder.replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isInside(file: string, folders: readonly string[]): boolean {
  return folders.some((folder) => file === folder || file.startsWith(`${folder}/`));
}

export interface SplitErrors {
  readonly own: readonly TypeError[];
  readonly others: readonly TypeError[];
  /** The folders the other errors are in, each once, sorted. */
  readonly otherFolders: readonly string[];
}

export function splitTypeErrors(
  errors: readonly TypeError[],
  folders: readonly string[],
): SplitErrors {
  const own = errors.filter((e) => isInside(e.file, folders));
  const others = errors.filter((e) => !isInside(e.file, folders));
  const otherFolders = [...new Set(others.map((e) => e.file.replace(/\/[^/]*$/, "")))].sort();
  return { own, others, otherFolders };
}
