# Save Character List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual start-screen list where players can see, continue, and delete every valid character save.

**Architecture:** Extend the existing local Node service with a collection `GET /api/saves` endpoint that derives safe metadata from valid save envelopes and returns newest saves first. Render that collection in the existing plain HTML/CSS/JavaScript start modal, reusing the current per-player load and delete APIs.

**Tech Stack:** Node.js HTTP server, ES modules, browser DOM APIs, plain CSS, Node test runner

---

### Task 1: Save collection API

**Files:**
- Modify: `test/server.test.mjs`
- Modify: `server.mjs`

- [ ] **Step 1: Write the failing API test**

Add a test that writes saves for `甲` and `乙`, creates an invalid JSON file in the saves directory, requests `GET /api/saves`, and asserts that the response contains only the two valid metadata records with `playerName`, `savedAt`, `phase`, `level`, and `levelName`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test --test-name-pattern='列出所有有效存档' test/server.test.mjs`

Expected: FAIL because `/api/saves` currently returns 404.

- [ ] **Step 3: Implement the collection endpoint**

Import `readdir`, read `data/saves` with an empty fallback for a missing directory, inspect only `.json` files, validate each parsed save with `validateSaveEnvelope`, discard invalid records, map valid saves to public metadata, sort descending by `savedAt`, and return `{ saves }` from `GET /api/saves`. Reject other methods with 405.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test --test-name-pattern='列出所有有效存档' test/server.test.mjs`

Expected: PASS.

### Task 2: Visual character/save list

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add semantic list markup and responsive styles**

Add a labelled save-list section to the start modal with an `aria-live` status region. Style compact save cards, metadata, continue/delete buttons, focus-visible states, empty/loading states, and a narrow-screen stacked layout using the existing grayscale visual language.

- [ ] **Step 2: Add safe DOM rendering and refresh logic**

Implement `refreshSaveList()` and `renderSaveList()` using `createElement` and `textContent`. Show every API metadata record, format phase/level/time, highlight the name currently in the input, and handle loading, empty, and error states.

- [ ] **Step 3: Reuse load/delete actions**

Extract save continuation into `continueSave(name)`. Wire each list button to select and continue a character. Wire delete buttons to the existing `DELETE /api/saves/:name` endpoint after confirmation, then refresh both the list and the typed-name metadata.

- [ ] **Step 4: Keep the list synchronized**

Refresh it after service connection, save deletion, and start-screen display. Update selection styling when the name input changes, without changing the existing overwrite confirmation behavior.

### Task 3: Verification and documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document save-list behavior**

State that the start page lists all character saves and that each normalized player name owns one save slot.

- [ ] **Step 2: Run the full automated test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Check the browser module syntax**

Extract the module script from `index.html` to a temporary `.mjs` file and run `node --check` on it.

Expected: no syntax errors.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check && git diff --stat`

Expected: no whitespace errors and changes limited to the plan, server, server tests, start-screen UI, and README.
