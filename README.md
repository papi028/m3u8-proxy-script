# m3u8 filter ads proxy script
cf worker，deno，php多语言m3u8播放链接去广告代理加速脚本

 * M3U8 Proxy Filter Script with EXT-X-MAP Support
 *
 * 功能：
 * 1. 支持使用代理获取 M3U8 文件并使用代理重写其中的 TS/fMP4 分片 URL
 * 2. 支持 EXT-X-MAP 初始化段代理
 * 3. 处理加密流 (EXT-X-KEY)
 * 4. 可配置是否过滤 discontinuity 标记
 * 5. 支持缓存；(PHP:本地文件；deno:内存；worker:kv【KV设置变量名称为M3U8_PROXY_KV】)
 * 6. 自动解析主播放列表(带递归深度限制)
 * 7. 检测非M3U8内容:
 *    - 如果是音视频/图片文件则使用TS代理跳转
 *    - 其他情况直接跳转原始URL

## 全部脚本支持双代理设置
## 支持m3u8全局加速及去除广告标记
# 使用
## cf worker，deno
```
https://deployurl/?url=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
OR
https://deployurl/m3u8filter/https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
```

## php脚本可设置伪静态
m3u8filter.php?url=m3u8link
m3u8filter.php/m3u8filter/m3u8link
(伪静态规则： m3u8filter/m3u8link)
### nginx
```
rewrite ^/m3u8filter/(https?):/(.*)$ /m3u8filter.php?url=$1://$2 last;
```
### apache
```
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteRule ^m3u8filter/(https?):/(.*)$ m3u8filter.php?url=$1://$2 [L,QSA]
</IfModule>
```


## 主要优化
两种传参方式，两种代理方式，超高自定义
完整的m3u8流媒体去广告和设置代理加速功能
完整的加密m3u8流媒体过滤代理播放处理
完整的传统ts与fmp4流媒体分片处理
完整的多媒体文件加速支持，即便是传入mp3,mp4音视频，或jpg,png图片资源也可支持使用TS代理跳转进行加速

## 性能优化

使用基于哈希的缓存键，减少缓存冲突
请求带超时处理，避免卡死
流处理改进，减少内存占用

## 功能增强

智能广告检测和过滤，标记可能的广告片段
增强对各种HLS标签的支持，如EXT-X-BYTERANGE
CORS标头设置完善
安全头添加，提高安全性
支持保留原始响应头的关键信息

## 模块化设计

每个函数负责单一功能
详细的错误处理和日志
添加了全面的JSDocs注释
配置项分组和详细说明

## 错误处理

统一的错误响应创建
更详细的错误信息
全局异常捕获，防止服务中断

## 日志与调试

可配置的日志级别
请求和响应的详细日志
时间戳和结构化日志
