<?php
/**
 * M3U8 Proxy and Filter Script with EXT-X-MAP Support
 *
 * 功能：
 * 1. 使用 CURL 代理获取 M3U8 文件并重写其中的 TS/fMP4 分片 URL
 * 2. 支持 EXT-X-MAP 初始化段代理
 * 3. 处理加密流 (EXT-X-KEY)
 * 4. 可配置是否开启智能过滤，智能过滤算法会分析可能的广告片段并过滤
 * 5. 支持本地缓存
 * 6. 自动解析主播放列表(带递归深度限制)
 * 7. 检测非M3U8内容:
 *    - 如果是音视频/图片文件则使用TS代理跳转
 *    - 其他情况直接跳转原始URL
 */

// ========== 配置区域 ==========
define('PROXY_URL', 'https://your/proxy/');    // 主代理地址；如不需要可留空字符串
define('PROXY_URLENCODE', false);                        // 是否编码目标URL

define('PROXY_TS', 'https://your/proxy/');   // TS分片代理地址；如不需要可留空字符串
define('PROXY_TS_URLENCODE', true);                      // 是否编码TS URL

define('CACHE_DIR', 'm3u8files/');                       // 缓存目录
define('CACHE_TIME', 86400);                             // 缓存时间(秒)

define('MAX_RECURSION', 30);                             // 最大递归深度(主播放列表解析)

/* // 不再过滤FILTER_DISCONTINUITY标识了，使用下面的智能过滤算法
define('FILTER_DISCONTINUITY', true);
*/

define('FILTER_ADS_INTELLIGENTLY', true);  // 是否启用智能广告过滤
define('FILTER_REGEX', null);              // 可选的正则过滤规则，例如: 'ad\.com|adsegment'，动态调整吧

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
 * 智能过滤M3U8内容
 * @param string $content - 原始M3U8内容
 * @param string|null $regexFilter - 可选的正则过滤规则
 * @return string 过滤后的完整M3U8内容
 */
function filterDiscontinuity($content, $regexFilter = null) {
    if (empty($content)) return $content;
    
    // ==================== 第一阶段：预处理 ====================
    // 1. 正则过滤
    $processedContent = $regexFilter 
        ? applyRegexFilter($content, $regexFilter) 
        : $content;
    
    // 2. 解析M3U8结构
    $parsed = parseM3U8Structure($processedContent);
    $segments = $parsed['segments'];
    $headers = $parsed['headers'];
    
    if (empty($segments)) return $processedContent;
    
    // ==================== 第二阶段：科学分析 ====================
    // 1. 计算基础统计量
    $stats = calculateSegmentStats($segments);
    
    // 2. 多维度广告检测
    $analyzedSegments = analyzeSegments($segments, $stats);
    
    // 3. 智能过滤决策
    $filteredSegments = applyFilterDecision($analyzedSegments, $stats);
    
    // ==================== 第三阶段：重建M3U8 ====================
    return rebuildM3U8($headers, $filteredSegments, $processedContent);
}

// ==================== 辅助函数 ====================

/**
 * 应用正则过滤
 */
function applyRegexFilter($content, $regexFilter) {
    try {
        return preg_replace('/' . $regexFilter . '/i', '', $content);
    } catch (Exception $e) {
        error_log('正则过滤失败: ' . $e->getMessage());
        return $content;
    }
}

/**
 * 深度解析M3U8结构
 */
function parseM3U8Structure($content) {
    $lines = explode("\n", $content);
    $segments = [];
    $headers = [
        'main' => [],
        'other' => []
    ];
    $currentDiscontinuity = false;
    $currentMap = null;
    $segmentIndex = 0;

    foreach ($lines as $i => $line) {
        $line = trim($line);
        
        // 收集头部信息
        if ($i < 10 && strpos($line, '#EXT') === 0) {
            $headers['main'][] = $line;
            continue;
        }
        
        // 处理关键标签
        if (strpos($line, '#EXT-X-MAP:') === 0) {
            $currentMap = $line;
            continue;
        }
        
        if (strpos($line, '#EXT-X-DISCONTINUITY') !== false) {
            $currentDiscontinuity = true;
            continue;
        }
        
        // 解析片段
        if (strpos($line, '#EXTINF:') === 0) {
            if (preg_match('/#EXTINF:([\d.]+)/', $line, $durationMatch)) {
                $nextLine = $lines[$i + 1] ?? '';
                if (!empty($nextLine) && strpos($nextLine, '#') !== 0) {
                    $duration = (float)$durationMatch[1];
                    $url = trim($nextLine);
                    
                    $segments[] = [
                        'index' => $segmentIndex++,
                        'startLine' => $i,
                        'endLine' => $i + 1,
                        'duration' => $duration,
                        'url' => $url,
                        'hasDiscontinuity' => $currentDiscontinuity,
                        'hasMap' => $currentMap !== null,
                        'content' => $currentMap 
                            ? $currentMap . "\n" . $line . "\n" . $nextLine
                            : $line . "\n" . $nextLine,
                        'isAd' => false,  // 初始标记
                        'adScore' => 0     // 广告概率得分
                    ];
                    
                    $currentDiscontinuity = false;
                    $currentMap = null;
                }
            }
        } elseif (strpos($line, '#') === 0) {
            $headers['other'][] = $line;
        }
    }
    
    return ['segments' => $segments, 'headers' => $headers];
}

/**
 * 计算高级统计量
 */
function calculateSegmentStats($segments) {
    $durations = array_column($segments, 'duration');
    $totalDuration = array_sum($durations);
    $avgDuration = $totalDuration / count($durations);
    
    // 计算标准差
    $squaredDiffs = array_map(function($d) use ($avgDuration) {
        return pow($d - $avgDuration, 2);
    }, $durations);
    $stdDev = sqrt(array_sum($squaredDiffs) / count($durations));
    
    // 排序后的时长数组用于百分位计算
    sort($durations);
    $p10 = $durations[(int)(count($durations) * 0.1)];
    $p90 = $durations[(int)(count($durations) * 0.9)];
    
    return [
        'avgDuration' => $avgDuration,
        'stdDev' => $stdDev,
        'p10' => $p10,
        'p90' => $p90,
        'totalDuration' => $totalDuration,
        'segmentCount' => count($segments),
        'durationRange' => [$durations[0], $durations[count($durations)-1]]
    ];
}

/**
 * 多维度片段分析
 */
function analyzeSegments($segments, $stats) {
    $avgDuration = $stats['avgDuration'];
    $stdDev = $stats['stdDev'];
    $p10 = $stats['p10'];
    $p90 = $stats['p90'];
    
    $analyzed = [];
    foreach ($segments as $segment) {
        $deviation = abs($segment['duration'] - $avgDuration);
        $zScore = $stdDev > 0 ? $deviation / $stdDev : 0;
        
        // 1. 时长异常检测
        $durationAbnormality = min(1, $zScore / 3); // 0-1范围
        
        // 2. 位置异常检测（开头/结尾的短片段更可能是广告）
        $positionFactor = 0;
        if ($segment['index'] < 3 && $segment['duration'] < $p10) {
            $positionFactor = 0.8; // 开头的短片段很可疑
        } elseif ($segment['index'] > count($segments) - 3 && $segment['duration'] < $p10) {
            $positionFactor = 0.5; // 结尾的短片段中等可疑
        }
        
        // 3. 不连续标记检测
        $discontinuityFactor = $segment['hasDiscontinuity'] ? 0.3 : 0;
        
        // 综合广告概率
        $adScore = min(1, 
            ($durationAbnormality * 0.6) + 
            ($positionFactor * 0.3) + 
            ($discontinuityFactor * 0.1)
        );
        
        $segment['adScore'] = $adScore;
        $segment['isAd'] = $adScore > 0.65; // 阈值可调整
        $segment['stats'] = ['deviation' => $deviation, 'zScore' => $zScore];
        
        $analyzed[] = $segment;
    }
    
    return $analyzed;
}

/**
 * 智能过滤决策
 */
function applyFilterDecision($segments, $stats) {
    $avgDuration = $stats['avgDuration'];
    $stdDev = $stats['stdDev'];
    
    // 动态调整阈值
    $baseThreshold = 0.65;
    $dynamicThreshold = min(0.8, max(0.5, 
        $baseThreshold - ($stdDev / $avgDuration) * 0.2
    ));
    
    return array_filter($segments, function($segment) use ($dynamicThreshold) {
        // 明确广告标记
        if ($segment['isAd'] && $segment['adScore'] > $dynamicThreshold) {
            return false;
        }
        
        // 极短片段过滤（<1秒且不在开头）
        if ($segment['duration'] < 1.0 && $segment['index'] > 3) {
            return false;
        }
        
        // 保留关键片段（如包含MAP的）
        if ($segment['hasMap']) {
            return true;
        }
        
        // 默认保留
        return true;
    });
}

/**
 * 完美重建M3U8
 */
function rebuildM3U8($headers, $segments, $originalContent) {
    // 收集需要保留的行号
    $keepLines = [];
    
    // 保留所有头部信息
    foreach ($headers['main'] as $line) {
        $keepLines[] = $line;
    }
    
    // 保留所有片段内容
    foreach ($segments as $segment) {
        $contentLines = explode("\n", $segment['content']);
        foreach ($contentLines as $line) {
            $keepLines[] = $line;
        }
    }
    
    // 处理其他关键标签
    $lines = explode("\n", $originalContent);
    $criticalTags = [
        '#EXT-X-VERSION',
        '#EXT-X-TARGETDURATION',
        '#EXT-X-MEDIA-SEQUENCE',
        '#EXT-X-PLAYLIST-TYPE',
        '#EXT-X-ENDLIST'
    ];
    
    foreach ($lines as $line) {
        $line = trim($line);
        foreach ($criticalTags as $tag) {
            if (strpos($line, $tag) === 0) {
                $keepLines[] = $line;
                break;
            }
        }
    }
    
    // 重建内容
    $filteredLines = array_unique($keepLines);
    
    // 更新关键头部信息
    $filteredContent = implode("\n", $filteredLines);
    $filteredContent = updateM3U8Headers($filteredContent, $segments);
    
    return $filteredContent;
}

/**
 * 更新M3U8头部信息
 */
function updateM3U8Headers($content, $segments) {
    if (empty($segments)) return $content;
    
    $lines = explode("\n", $content);
    
    // 更新TARGETDURATION
    $maxDuration = max(array_column($segments, 'duration'));
    foreach ($lines as &$line) {
        if (strpos($line, '#EXT-X-TARGETDURATION') === 0) {
            $line = '#EXT-X-TARGETDURATION:' . ceil($maxDuration);
            break;
        }
    }
    
    // 更新MEDIA-SEQUENCE
    if ($segments[0]['index'] > 0) {
        foreach ($lines as &$line) {
            if (strpos($line, '#EXT-X-MEDIA-SEQUENCE') === 0) {
                $line = '#EXT-X-MEDIA-SEQUENCE:' . $segments[0]['index'];
                break;
            }
        }
    }
    
    return implode("\n", $lines);
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
    // 替换原来的 filterDiscontinuity 调用
    $filtered = FILTER_ADS_INTELLIGENTLY 
    ? filterDiscontinuity($content, FILTER_REGEX)
    : $content;
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
