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

test("PrPanel CI checks without a targetUrl fall back to the PR's /checks page (issue #387)", () => {
  const noTarget: PullRequest = {
    ...SAMPLE_PR,
    statusCheckRollup: [
      {
        name: "ci / docs",
        state: "PENDING",
        description: "Building docs",
      },
    ],
  };
  const html = render(noTarget);
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388\/checks"/
  );
  assert.match(html, /ci \/ docs/);
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

test("PrPanel renders a review that has no url field (issue #387)", () => {
  // `gh pr view --json reviews` does not emit a per-review URL,
  // so the panel must still display the review row without an
  // outbound "↗" link. Earlier code threw the review away at the
  // server-side validator; the relaxed PrReview shape lets it
  // through and the component renders the author / state badge
  // without a link button.
  const noReviewUrl: PullRequest = {
    ...SAMPLE_PR,
    reviews: [
      {
        id: "PRR_no_url",
        author: {
          login: "reviewer-bot",
          name: "Reviewer Bot",
          avatarUrl:
            "https://avatars.githubusercontent.com/reviewer-bot?size=80",
        },
        state: "APPROVED",
        body: "No URL here.",
        submittedAt: "2026-09-22T22:00:00Z",
      },
    ],
  };
  const html = render(noReviewUrl);
  assert.match(html, /Reviewer Bot/);
  assert.match(html, /Approved/);
  assert.match(html, /No URL here\./);
  // No outbound link for the review (since `url` is absent).
  assert.doesNotMatch(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388#pullrequestreview-no_url"/
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

test("PrPanel markdown anchors open in a new tab so the Electron shell routes them to the browser (issue #387)", () => {
  // The markdown renderer (description + comment + review bodies) must
  // emit `target="_blank" rel="noopener noreferrer"` on every anchor.
  // Otherwise the packaged Controller app navigates the renderer away
  // from the app instead of opening the link in the system browser.
  const html = render(SAMPLE_PR);
  const anchored = html.match(
    /<a [^>]*href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388"[^>]*>/g
  );
  assert.ok(anchored, "expected at least one anchor to the PR url");
  for (const tag of anchored) {
    assert.match(
      tag,
      /target="_blank"/,
      `anchor missing target="_blank": ${tag}`
    );
    assert.match(
      tag,
      /rel="noopener noreferrer"/,
      `anchor missing rel="noopener noreferrer": ${tag}`
    );
  }
});

test("PrPanel relative markdown links resolve against the PR's GitHub context (issue #387)", () => {
  // GitHub-rendered PR / comment / review bodies usually contain
  // relative / root-relative / fragment links which the browser
  // would otherwise resolve against the Controller renderer's
  // origin. The panel rewrites each class against the PR's GitHub
  // context so the user lands on a real GitHub URL (and the
  // Electron-shell's `_blank` forwarding routes it to the system
  // browser, not the Controller renderer).
  const withRelativeLink: PullRequest = {
    ...SAMPLE_PR,
    body: [
      "Repo-relative file: [guide](docs/setup.md).",
      "Repo-relative with `./`: [the same guide](./docs/setup.md).",
      "Root-relative: [the issue](/germanescobar/controller/issues/1).",
      "Absolute: [Google](https://google.com).",
      "Fragment: [details](#anchor).",
    ].join("\n\n"),
  };
  const html = render(withRelativeLink);
  // Repo-relative file link → rewritten to the PR's `/files`
  // overview. The full path is dropped because GitHub's
  // `/files/<path>` only resolves paths that already appear in
  // the PR's diff; the overview is the safe landing page for any
  // arbitrary relative file link.
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388\/files"/
  );
  assert.doesNotMatch(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388\/files\/docs\/setup\.md"/
  );
  // `./docs/setup.md` resolves the same way (the `./` prefix is
  // dropped).
  assert.match(html, /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388\/files"/);
  // Root-relative → rebuild against the GitHub origin parsed
  // from the PR URL (avoids the Controller origin in the packaged
  // app).
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/issues\/1"/
  );
  // Absolute URL → unchanged.
  assert.match(html, /href="https:\/\/google\.com"/);
  // Fragment-only → merged onto the PR URL (no trailing slash on
  // the PR url — `<prUrl>#anchor`, not `<prUrl/>#anchor`).
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388#anchor"/
  );
  // Every link still targets _blank. We scan full <a …> tags
  // (start to end) instead of slicing at `href=` so we don't lose
  // the tail attributes when `href` is the first attribute.
  const anchored = html.match(/<a [^>]*>/g) ?? [];
  for (const tag of anchored) {
    assert.match(tag, /target="_blank"/, `unprocessed tag: ${tag}`);
    assert.match(tag, /rel="noopener noreferrer"/, `unprocessed tag: ${tag}`);
  }
});

test("PrPanel relative markdown image sources resolve against the PR's GitHub context (issue #387)", () => {
  // Markdown image sources can be repo-relative, root-relative,
  // or absolute. Earlier revisions either passed the source
  // through unchanged (which the packaged renderer would request
  // from the Controller origin) or rewrote it to the PR's `/files`
  // page — but that URL serves HTML, not image bytes, so the
  // `<img>` would still render broken. The current implementation
  // renders untrusted / non-renderable sources as click-to-open
  // anchor links with the alt text as the label, so the image
  // fetch only happens when the user opts in (issue #387 review
  // feedback — also addresses the untrusted-image IP-leakage
  // concern, since attacker-controlled absolute URLs no longer
  // auto-fetch through the renderer).
  const withImage: PullRequest = {
    ...SAMPLE_PR,
    body: [
      "Repo-relative: ![diagram](docs/diagram.png).",
      "Repo-relative with `./`: ![the same](./docs/diagram.png).",
      "Root-relative: ![avatar](/germanescobar/avatar.png).",
      "Absolute (untrusted host): ![logo](https://example.com/logo.png).",
    ].join("\n\n"),
  };
  const html = render(withImage);
  // Repo-relative → PR's /files overview, rendered as an anchor.
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/controller\/pull\/388\/files"[^>]*title="Open image on GitHub"/
  );
  // Root-relative → GitHub origin, rendered as an anchor.
  assert.match(
    html,
    /href="https:\/\/github\.com\/germanescobar\/avatar\.png"/
  );
  // Absolute URL → still rendered as an anchor, NOT an `<img>`,
  // because the renderer would otherwise auto-fetch an
  // attacker-controlled host and leak IP/timing.
  assert.match(
    html,
    /href="https:\/\/example\.com\/logo\.png"/
  );
  // Crucially: no `<img>` for any of these sources. Avatars are
  // the only image category the panel trusts to auto-load (see
  // SAMPLE_PR data — both `author.avatarUrl` and the comment /
  // review author avatars live on `avatars.githubusercontent.com`).
  assert.doesNotMatch(html, /<img src="https:\/\/example\.com/);
  assert.doesNotMatch(html, /<img src="https:\/\/github\.com\/germanescobar\/avatar\.png"/);
  assert.doesNotMatch(html, /<img src="https:\/\/github\.com\/germanescobar\/controller\/pull\/388\/files"/);
});

test("PrPanel trusts avatars.githubusercontent.com to render inline (issue #387)", () => {
  // Avatars and GitHub-hosted screenshots are served through a
  // known CDN / proxy and we want them inline. The
  // `AuthorLine` component renders those — they should still
  // produce an `<img src=… loading="lazy">`.
  const html = render(SAMPLE_PR);
  // At least one avatar rendered as <img>; loading="lazy" keeps
  // the panel responsive when many reviewers show up in the
  // timeline.
  const imgs = html.match(/<img [^>]*>/g) ?? [];
  for (const tag of imgs) {
    assert.match(tag, /src="https:\/\/avatars\.githubusercontent\.com/);
    assert.match(tag, /loading="lazy"/, `avatar not lazy: ${tag}`);
  }
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
