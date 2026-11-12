import type { NextConfig } from 'next';
const config: NextConfig = { reactStrictMode: true, poweredByHeader: false, devIndicators: false, turbopack: { root: process.cwd() }, outputFileTracingExcludes: { '/*': ['./.env*', './.local/**/*'] } };
export default config;
