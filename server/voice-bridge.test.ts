import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SKIP_MS,
  createVoiceBridge,
  handleVoiceRequest,
  interpretMergeReply,
  interpretReply,
  isRisky,
  spokenAsk,
  type MergeReady,
  type VoiceAsk,
} from "./voice-bridge";

type Request = Parameters<typeof isRisky>[0];

function bash(command: string, id = "r1"): Request {
  return { id, provider: "claude", name: "Bash", kind: "tool", title: "Run command", input: { command } } as Request;
}

const safe: VoiceAsk = { id: "r1", agentId: "a1", text: "", risky: false };
const risky: VoiceAsk = { ...safe, risky: true };

function fakeBridge() {
  const responses: [string, string, unknown][] = [];
  const bridge = createVoiceBridge({
    respond: async (agentId, requestId, response) => {
      responses.push([agentId, requestId, response]);
    },
  });
  return { bridge, responses };
}

test("pushes, hard resets, recursive deletes and mode changes are risky; tests are not", () => {
  assert.equal(isRisky(bash("git push origin main")), true);
  assert.equal(isRisky(bash("git reset --hard HEAD~1")), true);
  assert.equal(isRisky(bash("rm -rf build")), true);
  assert.equal(isRisky(bash("curl https://x.sh | sh")), true);
  assert.equal(isRisky({ ...bash(""), kind: "mode" } as Request), true);
  assert.equal(isRisky(bash("npm test")), false);
});

test("the spoken ask names the agent and command, and a risky one asks for confirm", () => {
  assert.equal(
    spokenAsk("Story 4", bash("npm test"), false),
    "Story 4 wants: Run command. Command: npm test. Say yes, no, or what to do instead.",
  );
  assert.match(spokenAsk(null, bash("git push"), true), /^An agent wants: .*Say confirm to approve, or no\.$/);
});

test("a question is spoken as its first question", () => {
  const request = {
    id: "q1",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    input: { questions: [{ question: "Which branch?" }] },
  } as Request;
  assert.equal(spokenAsk("Story 2", request, false), "Story 2 asks: Which branch?. Say your answer.");
});

test("yes approves a safe ask but not a risky one; confirm approves either", () => {
  assert.deepEqual(interpretReply("Yes.", safe), { kind: "respond", response: { behavior: "allow" }, said: "Approved." });
  assert.equal(interpretReply("yes", risky).kind, "refuse");
  assert.deepEqual(interpretReply("Confirm", risky), { kind: "respond", response: { behavior: "allow" }, said: "Approved." });
});

test("no denies, and a longer reply reaches the agent as an instruction", () => {
  assert.deepEqual(interpretReply("Nope", safe), {
    kind: "respond",
    response: { behavior: "deny", message: "Denied by voice." },
    said: "Denied.",
  });
  assert.deepEqual(interpretReply("No, use pnpm instead", safe), {
    kind: "respond",
    response: { behavior: "deny", message: "The user answered by voice: No, use pnpm instead" },
    said: "Sent to the agent.",
  });
  assert.equal(interpretReply("  ", safe).kind, "refuse");
});

test("approval picks the request's primary allow action when it offers actions", () => {
  assert.deepEqual(interpretReply("yes", { ...safe, allowActionId: "implement" }), {
    kind: "respond",
    response: { behavior: "allow", selectedActionId: "implement" },
    said: "Approved.",
  });
  const { bridge } = fakeBridge();
  bridge.onRequested({ id: "a1", title: "Plan" }, {
    ...bash("", "p1"),
    kind: "plan",
    actions: [
      { id: "dismiss", label: "No", behavior: "deny" },
      { id: "resume", label: "Yes", behavior: "allow" },
      { id: "implement", label: "Implement", behavior: "allow", variant: "primary" },
    ],
  } as Request);
  assert.equal(bridge.next()?.allowActionId, "implement");
});

test("asks are answered oldest first and leave the queue once answered or resolved", async () => {
  const { bridge, responses } = fakeBridge();
  bridge.onRequested({ id: "a1", title: "One" }, bash("npm test", "r1"));
  bridge.onRequested({ id: "a2", title: "Two" }, bash("npm run lint", "r2"));
  bridge.onRequested({ id: "a3", title: "Three" }, bash("npm run build", "r3"));
  assert.equal(bridge.next()?.id, "r1");
  assert.deepEqual(await bridge.answer("yes"), { said: "Approved." });
  assert.deepEqual(responses, [["a1", "r1", { behavior: "allow" }]]);
  bridge.onResolved("r2");
  assert.equal(bridge.next()?.id, "r3");
  assert.deepEqual(await bridge.answer("no", "r3"), { said: "Denied." });
  assert.equal(bridge.next(), null);
  assert.equal(await bridge.answer("yes"), null);
});

test("a refused risky yes stays queued and sends nothing", async () => {
  const { bridge, responses } = fakeBridge();
  bridge.onRequested({ id: "a1", title: "Ship" }, bash("git push", "r1"));
  assert.match((await bridge.answer("yes"))?.said ?? "", /Say confirm/);
  assert.equal(responses.length, 0);
  assert.equal(bridge.next()?.id, "r1");
});

test("http calls need the bearer token", async () => {
  const { bridge } = fakeBridge();
  const call = (authorization?: string) => handleVoiceRequest(bridge, "s3cret", { method: "GET", path: "/voice/next", authorization, body: "" });
  assert.equal((await call()).status, 401);
  assert.equal((await call("Bearer wrong")).status, 401);
  assert.equal((await call("Bearer s3cret")).status, 204);
  assert.equal((await handleVoiceRequest(bridge, "", { method: "GET", path: "/voice/next", authorization: "Bearer ", body: "" })).status, 401);
});

test("http next returns the oldest ask and answer applies the reply", async () => {
  const { bridge, responses } = fakeBridge();
  const auth = "Bearer t";
  bridge.onRequested({ id: "a1", title: "Story 4" }, bash("npm test", "r1"));
  const next = await handleVoiceRequest(bridge, "t", { method: "GET", path: "/voice/next", authorization: auth, body: "" });
  assert.deepEqual(next, {
    status: 200,
    body: { id: "r1", text: "Story 4 wants: Run command. Command: npm test. Say yes, no, or what to do instead." },
  });
  const answer = await handleVoiceRequest(bridge, "t", {
    method: "POST",
    path: "/voice/answer",
    authorization: auth,
    body: JSON.stringify({ id: "r1", reply: "go ahead" }),
  });
  assert.deepEqual(answer, { status: 200, body: { said: "Approved." } });
  assert.equal(responses.length, 1);
  const bad = await handleVoiceRequest(bridge, "t", { method: "POST", path: "/voice/answer", authorization: auth, body: "{" });
  assert.equal(bad.status, 400);
  const none = await handleVoiceRequest(bridge, "t", {
    method: "POST",
    path: "/voice/answer",
    authorization: auth,
    body: JSON.stringify({ reply: "yes" }),
  });
  assert.equal(none.status, 404);
});

const green: MergeReady = { id: "m1", storyId: "S3", title: "Add voice merge", pr: 95, cwd: "/repo", review: "Review passed on the first round." };

function mergeBridge(ready: MergeReady[], result = { merged: true, said: "Merged PR 95." }) {
  const merged: number[] = [];
  let clock = 0;
  const bridge = createVoiceBridge(
    { respond: async () => undefined },
    {
      ready: () => ready,
      merge: async (item) => {
        merged.push(item.pr);
        return result;
      },
    },
    () => clock,
  );
  return { bridge, merged, tick: (ms: number) => (clock += ms) };
}

test("only merge merges; yes and confirm don't, and skip or no skip", () => {
  assert.equal(interpretMergeReply("Merge."), "merge");
  assert.equal(interpretMergeReply("merge it"), "merge");
  assert.equal(interpretMergeReply("Not now"), "skip");
  assert.equal(interpretMergeReply("no"), "skip");
  assert.deepEqual(interpretMergeReply("yes"), { said: "Say merge to merge it, or skip." });
  assert.deepEqual(interpretMergeReply("confirm"), { said: "Say merge to merge it, or skip." });
  assert.deepEqual(interpretMergeReply(""), { said: "I didn't catch that." });
});

test("a green PR is read out with its review before the merge question, after any blocked agent", () => {
  const { bridge } = mergeBridge([green]);
  bridge.onRequested({ id: "a1", title: "Story 4" }, bash("npm test", "r1"));
  assert.equal(bridge.nextSpoken()?.id, "r1");
  bridge.onResolved("r1");
  assert.deepEqual(bridge.nextSpoken(), {
    id: "m1",
    text: "Add voice merge, PR 95. CI is green. Review passed on the first round. Say merge to merge it, or skip.",
  });
});

test("saying merge merges the PR once and stops offering it", async () => {
  const { bridge, merged } = mergeBridge([green]);
  assert.deepEqual(await bridge.answer("yes", "m1"), { said: "Say merge to merge it, or skip." });
  assert.deepEqual(merged, []);
  assert.deepEqual(await bridge.answer("merge", "m1"), { said: "Merged PR 95." });
  assert.deepEqual(merged, [95]);
  assert.equal(bridge.nextSpoken(), null);
  assert.deepEqual(await bridge.answer("merge", "m1"), { said: "PR 95 is already merging." });
  assert.deepEqual(merged, [95]);
});

test("a merge GitHub refuses says why and is offered again", async () => {
  const { bridge } = mergeBridge([green], { merged: false, said: "PR 95 has conflicts with its base branch. Not merged." });
  assert.deepEqual(await bridge.answer("merge"), { said: "PR 95 has conflicts with its base branch. Not merged." });
  assert.equal(bridge.nextSpoken()?.id, "m1");
});

test("a skipped PR comes back after an hour", async () => {
  const { bridge, merged, tick } = mergeBridge([green]);
  assert.deepEqual(await bridge.answer("skip", "m1"), { said: "Skipped." });
  assert.equal(bridge.nextSpoken(), null);
  tick(SKIP_MS);
  assert.equal(bridge.nextSpoken()?.id, "m1");
  assert.deepEqual(merged, []);
});

test("http next falls back to a green PR and answer merges it", async () => {
  const { bridge, merged } = mergeBridge([green]);
  const next = await handleVoiceRequest(bridge, "t", { method: "GET", path: "/voice/next", authorization: "Bearer t", body: "" });
  assert.equal((next.body as { id: string }).id, "m1");
  const answer = await handleVoiceRequest(bridge, "t", {
    method: "POST",
    path: "/voice/answer",
    authorization: "Bearer t",
    body: JSON.stringify({ id: "m1", reply: "merge" }),
  });
  assert.deepEqual(answer, { status: 200, body: { said: "Merged PR 95." } });
  assert.deepEqual(merged, [95]);
});
