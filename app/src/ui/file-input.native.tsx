/**
 * Choosing a file on a phone, the phone's side of `file-input.tsx`: there is none. Uploads are the
 * hub computer's alone (m2-design.md section 6, "C"; m3-design.md section 2: "these pages say do
 * this on the hub computer"), so in the file's place the page says so, under the same label.
 */
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type { FileInputProps } from "./file-input-types";
import { Body, Label } from "./parts";

export function FileInput({ label, testID }: FileInputProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-2" testID={testID}>
      <Label>{label}</Label>
      <Body>{t("files.onComputer")}</Body>
    </View>
  );
}
