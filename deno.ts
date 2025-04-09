/**
 * M3U8 Proxy and Filter Script with Advanced HLS Support
 * 
 * Features:
 * 1. Proxies M3U8 files and rewrites TS/fMP4 segment URLs
 * 2. Supports EXT-X-MAP initialization segments
 * 3. Handles encrypted streams (EXT-X-KEY)
 * 4. Filters discontinuity markers
 * 5. Supports caching
 * 6. Auto-resolves master playlists recursively
 */

import { serve } from "https://deno.land/std/http/server.ts";
import { LRUCache } from "https://deno.land/x/lru_cache/mod.ts";

// Configuration
const CONFIG = {
  PORT: 8000,
  PROXY_URL: 'https://proxy.mengze.vip/proxy/',                                 // Main proxy URL (leave empty for direct fetch)
  PROXY_URLENCODE: true,                        // Whether to URL-encode target URLs
  
  PROXY_TS: 'https://proxy.mengze.vip/proxy/',   // TS segment proxy URL
  PROXY_TS_URLENCODE: true,                      // Whether to URL-encode TS URLs
  
  CACHE_ENABLED: true,
  CACHE_TTL: 3600,                               // Cache TTL in seconds
  CACHE_SIZE: 500,                               // Max cache entries
  
  MAX_RECURSION: 50,                             // Max recursion for nested playlists
  FILTER_DISCONTINUITY: true,                    // Whether to filter discontinuity markers
  
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  ],
  
  DEBUG: false                                   // Enable debug logging
};

// Initialize cache
const cache = new LRUCache({
  capacity: CONFIG.CACHE_SIZE,
  expirationTimeInMS: CONFIG.CACHE_TTL * 1000
});

/**
 * Main request handler
 */
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  try {
    // Extract target URL
    const targetUrl = getTargetUrl(url);
    if (!targetUrl) {
      return createResponse(
        "Please provide an M3U8 URL via the 'url' parameter or /m3u8filter/URL path", 
        400, 
        { "Content-Type": "text/plain" }
      );
    }
    
    // Check cache
    const cacheKey = `m3u8:${targetUrl}`;
    if (CONFIG.CACHE_ENABLED) {
      const cachedContent = cache.get(cacheKey);
      if (cachedContent) {
        if (CONFIG.DEBUG) console.log(`[Cache hit] ${targetUrl}`);
        return createM3u8Response(cachedContent);
      }
    }
    
    // Process the M3U8 URL
    if (CONFIG.DEBUG) console.log(`[Processing] ${targetUrl}`);
    const processed = await processM3u8Url(targetUrl);
    
    // Cache the result
    if (CONFIG.CACHE_ENABLED) {
      cache.set(cacheKey, processed);
    }
    
    return createM3u8Response(processed);
    
  } catch (error) {
    console.error(`[Error] ${error.message}`);
    return createResponse(
      `Error processing request: ${error.message}`, 
      500, 
      { "Content-Type": "text/plain" }
    );
  }
}

/**
 * Extract target URL from request
 */
function getTargetUrl(url: URL): string | null {
  // Check query parameter
  if (url.searchParams.has('url')) {
    return url.searchParams.get('url')!;
  }
  
  // Check path format: /m3u8filter/URL
  const pathMatch = url.pathname.match(/^\/m3u8filter\/(.+)/);
  if (pathMatch && pathMatch[1]) {
    return decodeURIComponent(pathMatch[1]);
  }
  
  return null;
}

/**
 * Create a standardized response
 */
function createResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  
  return new Response(body, {
    status,
    headers: responseHeaders
  });
}

/**
 * Create an M3U8 response with proper headers
 */
function createM3u8Response(content: string): Response {
  return createResponse(content, 200, {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": `public, max-age=${CONFIG.CACHE_TTL}`
  });
}

/**
 * Main M3U8 processing function
 */
async function processM3u8Url(url: string, recursionDepth = 0): Promise<string> {
  if (recursionDepth > CONFIG.MAX_RECURSION) {
    throw new Error(`Maximum recursion depth (${CONFIG.MAX_RECURSION}) exceeded`);
  }
  
  // Fetch the M3U8 content
  const content = await fetchContent(url);
  if (!content || !content.includes('#EXTM3U')) {
    throw new Error('Invalid M3U8 content');
  }
  
  // Check if this is a master playlist
  if (content.includes('#EXT-X-STREAM-INF')) {
    if (CONFIG.DEBUG) console.log(`[Master playlist detected] ${url}`);
    return await processMasterPlaylist(url, content, recursionDepth);
  }
  
  // Process as a media playlist
  if (CONFIG.DEBUG) console.log(`[Media playlist] ${url}`);
  return processMediaPlaylist(url, content);
}

/**
 * Process a master playlist by selecting the first variant stream
 */
async function processMasterPlaylist(url: string, content: string, recursionDepth: number): Promise<string> {
  const baseUrl = getBaseUrl(url);
  const lines = content.split('\n');
  
  let variantUrl = '';
  
  // Find the first variant stream URL
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      // The next non-comment line should be the variant URL
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (line && !line.startsWith('#')) {
          variantUrl = resolveUrl(baseUrl, line);
          break;
        }
      }
      if (variantUrl) break;
    }
  }
  
  if (!variantUrl) {
    throw new Error('No variant stream found in master playlist');
  }
  
  // Recursively process the variant stream
  if (CONFIG.DEBUG) console.log(`[Selected variant] ${variantUrl}`);
  return await processM3u8Url(variantUrl, recursionDepth + 1);
}

/**
 * Process a media playlist by rewriting segment URLs
 */
function processMediaPlaylist(url: string, content: string): string {
  const baseUrl = getBaseUrl(url);
  const lines = content.split('\n');
  const output: string[] = [];
  
  let isNextLineSegment = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines
    if (!line) continue;
    
    // Filter discontinuity markers if enabled
    if (CONFIG.FILTER_DISCONTINUITY && line === '#EXT-X-DISCONTINUITY') {
      continue;
    }
    
    // Handle EXT-X-KEY (encryption)
    if (line.startsWith('#EXT-X-KEY')) {
      output.push(processKeyLine(line, baseUrl));
      continue;
    }
    
    // Handle EXT-X-MAP (initialization segment)
    if (line.startsWith('#EXT-X-MAP')) {
      output.push(processMapLine(line, baseUrl));
      continue;
    }
    
    // Mark segment lines
    if (line.startsWith('#EXTINF')) {
      isNextLineSegment = true;
      output.push(line);
      continue;
    }
    
    // Process segment URLs
    if (isNextLineSegment && !line.startsWith('#')) {
      const absoluteUrl = resolveUrl(baseUrl, line);
      output.push(proxyTsUrl(absoluteUrl));
      isNextLineSegment = false;
      continue;
    }
    
    // Pass through all other lines
    output.push(line);
  }
  
  return output.join('\n');
}

/**
 * Process EXT-X-KEY line by proxying the key URL
 */
function processKeyLine(line: string, baseUrl: string): string {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${proxyTsUrl(absoluteUri)}"`;
  });
}

/**
 * Process EXT-X-MAP line by proxying the map URL
 */
function processMapLine(line: string, baseUrl: string): string {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${proxyTsUrl(absoluteUri)}"`;
  });
}

/**
 * Apply TS proxy to a URL
 */
function proxyTsUrl(url: string): string {
  if (!CONFIG.PROXY_TS) return url;
  
  return CONFIG.PROXY_TS_URLENCODE 
    ? `${CONFIG.PROXY_TS}${encodeURIComponent(url)}`
    : `${CONFIG.PROXY_TS}${url}`;
}

/**
 * Fetch content with proper headers
 */
async function fetchContent(url: string): Promise<string> {
  const headers = new Headers({
    'User-Agent': getRandomUserAgent(),
    'Accept': '*/*',
    'Referer': new URL(url).origin
  });
  
  let fetchUrl = url;
  if (CONFIG.PROXY_URL) {
    fetchUrl = CONFIG.PROXY_URLENCODE 
      ? `${CONFIG.PROXY_URL}${encodeURIComponent(url)}`
      : `${CONFIG.PROXY_URL}${url}`;
  }
  
  try {
    const response = await fetch(fetchUrl, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }
    
    return await response.text();
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }
}

/**
 * Get a random user agent from the configured list
 */
function getRandomUserAgent(): string {
  return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

/**
 * Extract the base URL from a full URL
 */
function getBaseUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split('/');
    pathParts.pop(); // Remove the last part (filename)
    
    return `${parsedUrl.origin}${pathParts.join('/')}/`;
  } catch (e) {
    // Fallback: find the last slash
    const lastSlashIndex = url.lastIndexOf('/');
    return lastSlashIndex > 8 ? url.substring(0, lastSlashIndex + 1) : url;
  }
}

/**
 * Resolve a relative URL against a base URL
 */
function resolveUrl(baseUrl: string, relativeUrl: string): string {
  // Already absolute URL
  if (relativeUrl.match(/^https?:\/\//i)) {
    return relativeUrl;
  }
  
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch (e) {
    // Simple fallback
    if (relativeUrl.startsWith('/')) {
      const urlObj = new URL(baseUrl);
      return `${urlObj.origin}${relativeUrl}`;
    }
    return `${baseUrl}${relativeUrl}`;
  }
}

// Start the server
console.log(`Starting M3U8 Filter server on port ${CONFIG.PORT}`);
serve(handleRequest, { port: CONFIG.PORT });
