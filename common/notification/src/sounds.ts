// Purpose: One finite sound catalog shared by Config, previews and native packaging.

/** Bundled tones. Literal URLs let Vite copy the same files used by the OS. */
export const notificationSounds = [
  {
    id: "chime",
    label: "Chime",
    file: "openchart-chime.wav",
    url: new URL("./sounds/openchart-chime.wav", import.meta.url).href,
  },
  {
    id: "confirm",
    label: "Confirmation",
    file: "openchart-confirm.wav",
    url: new URL("./sounds/openchart-confirm.wav", import.meta.url).href,
  },
  {
    id: "question",
    label: "Question",
    file: "openchart-question.wav",
    url: new URL("./sounds/openchart-question.wav", import.meta.url).href,
  },
  {
    id: "glass",
    label: "Glass",
    file: "openchart-glass.wav",
    url: new URL("./sounds/openchart-glass.wav", import.meta.url).href,
  },
  {
    id: "bong",
    label: "Bong",
    file: "openchart-bong.wav",
    url: new URL("./sounds/openchart-bong.wav", import.meta.url).href,
  },
  {
    id: "pluck",
    label: "Pluck",
    file: "openchart-pluck.wav",
    url: new URL("./sounds/openchart-pluck.wav", import.meta.url).href,
  },
] as const;

/** Saved values include silent delivery and the OS default; neither needs an asset. */
export const notificationSoundIds = [
  "none",
  "system",
  ...notificationSounds.map((sound) => sound.id),
] as const;
/** A catalog identity, never a URL or arbitrary filename from Config. */
export type NotificationSound = (typeof notificationSoundIds)[number];
