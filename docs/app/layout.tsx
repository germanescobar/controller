import type { ReactNode } from "react";

export const metadata = {
  title: "Controller Docs",
  description: "Public documentation for Controller.",
};

// Placeholder root layout. Commit 2 swaps in the Fumadocs theme provider
// and the docs route group. This file only needs to render its children
// so `next build` succeeds before any content routes exist.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
