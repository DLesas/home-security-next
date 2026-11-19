import type { ImageCache } from "../download";

/** The console never downloads firmware for Bluetooth. */
export const imageCache: (image: string) => ImageCache | undefined = () => undefined;
