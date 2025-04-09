# m3u8-proxy-script
cf worker，deno，php多语言的m3u8播放链接去广告代理加速脚本
## 支持双代理设置
## 支持m3u8全局加速及去除广告标记
# 使用
## cf worker，deno
```
https://deployurl/?url=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
OR
https://deployurl/m3u8filter/https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
```
## php脚本需要设置伪静态规则


# 主要优化点：

## 性能优化

使用基于内容哈希的缓存键，减少缓存冲突
智能代理选择，根据内容类型选择不同的代理
请求带超时处理，避免卡死
流处理改进，减少内存占用

## 功能增强

智能广告检测和过滤，标记可能的广告片段
增强对各种HLS标签的支持，如EXT-X-BYTERANGE
CORS标头设置完善
安全头添加，提高安全性
支持保留原始响应头的关键信息

## 安全与保护

基于IP的速率限制
更严格的域名安全检查
输入验证改进
增加请求超时保护
代码结构与可维护性

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
