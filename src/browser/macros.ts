/**
 * Search macros — expand @macro_name + query into search URLs.
 * Runtime-agnostic. Used by goto handler to support `browse goto @google "query"`.
 */

const MACROS: Record<string, (query: string) => string> = {
  '@google': (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  '@youtube': (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  '@amazon': (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  '@reddit': (q) => `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=25`,
  '@reddit_subreddit': (q) => `https://www.reddit.com/r/${encodeURIComponent(q)}.json?limit=25`,
  '@wikipedia': (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  '@twitter': (q) => `https://twitter.com/search?q=${encodeURIComponent(q)}`,
  '@yelp': (q) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(q)}`,
  '@spotify': (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
  '@netflix': (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}`,
  '@linkedin': (q) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(q)}`,
  '@instagram': (q) => `https://www.instagram.com/explore/tags/${encodeURIComponent(q)}`,
  '@tiktok': (q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`,
  '@twitch': (q) => `https://www.twitch.tv/search?term=${encodeURIComponent(q)}`,
};

/** Expand a macro URL. Returns the expanded URL or null if not a macro. */
export function expandMacro(url: string): string | null {
  // Check if URL starts with @ — if so, parse as @macro query
  if (!url.startsWith('@')) return null;

  const spaceIdx = url.indexOf(' ');
  const macro = spaceIdx === -1 ? url : url.slice(0, spaceIdx);
  const query = spaceIdx === -1 ? '' : url.slice(spaceIdx + 1).trim();

  const fn = MACROS[macro];
  if (!fn) return null;
  return fn(query);
}

/** List all supported macro names. */
export function listMacros(): string[] {
  return Object.keys(MACROS);
}
