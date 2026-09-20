import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dev badge sits over the builder's bottom-left chrome, which is where
  // the validation pill lives, so screenshots of the demo carry it otherwise.
  devIndicators: false,
  transpilePackages: ['@wfm/contracts', '@wfm/workflows'],
  env: {
    NEXT_PUBLIC_STUDIO_API_URL: process.env.STUDIO_API_BASE_URL ?? 'http://127.0.0.1:4103',
  },
};

export default nextConfig;
