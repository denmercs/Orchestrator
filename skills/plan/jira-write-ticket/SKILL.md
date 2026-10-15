---
name: jira-write-ticket
description: >
  Write and create a Jira bug, story, or task that matches how the team already
  writes tickets: learn the title pattern and description shape from the user's
  recent issues, rephrase the user's note into a proper title, find the right
  parent epic by its alias, then create the issue via Atlassian MCP. Use when the
  user says "add a ticket", "write a Jira story/bug", "log this in Jira", "put
  this under our <epic>", or shares a screenshot of a defect to file.
---

# Jira write ticket

Turn a one-line note (often with a screenshot) into a ticket that looks like the team wrote it.

## Principles

- **Copy the team, don't invent a template.** Read real tickets first. The team's habits beat any format in this skill.
- **Short beats thorough.** Most bugs are steps + expected + actual. Write a long root-cause write-up only when you actually did that investigation.
- **Only facts you have.** Take facts from the screenshot (app version, screen, the text on screen) and from what the user said. Say plainly when you made an assumption. Never make up repro steps, devices, or customer impact.
- **No product defaults in this skill.** Project keys, epic aliases ("our Platform epic"), and priority habits come from the user, the repo's docs, or memory.

## Workflow

1. **Get the cloud id.** `getAccessibleAtlassianResources`, then use the site that has Jira scopes.
2. **Learn the house style.** Search `reporter = currentUser() ORDER BY created DESC` (ask for only `summary`, `issuetype`, `parent`, `project`, `priority`, `labels`). Then fetch 3–4 tickets of the same type with full descriptions (`responseContentFormat: markdown`). Note:
   - **Title pattern.** Example: `Platform | Short problem statement` (`Web |`, `iOS |`, `Android & TV |`).
   - **Description shape.** Example: `Steps:` with `>` arrows, then a screenshot. Or Summary / Root cause / Fix for investigated bugs.
   - **Priority and labels.** Use the values those tickets usually have. Leave fields empty when the team usually does.
3. **Resolve the parent.** "Under our X" means an epic alias. Search `issuetype = Epic AND summary ~ "X" ORDER BY created DESC`. Choose the newest epic that isn't Done. For recurring epics (quarterly or per sprint) that means the current period's epic. If two open epics both fit, ask the user.
4. **Rephrase the title.** Use the team's pattern. State the visible problem, not the fix. Example: "Order footnote has a light background on darkmode" becomes `Mobile | Order footnote content renders with a light background in dark mode`.
5. **Write the description** in the team's shape. Default for a bug:

   ```
   Steps:
   <precondition> > <screen> > <action>

   Expected: <what should happen>

   Actual: <what happens, quoting on-screen text if useful>

   App version: <from the screenshot, if shown>
   ```

   For a story or task, use whatever the team uses (user story, acceptance criteria, or a plain list). Keep it this short.
6. **Create** with `createJiraIssue`: `projectKey` from the parent epic, `issueTypeName`, `parent` = the epic key, `contentFormat: markdown`, and priority in `additional_fields`.
7. **Report back** with the key and link, title, type, parent (with why you chose it), and priority. Then list:
   - **Attach the screenshot yourself.** The MCP can't upload images.
   - Any assumption the user should check, such as the repro path or the platform.

## Rules of thumb

- If the user named the epic and the meaning is clear, just create the ticket. That request is your go-ahead. Ask first only when the parent, project, or type is unclear.
- One ticket per problem. If the screenshot shows two defects, offer a second ticket.
- No `Platform |` prefix when the team doesn't use one for that kind of ticket. Follow step 2.

## No MCP

Print the finished title, type, parent, priority, and description for the user to paste into Jira.

## Related

- `jira-close-story` moves a ticket to Done after merge.
- `major-feature-roadmap` creates many epics and stories at once.
- Prose follows `anti-slop`.
