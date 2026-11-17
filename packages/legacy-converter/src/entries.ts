import { defineEntry } from "@earendil-works/pi-durable";

export const historyNote = defineEntry<{ text: string; tone: "system" | "summary" }>("agents-in-the-cloud.history-note");
