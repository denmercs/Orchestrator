// The testing-guidelines skill: how Implement writes tests and how Review judges them. The plugin
// writes it into each Implement and Review worktree as TESTING_SKILL_PATH (under .harness/, kept out of
// git) and the step prompt points at it. Plan, Diagnose, the PR step and Fix CI never get it, so their
// context stays small. Its text lives here, not in skills/, so link-kit never makes it a global skill
// that every agent in every repo loads.
//
// A repo overrides it in `.orchestrator/pipeline.json` with `"testingSkill"`: a repo-relative path to its
// own skill file, or `false` to load none (see shared/repo-pipeline.ts and server/testing-skill.ts).

import type { LoopStep } from "./initiative-loop";

export const TESTING_SKILL_NAME = "testing-guidelines";
export const TESTING_SKILL_PATH = `.harness/skills/${TESTING_SKILL_NAME}/SKILL.md`;

// The steps that write or judge tests. Implement covers its cycle agents, the subagent parent (whose
// cycle brief carries the pointer) and the review-fix rounds. Fix CI ("fix") repairs red checks and does not get it.
export const TESTING_STEPS: readonly LoopStep[] = ["implement", "review"];

export function usesTestingSkill(step: string): boolean {
  return (TESTING_STEPS as readonly string[]).includes(step);
}

// The prompt line for a step. Empty for steps outside TESTING_STEPS or when no skill path is set.
export function testingLine(step: string, path: string | undefined): string {
  if (!path || !usesTestingSkill(step)) return "";
  return step === "review"
    ? `Judge every new or changed test against the testing guidelines in \`${path}\` (read it first; its checklist is the bar). A test that breaks them is a finding.`
    : `Read the testing guidelines in \`${path}\` before you write a test, and follow them.`;
}

export const TESTING_SKILL = `---
name: testing-guidelines
description: How to write and review tests - behavior over implementation, no false positives, accessible Testing Library queries, userEvent, correct async waits, typed ES-module mocks, clean setup and teardown. Use when writing tests in Implement or judging them in Review.
---

# Testing guidelines

Good tests give confidence to refactor and deploy. A test that doesn't is not a good test.

Aim for tests that are **user-centric** (behavior, not implementation), **maintainable**, **reliable** (no false positives, no flakes) and **simple** (KISS, YAGNI, DRY). Follow the repo's own test conventions first; this skill fills the gaps.

## Core rules

1. **ES module \`import\` only, never \`require()\`.** \`require()\` drops TypeScript types, mixes module systems and is flagged by lint. Import mocked modules too, and cast them:

   \`\`\`typescript
   import { usePostsResults } from '../../hooks/usePostsResults';
   jest.mock('../../hooks/usePostsResults');
   const mockUsePostsResults = usePostsResults as jest.MockedFunction<typeof usePostsResults>;
   mockUsePostsResults.mockReturnValue({ removeItems: [1, 2, 3] });
   \`\`\`

2. **Test what the user sees and does, not implementation details.** No component state, instance methods, class names or internal spinners.

   \`\`\`typescript
   // ❌ expect(component.state.isOpen).toBe(true);
   // ✅
   expect(screen.getByRole('dialog')).toBeInTheDocument();
   \`\`\`

3. **No \`data-testid\`.** Query the way a user finds things (\`getByRole('button', { name: /submit/i })\`). If nothing accessible exists, add proper ARIA (a label, a role) rather than a test id.

4. **No false positives: a test must fail when the feature breaks.** Prove it: revert the production change and watch the test fail. Avoid assertions that can't fail or don't test the behavior:
   - \`expect(mockFn).toBeDefined()\`, or only checking that an element exists when the story is about what it does.
   - \`expect(mockFn).not.toHaveBeenCalled()\` on its own, with nothing that would have called it. A negative assertion needs a positive one beside it (the error is shown **and** the API was not called).
   - Rendering or importing something with no assertion about its behavior.

   \`\`\`typescript
   // ✅ act, then assert the effect
   await userEvent.click(screen.getByRole('button', { name: /save/i }));
   expect(mockSave).toHaveBeenCalledWith(expectedData);
   expect(screen.getByText(/saved/i)).toBeInTheDocument();
   \`\`\`

5. **Arrange, Act, Assert, with short comments** saying what is tested, why it matters, and any non-obvious setup.

6. **Test both success and failure:** error states, empty states, validation messages and edge cases, not only the happy path.

## Testing Library

- **\`userEvent\`, not \`fireEvent\`**, and \`await\` it: \`await userEvent.click(button)\`. It simulates real typing, focus and blur (\`await userEvent.tab()\` triggers blur validation).
- **Query through \`screen\`**, not queries destructured from \`render\`.
- **Wait for async UI** with \`findBy*\` or \`await waitFor(() => expect(...))\`. Never assert an async result right after the action, and never use arbitrary sleeps. Assert loading states disappear with \`queryBy*\` + \`not.toBeInTheDocument()\`.
- **No DOM traversal:** no \`.closest()\`, \`.querySelector()\`, \`container.querySelector\`, \`.parentElement\`, \`.firstChild\`. Query the element itself (\`getByRole('button', { name: /delete/i })\`, \`getByLabelText(/email/i)\`).
- **Query priority:**
  1. Accessible: \`getByRole\` (with \`name\`), \`getByLabelText\`, \`getByPlaceholderText\`, \`getByText\`.
  2. Semantic: \`getByDisplayValue\`, \`getByAltText\`, \`getByTitle\`.
  3. Anything else (\`querySelector\`, class or tag selectors) is a smell. Fix the markup's accessibility instead.
- **Hooks:** test them with \`renderHook\` and assert \`result.current\` before and after \`waitFor\`, including the error path.
- **Accessibility:** where the repo has \`jest-axe\`, a component test can assert \`expect(await axe(container)).toHaveNoViolations()\`.
- **Snapshots sparingly**, only for truly static output. Prefer asserting specific text, roles and headings.

## Jest

- **Describe by feature and condition:** \`describe('Feature: Post editor') > describe('when the user is not authenticated') > it('shows an auth error')\`. Test names state the behavior.
- **Clean up between tests:** \`jest.clearAllMocks()\` in \`beforeEach\`/\`afterEach\` so a mock from one test never leaks into the next. Restore spies you replace (\`consoleError.mockRestore()\`), real timers (\`jest.useRealTimers()\`) and storage (\`localStorage.clear()\`).
- **Use the right matcher:** \`toBe\` for primitives, \`toEqual\` for deep equality, \`toMatchObject\` for partial objects, \`toHaveLength\`/\`toContain\` for arrays, \`toHaveBeenCalledTimes\`/\`toHaveBeenCalledWith\` for calls, \`toHaveValue\`/\`toBeDisabled\`/\`toHaveTextContent\` for elements.

## Mocking

- **Mock only external boundaries** (API clients, network, platform APIs, timers, storage). Mocking the component or module under test makes the test meaningless.
- **Module mocks:** \`jest.mock('../../services/apiService', () => ({ fetchPosts: jest.fn() }))\` at the top, ES-import the module, set a default in \`beforeEach\`, and override per test with \`(apiService.fetchPosts as jest.Mock).mockResolvedValue(...)\` or \`mockRejectedValue(new Error(...))\` for the error path.
- **Spies:** \`jest.spyOn(api, 'fetchPosts').mockResolvedValue(posts)\`; clear or restore after each test.
- **Timers:** \`jest.useFakeTimers()\` in \`beforeEach\`, \`jest.advanceTimersByTime(ms)\` in the test, \`jest.useRealTimers()\` in \`afterEach\`.
- **Storage and globals:** provide a small in-memory \`localStorage\` (\`getItem\`, \`setItem\`, \`removeItem\`, \`clear\`) and clear it after each test; stub globals such as \`wp.i18n.__\` to return their input.
- **Silence expected errors** (an error boundary test) with \`jest.spyOn(console, 'error').mockImplementation()\` and restore it after.

## WordPress

- **Data stores:** build a fresh registry per test (\`createRegistry()\` + \`registerStore\`) in \`beforeEach\`, dispatch actions and assert selectors, so no state leaks between tests.
- **Hooks from \`@wordpress/data\`:** \`jest.mock('@wordpress/data', () => ({ useSelect: jest.fn(), useDispatch: jest.fn() }))\`, then type the mock with \`jest.MockedFunction\`.
- **REST calls:** \`jest.mock('@wordpress/api-fetch')\`, resolve it with a realistic response shape (e.g. \`title: { rendered }\`), assert the rendered result **and** the request (\`expect(apiFetch).toHaveBeenCalledWith({ path: '/wp/v2/posts' })\`).

## Checklist (write and review against it)

- [ ] ES module imports only, no \`require()\`; mocked functions typed
- [ ] Tests user-visible behavior, not implementation details
- [ ] No \`data-testid\`; accessible queries; no DOM traversal
- [ ] \`userEvent\` (awaited), not \`fireEvent\`; queries via \`screen\`
- [ ] Async results awaited with \`findBy*\` / \`waitFor\`
- [ ] Mocks cleared or restored between tests; only external boundaries mocked
- [ ] Fails when the feature breaks (checked by reverting the change); no meaningless assertions
- [ ] Arrange-Act-Assert with short comments; clear, behavior-named tests
- [ ] Success, error, validation and edge cases covered
- [ ] Appropriate Jest matchers

## References

- Testing Library: https://testing-library.com/docs/react-testing-library/intro/
- Jest: https://jestjs.io/docs/getting-started
- Common mistakes with React Testing Library: https://kentcdodds.com/blog/common-mistakes-with-react-testing-library
- Testing implementation details: https://kentcdodds.com/blog/testing-implementation-details
`;
