import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";
import "fumadocs-ui/style.css";

// v1 is English-only. RootProvider wraps the rest of the app with
// Fumadocs' theme/search/page-tree context and handles dark-mode
// toggling via the `next-themes` integration.
export const metadata = {
  title: "Controller Docs",
  description: "Public documentation for Controller.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}