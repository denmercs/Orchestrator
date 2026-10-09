// Branch-prefix initials: the `branchInitials` setting, else the global git email, else the OS username.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { initialsFrom } from "../shared/naming";

const execFileAsync = promisify(execFile);

export type IdentityDeps = {
  readEmail: () => Promise<string | undefined>;
  readUsername: () => string | undefined;
};

// Global, not the repo's email: repos often carry a GitHub noreply address.
const readGlobalEmail = async () => {
  const { stdout } = await execFileAsync("git", ["config", "--global", "user.email"]);
  return stdout.trim() || undefined;
};

const defaultDeps: IdentityDeps = {
  readEmail: readGlobalEmail,
  readUsername: () => userInfo().username,
};

export const readBranchInitials = async (setting: string, deps: IdentityDeps = defaultDeps) => {
  const email = await deps.readEmail().catch(() => undefined);
  let username: string | undefined;
  try {
    username = deps.readUsername();
  } catch {
    username = undefined;
  }
  return initialsFrom({ setting, email, username });
};
