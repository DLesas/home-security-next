/**
 * Choosing a file on this computer, in the web build: the browser's own file input, labelled. Its
 * bytes are read here and sent as `fileChunk` requests (`hub/files.ts`); they never enter the store.
 */
import { useId } from "react";
import { Text, View } from "react-native";
import { styles } from "./theme";

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
    <View style={{ gap: 4 }}>
      <Text style={styles.h3} nativeID={`${id}-label`}>
        {label}
      </Text>
      <input
        type="file"
        aria-label={label}
        accept={accept}
        data-testid={testID}
        style={{ fontSize: 16, minHeight: 44 }}
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
