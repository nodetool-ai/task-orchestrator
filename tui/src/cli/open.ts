// The one thing `o` does that a test must never do: hand a url to the desktop.
// Kept in its own module and injected into the App, so the cockpit's tests
// exercise the choice (openUrlFor) without a process ever being spawned.

import { spawn } from "node:child_process";
import { openCommand } from "./commands.js";

/** Fire and forget: the launcher detaches, so closing the cockpit does not
 *  take the browser with it, and a missing `xdg-open` rejects rather than
 *  killing the process with an unhandled 'error' event. */
export function openInBrowser(url: string, platform: string = process.platform): Promise<void> {
  const { command, args } = openCommand(platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
