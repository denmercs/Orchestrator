import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Secrets live in the macOS login Keychain, added by the user with
// `security add-generic-password -U -a "$USER" -s <service> -w`, so they never sit in a file.
// Returns "" when the item is missing or this is not macOS. Never log the value.
export async function readKeychainSecret(service: string): Promise<string> {
  if (process.platform !== "darwin") {
    return "";
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}
