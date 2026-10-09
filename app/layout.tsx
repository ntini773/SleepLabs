import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resting Notes — Listening Study",
  description: "A quiet listening study prototype.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
