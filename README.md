# m3u8-proxy-script,but not only m3u8
cf worker，deno，php多语言m3u8播放链接去广告代理加速脚本，另外支持TS代理非m3u8类型的音视频及图片资源

## 支持双代理设置
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
