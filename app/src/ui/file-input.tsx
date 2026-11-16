/**
 * Choosing a file on this computer, in the web build: the browser's own file input, labelled. Its
 * bytes are read here and sent as `fileChunk` requests (`hub/files.ts`); they never enter the store.
 */
import { useId } from "react";
import { View } from "react-native";
import { Label } from "./parts";

export function FileInput({
  label,
  accept,
  onFile,
  testID,
}: {
  readonly label: string;
  readonly accept?: string;
  readonly onFile: (file: { readonly name: string; readonly bytes: Uint8Array }) => void;
  readonly testID?: string;
}) {
  const id = useId();
  return (
    <View className="gap-2">
      <Label id={`${id}-label`}>{label}</Label>
      <input
        type="file"
        aria-label={label}
        accept={accept}
        data-testid={testID}
        className="min-h-target font-text text-body text-ink"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file === undefined) return;
          void file.arrayBuffer().then((buffer) => {
            onFile({ name: file.name, bytes: new Uint8Array(buffer) });
          });
        }}
      />
    </View>
  );
}
