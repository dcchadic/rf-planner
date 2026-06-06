import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// ✅ Use supported font
const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RF Planner",
  description: "RF Network Planning Tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
  <body className={`${inter.className} min-h-full flex flex-col`}>
    {children}
  </body>
</html>
  );
}