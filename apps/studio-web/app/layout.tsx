import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { DemoActorProvider } from '@/components/demo-actor-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'WFM Automation Studio',
  description: 'Customer-authored workflows over workforce management events, with human approval on anything that moves pay.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DemoActorProvider>
          <AppShell>{children}</AppShell>
        </DemoActorProvider>
      </body>
    </html>
  );
}
