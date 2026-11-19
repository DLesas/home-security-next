/**
 * The types of `file-input.tsx`'s pair, apart from it: in the phone's type check
 * (`tsconfig.native.json`) `./file-input` is the phone's file.
 */
import type { JSX } from "react";

export interface FileInputProps {
  readonly label: string;
  readonly accept?: string;
  readonly onFile: (file: { readonly name: string; readonly bytes: Uint8Array }) => void;
  readonly testID?: string;
}

export interface FileChoosing {
  readonly FileInput: (props: FileInputProps) => JSX.Element;
}
