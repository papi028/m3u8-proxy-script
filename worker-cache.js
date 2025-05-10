/**
 * M3U8 Proxy and Filter for Cloudflare Workers
 * 
 * Features:
 * 1. Proxies M3U8 files and rewrites TS/fMP4 segment URLs
 * 2. Supports EXT-X-MAP initialization segments
 * 3. Handles encrypted streams (EXT-X-KEY)
 * 4. Filters discontinuity markers
 * 5. Uses Cache API for caching（无kv额度限制且不用配置）
 * 6. Auto-resolves master playlists
 * 7. Detects non-M3U8 content:
 *    - If it's a media file (audio/video/image), proxies through TS proxy
 *    - Otherwise redirects to original URL
 */

// Configuration
const CONFIG = {
  PROXY_URL: 'https://proxy.mengze.vip/proxy/',  // Main proxy URL (leave empty for direct fetch)
  PROXY_URLENCODE: true,                        // Whether to URL-encode target URLs
  
  PROXY_TS: 'https://proxy.mengze.vip/proxy/',   // TS segment proxy URL
  PROXY_TS_URLENCODE: true,                      // Whether to URL-encode TS URLs
  
  CACHE_TTL: 86400,                              // Cache TTL in seconds (24 hours)
  CACHE_NAME: 'm3u8-proxy-cache',                // Cache storage name
  
  MAX_RECURSION: 5,                              // Max recursion for nested playlists
  FILTER_ADS_INTELLIGENTLY: true,                    // Whether 智能过滤
  FILTER_REGEX: null,
  
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  ],
  
  DEBUG: false                                   // Enable debug logging
};

// Media file extensions to check
const MEDIA_FILE_EXTENSIONS = [
  // Video formats
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
  // Audio formats
  '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
  // Image formats
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];

// Media content types to check
const MEDIA_CONTENT_TYPES = [
  // Video types
  'video/', 
  // Audio types
  'audio/',
  // Image types
  'image/'
];

/**
 * Main request handler
 */
async function handleRequest(request) {
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
    const cacheKey = new Request(targetUrl);
    const cache = await caches.open(CONFIG.CACHE_NAME);
    const cachedResponse = await cache.match(cacheKey);
    
    if (cachedResponse) {
      if (CONFIG.DEBUG) console.log(`[Cache hit] ${targetUrl}`);
      const cachedContent = await cachedResponse.text();
      return createM3u8Response(cachedContent);
    }
    
    // Process the M3U8 URL
    if (CONFIG.DEBUG) console.log(`[Processing] ${targetUrl}`);
    
    // Fetch and validate content
    const { content, contentType } = await fetchContentWithType(targetUrl);
    
    // Check if content is actually an M3U8 file
    if (!isM3u8Content(content, contentType)) {
      // Not an M3U8 file, check if it's a media file
      if (isMediaFile(targetUrl, contentType)) {
        if (CONFIG.DEBUG) console.log(`[Media file detected] Redirecting to TS proxy: ${targetUrl}`);
        return Response.redirect(proxyTsUrl(targetUrl), 302);
      } else {
        // Not a media file, redirect to original URL
        if (CONFIG.DEBUG) console.log(`[Not media content] Redirecting to original URL: ${targetUrl}`);
        return Response.redirect(targetUrl, 302);
      }
    }
    
    // Process the M3U8 content
    let processed = await processM3u8Content(targetUrl, content, 0);
    //是否智能过滤广告
    if (CONFIG.FILTER_ADS_INTELLIGENTLY) {
      processed = SuperFilterAdsFromM3U8(processed, CONFIG.FILTER_REGEX);
    }
    
    // Cache the result
    const responseToCache = createM3u8Response(processed);
    await cache.put(cacheKey, responseToCache.clone());
    
    return responseToCache;
    
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
 * 超级M3U8广告算法过滤器
 * @param {string} m3u8Content - 原始M3U8内容
 * @param {string|null} regexFilter - 可选的正则过滤规则
 * @return {string} 过滤后的完整M3U8内容
 */
function SuperFilterAdsFromM3U8(m3u8Content, regexFilter = null) {
    if (!m3u8Content) return '';
    
    // ==================== 第一阶段：预处理 ====================
    // 1. 正则过滤
    let processedContent = regexFilter 
        ? applyRegexFilter(m3u8Content, regexFilter) 
        : m3u8Content;
    
    // 2. 解析M3U8结构
    const { segments, headers } = parseM3U8Structure(processedContent);
    if (segments.length === 0) return processedContent;
    
    // ==================== 第二阶段：科学分析 ====================
    // 1. 计算基础统计量
    const stats = calculateSegmentStats(segments);
    
    // 2. 多维度广告检测
    const analyzedSegments = analyzeSegments(segments, stats);
    
    // 3. 智能过滤决策
    const filteredSegments = applyFilterDecision(analyzedSegments, stats);
    
    // ==================== 第三阶段：重建M3U8 ====================
    return rebuildM3U8(headers, filteredSegments, processedContent);
}

// ==================== 辅助函数 ====================

/**
 * 应用正则过滤
 */
function applyRegexFilter(content, regexFilter) {
    try {
        const regex = new RegExp(regexFilter, 'gi');
        return content.replace(regex, '');
    } catch (e) {
        console.warn('正则过滤失败:', e);
        return content;
    }
}

/**
 * 深度解析M3U8结构
 */
function parseM3U8Structure(content) {
    const lines = content.split('\n');
    const segments = [];
    const headers = {
        main: [],
        other: []
    };
    let currentDiscontinuity = false;
    let currentMap = null;
    let segmentIndex = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // 收集头部信息
        if (i < 10 && line.startsWith('#EXT')) {
            headers.main.push(line);
            continue;
        }
        
        // 处理关键标签
        if (line.startsWith('#EXT-X-MAP:')) {
            currentMap = line;
            continue;
        }
        
        if (line.includes('#EXT-X-DISCONTINUITY')) {
            currentDiscontinuity = true;
            continue;
        }
        
        // 解析片段
        if (line.startsWith('#EXTINF:')) {
            const durationMatch = line.match(/#EXTINF:([\d.]+)/);
            if (durationMatch && lines[i + 1] && !lines[i + 1].startsWith('#')) {
                const duration = parseFloat(durationMatch[1]);
                const url = lines[i + 1].trim();
                
                segments.push({
                    index: segmentIndex++,
                    startLine: i,
                    endLine: i + 1,
                    duration,
                    url,
                    hasDiscontinuity: currentDiscontinuity,
                    hasMap: currentMap !== null,
                    content: currentMap 
                        ? [currentMap, line, lines[i + 1]].join('\n')
                        : [line, lines[i + 1]].join('\n'),
                    isAd: false,  // 初始标记
                    adScore: 0    // 广告概率得分
                });
                
                currentDiscontinuity = false;
                currentMap = null;
                i++; // 跳过URL行
            }
        } else if (line.startsWith('#')) {
            headers.other.push(line);
        }
    }
    
    return { segments, headers };
}

/**
 * 计算高级统计量
 */
function calculateSegmentStats(segments) {
    const durations = segments.map(s => s.duration);
    const totalDuration = durations.reduce((sum, d) => sum + d, 0);
    const avgDuration = totalDuration / durations.length;
    
    // 计算标准差和百分位数
    const squaredDiffs = durations.map(d => Math.pow(d - avgDuration, 2));
    const stdDev = Math.sqrt(squaredDiffs.reduce((sum, sd) => sum + sd, 0) / durations.length);
    
    // 排序后的时长数组用于百分位计算
    const sortedDurations = [...durations].sort((a, b) => a - b);
    const p10 = sortedDurations[Math.floor(durations.length * 0.1)];
    const p90 = sortedDurations[Math.floor(durations.length * 0.9)];
    
    return {
        avgDuration,
        stdDev,
        p10,
        p90,
        totalDuration,
        segmentCount: segments.length,
        durationRange: [sortedDurations[0], sortedDurations[sortedDurations.length - 1]]
    };
}

/**
 * 多维度片段分析
 */
function analyzeSegments(segments, stats) {
    const { avgDuration, stdDev, p10, p90 } = stats;
    
    return segments.map(segment => {
        const deviation = Math.abs(segment.duration - avgDuration);
        const zScore = deviation / stdDev;
        
        // 1. 时长异常检测
        const durationAbnormality = Math.min(1, zScore / 3); // 0-1范围
        
        // 2. 位置异常检测（开头/结尾的短片段更可能是广告）
        let positionFactor = 0;
        if (segment.index < 3 && segment.duration < p10) {
            positionFactor = 0.8; // 开头的短片段很可疑
        } else if (segment.index > segments.length - 3 && segment.duration < p10) {
            positionFactor = 0.5; // 结尾的短片段中等可疑
        }
        
        // 3. 不连续标记检测
        const discontinuityFactor = segment.hasDiscontinuity ? 0.3 : 0;
        
        // 综合广告概率
        const adScore = Math.min(1, 
            (durationAbnormality * 0.6) + 
            (positionFactor * 0.3) + 
            (discontinuityFactor * 0.1)
        );
        
        return {
            ...segment,
            adScore,
            isAd: adScore > 0.65, // 阈值可调整
            stats: { deviation, zScore }
        };
    });
}

/**
 * 智能过滤决策
 */
function applyFilterDecision(segments, stats) {
    const { avgDuration, stdDev } = stats;
    
    // 动态调整阈值
    const baseThreshold = 0.65;
    const dynamicThreshold = Math.min(0.8, Math.max(0.5, 
        baseThreshold - (stdDev / avgDuration) * 0.2
    ));
    
    return segments.filter(segment => {
        // 明确广告标记
        if (segment.isAd && segment.adScore > dynamicThreshold) {
            return false;
        }
        
        // 极短片段过滤（<1秒且不在开头）
        if (segment.duration < 1.0 && segment.index > 3) {
            return false;
        }
        
        // 保留关键片段（如包含MAP的）
        if (segment.hasMap) {
            return true;
        }
        
        // 默认保留
        return true;
    });
}

/**
 * 完美重建M3U8
 */
function rebuildM3U8(headers, segments, originalContent) {
    // 收集需要保留的行号
    const keepLines = new Set();
    
    // 保留所有头部信息
    headers.main.forEach((_, i) => keepLines.add(i));
    
    // 保留所有片段内容
    segments.forEach(segment => {
        for (let i = segment.startLine; i <= segment.endLine; i++) {
            keepLines.add(i);
        }
    });
    
    // 处理其他关键标签
    const lines = originalContent.split('\n');
    const criticalTags = [
        '#EXT-X-VERSION',
        '#EXT-X-TARGETDURATION',
        '#EXT-X-MEDIA-SEQUENCE',
        '#EXT-X-PLAYLIST-TYPE',
        '#EXT-X-ENDLIST'
    ];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (criticalTags.some(tag => line.startsWith(tag))) {
            keepLines.add(i);
        }
    }
    
    // 重建内容
    const filteredLines = lines.filter((_, i) => keepLines.has(i));
    
    // 更新关键头部信息
    updateM3U8Headers(filteredLines, segments);
    
    return filteredLines.join('\n');
}

/**
 * 更新M3U8头部信息
 */
function updateM3U8Headers(lines, segments) {
    if (segments.length === 0) return;
    
    // 更新TARGETDURATION
    const maxDuration = Math.max(...segments.map(s => s.duration));
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-TARGETDURATION')) {
            lines[i] = `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`;
            break;
        }
    }
    
    // 更新MEDIA-SEQUENCE
    if (segments[0].index > 0) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-MEDIA-SEQUENCE')) {
                lines[i] = `#EXT-X-MEDIA-SEQUENCE:${segments[0].index}`;
                break;
            }
        }
    }
}



/**
 * Check if content is a valid M3U8 file
 */
function isM3u8Content(content, contentType) {
  // Check content type header
  if (contentType && (
      contentType.includes('application/vnd.apple.mpegurl') || 
      contentType.includes('application/x-mpegurl'))) {
    return true;
  }
  
  // Check content for M3U8 signature
  if (content && content.trim().startsWith('#EXTM3U')) {
    return true;
  }
  
  return false;
}

/**
 * Check if the file is a media file based on extension and content type
 */
function isMediaFile(url, contentType) {
  // Check by content type
  if (contentType) {
    for (const mediaType of MEDIA_CONTENT_TYPES) {
      if (contentType.toLowerCase().startsWith(mediaType)) {
        return true;
      }
    }
  }
  
  // Check by file extension
  const urlLower = url.toLowerCase();
  for (const ext of MEDIA_FILE_EXTENSIONS) {
    // Check if URL ends with the extension or has it followed by a query parameter
    if (urlLower.endsWith(ext) || urlLower.includes(`${ext}?`)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract target URL from request
 */
function getTargetUrl(url) {
  // Check query parameter
  if (url.searchParams.has('url')) {
    return url.searchParams.get('url');
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
function createResponse(body, status = 200, headers = {}) {
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
function createM3u8Response(content) {
  return createResponse(content, 200, {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": `public, max-age=${CONFIG.CACHE_TTL}`
  });
}

/**
 * Fetch content with content type information
 */
async function fetchContentWithType(url) {
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
    
    const content = await response.text();
    const contentType = response.headers.get('Content-Type') || '';
    
    return { content, contentType };
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }
}

/**
 * Fetch content with proper headers
 */
async function fetchContent(url) {
  const { content } = await fetchContentWithType(url);
  return content;
}

/**
 * Process M3U8 content from the initial URL
 */
async function processM3u8Content(url, content, recursionDepth = 0) {
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
async function processMasterPlaylist(url, content, recursionDepth) {
  if (recursionDepth > CONFIG.MAX_RECURSION) {
    throw new Error(`Maximum recursion depth (${CONFIG.MAX_RECURSION}) exceeded`);
  }
  
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
  
  // Check cache first for variant
  const cache = await caches.open(CONFIG.CACHE_NAME);
  const cacheKey = new Request(variantUrl);
  const cachedResponse = await cache.match(cacheKey);
  
  if (cachedResponse) {
    if (CONFIG.DEBUG) console.log(`[Cache hit] ${variantUrl}`);
    return await cachedResponse.text();
  }
  
  // Recursively process the variant stream
  if (CONFIG.DEBUG) console.log(`[Selected variant] ${variantUrl}`);
  const variantContent = await fetchContent(variantUrl);
  const processed = await processM3u8Content(variantUrl, variantContent, recursionDepth + 1);
  
  // Cache the variant result
  const responseToCache = createM3u8Response(processed);
  await cache.put(cacheKey, responseToCache.clone());
  
  return processed;
}

/**
 * Process a media playlist by rewriting segment URLs
 */
function processMediaPlaylist(url, content) {
  const baseUrl = getBaseUrl(url);
  const lines = content.split('\n');
  const output = [];
  
  let isNextLineSegment = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines
    if (!line) continue;
    
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
function processKeyLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${proxyTsUrl(absoluteUri)}"`;
  });
}

/**
 * Process EXT-X-MAP line by proxying the map URL
 */
function processMapLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${proxyTsUrl(absoluteUri)}"`;
  });
}

/**
 * Apply TS proxy to a URL
 */
function proxyTsUrl(url) {
  if (!CONFIG.PROXY_TS) return url;
  
  return CONFIG.PROXY_TS_URLENCODE 
    ? `${CONFIG.PROXY_TS}${encodeURIComponent(url)}`
    : `${CONFIG.PROXY_TS}${url}`;
}

/**
 * Get a random user agent from the configured list
 */
function getRandomUserAgent() {
  return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

/**
 * Extract the base URL from a full URL
 */
function getBaseUrl(url) {
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
function resolveUrl(baseUrl, relativeUrl) {
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

// Main handler using ES Modules syntax
export default {
  async fetch(request) {
    return handleRequest(request);
  }
};
