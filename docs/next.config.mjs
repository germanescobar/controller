/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/controller',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
};

export default nextConfig;
