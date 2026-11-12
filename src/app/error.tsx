'use client';
import Link from 'next/link';
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return <main className="standalone"><div className="eyebrow">YOUR WORK HAS NOT BEEN RESET</div><h1>That view needs another try.</h1><p>A page could not finish rendering. Retry the view or return to Settings to inspect the demo workspace. Retrying does not resend a financial operation.</p><div className="inline-actions"><button className="button primary" onClick={retry}>Try this view again</button><Link className="button" href="/settings">Workspace settings</Link></div></main>;
}
