const NO_REPLY = "No reply from Sulti yet";

// The strip's reply preview: the plain-text reply, trimmed. The component clips it to 3 lines.
export function previewText(reply: string | null): string {
  const text = reply?.trim();
  return text ? text : NO_REPLY;
}

// The line under the text box after a send: what Sulti said, else the router's note, else nothing.
export function statusLine(result: { spoken: string[]; note: string | null }): string {
  if (result.spoken.length > 0) {
    return result.spoken.join(" ");
  }
  return result.note ?? "";
}

// Send is enabled for non-blank text while no send is in flight.
export function canSend(text: string, busy: boolean): boolean {
  return !busy && text.trim().length > 0;
}
