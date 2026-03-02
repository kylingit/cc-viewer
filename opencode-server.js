/**
 * OpenCode Viewer Server
 * 复用 cc-viewer 前端，提供 opencode 数据的 HTTP API
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import {
  OPENCODE_DATA_DIR,
  OPENCODE_STORAGE_DIR,
  getMessages,
  getParts,
  getTokenStats,
  convertMessage,
  convertPartToContent,
  getActiveSessions,
  watchMessages,
  getProjects
} from './opencode-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const START_PORT = 7010;
const MAX_PORT = 7019;
const HOST = '127.0.0.1';

let clients = [];
let server;
let actualPort = START_PORT;
let messageWatcher = null;
let currentSessionId = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 获取会话的所有消息（转换为 cc-viewer 格式）
 */
function getSessionMessages(sessionId) {
  let messages = getMessages(sessionId);
  const entries = [];
  // 确保包含完整的对话轮次
  if (messages.length > 20) {
    let userCount = 0;
    let startIndex = messages.length;
    for (let i = messages.length - 1; i >= 0 && userCount < 5; i--) {
      if (messages[i].role === 'user') {
        userCount++;
        startIndex = i;
      }
    }
    messages = messages.slice(startIndex);
  }
  
  
  // 预加载所有 parts（避免重复查询）
  const allParts = {};
  for (const msg of messages) {
    allParts[msg.id] = getParts(msg.id);
  }
  
  // 记录上一轮的historyMessages长度（用于计算新增消息）
  let prevHistoryLength = 0;
  
  // 构建每条消息的历史上下文
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const parts = allParts[msg.id];
    
    // 构建历史消息（到当前消息为止的所有历史）
    const historyMessages = [];
    for (let j = 0; j <= i; j++) {
      const histMsg = messages[j];
      const histParts = allParts[histMsg.id];
      
      if (histMsg.role === 'user') {
        const userContent = histParts
          .filter(p => p.type === 'text' && !p.synthetic)
          .map(p => p.text)
          .join('\n');
        if (userContent) {
          historyMessages.push({
            role: 'user',
            content: [{ type: 'text', text: userContent }]
          });
        }
      } else if (histMsg.role === 'assistant') {
        const content = histParts
          .map(p => convertPartToContent(p))
          .filter(Boolean);
        
        if (content.length > 0) {
          historyMessages.push({
            role: 'assistant',
            content
          });
        }
      }
    }
    
    // 标记新增消息的起始索引（当前消息相对于历史的增量）
    const newMessagesStartIndex = prevHistoryLength;
    
    const entry = convertMessage(msg, parts, historyMessages);
    // 添加新增消息标记
    entry.body._newMessagesStartIndex = newMessagesStartIndex;
    entry.body._newMessagesCount = historyMessages.length - prevHistoryLength;
    
    entries.push(entry);
    prevHistoryLength = historyMessages.length;
  }
  
  // 按时间正序排序（最老在前，最新在后，匹配cc-viewer期望）
  entries.sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  
  // 只返回最近的20条消息，避免数据量过大导致前端卡死
  return entries.slice(0, 20);
}

/**
 * 构建 mainAgentSessions 数据（用于 ChatView 组件）
 * 将 OpenCode 的 session 数据转换为 mainAgentSessions 格式
 * 
 * mainAgentSessions 结构：
 * [{
 *   userId: string | null,
 *   messages: Array<Message>,  // 完整的历史对话
 *   response: Object,          // 最后的响应
 *   entryTimestamp: string
 * }]
 */
function buildMainAgentSessions(sessionId) {
  if (!sessionId) return [];
  
  const messages = getMessages(sessionId);
  if (messages.length === 0) return [];
  
  // 预加载所有 parts
  const allParts = {};
  for (const msg of messages) {
    allParts[msg.id] = getParts(msg.id);
  }
  
  // 构建完整的历史消息
  const historyMessages = [];
  for (const msg of messages) {
    const parts = allParts[msg.id];
    
    if (msg.role === 'user') {
      const userContent = parts
        .filter(p => p.type === 'text' && !p.synthetic)
        .map(p => p.text)
        .join('\n');
      if (userContent) {
        historyMessages.push({
          role: 'user',
          content: [{ type: 'text', text: userContent }],
          _timestamp: msg.timeCreated || msg.time?.created
        });
      }
    } else if (msg.role === 'assistant') {
      const content = parts
        .map(p => convertPartToContent(p))
        .filter(Boolean);
      
      if (content.length > 0) {
        historyMessages.push({
          role: 'assistant',
          content,
          _timestamp: msg.timeCreated || msg.time?.completed
        });
      }
    }
  }
  
  // 获取最后的响应（最后一条助手消息）
  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
  let lastResponse = null;
  if (lastAssistantMsg) {
    const lastParts = allParts[lastAssistantMsg.id];
    const lastContent = lastParts
      .map(p => convertPartToContent(p))
      .filter(Boolean);
    
    lastResponse = {
      status: 200,
      statusText: 'OK',
      body: {
        id: lastAssistantMsg.id,
        role: 'assistant',
        content: lastContent,
        model: lastAssistantMsg.modelID,
        stop_reason: lastAssistantMsg.finish || 'end_turn',
        usage: {
          input_tokens: lastAssistantMsg.tokens?.input || 0,
          output_tokens: lastAssistantMsg.tokens?.output || 0,
          cache_read_input_tokens: lastAssistantMsg.tokens?.cache?.read || 0,
          cache_creation_input_tokens: lastAssistantMsg.tokens?.cache?.write || 0
        }
      }
    };
  }
  
  // 返回单个 session
  return [{
    userId: null, // OpenCode 暂时没有 user_id 概念
    messages: historyMessages,
    response: lastResponse,
    entryTimestamp: messages[messages.length - 1]?.timeCreated || new Date().toISOString()
  }];
}

/**
 * 发送 SSE 事件到所有客户端
 */
function sendToClients(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    try {
      client.write(message);
    } catch (e) {
      // 忽略已断开的客户端
    }
  });
}

/**
 * 获取最近活跃的会话数据（按时间倒序）
 */
function getRecentRequestEntries(limit = 20) {
  const activeSessions = getActiveSessions(5);
  const allEntries = [];
  
  for (const session of activeSessions) {
    let messages = getMessages(session.id);
    
    // 确保包含完整的对话轮次（user+assistant配对）
    if (messages.length > 20) {
      // 从末尾向前查找，找到最近的5个完整对话轮次（10条消息）
      let userCount = 0;
      let startIndex = messages.length;
      for (let i = messages.length - 1; i >= 0 && userCount < 5; i--) {
        if (messages[i].role === 'user') {
          userCount++;
          startIndex = i;
        }
      }
      messages = messages.slice(startIndex);
    }
    // 预加载所有 parts
    const allParts = {};
    for (const msg of messages) {
      allParts[msg.id] = getParts(msg.id);
    }
    
    // 记录上一轮的historyMessages长度
    let prevHistoryLength = 0;
    
    // 为每个会话构建历史消息（只处理最近的几条）
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const parts = allParts[msg.id];
      
      // 构建历史消息（到当前消息为止）
      const historyMessages = [];
      for (let j = 0; j <= i; j++) {
        const histMsg = messages[j];
        const histParts = allParts[histMsg.id];
        
        if (histMsg.role === 'user') {
          const userContent = histParts
            .filter(p => p.type === 'text' && !p.synthetic)
            .map(p => p.text)
            .join('\n');
          if (userContent) {
            historyMessages.push({
              role: 'user',
              content: [{ type: 'text', text: userContent }]
            });
          }
        } else if (histMsg.role === 'assistant') {
          const content = histParts
            .map(p => convertPartToContent(p))
            .filter(Boolean);
          
          if (content.length > 0) {
            historyMessages.push({
              role: 'assistant',
              content
            });
          }
        }
      }
      
      // 标记新增消息的起始索引
      const newMessagesStartIndex = prevHistoryLength;
      
      const entry = convertMessage(msg, parts, historyMessages);
      allEntries.push(entry);
      // 添加新增消息标记
      entry.body._newMessagesStartIndex = newMessagesStartIndex;
      entry.body._newMessagesCount = historyMessages.length - prevHistoryLength;
      
      prevHistoryLength = historyMessages.length;
    }
  }
  
  // 按时间正序排序（最老在前，最新在后）
  allEntries.sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  
  // 限制返回数量（只保留最新的N条，即数组末尾）
  return allEntries.slice(0, limit);
}

/**
 * 为单条消息构建完整entry（包含历史消息和新增标记）
 */
function buildSingleEntry(msg) {
  const parts = getParts(msg.id);
  
  // 获取该session的所有消息以构建历史
  const sessionMessages = getMessages(msg.sessionID);
  const msgIndex = sessionMessages.findIndex(m => m.id === msg.id);
  
  if (msgIndex === -1) {
    // 如果找不到消息，返回基本entry
    return convertMessage(msg, parts, []);
  }
  
  // 预加载所有parts
  const allParts = {};
  for (const m of sessionMessages) {
    allParts[m.id] = getParts(m.id);
  }
  
  // 构建到当前消息为止的历史
  const historyMessages = [];
  for (let j = 0; j <= msgIndex; j++) {
    const histMsg = sessionMessages[j];
    const histParts = allParts[histMsg.id];
    
    if (histMsg.role === 'user') {
      const userContent = histParts
        .filter(p => p.type === 'text' && !p.synthetic)
        .map(p => p.text)
        .join('\n');
      if (userContent) {
        historyMessages.push({
          role: 'user',
          content: [{ type: 'text', text: userContent }]
        });
      }
    } else if (histMsg.role === 'assistant') {
      const content = histParts
        .map(p => convertPartToContent(p))
        .filter(Boolean);
      
      if (content.length > 0) {
        historyMessages.push({
          role: 'assistant',
          content
        });
      }
    }
  }
  
  // 计算之前的历史长度（当前消息之前的消息数量）
  let prevHistoryLength = 0;
  for (let j = 0; j < msgIndex; j++) {
    const histMsg = sessionMessages[j];
    const histParts = allParts[histMsg.id];
    
    if (histMsg.role === 'user') {
      const userContent = histParts
        .filter(p => p.type === 'text' && !p.synthetic)
        .map(p => p.text)
        .join('\n');
      if (userContent) prevHistoryLength++;
    } else if (histMsg.role === 'assistant') {
      const content = histParts.map(p => convertPartToContent(p)).filter(Boolean);
      if (content.length > 0) prevHistoryLength++;
    }
  }
  
  const entry = convertMessage(msg, parts, historyMessages);
  entry.body._newMessagesStartIndex = prevHistoryLength;
  entry.body._newMessagesCount = historyMessages.length - prevHistoryLength;
  
  return entry;
}

/**
 * 监听消息变化（使用数据库轮询）
 */
function startWatching() {
  messageWatcher = watchMessages((event) => {
    if (event.type === 'new_message') {
      const msg = event.message;
      
      if (!currentSessionId || msg.sessionID === currentSessionId) {
        const entry = buildSingleEntry(msg);
        sendToClients('message', entry);
      }
    }
  }, 2000);  // 每2秒检查一次
}

/**
 * 处理 HTTP 请求
 */
function handleRequest(req, res) {
  const { url, method } = req;
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // API: 获取当前监控的会话
  if (url === '/api/session' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId: currentSessionId }));
    return;
  }
  
  // API: 切换当前监控的会话
  if (url === '/api/session' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { sessionId } = JSON.parse(body);
        currentSessionId = sessionId;
        const entries = getSessionMessages(sessionId);
        sendToClients('full_reload', entries);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }
  
  // API: 获取活跃会话列表
  if (url === '/api/sessions' && method === 'GET') {
    const sessions = getActiveSessions(20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }
  
  // API: 插件事件推送
  if (url === '/api/plugin-event' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        if (event.type === 'message' && event.fullMessage) {
          const msg = event.fullMessage;
          const parts = event.parts || [];
          const entry = convertMessage(msg, parts);
          sendToClients('message', entry);
        } else {
          sendToClients('plugin_event', event);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  
  // API: 获取请求列表（按时间倒序）
  if (url === '/api/requests' && method === 'GET') {
    const entries = currentSessionId 
      ? getSessionMessages(currentSessionId)
      : getRecentRequestEntries(100);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }
  
  // API: 获取 Token 统计
  if (url === '/api/token-stats' && method === 'GET') {
    const stats = getTokenStats(currentSessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }
  
  // API: 获取项目列表
  if (url === '/api/projects' && method === 'GET') {
    const projects = getProjects();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(projects));
    return;
  }
  
  // API: 获取指定会话的消息
  if (url.startsWith('/api/messages/') && method === 'GET') {
    const sessionId = url.replace('/api/messages/', '');
    const entries = getSessionMessages(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }
  
  // SSE endpoint
  if (url === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    
    clients.push(res);
    
    const entries = currentSessionId 
      ? getSessionMessages(currentSessionId)
      : getRecentRequestEntries(100);
    res.write(`event: full_reload\ndata: ${JSON.stringify(entries)}\n\n`);
    
    req.on('close', () => {
      clients = clients.filter(client => client !== res);
    });
    return;
  }
  
  // API: 项目名称
  if (url === '/api/project-name' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projectName: 'OpenCode Monitor' }));
    return;
  }
  
  // API: 版本信息
  if (url === '/api/version-info' && method === 'GET') {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: pkg.version }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read version' }));
    }
    return;
  }
  
  // API: 用户配置
  if (url === '/api/preferences' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
    return;
  }
  
  // 静态文件服务
  if (method === 'GET') {
    let filePath = url === '/' ? '/index.html' : url;
    filePath = filePath.split('?')[0];
    
    const fullPath = join(__dirname, 'dist', filePath);
    
    try {
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        const content = readFileSync(fullPath);
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
      }
    } catch (e) {
      // fall through
    }
    
    // SPA fallback
    try {
      const indexPath = join(__dirname, 'dist', 'index.html');
      const html = readFileSync(indexPath, 'utf-8');
      const modifiedHtml = html.replace(
        /<title>.*?<\/title>/,
        '<title>OpenCode Viewer</title>'
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(modifiedHtml);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
    return;
  }
  
  res.writeHead(404);
  res.end('Not Found');
}

/**
 * 启动服务器
 */
export async function startViewer() {
  return new Promise((resolve, reject) => {
    function tryListen(port) {
      if (port > MAX_PORT) {
        console.error(`All ports ${START_PORT}-${MAX_PORT} are busy`);
        resolve(null);
        return;
      }
      
      const currentServer = createServer(handleRequest);
      
      currentServer.listen(port, HOST, () => {
        server = currentServer;
        actualPort = port;
        const url = `http://${HOST}:${port}`;
        console.log(`[OpenCode Viewer] Server started at ${url}`);
        
        startWatching();
        resolve(server);
      });
      
      currentServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          tryListen(port + 1);
        } else {
          reject(err);
        }
      });
    }
    
    tryListen(START_PORT);
  });
}

/**
 * 停止服务器
 */
export function stopViewer() {
  if (messageWatcher) {
    messageWatcher.close();
    messageWatcher = null;
  }
  
  clients.forEach(client => client.end());
  clients = [];
  
  if (server) {
    server.close();
  }
}