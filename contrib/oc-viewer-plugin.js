/**
 * OpenCode Viewer Plugin
 * 实时监控消息事件并推送到 cc-viewer 服务
 * 
 * 安装方式:
 * 1. 复制此文件到 ~/.opencode/plugin/oc-viewer-plugin.js
 * 2. 在 opencode.jsonc 中添加: { "plugins": ["file:///$HOME/.opencode/plugin/oc-viewer-plugin.js"] }
 * 或者使用 ocx 安装: ocx install oc-viewer
 * 
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function OcViewerPlugin({ client, directory }) {
  // 消息事件处理
  async function handleMessageEvent(input, output) {
    const { sessionID, model, messageID, agent } = input;
    const { message, parts } = output;
    
    // 构建监控数据
    const monitorData = {
      timestamp: new Date().toISOString(),
      sessionID,
      messageID,
      agent,
      model: model ? `${model.providerID}/${model.modelID}` : 'unknown',
      role: message.role,
      partsCount: parts?.length || 0,
      tokens: message.tokens || null
    };
    
    // 推送到 cc-viewer 服务
    try {
      const viewerUrl = 'http://127.0.0.1:7010/api/plugin-event';
      await fetch(viewerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          data: monitorData,
          fullMessage: message,
          parts: parts
        })
      });
    } catch (e) {
      // 静默失败，不影响 opencode 运行
    }
  }
  
  // 工具执行前
  async function handleToolBefore(input, output) {
    const { tool, sessionID, callID } = input;
    
    try {
      const viewerUrl = 'http://127.0.0.1:7010/api/plugin-event';
      await fetch(viewerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'tool_before',
          data: { tool, sessionID, callID, args: output.args }
        })
      });
    } catch (e) {
      // 静默失败
    }
  }
  
  // 工具执行后
  async function handleToolAfter(input, output) {
    const { tool, sessionID, callID, args } = input;
    const { title, output: toolOutput, metadata } = output;
    
    try {
      const viewerUrl = 'http://127.0.0.1:7010/api/plugin-event';
      await fetch(viewerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'tool_after',
          data: { tool, sessionID, callID, args, title, output: toolOutput?.slice(0, 500), metadata }
        })
      });
    } catch (e) {
      // 静默失败
    }
  }
  
  return {
    // 消息钩子
    'chat.message': handleMessageEvent,
    
    // 工具执行钩子
    'tool.execute.before': handleToolBefore,
    'tool.execute.after': handleToolAfter,
  };
}