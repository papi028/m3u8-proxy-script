<?php
/**
 * M3U8 Proxy and Filter Script with EXT-X-MAP Support
 *
 * 功能：
 * 1. 使用 CURL 代理获取 M3U8 文件并重写其中的 TS/fMP4 分片 URL
 * 2. 支持 EXT-X-MAP 初始化段代理
 * 3. 处理加密流 (EXT-X-KEY)
 * 4. 可配置是否过滤 discontinuity 标记
 * 5. 支持本地缓存
 * 6. 自动解析主播放列表(带递归深度限制)
 * 7. 检测非M3U8内容:
 *    - 如果是音视频/图片文件则使用TS代理跳转
 *    - 其他情况直接跳转原始URL
 */

// ========== 配置区域 ==========
define('PROXY_URL', 'https://proxy.mengze.vip/proxy/');    // 主代理地址；如不需要可留空字符串
define('PROXY_URLENCODE', true);                        // 是否编码目标URL

define('PROXY_TS', 'https://proxy.mengze.vip/proxy/');   // TS分片代理地址；如不需要可留空字符串
define('PROXY_TS_URLENCODE', true);                      // 是否编码TS URL

define('CACHE_DIR', 'm3u8files/');                       // 缓存目录
define('CACHE_TIME', 86400);                             // 缓存时间(秒)

define('MAX_RECURSION', 30);                             // 最大递归深度(主播放列表解析)
define('FILTER_DISCONTINUITY', true);                    // 是否过滤 discontinuity 标记

// 媒体文件扩展名
define('MEDIA_FILE_EXTENSIONS', [
    // 视频格式
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    // 音频格式
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    // 图片格式
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
]);

// 媒体内容类型
define('MEDIA_CONTENT_TYPES', [
    // 视频类型
    'video/',
    // 音频类型
    'audio/',
    // 图片类型
    'image/'
]);

// 常用浏览器UA
$userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.2 Safari/605.1.15'
];


// ========== 核心函数 ==========

/**
 * 获取缓存文件名
 */
function getCacheFilename($url) {
    return CACHE_DIR . md5($url) . '.m3u8';
}

/**
 * 清理过期缓存
 */
function cleanExpiredCache() {
    $count = 0;
    if (!is_dir(CACHE_DIR)) return $count;
    
    foreach (glob(CACHE_DIR . '*.m3u8') as $file) {
        if (time() - filemtime($file) > CACHE_TIME && unlink($file)) {
            $count++;
        }
    }
    return $count;
}

/**
 * 从缓存获取内容
 */
function getFromCache($url) {
    $cacheFile = getCacheFilename($url);
    if (!file_exists($cacheFile)) return false;
    
    if (time() - filemtime($cacheFile) > CACHE_TIME) {
        cleanExpiredCache();
        return false;
    }
    
    return file_get_contents($cacheFile);
}

/**
 * 写入缓存
 */
function writeToCache($url, $content) {
    if (!is_dir(CACHE_DIR)) mkdir(CACHE_DIR, 0755, true);
    file_put_contents(getCacheFilename($url), $content);
}

/**
 * 使用 curl 获取远程内容。增加超时设置和错误处理。
 *
 * @param string $url 请求的 URL
 * @param array $customHeaders 可选：自定义 HTTP 头
 * @return array [ 'content' => string|false, 'contentType' => string ]
 */
function curlFetch($url, $customHeaders = []) {
    global $userAgents;
    
    // 如果配置了代理 URL，则拼接代理路径
    if (!empty(PROXY_URL)) {
        $url = PROXY_URL . (PROXY_URLENCODE ? urlencode($url) : $url);
    }
    
    $ch = curl_init();
    
    // 构造请求头，默认 Accept: */*
    $defaultHeaders = [
        'Accept: */*'
    ];
    $allHeaders = array_merge($defaultHeaders, $customHeaders);
    
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT => $userAgents[array_rand($userAgents)],
        CURLOPT_HTTPHEADER => $allHeaders,
        CURLOPT_HEADER => true,         // 同时返回header和body部分
        CURLOPT_CONNECTTIMEOUT => 30,     // 建立连接超时（秒）
        CURLOPT_TIMEOUT => 60,            // 整体超时（秒）
    ]);
    
    $response = curl_exec($ch);
    if (curl_errno($ch)) {
        error_log('CURL Error (' . curl_errno($ch) . '): ' . curl_error($ch));
        curl_close($ch);
        return [
            'content' => false,
            'contentType' => ''
        ];
    }
    
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $headersStr = substr($response, 0, $headerSize);
    $content = substr($response, $headerSize);
    $contentType = '';
    
    // 解析 header 获取内容类型
    $headerLines = explode("\r\n", $headersStr);
    foreach ($headerLines as $header) {
        if (stripos($header, 'Content-Type:') === 0) {
            $contentType = trim(substr($header, 13));
            break;
        }
    }
    
    curl_close($ch);
    
    return [
        'content' => $content,
        'contentType' => $contentType
    ];
}

/**
 * 获取远程内容(封装 curlFetch)
 */
function fetchContentWithType($url) {
    return curlFetch($url);
}

/**
 * 判断内容是否为 M3U8 格式(通过内容头或内容签名)
 */
function isM3u8Content($content, $contentType) {
    // 根据 Content-Type 头判断
    if ($contentType &&
        (stripos($contentType, 'application/vnd.apple.mpegurl') !== false ||
         stripos($contentType, 'application/x-mpegurl') !== false)) {
        return true;
    }
    
    // 检查文件开头字符
    if ($content && strpos(trim($content), '#EXTM3U') === 0) {
        return true;
    }
    
    return false;
}

/**
 * 判断是否为媒体文件（通过扩展名或内容类型）
 */
function isMediaFile($url, $contentType) {
    // 根据 Content-Type 判断
    if ($contentType) {
        foreach (MEDIA_CONTENT_TYPES as $mediaType) {
            if (stripos($contentType, $mediaType) === 0) {
                return true;
            }
        }
    }
    
    // 根据 URL 扩展名判断
    $urlLower = strtolower($url);
    foreach (MEDIA_FILE_EXTENSIONS as $ext) {
        // 判断 URL 中是否包含扩展名，例如以该扩展名结尾或者扩展名后跟查询参数
        if (strpos($urlLower, $ext) !== false &&
           (substr($urlLower, -strlen($ext)) === $ext || strpos($urlLower, $ext . '?') !== false)) {
            return true;
        }
    }
    
    return false;
}

/**
 * 生成 TS 分片代理 URL
 */
function proxyTsUrl($url) {
    if (empty(PROXY_TS)) return $url;
    
    return PROXY_TS . (PROXY_TS_URLENCODE ? urlencode($url) : $url);
}

/**
 * 解析相对 URL 为绝对 URL
 */
function resolveUrl($baseUrl, $relativeUrl) {
    if (preg_match('/^https?:\/\//i', $relativeUrl)) return $relativeUrl;
    
    $parsed = parse_url($baseUrl);
    if (!$parsed || !isset($parsed['scheme']) || !isset($parsed['host'])) {
        return $relativeUrl;
    }
    
    $scheme = $parsed['scheme'];
    $host = $parsed['host'];
    $port   = isset($parsed['port']) ? ':' . $parsed['port'] : '';
    
    if (strpos($relativeUrl, '/') === 0) {
        return "$scheme://$host$port$relativeUrl";
    }
    
    $path = isset($parsed['path']) ? $parsed['path'] : '';
    if ($path !== '' && substr($path, -1) !== '/') {
        $path = dirname($path) . '/';
    }
    
    return "$scheme://$host$port$path$relativeUrl";
}

/**
 * 修改加密密钥 URI（通过代理 TS 地址）
 */
function modifyKeyUri($line, $baseUrl) {
    if (preg_match('/URI="([^"]+)"/', $line, $matches)) {
        $absoluteUri = resolveUrl($baseUrl, $matches[1]);
        if (!empty(PROXY_TS)) {
            $proxiedUri = proxyTsUrl($absoluteUri);
            $line = str_replace($matches[1], $proxiedUri, $line);
        }
    }
    return $line;
}

/**
 * 修改 M3U8 内容中的 URL ：
 * 1. 修改 EXT-X-MAP 初始化段；
 * 2. 修改加密密钥；
 * 3. 修改媒体分片地址（通过 TS 代理）。
 */
function modifyM3u8Urls($content, $baseUrl) {
    $lines = explode("\n", $content);
    $modified = [];
    $isNextLineMedia = false;
    
    foreach ($lines as $line) {
        $trimmed = trim($line);
        
        if (empty($trimmed)) {
            $modified[] = $line;
            continue;
        }
        
        // 处理 EXT-X-MAP 初始化段
        if (strpos($trimmed, '#EXT-X-MAP:') === 0) {
            if (preg_match('/URI="([^"]+)"/', $trimmed, $matches)) {
                $absoluteUri = resolveUrl($baseUrl, $matches[1]);
                if (!empty(PROXY_TS)) {
                    $proxiedUri = proxyTsUrl($absoluteUri);
                    $line = str_replace($matches[1], $proxiedUri, $line);
                }
            }
            $modified[] = $line;
            continue;
        }
        
        // 处理加密密钥
        if (strpos($trimmed, '#EXT-X-KEY') === 0) {
            $modified[] = modifyKeyUri($line, $baseUrl);
            continue;
        }
        
        // 处理媒体分片：EXTINF 后一行通常为媒体文件 URL
        if (strpos($trimmed, '#EXTINF:') === 0) {
            $isNextLineMedia = true;
            $modified[] = $line;
        } elseif ($isNextLineMedia && strpos($trimmed, '#') !== 0) {
            $absoluteUrl = resolveUrl($baseUrl, $trimmed);
            if (!empty(PROXY_TS)) {
                $modified[] = proxyTsUrl($absoluteUrl);
            } else {
                $modified[] = $absoluteUrl;
            }
            $isNextLineMedia = false;
        } else {
            $modified[] = $line;
            $isNextLineMedia = false;
        }
    }
    
    return implode("\n", $modified);
}

/**
 * 对 M3U8 内容过滤 discontinuity 标记
 */
function filterDiscontinuity($content) {
    if (!FILTER_DISCONTINUITY) return $content;
    
    return implode("\n", array_filter(explode("\n", $content), function($line) {
        return !empty(trim($line)) && strpos(trim($line), '#EXT-X-DISCONTINUITY') !== 0;
    }));
}

/**
 * 获取基础 URL 路径，用于解析相对地址
 */
function getBaseDirectoryUrl($url) {
    $parsed = parse_url($url);
    if (!$parsed || !isset($parsed['path'])) return $url;
    
    $path = $parsed['path'];
    $lastSlash = strrpos($path, '/');
    $path = $lastSlash !== false ? substr($path, 0, $lastSlash + 1) : '/';
    
    $scheme = $parsed['scheme'] ?? 'https';
    $host = $parsed['host'] ?? '';
    $port = isset($parsed['port']) ? ':' . $parsed['port'] : '';
    
    return "$scheme://$host$port$path";
}

/**
 * 主处理函数：对提供的 M3U8 URL 进行代理和过滤处理
 */
function processM3u8Url($url) {
    // 尝试从缓存中获取
    if (($cached = getFromCache($url)) !== false) {
        header('Content-Type: application/vnd.apple.mpegurl');
        header('Access-Control-Allow-Origin: *');
        echo $cached;
        return;
    }
    
    // 使用 CURL 获取内容和响应头类型
    $result = fetchContentWithType($url);
    $content = $result['content'];
    $contentType = $result['contentType'];
    
    // 判断是否为 M3U8 内容
    if (!isM3u8Content($content, $contentType)) {
        // 非 M3U8 文件，则判断是否为媒体文件，采用 TS代理跳转
        if (isMediaFile($url, $contentType)) {
            header('Location: ' . proxyTsUrl($url));
        } else {
            // 非媒体文件，直接跳转到原始 URL
            header("Location: $url");
        }
        exit;
    }
    
    // 主播放列表递归解析。如果遇到 EXT-X-STREAM-INF，则根据其后续的媒体 URL 重新请求
    $currentUrl = $url;
    $recursionCount = 0;
    while (strpos($content, '#EXT-X-STREAM-INF') !== false) {
        if ($recursionCount >= MAX_RECURSION) {
            error_log("Exceeded maximum recursion count: " . MAX_RECURSION);
            break;
        }
        
        $lines = array_filter(explode("\n", $content), 'trim');
        foreach ($lines as $line) {
            $line = trim($line);
            if (empty($line)) continue;
            if ($line[0] !== '#') {
                $currentUrl = resolveUrl($currentUrl, $line);
                break;
            }
        }
        
        $result = fetchContentWithType($currentUrl);
        if (!$result['content']) {
            error_log("Failed to fetch M3U8 content from URL: " . $currentUrl);
            break;
        }
        $content = $result['content'];
        $recursionCount++;
    }
    
    // 处理并修改 M3U8 中的 URL
    $baseUrl = getBaseDirectoryUrl($currentUrl);
    $filtered = filterDiscontinuity($content);
    $modified = modifyM3u8Urls($filtered, $baseUrl);
    
    // 写入缓存后返回
    writeToCache($url, $modified);
    header('Content-Type: application/vnd.apple.mpegurl');
    header('Access-Control-Allow-Origin: *');
    echo $modified;
}

/**
 * 获取目标 URL
 */
function getTargetUrl() {
    $url = isset($_GET['url']) ? $_GET['url'] : null;
    
    // 如果 URL 参数为空，则尝试从 REQUEST_URI 中提取参数
    if (empty($url)) {
        $path = $_SERVER['REQUEST_URI'] ?? '';
        if (preg_match('/\/m3u8filter\/(.+)/', $path, $matches)) {
            $url = $matches[1];
        }
    }
    
    return !empty($url) ? urldecode($url) : null;
}

// ========== 主执行逻辑 ==========
$TargetUrl = getTargetUrl();
if (!empty($TargetUrl)) {
    processM3u8Url($TargetUrl);
} else {
    header('Content-Type: text/plain');
    echo "请通过 url 参数提供M3U8地址";
}
?>
