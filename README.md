# M3U8 Proxy Filter Script
# 项目说明文档

# 代理地址说明
脚本内示例的代理地址`https://proxy.mengze.vip/proxy/`已失效，请自行部署cf代理或其他代理进行替换，cf代理部署参考[cloudflare-safeproxy](https://github.com/eraycc/cloudflare-safeproxy)，部署后，将代理地址替换为API代理地址，URL编码配置为false(也可自行修改cf代理脚本代码，使其支持URL编码)。
## 项目概述

M3U8 Proxy Filter Script 是一个多语言实现的 HLS (HTTP Live Streaming) 代理过滤脚本，支持Nodejs、Cloudflare Worker(cf Pages)、Deno 和 PHP 环境。脚本提供 M3U8 播放链接的去广告、代理加速功能，并支持多种 HLS 协议特性。

## 功能特性

### 核心功能
- **代理重写**：使用代理获取 M3U8 文件并重写其中的 TS/fMP4 分片 URL
- **EXT-X-MAP 支持**：完整支持初始化段代理
- **加密流处理**：支持 EXT-X-KEY 加密流处理
- **discontinuity 标记过滤（建议弃用吧）**：可配置是否过滤 discontinuity 标记
- **基于正则表达式和统计学算法进行过滤**：可参考最新上传的php过滤脚本自行修改，js语法可参考下面的函数：
```
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
```
- **缓存支持**：
  - PHP：本地文件缓存
  - Deno：内存缓存
  - Cloudflare Worker：
    worker.js: KV 存储版（需设置变量名称为 `M3U8_PROXY_KV`）
    worker-chache.js: 基于worker的边缘网络自带cache缓存，可以直接调用，直接缓存，无限制且无需配置(感谢L站edwa佬友提供的思路)

### 高级功能
- **主播放列表解析**：自动解析主播放列表（带递归深度限制）
- **非 M3U8 内容处理**：
  - 音视频/图片文件：使用 TS 代理跳转加速
  - 其他内容：直接跳转原始 URL
- **双代理设置**：全部脚本支持双代理配置
- **广告处理**：支持 M3U8 全局加速及去除广告标记

## 部署与使用
```
deno 部署：
fork该项目，打开deno面板，导入复刻的项目，Entrypoint填写deno.ts

cf worker 部署：
新建kv后，绑定时设置变量名称为M3U8_PROXY_KV，复制worker.js到新建worker内部署。** worker-cache版不用配置kv **

PHP 部署：
把PHP脚本复制到PHP(CURL)环境服务器，设置伪静态规则
```

### 通用调用方式
```
https://deployurl/?url=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
或
https://deployurl/m3u8filter/https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
```

### 环境特定配置

#### PHP 环境
```
m3u8filter.php?url=m3u8link
或
m3u8filter.php/m3u8filter/m3u8link
或设置伪静态后
m3u8filter/m3u8link
```

**PHP伪静态规则配置**：

**Nginx**:
```nginx
rewrite ^/m3u8filter/(https?):/(.*)$ /m3u8filter.php?url=$1://$2 last;
```

**Apache**:
```apache
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteRule ^m3u8filter/(https?):/(.*)$ m3u8filter.php?url=$1://$2 [L,QSA]
</IfModule>
```

## 技术优化

### 性能优化
- 基于哈希的缓存键，减少缓存冲突
- 请求超时处理，避免服务卡死
- 流处理改进，减少内存占用

### 功能增强
- 智能广告检测和过滤，标记可能的广告片段
- 增强对各种 HLS 标签的支持（如 EXT-X-BYTERANGE）
- CORS 标头设置完善
- 安全头添加，提高安全性
- 支持保留原始响应头的关键信息

## 架构设计

### 模块化设计
- 每个函数负责单一功能
- 详细的错误处理和日志记录
- 配置项分组和详细说明

### 错误处理
- 统一的错误响应创建
- 详细的错误信息反馈
- 全局异常捕获，防止服务中断

### 日志与调试
- 可配置日志开关(debug)
- 请求和响应的详细日志
- 时间戳和结构化日志输出

## 配置参数

### 通用配置项
| 参数名 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `url` | string | 必填 | 要处理的 M3U8 文件 URL |
| `PROXY_URL` | string | 可选 | 主代理服务器地址 |
| `PROXY_TS` | string | 可选 | TS视频流代理服务器地址 |
| `FILTER_DISCONTINUITY` | boolean | `true` | 是否过滤 discontinuity 标记 |
| `CACHE_TTL` | number | `3600` | 缓存时间（秒） |
| `MAX_RECURSION` | number | `3` | 最大重定向深度 |

### 脚本环境特定配置
- **Cloudflare Worker**：需配置 `M3U8_PROXY_KV` KV 存储绑定
- **PHP**：需配置可写的缓存目录
- **Deno**：内存级缓存，可直接部署使用

## 开发指南

### 构建与部署

#### Cloudflare Worker
worker.js
1. 创建新的 Worker 项目
2. 绑定 KV 命名空间（名称为 `M3U8_PROXY_KV`）
3. 部署脚本

worker-cache.js
1. 创建新的 Worker 项目
2. 复制代码
3. 部署脚本

#### 如何将worker部署到cf pages？
第一种：fork该项目，修改你要部署的cf worker脚本名为`_worker.js`，在cfpage中导入fork的仓库，如果是kv缓存还需要配置kv变量，如果是cache版则直接部署。

第二种：下载cf worker脚本，重命名为_worker.js，并打包成_worker.js.zip
在 Cloudflare Pages 控制台中选择 上传资产后，为你的项目取名后点击 创建项目，然后上传你压缩好的 _worker.js.zip 文件后点击 部署站点。
部署完成后点击 继续处理站点 后，选择 设置 > 环境变量 > 制作为生产环境定义变量 > 添加KV变量（如果不是cf kv版可不用设置），点击保存。
返回 部署 选项卡，在右下角点击 创建新部署 后，重新上传 _worker.js.zip 文件后点击 保存并部署 即可。

#### Deno
fork该项目,在deno控制面板导入fork的项目，安装和部署命令参考下方代码块，
选择边缘节点自带cache api版(deno-cache.js)和内存缓存版(deno.js)都可以，Entrypoint配置项填写deno-cache.js或deno.ts，部署后返回Github action打开deploy进行授权
```bash
安装
deno install -gArf jsr:@deno/deployctl
部署
deployctl deploy
```

#### PHP
1. 上传 `m3u8filter.php` 到 web 服务器
2. 配置伪静态规则（可选）
3. 确保缓存目录可写

## 安全注意事项

1. 建议部署后启用 HTTPS
2. 定期更新
3. 监控异常请求
4. 对速率进行限制

## 故障排除

### 常见问题
1. **播放失败**：
   - 检查原始 URL 是否可访问
   - 验证代理服务器配置
   - 检查缓存是否过期
   - 检查脚本处理逻辑

2. **广告过滤不生效**：
   - 确认广告标记检测规则
   - 检查 M3U8 文件结构是否有变化

3. **性能问题**：
   - 调整缓存 TTL
   - 检查代理服务器性能
   - 优化网络连接

## 未来计划

1. 将m3u8广告过滤通过正则表达式匹配，达到动态过滤效果

## 贡献指南

欢迎通过 Issue 和 Pull Request 贡献代码。提交前请确保：
1. 代码符合项目风格
2. 通过基本测试
3. 更新相关文档

## 许可证

本项目采用 Apache-2.0 许可证开源。
