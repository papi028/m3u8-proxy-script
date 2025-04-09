/**
 * 高性能 M3U8 代理 Deno 服务器
 * 支持多级播放列表、TS片段代理、内容过滤与缓存
 */

// 导入必要的Deno模块
import { serve } from "https://deno.land/std/http/server.ts";
import { Status } from "https://deno.land/std/http/http_status.ts";
import { LRUCache } from "https://deno.land/x/lru_cache/mod.ts";

// 配置项
const CONFIG = {
  // 基本设置
  PORT: 8000,                                    // 监听端口
  PROXY_URL: 'https://proxy.mengze.vip/proxy/',  // 主代理地址
  PROXY_URLENCODE: true,                         // 是否编码目标URL
  TS_PROXY_URL: 'https://proxy.mengze.vip/proxy/', // TS分片专用代理地址
  TS_PROXY_URLENCODE: true,                      // 是否编码TS分片URL
  
  // 递归与缓存设置
  MAX_REDIRECTS: 6,                              // 最大递归深度
  CACHE_TTL: 60 * 5,                             // 缓存时间(秒) - 5分钟
  CACHE_SIZE: 500,                               // 缓存条目数量上限
  CACHE_BY_CONTENT: true,                        // 是否基于内容哈希缓存
  
  // 请求设置
  USER_AGENTS: [                                 // 随机User-Agent池
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  ],
  FETCH_TIMEOUT: 10000,                          // 请求超时时间(毫秒)
  MAX_RETRIES: 6,                                // 最大重试次数
  
  // 安全设置
  ALLOWED_DOMAINS: [],                           // 允许的域名白名单(空数组表示允许所有)
  BLOCKED_DOMAINS: [],                           // 阻止的域名黑名单
  REQUEST_LIMIT: 100,                            // 每分钟最大请求数
  
  // 功能开关
  ENABLE_CORS: true,                             // 是否启用CORS
  ENABLE_COMPRESSION: true,                      // 是否启用响应压缩
  STRIP_ADS: true,                               // 是否移除广告标记
  NORMALIZE_SEGMENTS: true,                      // 是否标准化分片URL
  SMART_PROXY_SELECTION: true,                   // 智能选择代理
  PRESERVE_ORIGINAL_HEADERS: true,               // 是否保留原始响应头
  
  // 高级HLS支持
  SUPPORT_EXT_X_KEY: true,                       // 支持密钥处理
  SUPPORT_EXT_X_MAP: true,                       // 支持映射片段
  SUPPORT_EXT_X_BYTERANGE: true,                 // 支持字节范围
  SUPPORT_EXT_X_DATERANGE: true,                 // 支持日期范围
  
  // 调试
  DEBUG: false,                                  // 调试模式
  VERBOSE_LOGS: false                            // 详细日志
};

// 创建内存缓存
const CACHE = new LRUCache({
  capacity: CONFIG.CACHE_SIZE,
  expirationTimeInMS: CONFIG.CACHE_TTL * 1000
});

// 速率限制计数器
const REQUEST_COUNTERS = new Map();

/**
 * 主处理函数 - Deno服务器处理请求
 * @param {Request} request - 请求对象
 * @returns {Promise<Response>} 响应对象
 */
async function handleRequest(request) {
  const clientIP = request.headers.get('x-forwarded-for') || 'unknown';
  const requestUrl = new URL(request.url);
  
  try {
    // 1. 速率限制检查
    if (!checkRateLimit(clientIP)) {
      return new Response('Too many requests', { status: Status.TooManyRequests });
    }
    
    // 2. CORS预检请求处理
    if (request.method === 'OPTIONS' && CONFIG.ENABLE_CORS) {
      return handleCorsRequest();
    }
    
    // 3. 获取目标URL
    const targetUrl = getTargetUrl(requestUrl);
    if (!targetUrl) {
      return createErrorResponse('Missing URL parameter. Usage: ?url=encoded_url or /m3u8filter/encoded_url', Status.BadRequest);
    }
    
    // 4. 域名安全检查
    if (!isDomainAllowed(targetUrl)) {
      return createErrorResponse('Domain not allowed', Status.Forbidden);
    }
    
    // 5. 创建缓存键并检查缓存
    const cacheKey = await createCacheKey(request.url, targetUrl);
    if (CONFIG.DEBUG) log(`Cache key: ${cacheKey}`);
    
    let cachedResponse = CACHE.get(cacheKey);
    if (cachedResponse) {
      if (CONFIG.DEBUG) log('Serving from cache');
      return new Response(cachedResponse.body, {
        headers: cachedResponse.headers,
        status: cachedResponse.status,
      });
    }
    
    // 6. 获取目标内容
    const { response: targetResponse, finalUrl } = await fetchWithRedirects(targetUrl);
    
    if (!targetResponse.ok) {
      return createErrorResponse(`Failed to fetch content: ${targetResponse.status} ${targetResponse.statusText}`, targetResponse.status);
    }
    
    // 7. 读取内容并检查是否为M3U8
    const contentType = targetResponse.headers.get('Content-Type') || '';
    const content = await targetResponse.text();
    
    if (!isM3U8Content(content, contentType)) {
      // 不是M3U8内容，根据情况处理
      return handleNonM3U8Content(content, contentType, finalUrl, targetResponse.headers);
    }
    
    // 8. 处理M3U8内容
    const processedContent = await processM3U8Content(content, finalUrl, 0, requestUrl);
    
    // 9. 创建响应
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
    responseHeaders.set('Cache-Control', `public, max-age=${CONFIG.CACHE_TTL}`);
    
    if (CONFIG.ENABLE_CORS) {
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
    }
    
    // 保留必要的原始头
    if (CONFIG.PRESERVE_ORIGINAL_HEADERS) {
      ['Content-Disposition', 'Expires', 'Last-Modified'].forEach(key => {
        if (targetResponse.headers.has(key)) {
          responseHeaders.set(key, targetResponse.headers.get(key));
        }
      });
    }
    
    const response = new Response(processedContent, { 
      headers: responseHeaders,
      status: Status.OK
    });
    
    // 10. 缓存响应
    if (CONFIG.CACHE_TTL > 0) {
      CACHE.set(cacheKey, {
        body: processedContent,
        headers: Object.fromEntries(responseHeaders.entries()),
        status: Status.OK
      });
    }
    
    return response;
    
  } catch (error) {
    // 统一错误处理
    if (CONFIG.DEBUG) log(`Error: ${error.stack || error.message || error}`, true);
    return createErrorResponse(`Error processing request: ${error.message}`, Status.InternalServerError);
  }
}

/**
 * 速率限制检查
 * @param {string} clientIP - 客户端IP
 * @returns {boolean} 是否通过速率限制
 */
function checkRateLimit(clientIP) {
  if (!CONFIG.REQUEST_LIMIT) return true;
  
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const key = `${clientIP}:${minute}`;
  
  const count = REQUEST_COUNTERS.get(key) || 0;
  if (count >= CONFIG.REQUEST_LIMIT) return false;
  
  REQUEST_COUNTERS.set(key, count + 1);
  
  // 清理过期计数器
  for (const [k, _] of REQUEST_COUNTERS) {
    const keyMinute = parseInt(k.split(':')[1]);
    if (keyMinute < minute) {
      REQUEST_COUNTERS.delete(k);
    }
  }
  
  return true;
}

/**
 * 处理CORS预检请求
 * @returns {Response} CORS响应
 */
function handleCorsRequest() {
  return new Response(null, {
    status: Status.NoContent,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    }
  });
}

/**
 * 创建缓存键
 * @param {string} requestUrl - 请求URL
 * @param {string} targetUrl - 目标URL
 * @returns {Promise<string>} 缓存键
 */
async function createCacheKey(requestUrl, targetUrl) {
  if (!CONFIG.CACHE_BY_CONTENT) {
    return requestUrl;
  }
  
  // 基于内容hash创建缓存键
  const urlHash = await sha256(targetUrl);
  return `cache:${urlHash}`;
}

/**
 * 计算文本的SHA-256哈希
 * @param {string} text - 要哈希的文本
 * @returns {Promise<string>} 哈希值
 */
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 从请求URL中提取目标地址
 * @param {URL} url - 请求URL
 * @returns {string|null} 目标URL或null
 */
function getTargetUrl(url) {
  // 优先从查询参数获取
  if (url.searchParams.has('url')) {
    return decodeURIComponent(url.searchParams.get('url'));
  }
  
  // 从路径获取 /m3u8filter/<encoded_url>
  const pathMatch = url.pathname.match(/\/m3u8filter\/(.+)/);
  if (pathMatch && pathMatch[1]) {
    return decodeURIComponent(pathMatch[1]);
  }
  
  return null;
}

/**
 * 域名安全检查
 * @param {string} url - URL字符串
 * @returns {boolean} 是否允许
 */
function isDomainAllowed(url) {
  try {
    const domain = new URL(url).hostname;
    
    // 检查黑名单
    if (CONFIG.BLOCKED_DOMAINS.length > 0 && 
        CONFIG.BLOCKED_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`))) {
      if (CONFIG.DEBUG) log(`Domain ${domain} blocked by blacklist`);
      return false;
    }
    
    // 检查白名单
    if (CONFIG.ALLOWED_DOMAINS.length > 0 && 
        !CONFIG.ALLOWED_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`))) {
      if (CONFIG.DEBUG) log(`Domain ${domain} not in whitelist`);
      return false;
    }
    
    return true;
  } catch (error) {
    if (CONFIG.DEBUG) log(`Domain check error: ${error.message}`);
    return false;
  }
}

/**
 * 带超时、重试和重定向处理的fetch
 * @param {string} url - 目标URL
 * @param {Object} options - fetch选项
 * @param {number} depth - 当前重定向深度
 * @returns {Promise<{response: Response, finalUrl: string}>} 响应和最终URL
 */
async function fetchWithRedirects(url, options = {}, depth = 0) {
  if (depth > CONFIG.MAX_REDIRECTS) {
    throw new Error(`Maximum redirect depth (${CONFIG.MAX_REDIRECTS}) exceeded`);
  }
  
  const fetchOptions = {
    ...options,
    headers: {
      ...options.headers,
      'User-Agent': getRandomUserAgent(),
      'Referer': new URL(url).origin,
      'Accept': 'application/vnd.apple.mpegurl, application/x-mpegurl, */*',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    // 不自动跟随重定向
    redirect: 'manual'
  };
  
  // 带超时的fetch
  const response = await fetchWithTimeout(url, fetchOptions);
  
  // 处理重定向
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('Location');
    if (location) {
      const redirectUrl = new URL(location, url).toString();
      if (CONFIG.DEBUG) log(`Redirecting to: ${redirectUrl}`);
      return fetchWithRedirects(redirectUrl, options, depth + 1);
    }
  }
  
  return { response, finalUrl: url };
}

/**
 * 带超时的fetch
 * @param {string} url - 目标URL
 * @param {Object} options - fetch选项
 * @returns {Promise<Response>} 响应
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${CONFIG.FETCH_TIMEOUT}ms`);
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

/**
 * 获取随机User-Agent
 * @returns {string} 随机User-Agent
 */
function getRandomUserAgent() {
  return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

/**
 * 检查是否为M3U8内容
 * @param {string} content - 内容文本
 * @param {string} contentType - 内容类型头
 * @returns {boolean} 是否为M3U8内容
 */
function isM3U8Content(content, contentType) {
  // 首先检查Content-Type
  if (contentType && (
      contentType.includes('mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      contentType.includes('application/vnd.apple.mpegurl'))) {
    return true;
  }
  
  // 内容检查
  const trimmedContent = content.trim();
  if (trimmedContent.startsWith('#EXTM3U')) {
    return true;
  }
  
  // 检查前几行是否包含典型的HLS标签
  const firstLines = trimmedContent.split('\n', 10);
  const hlsTags = ['#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE'];
  return hlsTags.some(tag => firstLines.some(line => line.startsWith(tag)));
}

/**
 * 处理非M3U8内容
 * @param {string} content - 内容文本
 * @param {string} contentType - 内容类型
 * @param {string} url - 原始URL
 * @param {Headers} originalHeaders - 原始响应头
 * @returns {Response} 响应
 */
function handleNonM3U8Content(content, contentType, url, originalHeaders) {
  // 对于小体积内容，可以直接返回
  if (content.length < 1024 * 10) { // 10KB
    return new Response(content, {
      headers: {
        'Content-Type': contentType || 'text/plain',
        'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL}`
      }
    });
  }
  
  // 否则重定向到原始URL
  const headers = new Headers();
  headers.set('Location', url);
  return new Response(null, { 
    status: Status.Found, 
    headers 
  });
}

/**
 * 处理M3U8内容
 * @param {string} content - M3U8内容
 * @param {string} sourceUrl - 源URL
 * @param {number} depth - 递归深度
 * @param {URL} requestUrl - 原始请求URL
 * @returns {Promise<string>} 处理后的内容
 */
async function processM3U8Content(content, sourceUrl, depth, requestUrl) {
  // 防止递归过深
  if (depth > CONFIG.MAX_REDIRECTS) {
    throw new Error('Maximum processing depth reached');
  }
  
  try {
    // 检查是否是主播放列表
    if (isMasterPlaylist(content)) {
      if (CONFIG.DEBUG) log('Processing master playlist');
      return await processMasterPlaylist(content, sourceUrl, depth, requestUrl);
    }
    
    if (CONFIG.DEBUG) log('Processing media playlist');
    return processMediaPlaylist(content, sourceUrl);
  } catch (error) {
    log(`Error processing M3U8: ${error.message}`, true);
    throw error;
  }
}

/**
 * 检查是否为主播放列表
 * @param {string} content - M3U8内容
 * @returns {boolean} 是否为主播放列表
 */
function isMasterPlaylist(content) {
  return content.includes('#EXT-X-STREAM-INF') || 
         (content.includes('#EXT-X-MEDIA') && !content.includes('#EXTINF'));
}

/**
 * 处理主播放列表
 * @param {string} content - M3U8内容
 * @param {string} sourceUrl - 源URL
 * @param {number} depth - 递归深度
 * @param {URL} requestUrl - 原始请求URL
 * @returns {Promise<string>} 处理后的内容
 */
async function processMasterPlaylist(content, sourceUrl, depth, requestUrl) {
  const baseUrl = getBaseUrl(sourceUrl);
  const lines = content.split('\n');
  const output = [];
  
  let isStreamInf = false;
  let currentAttrs = {};
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 跳过空行
    if (!line.trim()) {
      continue;
    }
    
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isStreamInf = true;
      currentAttrs = parseAttributes(line);
      output.push(line);
      continue;
    }
    
    if (line.startsWith('#EXT-X-MEDIA')) {
      output.push(processMediaTag(line, baseUrl, requestUrl));
      continue;
    }
    
    if (isStreamInf && !line.startsWith('#') && line.trim()) {
      isStreamInf = false;
      
      // 解析变体流URL
      const variantUrl = resolveUrl(baseUrl, line);
      
      // 构建代理URL，保留原有参数
      const proxyUrl = createProxyUrl(requestUrl, variantUrl, currentAttrs);
      output.push(proxyUrl);
      
      // 清空当前属性
      currentAttrs = {};
    } else {
      output.push(line);
    }
  }
  
  return output.join('\n');
}

/**
 * 为变体流创建代理URL
 * @param {URL} requestUrl - 原始请求URL
 * @param {string} variantUrl - 变体流URL
 * @param {Object} attrs - 流属性
 * @returns {string} 代理URL
 */
function createProxyUrl(requestUrl, variantUrl, attrs) {
  // 创建代理URL基础
  const proxyUrl = new URL(requestUrl.origin);
  proxyUrl.pathname = '/m3u8filter/' + encodeURIComponent(variantUrl);
  
  // 添加有用的属性作为查询参数
  if (attrs.BANDWIDTH) proxyUrl.searchParams.set('bw', attrs.BANDWIDTH);
  if (attrs.RESOLUTION) proxyUrl.searchParams.set('res', attrs.RESOLUTION);
  if (attrs['FRAME-RATE']) proxyUrl.searchParams.set('fr', attrs['FRAME-RATE']);
  if (attrs.CODECS) proxyUrl.searchParams.set('codecs', attrs.CODECS);
  
  return proxyUrl.toString();
}

/**
 * 处理媒体播放列表
 * @param {string} content - M3U8内容
 * @param {string} sourceUrl - 源URL
 * @returns {string} 处理后的内容
 */
function processMediaPlaylist(content, sourceUrl) {
  const baseUrl = getBaseUrl(sourceUrl);
  const lines = content.split('\n');
  const output = [];
  
  let segmentDuration = 0;
  let isDiscontinuity = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 处理片段持续时间
    if (line.startsWith('#EXTINF:')) {
      const durationMatch = line.match(/#EXTINF:([\d.]+)/);
      if (durationMatch) {
        segmentDuration = parseFloat(durationMatch[1]);
      }
    }
    
    // 检测并处理广告片段
    if (CONFIG.STRIP_ADS && line.startsWith('#EXT-X-DISCONTINUITY')) {
      isDiscontinuity = true;
      
      // 如果下一行是#EXTINF，我们需要跳过下一个分段
      if (i + 1 < lines.length && lines[i + 1].startsWith('#EXTINF:') && 
          i + 2 < lines.length && !lines[i + 2].startsWith('#')) {
        i += 2; // 跳过EXTINF和分段URL
      }
      continue;
    }
    
    // 如果遇到新的EXTINF，重置状态
    if (line.startsWith('#EXTINF:')) {
      isDiscontinuity = false;
    }
    
    // 跳过不连续片段
    if (isDiscontinuity) {
      continue;
    }
    
    // 处理密钥行
    if (CONFIG.SUPPORT_EXT_X_KEY && line.startsWith('#EXT-X-KEY')) {
      output.push(processKeyLine(line, baseUrl));
      continue;
    }
    
    // 处理MAP行
    if (CONFIG.SUPPORT_EXT_X_MAP && line.startsWith('#EXT-X-MAP')) {
      output.push(processMapLine(line, baseUrl));
      continue;
    }
    
    // 处理字节范围
    if (CONFIG.SUPPORT_EXT_X_BYTERANGE && line.startsWith('#EXT-X-BYTERANGE')) {
      output.push(line);
      continue;
    }
    
    // 处理分段URL
    if (!line.startsWith('#') && line.trim()) {
      output.push(processSegmentLine(line, baseUrl, segmentDuration));
      continue;
    }
    
    // 保留其他行
    output.push(line);
  }
  
  return output.join('\n');
}

/**
 * 处理MEDIA标签
 * @param {string} line - 标签行
 * @param {string} baseUrl - 基础URL
 * @param {URL} requestUrl - 原始请求URL
 * @returns {string} 处理后的行
 */
function processMediaTag(line, baseUrl, requestUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const fullUrl = resolveUrl(baseUrl, uri);
    const proxyUrl = new URL(requestUrl.origin);
    proxyUrl.pathname = '/m3u8filter/' + encodeURIComponent(fullUrl);
    return `URI="${proxyUrl.toString()}"`;
  });
}

/**
 * 处理KEY标签
 * @param {string} line - 标签行
 * @param {string} baseUrl - 基础URL
 * @returns {string} 处理后的行
 */
function processKeyLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const fullUrl = resolveUrl(baseUrl, uri);
    const proxyUrl = constructProxyUrl(fullUrl, true);
    return `URI="${proxyUrl}"`;
  });
}

/**
 * 处理MAP标签
 * @param {string} line - 标签行
 * @param {string} baseUrl - 基础URL
 * @returns {string} 处理后的行
 */
function processMapLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const fullUrl = resolveUrl(baseUrl, uri);
    const proxyUrl = constructProxyUrl(fullUrl, true);
    return `URI="${proxyUrl}"`;
  });
}

/**
 * 处理分段URL
 * @param {string} line - URL行
 * @param {string} baseUrl - 基础URL
 * @param {number} duration - 片段持续时间
 * @returns {string} 处理后的URL
 */
function processSegmentLine(line, baseUrl, duration) {
  let segmentUrl = line.trim();
  
  // 标准化URL（如果启用）
  if (CONFIG.NORMALIZE_SEGMENTS) {
    // 移除查询参数和片段标识
    segmentUrl = segmentUrl.split(/[?#]/)[0];
  }
  
  const fullUrl = resolveUrl(baseUrl, segmentUrl);
  
  // 智能代理选择
  if (CONFIG.SMART_PROXY_SELECTION) {
    // 一种基于文件扩展名的简单策略
    const isTs = /\.(ts|aac|m4s|mp4)$/i.test(fullUrl);
    return constructProxyUrl(fullUrl, isTs);
  }
  
  return constructProxyUrl(fullUrl, false);
}

/**
 * 构建代理URL
 * @param {string} url - 目标URL
 * @param {boolean} isKey - 是否为密钥或TS片段
 * @returns {string} 代理URL
 */
function constructProxyUrl(url, isKey = false) {
  // 选择代理地址
  const proxyUrl = isKey ? CONFIG.TS_PROXY_URL : CONFIG.PROXY_URL;
  const shouldEncode = isKey ? CONFIG.TS_PROXY_URLENCODE : CONFIG.PROXY_URLENCODE;
  
  if (!proxyUrl) return url;
  
  // 构造最终URL
  return shouldEncode
    ? `${proxyUrl}${encodeURIComponent(url)}`
    : `${proxyUrl}${url}`;
}

/**
 * 获取基础URL
 * @param {string} url - 完整URL
 * @returns {string} 基础URL
 */
function getBaseUrl(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    return `${urlObj.origin}${path.substring(0, path.lastIndexOf('/') + 1)}`;
  } catch {
    // 如果URL解析失败，尝试简单字符串处理
    const lastSlash = url.lastIndexOf('/');
    return lastSlash > 8 ? url.substring(0, lastSlash + 1) : url;
  }
}

/**
 * 解析相对URL
 * @param {string} baseUrl - 基础URL
 * @param {string} relativeUrl - 相对URL
 * @returns {string} 完整URL
 */
function resolveUrl(baseUrl, relativeUrl) {
  // 检查是否已经是绝对URL
  if (relativeUrl.match(/^https?:\/\//i)) {
    return relativeUrl;
  }
  
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch {
    // 简单拼接
    if (relativeUrl.startsWith('/')) {
      // 相对于域名根路径
      const urlObj = new URL(baseUrl);
      return `${urlObj.origin}${relativeUrl}`;
    }
    // 相对于当前路径
    return baseUrl + relativeUrl;
  }
}

/**
 * 解析标签属性
 * @param {string} line - 标签行
 * @returns {Object} 解析后的属性
 */
function parseAttributes(line) {
  const attrs = {};
  // 使用更强大的正则表达式处理双引号和未引用的值
  const matches = line.matchAll(/([A-Z-]+)=(?:"([^"]*)"|([^,\s]+))/g);
  
  for (const match of matches) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2] : match[3];
    attrs[key] = value;
  }
  
  return attrs;
}

/**
 * 创建错误响应
 * @param {string} message - 错误消息
 * @param {number} status - 状态码
 * @returns {Response} 错误响应
 */
function createErrorResponse(message, status = Status.BadRequest) {
  const headers = new Headers({
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-store'
  });
  
  if (CONFIG.ENABLE_CORS) {
    headers.set('Access-Control-Allow-Origin', '*');
  }
  
  return new Response(`Error: ${message}`, { status, headers });
}

/**
 * 日志函数
 * @param {string} message - 日志消息
 * @param {boolean} isError - 是否为错误日志
 */
function log(message, isError = false) {
  if (!CONFIG.DEBUG && !isError) return;
  
  const prefix = isError ? '[ERROR]' : '[INFO]';
  const timestamp = new Date().toISOString();
  console.log(`${prefix} ${timestamp} ${message}`);
}

// 启动服务器
console.log(`Starting M3U8 proxy server on port ${CONFIG.PORT}...`);
console.log(`Server URL: http://localhost:${CONFIG.PORT}/`);

// 启动HTTP服务器
serve(handleRequest, { port: CONFIG.PORT });
