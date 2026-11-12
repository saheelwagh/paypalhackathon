import type { Metadata } from 'next';
import './globals.css';
import './lancepal-theme.css';
import './lancepal-shell.css';
export const metadata: Metadata = { title: 'lancepal · Freelancer workspace', icons: { icon: '/icon.svg' }, description: 'Your freelance command center. Review scope, track funding, and direct your workspace with voice.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className="lancepal"><body>{children}</body></html>;
}
