import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

import { AERIAL_HOST_ORIGIN, AERIAL_SPAWN_PRELOAD_URL } from './world-imagery';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Kalamazoo Goose',
  description:
    'Fly, splash down, recruit a flock, and cause campus chaos as a Canada goose at Western Michigan University.',
  openGraph: {
    title: 'Kalamazoo Goose',
    description:
      'Take wing above Western Michigan University, recruit a flock, and explore Kalamazoo as one very determined goose.',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Kalamazoo Goose flying above Western Michigan University',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kalamazoo Goose',
    description:
      'A chaotic 3D goose sandbox set around Western Michigan University.',
    images: ['/og.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0b2a25',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preconnect"
          href={AERIAL_HOST_ORIGIN}
          crossOrigin="anonymous"
        />
        <link rel="dns-prefetch" href={AERIAL_HOST_ORIGIN} />
        <link
          rel="preload"
          as="image"
          href={AERIAL_SPAWN_PRELOAD_URL}
          crossOrigin="anonymous"
          fetchPriority="high"
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
