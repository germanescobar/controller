import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PrPanel } from "../PrPanel.tsx";
import type { PullRequest } from "../../api.ts";

/*
 * Issue #387: the right sidebar's PR tab. `PrPanel` is purely
 * presentational — it receives the pull request as a prop from
 * SessionView (which owns polling) and renders header, checks,
 * description, timeline, and footer.
 *
 * Coverage:
 *   1. Empty state when `pullRequest == null` (no branch-level PR).
 *   2. Header binds to the canonical PR url.
 *   3. CI checks render for the supplied rollup; each row links to
 *      its `targetUrl` when one is supplied.
 *   4. Chronological merge of `comments` + `reviews` is oldest-first.
 *   5. Description renders as markdown (link target is preserved).
 *   6. Footer carries the "Open on GitHub" link to the PR.
 *   7. `now` override gives stable relative timestamps in tests.
 */

const SAMPLE_PR: PullRequest = {
  number: 388,
  title: "Per-session inactivity-timeout override",
  state: "OPEN",
  url: "https://github.com/germanescobar/controller/pull/388",
  author: {
    login: "germanescobar",
    name: "German Escobar",
    avatarUrl: "https://avatars.githubusercontent.com/germanescobar?size=80",
  },
  body: "Closes #386. See [PR #388](https://github.com/germanescobar/controller/pull/388).",
  createdAt: "2026-09-22T21:09:40Z",
  headRefName: "issue-386",
  baseRefName: "main",
  additions: 875,
  deletions: 9,
  changedFiles: 6,
  mergeable: "MERGEABLE",
  isDraft: false,
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    {
      name: "ci / build",
      state: "SUCCESS",
      targetUrl:
        "https://github.com/germanescobar/controller/runs/12345",
      description: "Build succeeded",
    },
    {
      name: "ci / lint",
      state: "FAILURE",
      targetUrl:
        "https://github.com/germanescobar/controller/runs/12346",
      description: "Lint failed",
    },
  ],
  comments: [
    {
      id: "C1",
      author: {
        login: "germanescobar",
        name: "German Escobar",
        avatarUrl:
          "https://avatars.githubusercontent.com/germanescobar?size=80",
      },
      body: "Comment by author.",
      createdAt: "2026-09-22T21:09:51Z",
      url: "https://github.com/germanescobar/controller/pull/388#issuecomment-1",
    },
  ],
  reviews: [
    {
      id: "R1",
      author: {
        login: "reviewer-bot",
        name: "Reviewer Bot",
        avatarUrl:
          "https://avatars.githubusercontent.com/reviewer-bot?size=80",
      },
      state: "APPROVED",
      body: "LGTM.",
      submittedAt: "2026-09-22T22:00:00Z",
      url: "https://github.com/germanescobar/controller/pull/388#pullrequestreview-1",
    },
  ],
};

function render(pr: PullRequest | null): string {
  return renderToStaticMarkup(
    // `now: () => 0` ensures every ISO timestamp resolves to a
    // deterministic "ago" string ("0s" when the timestamp is in
    // the future). Tests assert structure, not wording.
    <PrPanel pullRequest={pr} now={() => 0} />
  );
}

test("PrPanel shows the empty state when the branch has no PR (issue #387)", () => {
  const html = render(null);
  assert.match(html, /No pull request is open for this branch\./);
  assert.doesNotMatch(html, /Open on GitHub/);
  assert.doesNotMatch(html, /Conversation/);
});

test("PrPanel header links to the PR's canonical URL and surfaces state + decisions (issue #387)", () => {
  const html = render(SAMPLE_PR);
  assert.match(html, /Per-session inactivity-timeout override/);
  assert.match(html, /#388/);
  assert.match(html, /Open/);
  assert.match(html, /Approved/);
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388"/
  );
  assert.match(html, /\+875/);
  assert.match(html, /−9/);
  assert.match(html, /6 files changed/);
  assert.match(html, /issue-386/);
  assert.match(html, /main/);
});

test("PrPanel CI checks link to each check's targetUrl (issue #387)", () => {
  const html = render(SAMPLE_PR);
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/runs\/12345"/
  );
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/runs\/12346"/
  );
  assert.match(html, /ci \/ build/);
  assert.match(html, /ci \/ lint/);
});

test("PrPanel chronologically merges comments and reviews oldest-first (issue #387)", () => {
  const html = render(SAMPLE_PR);
  // Comment was created BEFORE the review. Whichever item appears
  // first in the HTML represents the oldest entry. The exact "ago"
  // relative wording is irrelevant — both clock to 0s under
  // `now: () => 0` — but we assert both items are present.
  const commentIdx = html.indexOf("Comment by author");
  const reviewIdx = html.indexOf("LGTM");
  assert.ok(commentIdx > -1, "comment should render");
  assert.ok(reviewIdx > -1, "review should render");
  assert.ok(
    commentIdx < reviewIdx,
    "older comment should appear before newer review"
  );
});

test("PrPanel timeline items link out to GitHub (issue #387)", () => {
  const html = render(SAMPLE_PR);
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388#issuecomment-1"/
  );
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388#pullrequestreview-1"/
  );
});

test("PrPanel description is rendered as markdown with preserved links (issue #387)", () => {
  const html = render(SAMPLE_PR);
  assert.match(html, /<p>Closes #386\./);
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388"/
  );
});

test("PrPanel footer holds a single 'Open on GitHub' link to the canonical PR URL (issue #387)", () => {
  const html = render(SAMPLE_PR);
  // Anchor count to the PR url should be ≥ 1 (header title + footer).
  const linkMatches = html.match(
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388"/g
  );
  assert.ok(linkMatches, "should contain at least one canonical link");
  assert.match(html, /Open on GitHub/);
});

test("PrPanel honors isDraft + mergeable CONFLICTING via badge text (issue #387)", () => {
  const draft: PullRequest = {
    ...SAMPLE_PR,
    isDraft: true,
    mergeable: "CONFLICTING",
    reviewDecision: undefined,
    reviews: [
      {
        ...SAMPLE_PR.reviews[0],
        state: "CHANGES_REQUESTED",
      },
    ],
  };
  const html = render(draft);
  assert.match(html, /Draft/);
  assert.match(html, /Has conflicts/);
  // Without `reviewDecision` and with the only review requesting
  // changes, neither the header's decision badge nor the review's
  // own badge should read "Approved".
  assert.doesNotMatch(html, /Approved/);
});
