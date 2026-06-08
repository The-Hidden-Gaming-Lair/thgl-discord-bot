/**
 * Discord attachment/media URLs are signed and expire (~24h) via their
 * `?ex=&is=&hm=` query params. When the web caches a message response longer
 * than that window, the URL 404s by the time it's viewed (observed as
 * "upstream image response failed ... 404" in the games-web logs).
 *
 * To make these images durable we route them through a Bunny pull zone that
 * has Perma-Cache enabled and ignores the query string in its cache key:
 * Bunny pulls each file once while the signature is still valid (the bot
 * always serves freshly-fetched URLs), stores it permanently, and serves that
 * copy forever — Discord's expiry becomes irrelevant.
 *
 * Enable by setting DISCORD_CDN_PROXY to the proxy origin, e.g.
 *   DISCORD_CDN_PROXY="https://discord-cdn.th.gl"
 * When unset, URLs are returned unchanged (no-op) so nothing breaks before the
 * Bunny zone exists.
 */
const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

function getProxyBase(): string | null {
  const proxy = process.env.DISCORD_CDN_PROXY?.trim();
  if (!proxy) return null;
  return proxy.replace(/\/+$/, ""); // strip trailing slash(es)
}

/**
 * Rewrite a Discord CDN attachment/media URL to the configured Bunny proxy
 * origin, preserving path + query (Bunny forwards the signed query to Discord
 * on a cache miss; the cache key ignores it). Non-Discord hosts and non-URLs
 * are returned unchanged.
 */
export function rewriteDiscordCdn(url: string): string {
  const proxyBase = getProxyBase();
  if (!proxyBase || !url) return url;
  try {
    const parsed = new URL(url);
    if (!DISCORD_CDN_HOSTS.has(parsed.hostname)) return url;
    return `${proxyBase}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
