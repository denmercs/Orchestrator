// Unread and reply identity for the sidebar Sulti item (see CONTEXT.md, Sulti sidebar).
export function replyFingerprint(reply: string | null): string {
  return reply?.trim() ?? "";
}

/** True when there is a non-empty reply the user has not marked seen yet. */
export function hasUnread(reply: string | null, lastSeenReply: string): boolean {
  const fp = replyFingerprint(reply);
  return fp.length > 0 && fp !== lastSeenReply.trim();
}