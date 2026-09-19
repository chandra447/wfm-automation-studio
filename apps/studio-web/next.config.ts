import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@wfm/contracts', '@wfm/workflows'],
  env: {
    NEXT_PUBLIC_STUDIO_API_URL: process.env.STUDIO_API_BASE_URL ?? 'http://127.0.0.1:4103',
  },
};

export default nextConfig;
