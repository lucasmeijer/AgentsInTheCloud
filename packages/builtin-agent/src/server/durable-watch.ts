import type { Context, WatchCall } from "@earendil-works/chord";

export function onValues<T>(listener: (value: T, context: Context) => void | Promise<void>) {
  return async (call: WatchCall<T>, context: Context) => {
    if (call.kind === "failed") throw call.error;
    await listener(call.value, context);
  };
}
