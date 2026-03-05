/** @type {import('next').NextConfig} */
const repoName = process.env.GITHUB_REPOSITORY?.replace(/^[^/]+\//, "") ?? "";
const useRepoBasePath = process.env.NEXT_USE_REPO_BASE_PATH === "true";
const basePath = useRepoBasePath && repoName ? `/${repoName}` : "";

const nextConfig = {
  reactStrictMode: true,
  output: "export",
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
};

export default nextConfig;
