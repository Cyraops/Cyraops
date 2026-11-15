import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";

/**
 * Every marketing route is prerendered to `public/<route>/index.html` by
 * `site-3d/prerender.mjs`. This turns that manifest into rewrites so a request
 * for `/catalogue` serves the static document instead of a 404: Googlebot gets
 * the content and the metadata in the first response, before any JavaScript.
 *
 * The manifest is written by the prerender step. If it is absent (a fresh clone
 * that has not built the site yet), the config still works — the site just falls
 * back to the previous single-document behaviour.
 */
function marketingRewrites() {
  const manifestPath = path.join(process.cwd(), "public", "routes.json");
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const { routes } = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { routes: string[] };
    return routes
      .filter((route) => route !== "/")
      .map((route) => ({
        source: route,
        destination: `${route}/index.html`,
      }));
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client"],
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [{ source: "/", destination: "/index.html" }, ...marketingRewrites()],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
