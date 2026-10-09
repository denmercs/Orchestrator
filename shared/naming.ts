// Naming rules for branches, commit subjects and PRs. Pure functions: the server and the client both import them.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Same rule as `slugOf` in server/harness-layout.ts (the client can't import server code).
const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");

// `dennis.mercado` → `dm`. Only 2–3 letter-only parts count; a single token is not guessed at.
const initialsOfName = (name: string): string | null => {
  const parts = name.split(/[._-]/);
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^[a-z]+$/i.test(part))) return null;
  return parts.map((part) => part[0]).join("").toLowerCase();
};

export const initialsFrom = ({
  setting,
  email,
  username,
}: {
  setting?: string;
  email?: string;
  username?: string;
}): string | null => {
  const fromSetting = (setting ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (fromSetting) return fromSetting;
  const local = email && !email.includes("noreply") ? email.split("@")[0] : "";
  return (local && initialsOfName(local)) || (username && initialsOfName(username)) || null;
};

export const branchName = ({ initials, key, title }: { initials?: string | null; key?: string; title: string }) =>
  [initials, key?.toLowerCase(), slugOf(title)].filter(Boolean).join("/");

const SUBJECT_MAX = 72;

// First non-empty line, minus a leading `S17:` / `ABC-123:` / `ABC-123 |`, cut at a word boundary.
export const cleanSubject = (text: string): string | null => {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const subject = line.replace(/^(?:S\d+|[A-Z][A-Z0-9]*-\d+)\s*[:|]\s*/, "").trim();
  if (subject.length <= SUBJECT_MAX) return subject || null;
  const space = subject.slice(0, SUBJECT_MAX + 1).lastIndexOf(" ");
  return subject.slice(0, space > 0 ? space : SUBJECT_MAX).trimEnd();
};

type PrStory = { id: string; title: string; jira: boolean };

export const prTitle = ({ id, title, jira }: PrStory) => (jira ? `${id} | ${title}` : title);

export const prHeadline = ({ id, title, jira }: PrStory) => `${jira ? "Jira" : "Story"}: ${id} — ${title}`;

// The server resolves initials (setting → global git email → OS username) and hands them to the client.
export const getBranchInitials = defineRpc({
  name: "orchestration.naming.branch-initials",
  input: z.object({}),
  output: z.object({ initials: z.string().nullable() }),
});
