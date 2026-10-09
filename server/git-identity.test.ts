import assert from "node:assert/strict";
import { test } from "node:test";
import { readBranchInitials } from "./git-identity";

const deps = (email: string | undefined, username: string | undefined) => ({
  readEmail: async () => email,
  readUsername: () => username,
});

test("readBranchInitials prefers the setting over the email and username", async () => {
  assert.equal(await readBranchInitials("JD", deps("dennis.mercado@lifeway.com", "dennis.mercado")), "jd");
});

test("readBranchInitials takes initials from the global email's local part", async () => {
  assert.equal(await readBranchInitials("", deps("dennis.mercado@lifeway.com", "jsmith")), "dm");
});

test("readBranchInitials skips a noreply email and falls through to the username", async () => {
  assert.equal(
    await readBranchInitials("", deps("12239322+denmercs@users.noreply.github.com", "dennis.mercado")),
    "dm",
  );
});

test("readBranchInitials gives nothing for a single-token username", async () => {
  assert.equal(await readBranchInitials("", deps(undefined, "jsmith")), null);
});

test("readBranchInitials falls through when the email reader throws", async () => {
  const throwing = {
    readEmail: async (): Promise<string | undefined> => {
      throw new Error("git not found");
    },
    readUsername: () => "dennis.mercado",
  };
  assert.equal(await readBranchInitials("", throwing), "dm");
});

test("readBranchInitials falls through when the username reader throws", async () => {
  const throwing = {
    readEmail: async () => undefined,
    readUsername: (): string | undefined => {
      throw new Error("no passwd entry");
    },
  };
  assert.equal(await readBranchInitials("", throwing), null);
});
