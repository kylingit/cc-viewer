/**
 * OpenCode 数据读取模块
 * 从 SQLite 数据库和 JSON 存储文件中读取会话和消息数据
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';

// OpenCode 数据目录
export const OPENCODE_DATA_DIR = join(homedir(), '.local', 'share', 'opencode');
export const OPENCODE_DB_PATH = join(OPENCODE_DATA_DIR, 'opencode.db');
export const OPENCODE_STORAGE_DIR = join(OPENCODE_DATA_DIR, 'storage');
export const OPENCODE_LOG_DIR = join(OPENCODE_DATA_DIR, 'log');

// 日志存储目录（与 cc-viewer 格式兼容）
export const LOG_DIR = join(homedir(), '.opencode', 'oc-viewer');

// 数据库连接（懒加载）
let _db = null;

function getDb() {
  if (!_db && existsSync(OPENCODE_DB_PATH)) {
    _db = new Database(OPENCODE_DB_PATH, { readonly: true });
  }
  return _db;
}

/**
 * 从数据库查询消息
 */
export function queryMessagesFromDb(sessionId = null, limit = 100) {
  const db = getDb();
  if (!db) return [];
  
  try {
    let sql, params;
    if (sessionId) {
      sql = `SELECT id, session_id, data, time_created FROM message 
             WHERE session_id = ? ORDER BY time_created DESC LIMIT ?`;
      params = [sessionId, limit];
    } else {
      sql = `SELECT id, session_id, data, time_created FROM message 
             ORDER BY time_created DESC LIMIT ?`;
      params = [limit];
    }
    
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    
    return rows.map(row => {
      try {
        const data = JSON.parse(row.data);
        return {
          id: row.id,
          sessionID: row.session_id,
          timeCreated: row.time_created,
          ...data
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * 从数据库查询 parts
 */
export function queryPartsFromDb(messageId) {
  const db = getDb();
  if (!db) return [];
  
  try {
    const sql = `SELECT id, message_id, data, time_created FROM part 
             WHERE message_id = ? ORDER BY time_created ASC`;
    const stmt = db.prepare(sql);
    const rows = stmt.all(messageId);
    
    return rows.map(row => {
      try {
        const data = JSON.parse(row.data);
        return {
          id: row.id,
          messageID: row.message_id,
          ...data
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * 从数据库查询会话列表
 */
export function querySessionsFromDb(limit = 20) {
  const db = getDb();
  if (!db) return [];
  
  try {
    const sql = `
      SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
             COUNT(m.id) as message_count
      FROM session s
      LEFT JOIN message m ON s.id = m.session_id
      GROUP BY s.id
      ORDER BY s.time_updated DESC
      LIMIT ?
    `;
    const stmt = db.prepare(sql);
    return stmt.all(limit);
  } catch (e) {
    return [];
  }
}

/**
 * 获取所有会话列表
 */
export function getSessions() {
  // 优先从数据库获取
  const dbSessions = querySessionsFromDb(50);
  if (dbSessions.length > 0) {
    return dbSessions.map(s => ({
      id: s.id,
      title: s.title || 'Untitled',
      directory: s.directory,
      messageCount: s.message_count || 0,
      timeCreated: s.time_created,
      timeUpdated: s.time_updated,
      modified: new Date(s.time_updated)
    }));
  }
  
  // 降级到文件系统
  const sessions = [];
  const sessionDir = join(OPENCODE_STORAGE_DIR, 'session');
  
  if (!existsSync(sessionDir)) return sessions;
  
  const dirs = readdirSync(sessionDir, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    
    try {
      const sessionPath = join(sessionDir, dir.name);
      const stats = statSync(sessionPath);
      const files = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
      
      sessions.push({
        id: dir.name,
        messageCount: files.length,
        modified: stats.mtime
      });
    } catch {
      // 忽略错误
    }
  }
  
  // 按修改时间倒序排序
  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}

/**
 * 获取消息列表（优先从数据库获取）
 */
export function getMessages(sessionId) {
  // 优先从数据库获取
  const dbMessages = queryMessagesFromDb(sessionId, 1000);
  if (dbMessages.length > 0) {
    // 按时间正序排列（对话顺序）
    return dbMessages.sort((a, b) => (a.timeCreated || 0) - (b.timeCreated || 0));
  }
  
  // 降级到文件系统
  const messages = [];
  const messageDir = join(OPENCODE_STORAGE_DIR, 'message', sessionId);
  
  if (!existsSync(messageDir)) return messages;
  
  const files = readdirSync(messageDir)
    .filter(f => f.endsWith('.json'))
    .sort();
  
  for (const file of files) {
    try {
      const filePath = join(messageDir, file);
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      messages.push(content);
    } catch {
      // 忽略解析错误
    }
  }
  
  return messages;
}

/**
 * 获取消息的 part 列表（优先从数据库获取）
 */
export function getParts(messageId) {
  // 优先从数据库获取
  const dbParts = queryPartsFromDb(messageId);
  if (dbParts.length > 0) {
    return dbParts;
  }
  
  // 降级到文件系统
  const parts = [];
  const partDir = join(OPENCODE_STORAGE_DIR, 'part', messageId);
  
  if (!existsSync(partDir)) return parts;
  
  const files = readdirSync(partDir)
    .filter(f => f.endsWith('.json'))
    .sort();
  
  for (const file of files) {
    try {
      const filePath = join(partDir, file);
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      parts.push(content);
    } catch {
      // 忽略解析错误
    }
  }
  
  return parts;
}

/**
 * 获取 Token 统计数据
 */
export function getTokenStats(sessionId = null) {
  const stats = {
    total: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    byModel: {},
    byProvider: {},
    sessions: []
  };
  
  // 从数据库获取消息
  const messages = queryMessagesFromDb(sessionId, 10000);
  
  const sessionMap = new Map();
  
  for (const msg of messages) {
    if (msg.tokens) {
      const t = msg.tokens;
      const input = t.input || 0;
      const output = t.output || 0;
      const reasoning = t.reasoning || 0;
      const cacheRead = t.cache?.read || 0;
      const cacheWrite = t.cache?.write || 0;
      
      // 累计总数
      stats.total.input += input;
      stats.total.output += output;
      stats.total.reasoning += reasoning;
      stats.total.cacheRead += cacheRead;
      stats.total.cacheWrite += cacheWrite;
      
      // 按 model 统计
      if (msg.modelID) {
        if (!stats.byModel[msg.modelID]) {
          stats.byModel[msg.modelID] = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
        }
        stats.byModel[msg.modelID].input += input;
        stats.byModel[msg.modelID].output += output;
        stats.byModel[msg.modelID].reasoning += reasoning;
        stats.byModel[msg.modelID].cacheRead += cacheRead;
        stats.byModel[msg.modelID].cacheWrite += cacheWrite;
      }
      
      // 按 provider 统计
      if (msg.providerID) {
        if (!stats.byProvider[msg.providerID]) {
          stats.byProvider[msg.providerID] = { input: 0, output: 0 };
        }
        stats.byProvider[msg.providerID].input += input;
        stats.byProvider[msg.providerID].output += output;
      }
      
      // session 统计
      const sid = msg.sessionID;
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, {
          sessionId: sid,
          total: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          messages: 0,
          models: {}
        });
      }
      const sessionStats = sessionMap.get(sid);
      sessionStats.total.input += input;
      sessionStats.total.output += output;
      sessionStats.total.reasoning += reasoning;
      sessionStats.total.cacheRead += cacheRead;
      sessionStats.total.cacheWrite += cacheWrite;
      sessionStats.messages++;
    }
  }
  
  stats.sessions = Array.from(sessionMap.values())
    .sort((a, b) => b.messages - a.messages);
  
  return stats;
}

/**
 * 将 OpenCode Part 转换为 cc-viewer 格式的内容块
 */
export function convertPartToContent(part) {
  const type = part.type;
  
  // 过滤掉元数据类型
  if (type === 'step-start' || type === 'step-finish' || type === 'compaction') {
    return null;
  }
  
  switch (type) {
    case 'text':
      return {
        type: 'text',
        text: part.text || ''
      };
      
    case 'reasoning':
    case 'thinking':
      return {
        type: 'thinking',
        thinking: part.text || ''
      };
      
    case 'tool':
      return {
        type: 'tool_use',
        id: part.callID || part.id,
        name: part.tool,
        input: part.state?.input || part.input || {}
      };
      
    case 'tool-result':
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.callID || part.toolCallID,
        content: part.result || part.content || '',
        is_error: part.state?.status === 'error'
      };
      
    case 'patch':
      return {
        type: 'text',
        text: `[Patch] ${part.path || ''}\n${part.diff || JSON.stringify(part)}`
      };
      
    case 'file':
      return {
        type: 'text',
        text: `[File] ${part.path || part.name || JSON.stringify(part)}`
      };
      
    case 'agent':
      return {
        type: 'text',
        text: `[Agent] ${part.name || part.agentID || JSON.stringify(part)}`
      };
      
    default:
      // 如果有 text 字段，显示为文本
      if (part.text) {
        return {
          type: 'text',
          text: part.text
        };
      }
      return null;
  }
}

/**
 * 将 OpenCode 消息转换为 cc-viewer 格式
 * @param {object} msg - 消息对象
 * @param {array} parts - 消息的parts
 * @param {array} historyMessages - 历史消息（可选，用于助手消息补充历史）
 */
export function convertMessage(msg, parts = [], historyMessages = []) {
  // 构建agent信息（OpenCode特有）
  const agentInfo = msg.agent || msg.mode || 'unknown';
  const modelInfo = msg.modelID || 'unknown';
  const providerInfo = msg.providerID || 'unknown';
  
  // 构建请求体
  const body = {
    model: msg.modelID,
    messages: [],
    stream: true,
    // 根据实际数据动态生成agent信息
    system: `OpenCode Agent Configuration\n\nAgent: ${agentInfo}\nModel: ${modelInfo}\nProvider: ${providerInfo}\n\nNote: System prompt and tools are built-in to the agent definition.`,
    // Tools list not available in OpenCode data
    tools: []
  };
  
  // 构建响应内容（过滤掉 null）
  const responseContent = parts.map(convertPartToContent).filter(Boolean);
  
  // 如果是用户消息，尝试从 parts 中获取用户输入
  if (msg.role === 'user' && parts.length > 0) {
    const userContent = parts
      .filter(p => p.type === 'text' && !p.synthetic)
      .map(p => p.text)
      .join('\n');
    if (userContent) {
      // 使用数组格式，与服务器端历史消息保持一致
      body.messages = [{ role: 'user', content: [{ type: 'text', text: userContent }] }];
    }
  }
  
  // 如果是助手消息，补充历史消息（用于ChatView显示对话历史）
  if (msg.role === 'assistant' && historyMessages.length > 0) {
    body.messages = historyMessages;
  }
  
  // 构建时间戳
  const timestamp = msg.timeCreated 
    ? new Date(msg.timeCreated).toISOString()
    : new Date(msg.time?.created || Date.now()).toISOString();
  // 构建 cc-viewer 兼容格式
  return {
    timestamp,
    project: msg.path?.cwd || 'unknown',
    
    url: `opencode://chat/${msg.providerID || 'unknown'}/${msg.modelID || 'unknown'}`,
    method: 'POST',
    headers: {},
    body: body,
    
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: {
        id: msg.id,
        role: msg.role,
        content: responseContent,
        model: msg.modelID,
        stop_reason: msg.finish || 'end_turn',
        usage: {
          input_tokens: msg.tokens?.input || 0,
          output_tokens: msg.tokens?.output || 0,
          cache_read_input_tokens: msg.tokens?.cache?.read || 0,
          cache_creation_input_tokens: msg.tokens?.cache?.write || 0
        }
      }
    },
    
    duration: msg.time?.created && msg.time?.completed 
      ? msg.time.completed - msg.time.created 
      : 0,
    isStream: true,
    isHeartbeat: false,
    isCountTokens: false,
    mainAgent: msg.role === 'assistant',
    
    opencode: {
      messageID: msg.id,
      sessionID: msg.sessionID,
      providerID: msg.providerID,
      modelID: msg.modelID,
      agent: msg.agent,
      mode: msg.mode,
      tokens: msg.tokens,
      cost: msg.cost,
      role: msg.role
    }
  };
}
/**
 * 构建历史消息列表（用于助手消息补充历史）
 * @param {array} allMessages - 按时间正序排列的所有消息
 * @param {array} allParts - Map<messageId, parts>
 * @param {number} upToIndex - 构建到哪个消息为止（不包含当前消息）
 */
function buildHistoryMessages(allMessages, allParts, upToIndex) {
  const history = [];
  
  for (let i = 0; i < upToIndex; i++) {
    const msg = allMessages[i];
    const parts = allParts[msg.id] || [];
    
    if (msg.role === 'user') {
      // 用户消息：提取文本内容
      const userContent = parts
        .filter(p => p.type === 'text' && !p.synthetic)
        .map(p => p.text)
        .join('\n');
      if (userContent) {
        // 转换为数组格式（符合 Claude API 格式）
        history.push({
          role: 'user',
          content: [{ type: 'text', text: userContent }]
        });
      }
    } else if (msg.role === 'assistant') {
      // 助手消息：提取响应内容
      const content = parts
        .map(convertPartToContent)
        .filter(Boolean);
      
      if (content.length > 0) {
        history.push({
          role: 'assistant',
          content
        });
      }
    }
  }
  
  return history;
}

/**
 * 获取最近活跃的会话
 */

/**
 * 获取最近活跃的会话
 */
export function getActiveSessions(limit = 10) {
  // 优先从数据库获取
  const dbSessions = querySessionsFromDb(limit);
  if (dbSessions.length > 0) {
    return dbSessions.map(s => ({
      id: s.id,
      messageCount: s.message_count || 0,
      modified: new Date(s.time_updated)
    }));
  }
  
  // 降级到文件系统
  const messageDir = join(OPENCODE_STORAGE_DIR, 'message');
  if (!existsSync(messageDir)) return [];
  
  const sessionDirs = readdirSync(messageDir, { withFileTypes: true });
  const sessions = [];
  
  for (const dir of sessionDirs) {
    if (!dir.isDirectory()) continue;
    
    const sessionPath = join(messageDir, dir.name);
    try {
      const stats = statSync(sessionPath);
      const files = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
      
      sessions.push({
        id: dir.name,
        messageCount: files.length,
        modified: stats.mtime
      });
    } catch {
      // 忽略错误
    }
  }
  
  // 按修改时间倒序排序
  sessions.sort((a, b) => b.modified - a.modified);
  
  return sessions.slice(0, limit);
}

/**
 * 监听消息变化（数据库轮询方式）
 */
export function watchMessages(callback, interval = 2000) {
  const db = getDb();
  if (!db) return null;
  
  let lastTime = Date.now();
  
  const timer = setInterval(() => {
    try {
      // 查询比上次检查更新的消息
      const sql = `SELECT id, session_id, data, time_created FROM message 
                   WHERE time_created > ? ORDER BY time_created DESC LIMIT 10`;
      const stmt = db.prepare(sql);
      const rows = stmt.all(lastTime);
      
      if (rows.length > 0) {
        lastTime = rows[0].time_created;
        
        for (const row of rows) {
          try {
            const data = JSON.parse(row.data);
            callback({
              type: 'new_message',
              sessionId: row.session_id,
              messageId: row.id,
              message: { id: row.id, sessionID: row.session_id, ...data }
            });
          } catch {
            // 忽略解析错误
          }
        }
      }
    } catch {
      // 忽略错误
    }
  }, interval);
  
  return {
    close: () => clearInterval(timer)
  };
}

/**
 * 获取所有项目列表
 */
export function getProjects() {
  const projects = new Map();
  
  // 从数据库获取消息
  const messages = queryMessagesFromDb(null, 5000);
  
  for (const msg of messages) {
    if (msg.path?.cwd) {
      const projectPath = msg.path.cwd;
      if (!projects.has(projectPath)) {
        projects.set(projectPath, {
          path: projectPath,
          root: msg.path.root,
          messageCount: 0,
          sessions: new Set()
        });
      }
      const project = projects.get(projectPath);
      project.messageCount++;
      project.sessions.add(msg.sessionID);
    }
  }
  
  return Array.from(projects.values()).map(p => ({
    ...p,
    sessions: p.sessions.size
  }));
}