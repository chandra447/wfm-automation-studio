import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { DemoActorProvider } from '@/components/demo-actor-provider';
import './globals.css';
import { Space_Grotesk, Noto_Sans } from "next/font/google";
import { cn } from "@/lib/utils";

const notoSansHeading = Noto_Sans({subsets:['latin'],variable:'--font-heading'});

const spaceGrotesk = Space_Grotesk({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: 'WFM Automation Studio',
  description: 'Customer-authored workflows over workforce management events, with human approval on anything that moves pay.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `dark` selects the preset's dark palette. The studio is dark-first, so
    // without it the shadcn components would use the preset's light values on
    // the studio's dark surfaces.
    <html
      lang="en"
      className={cn('dark', 'font-sans', spaceGrotesk.variable, notoSansHeading.variable)}
    >
      <body>
        <DemoActorProvider>
          <AppShell>{children}</AppShell>
        </DemoActorProvider>
      </body>
    </html>
  );
}
