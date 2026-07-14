#!/usr/bin/env node
/**
 * ruyi-mcp — Firefox 反检测浏览器全链路逆向 MCP 服务。
 *
 * 双场景架构：
 *   - 弱检测/无反检测 → js-reverse-mcp (Chrome/CDP)
 *   - 强检测 (CF/hCaptcha) → ruyi-mcp (Firefox/BiDi, 本服务)
 *
 * 工作流（对齐 mcp-js-reverse-playbook）:
 *   Observe → Capture → Rebuild → Patch → DeepDive
 *
 * 启动方式：
 *   node build/src/index.js
 *   或通过 .mcp.json 由 Claude Code 自动拉起
 */
export {};
