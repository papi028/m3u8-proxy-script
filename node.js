/*
node.js m3u8过滤代理脚本，未测试
Usage:
Install Node.js (v14+ recommended)
Save the script as m3u8-proxy.js
Run with: node m3u8-proxy.js
Access via:
http://localhost:8000/?url=[M3U8_URL]
http://localhost:8000/m3u8filter/[M3U8_URL]
The server will cache processed playlists in the m3u8files/ directory and automatically clean up expired files. All configuration options are at the top of the script for easy customization.
*/
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ========== Configuration ==========
const CONFIG = {
  PORT: 8000,
  PROXY_URL: 'https://proxy.mengze.vip/proxy/',    // Main proxy URL
  PROXY_URLENCODE: true,                           // Whether to encode target URLs
  
  PROXY_TS: 'https://proxy.mengze.vip/proxy/',     // TS segment proxy URL
  PROXY_TS_URLENCODE: true,                        // Whether to encode TS URLs
  
  CACHE_DIR: 'm3u8files/',                         // Cache directory
  CACHE_TIME: 86400,                               // Cache time in seconds (24 hours)
  
  MAX_RECURSION: 30,                               // Max recursion depth for master playlists
  FILTER_DISCONTINUITY: true,                      // Whether to filter discontinuity markers
  
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.2 Safari/605.1.15'
  ],

  MEDIA_FILE_EXTENSIONS: [
    // Video formats
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    // Audio formats
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    // Image formats
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
  ],

  MEDIA_CONTENT_TYPES: [
    // Video types
    'video/', 
    // Audio types
    'audio/',
    // Image types
    'image/'
  ]
};

// ========== Helper Functions ==========

/**
 * Get cache filename for a URL
 */
function getCacheFilename(targetUrl) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(targetUrl).digest('hex');
  return path.join(CONFIG.CACHE_DIR, `${hash}.m3u8`);
}

/**
 * Clean expired cache files
 */
function cleanExpiredCache() {
  if (!fs.existsSync(CONFIG.CACHE_DIR)) {
    return 0;
  }

  let count = 0;
  const files = fs.readdirSync(CONFIG.CACHE_DIR);
  const now = Math.floor(Date.now() / 1000);

  files.forEach(file => {
    if (file.endsWith('.m3u8')) {
      const filePath = path.join(CONFIG.CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      const mtime = Math.floor(stats.mtimeMs / 1000);

      if (now - mtime > CONFIG.CACHE_TIME) {
        fs.unlinkSync(filePath);
        count++;
      }
    }
  });

  return count;
}

/**
 * Get content from cache
 */
function getFromCache(targetUrl) {
  const cacheFile = getCacheFilename(targetUrl);
  
  if (!fs.existsSync(cacheFile)) {
    return null;
  }

  const stats = fs.statSync(cacheFile);
  const mtime = Math.floor(stats.mtimeMs / 1000);
  const now = Math.floor(Date.now() / 1000);

  if (now - mtime > CONFIG.CACHE_TIME) {
    cleanExpiredCache();
    return null;
  }

  return fs.readFileSync(cacheFile, 'utf8');
}

/**
 * Write content to cache
 */
function writeToCache(targetUrl, content) {
  if (!fs.existsSync(CONFIG.CACHE_DIR)) {
    fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });
  }

  const cacheFile = getCacheFilename(targetUrl);
  fs.writeFileSync(cacheFile, content, 'utf8');
}

/**
 * Fetch content with type information
 */
function fetchContentWithType(targetUrl) {
  return new Promise((resolve, reject) => {
    const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    let fetchUrl = targetUrl;

    if (CONFIG.PROXY_URL) {
      fetchUrl = CONFIG.PROXY_URL + (CONFIG.PROXY_URLENCODE ? encodeURIComponent(targetUrl) : targetUrl);
    }

    const parsedUrl = new URL(fetchUrl);
    const options = {
      headers: {
        'User-Agent': userAgent,
        'Accept': '*/*',
        'Referer': new URL(targetUrl).origin
      }
    };

    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    protocol.get(fetchUrl, options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP error ${res.statusCode}: ${res.statusMessage}`));
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve({
          content: data,
          contentType: res.headers['content-type'] || ''
        });
      });
    }).on('error', (err) => {
      reject(new Error(`Failed to fetch ${targetUrl}: ${err.message}`));
    });
  });
}

/**
 * Check if content is M3U8
 */
function isM3u8Content(content, contentType) {
  // Check content type
  if (contentType && (
    contentType.includes('application/vnd.apple.mpegurl') || 
    contentType.includes('application/x-mpegurl'))) {
    return true;
  }

  // Check content signature
  if (content && content.trim().startsWith('#EXTM3U')) {
    return true;
  }

  return false;
}

/**
 * Check if URL points to a media file
 */
function isMediaFile(targetUrl, contentType) {
  // Check content type
  if (contentType) {
    for (const mediaType of CONFIG.MEDIA_CONTENT_TYPES) {
      if (contentType.toLowerCase().startsWith(mediaType)) {
        return true;
      }
    }
  }

  // Check file extension
  const targetUrlLower = targetUrl.toLowerCase();
  for (const ext of CONFIG.MEDIA_FILE_EXTENSIONS) {
    if (targetUrlLower.includes(ext) && 
        (targetUrlLower.includes(`${ext}?`) || targetUrlLower.endsWith(ext))) {
      return true;
    }
  }

  return false;
}

/**
 * Generate proxied TS URL
 */
function proxyTsUrl(targetUrl) {
  if (!CONFIG.PROXY_TS) return targetUrl;
  
  return CONFIG.PROXY_TS + (CONFIG.PROXY_TS_URLENCODE ? encodeURIComponent(targetUrl) : targetUrl);
}

/**
 * Resolve relative URL against base URL
 */
function resolveUrl(baseUrl, relativeUrl) {
  if (/^https?:\/\//i.test(relativeUrl)) {
    return relativeUrl;
  }

  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch (e) {
    // Fallback for invalid URLs
    const parsedBase = new URL(baseUrl);
    if (relativeUrl.startsWith('/')) {
      return `${parsedBase.origin}${relativeUrl}`;
    }
    return `${baseUrl}${relativeUrl}`;
  }
}

/**
 * Modify encryption key URI
 */
function modifyKeyUri(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${proxyTsUrl(absoluteUri)}"`;
  });
}

/**
 * Modify M3U8 content URLs
 */
function modifyM3u8Urls(content, baseUrl) {
  const lines = content.split('\n');
  const modified = [];
  let isNextLineMedia = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      modified.push(line);
      continue;
    }

    // Handle EXT-X-MAP
    if (trimmed.startsWith('#EXT-X-MAP:')) {
      const modifiedLine = trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        return `URI="${proxyTsUrl(absoluteUri)}"`;
      });
      modified.push(modifiedLine);
      continue;
    }

    // Handle encryption keys
    if (trimmed.startsWith('#EXT-X-KEY')) {
      modified.push(modifyKeyUri(line, baseUrl));
      continue;
    }

    // Handle media segments
    if (trimmed.startsWith('#EXTINF:')) {
      isNextLineMedia = true;
      modified.push(line);
    } else if (isNextLineMedia && !trimmed.startsWith('#')) {
      const absoluteUrl = resolveUrl(baseUrl, trimmed);
      modified.push(proxyTsUrl(absoluteUrl));
      isNextLineMedia = false;
    } else {
      modified.push(line);
      isNextLineMedia = false;
    }
  }

  return modified.join('\n');
}

/**
 * Filter discontinuity markers
 */
function filterDiscontinuity(content) {
  if (!CONFIG.FILTER_DISCONTINUITY) return content;

  return content.split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#EXT-X-DISCONTINUITY');
    })
    .join('\n');
}

/**
 * Get base directory URL
 */
function getBaseDirectoryUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  const pathParts = parsed.pathname.split('/');
  pathParts.pop(); // Remove last part (filename)
  parsed.pathname = pathParts.join('/') + '/';
  return parsed.toString();
}

/**
 * Process M3U8 URL
 */
async function processM3u8Url(targetUrl, res) {
  try {
    // Try to get from cache
    const cached = getFromCache(targetUrl);
    if (cached) {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(cached);
      return;
    }

    // Fetch content with type info
    const { content, contentType } = await fetchContentWithType(targetUrl);

    // Check if it's M3U8 content
    if (!isM3u8Content(content, contentType)) {
      if (isMediaFile(targetUrl, contentType)) {
        res.writeHead(302, {
          'Location': proxyTsUrl(targetUrl)
        });
        res.end();
      } else {
        res.writeHead(302, {
          'Location': targetUrl
        });
        res.end();
      }
      return;
    }

    // Process master playlist with recursion
    let currentUrl = targetUrl;
    let processedContent = content;
    let recursionCount = 0;

    while (processedContent.includes('#EXT-X-STREAM-INF') && recursionCount < CONFIG.MAX_RECURSION) {
      const lines = processedContent.split('\n').filter(line => line.trim());
      let variantUrl = '';

      for (const line of lines) {
        if (line.trim().startsWith('#EXT-X-STREAM-INF')) {
          // Next non-comment line is the variant URL
          const nextLine = lines[lines.indexOf(line) + 1];
          if (nextLine && !nextLine.trim().startsWith('#')) {
            variantUrl = resolveUrl(currentUrl, nextLine.trim());
            break;
          }
        }
      }

      if (!variantUrl) break;

      const variantResult = await fetchContentWithType(variantUrl);
      processedContent = variantResult.content;
      currentUrl = variantUrl;
      recursionCount++;
    }

    // Process the content
    const baseUrl = getBaseDirectoryUrl(currentUrl);
    const filtered = filterDiscontinuity(processedContent);
    const modified = modifyM3u8Urls(filtered, baseUrl);

    // Write to cache and send response
    writeToCache(targetUrl, modified);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(modified);
  } catch (error) {
    console.error(`Error processing ${targetUrl}:`, error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error processing request: ${error.message}`);
  }
}

/**
 * Get target URL from request
 */
function getTargetUrl(req) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let targetUrl = parsedUrl.searchParams.get('url');

  if (!targetUrl) {
    const pathMatch = req.url.match(/\/m3u8filter\/(.+)/);
    if (pathMatch && pathMatch[1]) {
      targetUrl = decodeURIComponent(pathMatch[1]);
    }
  }

  return targetUrl;
}

// ========== Server Setup ==========
const server = http.createServer((req, res) => {
  const targetUrl = getTargetUrl(req);

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Please provide an M3U8 URL via the "url" parameter or /m3u8filter/URL path');
    return;
  }

  processM3u8Url(targetUrl, res);
});

// Start the server
server.listen(CONFIG.PORT, () => {
  console.log(`M3U8 Proxy Server running on port ${CONFIG.PORT}`);
  if (!fs.existsSync(CONFIG.CACHE_DIR)) {
    fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });
  }
});
