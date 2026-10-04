import type { Config } from "./config.ts";

function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]!);
}

export function canIndex(config: Config, preview: boolean): boolean {
  return config.publicIndexing === true && !preview &&
    new URL(config.origin).protocol === "https:";
}

export function renderLanding(
  source: string,
  config: Config,
  indexable: boolean,
): string {
  const origin = escapeMarkup(config.origin);
  const metadata = [
    `<meta name="robots" content="${
      indexable ? "index, follow" : "noindex, nofollow"
    }">`,
    `<link rel="canonical" href="${origin}/">`,
    `<meta property="og:url" content="${origin}/">`,
    `<meta property="og:image" content="${origin}/social.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Dayfold — A personal to-do list you can talk to. Less to keep in your head.">`,
    `<meta name="twitter:image" content="${origin}/social.png">`,
    `<meta name="twitter:image:alt" content="Dayfold — A personal to-do list you can talk to. Less to keep in your head.">`,
  ].join("\n");
  const access = config.openrouterKey
    ? "This app provides chat access. You can optionally use your own OpenRouter key; usage is billed to the account whose key is used."
    : "You will need your own OpenRouter API key to chat after signing in. OpenRouter usage is billed to your OpenRouter account.";
  return source.replace(/\{\{\s*PUBLIC_METADATA\s*\}\}/g, () => metadata)
    .replace(/\{\{\s*CHAT_ACCESS\s*\}\}/g, () => access);
}

export function robots(config: Config, indexable: boolean): string {
  return indexable
    ? `User-agent: *\nAllow: /\nDisallow: /auth/\nDisallow: /api/\nSitemap: ${config.origin}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n";
}

export function sitemap(config: Config): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${
    escapeMarkup(config.origin)
  }/</loc></url></urlset>\n`;
}
