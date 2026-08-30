import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Wild Goose: Open Earth',
  description:
    'Fly a Canada goose through a living OpenStreetMap world, land with a splash, waddle across campus, and stop traffic.',
  openGraph: {
    title: 'Wild Goose: Open Earth',
    description:
      'Take wing above Western Michigan University, find open water, and explore Kalamazoo as one very determined goose.',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Wild Goose flying above a lakeside campus' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Wild Goose: Open Earth',
    description: 'A playful 3D goose flight game over a living OpenStreetMap world.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
