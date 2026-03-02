import React from 'react';
import { Empty, Typography, Divider, Spin } from 'antd';
import ChatMessage from './ChatMessage';
import TerminalPanel from './TerminalPanel';
import { extractToolResultText, getModelInfo } from '../utils/helpers';
import { isSystemText, classifyUserContent, isMainAgent } from '../utils/contentFilter';
import { classifyRequest, formatRequestTag } from '../utils/requestType';
import { t } from '../i18n';
import styles from './ChatView.module.css';

const { Text } = Typography;

const QUEUE_THRESHOLD = 20;

function randomInterval() {
  return 100 + Math.random() * 50;
}

function buildToolResultMap(messages) {
  const toolUseMap = {};
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolUseMap[block.id] = block;
        }
      }
    }
  }

  const toolResultMap = {};
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const matchedTool = toolUseMap[block.tool_use_id];
          let label = t('ui.toolReturn');
          let toolName = null;
          let toolInput = null;
          if (matchedTool) {
            toolName = matchedTool.name;
            toolInput = matchedTool.input;
            if (matchedTool.name === 'Task' && matchedTool.input) {
              const st = matchedTool.input.subagent_type || '';
              const desc = matchedTool.input.description || '';
              label = `SubAgent: ${st}${desc ? ' — ' + desc : ''}`;
            } else {
              label = t('ui.toolReturnNamed', { name: matchedTool.name });
            }
          }
          toolResultMap[block.tool_use_id] = {
            label,
            toolName,
            toolInput,
            resultText: extractToolResultText(block),
          };
        }
      }
    }
  }
  return { toolUseMap, toolResultMap };
}

class ChatView extends React.Component {
  constructor(props) {
    super(props);
    this.containerRef = React.createRef();
    this.splitContainerRef = React.createRef();
    this.state = {
      visibleCount: 0,
      loading: false,
      allItems: [],
      highlightTs: null,
      highlightFading: false,
      splitRatio: 0.6,
      inputEmpty: true,
      pendingInput: null,
      stickyBottom: true,
      ptyPrompt: null,
      ptyPromptHistory: [],
      inputSuggestion: null,
    };
    this._queueTimer = null;
    this._prevItemsLen = 0;
    this._scrollTargetIdx = null;
    this._scrollTargetRef = React.createRef();
    this._scrollFadeTimer = null;
    this._resizing = false;
    this._inputWs = null;
    this._inputRef = React.createRef();
    this._ptyBuffer = '';
    this._ptyDebounceTimer = null;
  }

  componentDidMount() {
    this.startRender();
    if (this.props.cliMode) {
      this.connectInputWs();
    }
    this._bindStickyScroll();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.mainAgentSessions !== this.props.mainAgentSessions) {
      this.startRender();
      if (this.state.pendingInput) {
        this.setState({ pendingInput: null });
      }
      this._updateSuggestion();
    } else if (prevProps.collapseToolResults !== this.props.collapseToolResults || prevProps.expandThinking !== this.props.expandThinking) {
      const allItems = this.buildAllItems();
      this.setState({ allItems, visibleCount: allItems.length });
    }
    // scrollToTimestamp 变化时（如从 raw 模式切回 chat），重建 items 并滚动定位
    if (!prevProps.scrollToTimestamp && this.props.scrollToTimestamp) {
      const allItems = this.buildAllItems();
      this.setState({ allItems, visibleCount: allItems.length }, () => this.scrollToBottom());
    }
    // cliMode 异步生效后建立 WebSocket 连接
    if (!prevProps.cliMode && this.props.cliMode) {
      this.connectInputWs();
    }
    this._rebindStickyEl();
  }

  componentWillUnmount() {
    if (this._queueTimer) clearTimeout(this._queueTimer);
    if (this._fadeClearTimer) clearTimeout(this._fadeClearTimer);
    if (this._ptyDebounceTimer) clearTimeout(this._ptyDebounceTimer);
    this._unbindScrollFade();
    this._unbindStickyScroll();
    if (this._inputWs) {
      this._inputWs.close();
      this._inputWs = null;
    }
  }

  startRender() {
    if (this._queueTimer) clearTimeout(this._queueTimer);

    const allItems = this.buildAllItems();
    const prevLen = this._prevItemsLen;
    this._prevItemsLen = allItems.length;

    const newCount = allItems.length - prevLen;

    if (newCount <= 0 || (prevLen > 0 && newCount <= 3)) {
      this.setState({ allItems, visibleCount: allItems.length, loading: false }, () => this.scrollToBottom());
      return;
    }

    if (allItems.length > QUEUE_THRESHOLD) {
      this.setState({ allItems, visibleCount: 0, loading: true });
      this._queueTimer = setTimeout(() => {
        this.setState({ visibleCount: allItems.length, loading: false }, () => this.scrollToBottom());
      }, 300);
    } else {
      const startFrom = Math.max(0, prevLen);
      this.setState({ allItems, visibleCount: startFrom, loading: false });
      this.queueNext(startFrom, allItems.length);
    }
  }

  queueNext(current, total) {
    if (current >= total) return;
    this._queueTimer = setTimeout(() => {
      this.setState({ visibleCount: current + 1 }, () => {
        this.scrollToBottom();
        this.queueNext(current + 1, total);
      });
    }, randomInterval());
  }

  _isNearBottom() {
    const el = this.containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 30;
  }

  scrollToBottom() {
    if (this._scrollTargetRef.current) {
      const targetEl = this._scrollTargetRef.current;
      const container = this.containerRef.current;
      if (container && targetEl.offsetHeight > container.clientHeight) {
        targetEl.scrollIntoView({ block: 'start', behavior: 'instant' });
      } else {
        targetEl.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
      const targetTs = this.props.scrollToTimestamp;
      this._scrollTargetRef = React.createRef();
      if (targetTs) {
        this.setState({ highlightTs: targetTs, highlightFading: false });
        this._bindScrollFade();
      }
      if (this.props.onScrollTsDone) this.props.onScrollTsDone();
      return;
    }
    if (this.state.stickyBottom) {
      const el = this.containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }

  _bindStickyScroll() {
    this._onStickyScroll = () => {
      if (this._stickyScrollLock) return;
      const el = this.containerRef.current;
      if (!el) return;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (this.state.stickyBottom && gap > 30) {
        this.setState({ stickyBottom: false });
      } else if (!this.state.stickyBottom && gap <= 5) {
        this.setState({ stickyBottom: true });
      }
    };
    this._rebindStickyEl();
  }

  _rebindStickyEl() {
    const el = this.containerRef.current;
    if (el === this._stickyBoundEl) return;
    if (this._stickyBoundEl) {
      this._stickyBoundEl.removeEventListener('scroll', this._onStickyScroll);
    }
    this._stickyBoundEl = el;
    if (el) el.addEventListener('scroll', this._onStickyScroll);
  }

  _unbindStickyScroll() {
    if (this._stickyBoundEl && this._onStickyScroll) {
      this._stickyBoundEl.removeEventListener('scroll', this._onStickyScroll);
      this._stickyBoundEl = null;
    }
  }

  handleStickToBottom = () => {
    this.setState({ stickyBottom: true }, () => {
      const el = this.containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  _bindScrollFade() {
    this._unbindScrollFade();
    const container = this.containerRef.current;
    if (!container) return;
    this._scrollFadeIgnoreFirst = true;
    this._onScrollFade = () => {
      if (this._scrollFadeIgnoreFirst) {
        this._scrollFadeIgnoreFirst = false;
        return;
      }
      this.setState({ highlightFading: true });
      this._fadeClearTimer = setTimeout(() => {
        this.setState({ highlightTs: null, highlightFading: false });
      }, 2000);
      this._unbindScrollFade();
    };
    container.addEventListener('scroll', this._onScrollFade);
  }

  _unbindScrollFade() {
    if (this._onScrollFade && this.containerRef.current) {
      this.containerRef.current.removeEventListener('scroll', this._onScrollFade);
      this._onScrollFade = null;
    }
  }

  renderSessionMessages(messages, keyPrefix, modelInfo, tsToIndex) {
    const { userProfile, collapseToolResults, expandThinking, onViewRequest } = this.props;
    const { toolUseMap, toolResultMap } = buildToolResultMap(messages);

    const renderedMessages = [];

    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      const content = msg.content;
      const ts = msg._timestamp || null;
      const reqIdx = ts ? tsToIndex[ts] : undefined;
      const viewReqProps = reqIdx != null && onViewRequest ? { requestIndex: reqIdx, onViewRequest } : {};

      if (msg.role === 'user') {
        if (Array.isArray(content)) {
          const suggestionText = content.find(b => b.type === 'text' && /^\[SUGGESTION MODE:/i.test((b.text || '').trim()));
          const toolResults = content.filter(b => b.type === 'tool_result');

          if (suggestionText && toolResults.length > 0) {
            let questions = null;
            let answers = {};
            for (const tr of toolResults) {
              const matchedTool = toolUseMap[tr.tool_use_id];
              if (matchedTool && matchedTool.name === 'AskUserQuestion' && matchedTool.input?.questions) {
                questions = matchedTool.input.questions;
                const resultText = extractToolResultText(tr);
                try {
                  const parsed = JSON.parse(resultText);
                  answers = parsed.answers || {};
                } catch {}
                break;
              }
            }

            if (questions) {
              renderedMessages.push(
                <ChatMessage key={`${keyPrefix}-selection-${mi}`} role="user-selection" questions={questions} answers={answers} timestamp={ts} userProfile={userProfile} {...viewReqProps} />
              );
            }
          } else {
            const { commands, textBlocks, skillBlocks } = classifyUserContent(content);
            // 渲染 slash command 作为独立用户输入
            for (let ci = 0; ci < commands.length; ci++) {
              renderedMessages.push(
                <ChatMessage key={`${keyPrefix}-cmd-${mi}-${ci}`} role="user" text={commands[ci]} timestamp={ts} userProfile={userProfile} modelInfo={modelInfo} {...viewReqProps} />
              );
            }
            // 渲染 skill 加载块
            for (const sb of skillBlocks) {
              const nameMatch = sb.text.match(/^#\s+(.+)$/m);
              const skillName = nameMatch ? nameMatch[1] : 'Skill';
              renderedMessages.push(
                <ChatMessage key={`${keyPrefix}-skill-${mi}`} role="skill-loaded" text={sb.text} skillName={skillName} timestamp={ts} {...viewReqProps} />
              );
            }
            // 渲染普通用户文本块
            for (let ti = 0; ti < textBlocks.length; ti++) {
              const isPlan = /^Implement the following plan:/i.test((textBlocks[ti].text || '').trim());
              renderedMessages.push(
                <ChatMessage key={`${keyPrefix}-user-${mi}-${ti}`} role={isPlan ? 'plan-prompt' : 'user'} text={textBlocks[ti].text} timestamp={ts} userProfile={userProfile} modelInfo={modelInfo} {...viewReqProps} />
              );
            }
          }
        } else if (typeof content === 'string' && !isSystemText(content)) {
          const isPlan = /^Implement the following plan:/i.test(content.trim());
          renderedMessages.push(
            <ChatMessage key={`${keyPrefix}-user-${mi}`} role={isPlan ? 'plan-prompt' : 'user'} text={content} timestamp={ts} userProfile={userProfile} modelInfo={modelInfo} {...viewReqProps} />
          );
        }
      } else if (msg.role === 'assistant') {
        if (Array.isArray(content)) {
          renderedMessages.push(
            <ChatMessage key={`${keyPrefix}-asst-${mi}`} role="assistant" content={content} toolResultMap={toolResultMap} timestamp={ts} modelInfo={modelInfo} collapseToolResults={collapseToolResults} expandThinking={expandThinking} {...viewReqProps} />
          );
        } else if (typeof content === 'string') {
          renderedMessages.push(
            <ChatMessage key={`${keyPrefix}-asst-${mi}`} role="assistant" content={[{ type: 'text', text: content }]} toolResultMap={toolResultMap} timestamp={ts} modelInfo={modelInfo} collapseToolResults={collapseToolResults} expandThinking={expandThinking} {...viewReqProps} />
          );
        }
      }
    }

    return renderedMessages;
  }

  buildAllItems() {
    const { mainAgentSessions, requests, collapseToolResults, expandThinking, onViewRequest } = this.props;
    if (!mainAgentSessions || mainAgentSessions.length === 0) return [];

    // 构建 timestamp → filteredRequests index 映射
    const tsToIndex = {};
    if (requests) {
      for (let i = 0; i < requests.length; i++) {
        if (isMainAgent(requests[i]) && requests[i].timestamp) {
          tsToIndex[requests[i].timestamp] = i;
        }
      }
    }

    // 从最新的 mainAgent 请求中提取模型名
    let modelName = null;
    if (requests) {
      for (let i = requests.length - 1; i >= 0; i--) {
        if (isMainAgent(requests[i]) && requests[i].body?.model) {
          modelName = requests[i].body.model;
          break;
        }
      }
    }
    const modelInfo = getModelInfo(modelName);

    const allItems = [];
    // 记录每个 timestamp 对应的最后一个 item index，用于滚动定位
    const tsItemMap = {};

    // 收集 SubAgent entries（按 timestamp 排序）
    const subAgentEntries = [];
    if (requests) {
      for (let i = 0; i < requests.length; i++) {
        const req = requests[i];
        if (!req.timestamp) continue;
        const cls = classifyRequest(req, requests[i + 1]);
        if (cls.type === 'SubAgent') {
          const respContent = req.response?.body?.content;
          if (Array.isArray(respContent) && respContent.length > 0) {
            const subToolResultMap = buildToolResultMap(req.body?.messages || []).toolResultMap;
            subAgentEntries.push({
              timestamp: req.timestamp,
              content: respContent,
              toolResultMap: subToolResultMap,
              label: formatRequestTag(cls.type, cls.subType),
              requestIndex: i,
            });
          }
        }
      }
    }

    let subIdx = 0;

    mainAgentSessions.forEach((session, si) => {
      if (si > 0) {
        allItems.push(
          <Divider key={`session-div-${si}`} style={{ borderColor: '#333', margin: '16px 0' }}>
            <Text className={styles.sessionDividerText}>Session</Text>
          </Divider>
        );
      }

      const msgs = this.renderSessionMessages(session.messages, `s${si}`, modelInfo, tsToIndex);

      // 将 SubAgent entries 按时间戳插入到 session 消息之间
      for (const m of msgs) {
        const msgTs = m.props.timestamp;
        // 插入时间戳 <= 当前消息时间戳的 SubAgent entries
        while (subIdx < subAgentEntries.length && msgTs && subAgentEntries[subIdx].timestamp <= msgTs) {
          const sa = subAgentEntries[subIdx];
          if (sa.timestamp) tsItemMap[sa.timestamp] = allItems.length;
          allItems.push(
            <ChatMessage key={`sub-chat-${subIdx}`} role="sub-agent-chat" content={sa.content} toolResultMap={sa.toolResultMap} label={sa.label} timestamp={sa.timestamp} collapseToolResults={collapseToolResults} expandThinking={expandThinking} requestIndex={sa.requestIndex} onViewRequest={onViewRequest} />
          );
          subIdx++;
        }
        if (msgTs) tsItemMap[msgTs] = allItems.length;
        allItems.push(m);
      }
      // 插入剩余的 SubAgent entries（时间戳在最后一条消息之后）
      while (subIdx < subAgentEntries.length) {
        const sa = subAgentEntries[subIdx];
        // 只插入属于当前 session 时间范围内的（下一个 session 之前的）
        const nextSessionStart = si < mainAgentSessions.length - 1 && mainAgentSessions[si + 1].messages?.[0]?._timestamp;
        if (nextSessionStart && sa.timestamp > nextSessionStart) break;
        if (sa.timestamp) tsItemMap[sa.timestamp] = allItems.length;
        allItems.push(
          <ChatMessage key={`sub-chat-${subIdx}`} role="sub-agent-chat" content={sa.content} toolResultMap={sa.toolResultMap} label={sa.label} timestamp={sa.timestamp} collapseToolResults={collapseToolResults} expandThinking={expandThinking} requestIndex={sa.requestIndex} onViewRequest={onViewRequest} />
        );
        subIdx++;
      }

      if (si === mainAgentSessions.length - 1 && session.response?.body?.content) {
        const respContent = session.response.body.content;
        if (Array.isArray(respContent)) {
          allItems.push(
            <React.Fragment key="resp-divider">
              <Divider style={{ borderColor: '#2a2a2a', margin: '8px 0' }}>
                <Text type="secondary" className={styles.lastResponseLabel}>{t('ui.lastResponse')}</Text>
              </Divider>
            </React.Fragment>
          );
          // 将 Last Response 关联到该 session 对应的 entry timestamp，用于原文-对话定位
          if (session.entryTimestamp) tsItemMap[session.entryTimestamp] = allItems.length;
          allItems.push(
            <ChatMessage key="resp-asst" role="assistant" content={respContent} timestamp={session.entryTimestamp} modelInfo={modelInfo} collapseToolResults={collapseToolResults} expandThinking={expandThinking} toolResultMap={{}} />
          );
        }
      }
    });

    // 记录滚动目标 item index
    const { scrollToTimestamp } = this.props;
    this._scrollTargetIdx = scrollToTimestamp && tsItemMap[scrollToTimestamp] != null
      ? tsItemMap[scrollToTimestamp] : null;
    this._tsItemMap = tsItemMap;

    return allItems;
  }

  _extractSuggestion() {
    const { mainAgentSessions } = this.props;
    if (!mainAgentSessions?.length) return null;
    const lastSession = mainAgentSessions[mainAgentSessions.length - 1];
    const resp = lastSession?.response;
    if (!resp) return null;
    const body = resp.body;
    if (!body) return null;
    // 仅在 end_turn 或 max_tokens 时提取建议（非工具调用中断）
    const stop = body.stop_reason;
    if (stop !== 'end_turn' && stop !== 'max_tokens') return null;
    const content = body.content;
    if (!Array.isArray(content)) return null;
    // 取最后一个 text block 的文本
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i].type === 'text' && content[i].text?.trim()) {
        return content[i].text.trim();
      }
    }
    return null;
  }

  _updateSuggestion() {
    const text = this._extractSuggestion();
    this.setState({ inputSuggestion: text || null });
  }

  connectInputWs() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
    this._inputWs = new WebSocket(wsUrl);
    this._inputWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data') {
          this._appendPtyData(msg.data);
        } else if (msg.type === 'exit') {
          this._clearPtyPrompt();
        }
      } catch {}
    };
    this._inputWs.onclose = () => {
      setTimeout(() => {
        if (this.splitContainerRef.current && this.props.cliMode) {
          this.connectInputWs();
        }
      }, 2000);
    };
  }

  _stripAnsi(str) {
    // Remove CSI sequences (ESC [ ... final byte), OSC sequences (ESC ] ... ST), and other escape sequences
    return str
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[^[\]](.|$)/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  }

  _appendPtyData(raw) {
    const clean = this._stripAnsi(raw);
    this._ptyBuffer += clean;
    // Keep buffer at max 4KB
    if (this._ptyBuffer.length > 4096) {
      this._ptyBuffer = this._ptyBuffer.slice(-4096);
    }
    if (this._ptyDebounceTimer) clearTimeout(this._ptyDebounceTimer);
    this._ptyDebounceTimer = setTimeout(() => this._detectPrompt(), 200);
  }

  _detectPrompt() {
    const buf = this._ptyBuffer;
    // Match a question line ending with ? followed by numbered options
    const match = buf.match(/([^\n]*\?)\s*\n((?:\s*[❯>]?\s*\d+\.\s+[^\n]+\n?){2,})$/);
    if (match) {
      const question = match[1].trim();
      const optionsBlock = match[2];
      const optionLines = optionsBlock.match(/\s*([❯>])?\s*(\d+)\.\s+([^\n]+)/g);
      if (optionLines) {
        const options = optionLines.map(line => {
          const m = line.match(/\s*([❯>])?\s*(\d+)\.\s+(.+)/);
          return {
            number: parseInt(m[2], 10),
            text: m[3].trim(),
            selected: !!m[1],
          };
        });
        const prev = this.state.ptyPrompt;
        const prompt = { question, options };
        // 同一问题只更新选项（光标移动），不重复推入历史
        if (prev && prev.question === question) {
          this.setState({ ptyPrompt: prompt });
        } else {
          // 新提示：先将旧的 active 提示标记为 dismissed
          this.setState(state => {
            const history = state.ptyPromptHistory.slice();
            if (state.ptyPrompt) {
              const last = history[history.length - 1];
              if (last && last.status === 'active') {
                history[history.length - 1] = { ...last, status: 'dismissed' };
              }
            }
            history.push({ ...prompt, status: 'active', selectedNumber: null, timestamp: new Date().toISOString() });
            return { ptyPrompt: prompt, ptyPromptHistory: history };
          });
          this.scrollToBottom();
        }
        return;
      }
    }
    // No match — if there was an active prompt, mark it dismissed
    if (this.state.ptyPrompt) {
      this.setState(state => {
        const history = state.ptyPromptHistory.slice();
        const last = history[history.length - 1];
        if (last && last.status === 'active') {
          history[history.length - 1] = { ...last, status: 'dismissed' };
        }
        return { ptyPrompt: null, ptyPromptHistory: history };
      });
    }
  }

  _clearPtyPrompt() {
    this._ptyBuffer = '';
    if (this._ptyDebounceTimer) clearTimeout(this._ptyDebounceTimer);
    if (this.state.ptyPrompt) {
      this.setState({ ptyPrompt: null });
    }
  }

  handlePromptOptionClick = (number) => {
    const ws = this._inputWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const prompt = this.state.ptyPrompt;
    if (!prompt) return;

    // Claude Code TUI 使用 Ink SelectInput，需要用箭头键移动光标再回车
    const options = prompt.options;
    const targetIdx = options.findIndex(o => o.number === number);
    let currentIdx = options.findIndex(o => o.selected);
    if (currentIdx < 0) currentIdx = 0;

    const diff = targetIdx - currentIdx;
    const arrowKey = diff > 0 ? '\x1b[B' : '\x1b[A';
    const steps = Math.abs(diff);

    const sendStep = (i) => {
      if (i < steps) {
        ws.send(JSON.stringify({ type: 'input', data: arrowKey }));
        setTimeout(() => sendStep(i + 1), 30);
      } else {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: '\r' }));
          }
        }, 50);
      }
    };
    sendStep(0);

    // 标记历史中最后一个 active 为 answered
    this.setState(state => {
      const history = state.ptyPromptHistory.slice();
      const last = history[history.length - 1];
      if (last && last.status === 'active') {
        history[history.length - 1] = { ...last, status: 'answered', selectedNumber: number };
      }
      return { ptyPrompt: null, ptyPromptHistory: history };
    });
    this._ptyBuffer = '';
    if (this._ptyDebounceTimer) clearTimeout(this._ptyDebounceTimer);
  };

  handleInputSend = () => {
    const textarea = this._inputRef.current;
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) return;
    if (this._inputWs && this._inputWs.readyState === WebSocket.OPEN) {
      // Claude Code TUI 逐字符处理输入，需要先发文字再单独发回车
      this._inputWs.send(JSON.stringify({ type: 'input', data: text }));
      setTimeout(() => {
        if (this._inputWs && this._inputWs.readyState === WebSocket.OPEN) {
          this._inputWs.send(JSON.stringify({ type: 'input', data: '\r' }));
        }
      }, 50);
      textarea.value = '';
      textarea.style.height = 'auto';
      this.setState({ inputEmpty: true, pendingInput: text, inputSuggestion: null }, () => this.scrollToBottom());
    }
  };

  handleInputKeyDown = (e) => {
    if (e.key === 'Tab' && this.state.inputSuggestion) {
      e.preventDefault();
      const textarea = this._inputRef.current;
      if (textarea) {
        textarea.value = this.state.inputSuggestion;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      }
      this.setState({ inputSuggestion: null, inputEmpty: false });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleInputSend();
    }
  };

  handleInputChange = (e) => {
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    const empty = !textarea.value.trim();
    this.setState({ inputEmpty: empty });
    if (this.state.inputSuggestion && !empty) {
      this.setState({ inputSuggestion: null });
    }
  };

  handleSuggestionToTerminal = () => {
    const text = this.state.inputSuggestion;
    if (!text || !this._inputWs || this._inputWs.readyState !== WebSocket.OPEN) return;
    this._inputWs.send(JSON.stringify({ type: 'input', data: text }));
    setTimeout(() => {
      if (this._inputWs && this._inputWs.readyState === WebSocket.OPEN) {
        this._inputWs.send(JSON.stringify({ type: 'input', data: '\r' }));
      }
    }, 50);
    this.setState({ inputSuggestion: null, pendingInput: text }, () => this.scrollToBottom());
  };

  handleSplitMouseDown = (e) => {
    e.preventDefault();
    this._resizing = true;
    const onMouseMove = (ev) => {
      if (!this._resizing) return;
      const container = this.splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      const clamped = Math.min(0.85, Math.max(0.25, ratio));
      this.setState({ splitRatio: clamped });
    };
    const onMouseUp = () => {
      this._resizing = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  render() {
    const { mainAgentSessions, cliMode, terminalVisible } = this.props;
    const { allItems, visibleCount, loading, splitRatio } = this.state;

    const noData = !mainAgentSessions || mainAgentSessions.length === 0;

    if (noData && !cliMode) {
      return (
        <div className={styles.centerEmpty}>
          <Empty description={t('ui.noChat')} />
        </div>
      );
    }

    if (loading && !cliMode) {
      return (
        <div className={styles.centerEmpty}>
          <Spin size="large" />
        </div>
      );
    }

    const targetIdx = this._scrollTargetIdx;
    const { highlightTs, highlightFading } = this.state;
    const highlightIdx = highlightTs && this._tsItemMap && this._tsItemMap[highlightTs] != null
      ? this._tsItemMap[highlightTs] : null;
    const visible = allItems.slice(0, visibleCount);

    const { pendingInput, stickyBottom, ptyPromptHistory } = this.state;

    const pendingBubble = cliMode && pendingInput ? (
      <ChatMessage key="pending-input" role="user" text={pendingInput} timestamp={new Date().toISOString()} userProfile={this.props.userProfile} />
    ) : null;

    const stickyBtn = !stickyBottom ? (
      <button className={styles.stickyBottomBtn} onClick={this.handleStickToBottom}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        {t('ui.stickyBottom')}
      </button>
    ) : null;

    const promptBubbles = cliMode && ptyPromptHistory.length > 0 ? ptyPromptHistory.map((p, i) => {
      const isActive = p.status === 'active';
      const isAnswered = p.status === 'answered';
      return (
        <div key={`pty-prompt-${i}`} className={`${styles.ptyPromptBubble}${isActive ? '' : ' ' + styles.ptyPromptResolved}`}>
          <div className={styles.ptyPromptQuestion}>{p.question}</div>
          <div className={styles.ptyPromptOptions}>
            {p.options.map(opt => {
              const chosen = isAnswered && p.selectedNumber === opt.number;
              let cls = styles.ptyPromptOption;
              if (isActive && opt.selected) cls = styles.ptyPromptOptionPrimary;
              if (chosen) cls = styles.ptyPromptOptionChosen;
              if (!isActive && !chosen) cls = styles.ptyPromptOptionDimmed;
              return (
                <button
                  key={opt.number}
                  className={cls}
                  disabled={!isActive}
                  onClick={isActive ? () => this.handlePromptOptionClick(opt.number) : undefined}
                >
                  {opt.number}. {opt.text}
                </button>
              );
            })}
          </div>
        </div>
      );
    }) : null;

    const messageList = (noData || loading) ? (
      <div className={styles.messageListWrap}>
        <div ref={this.containerRef} className={styles.container}>
          {(!cliMode || loading) ? (
            <div className={styles.centerEmpty}>
              {loading ? <Spin size="large" /> : <Empty description={t('ui.noChat')} />}
            </div>
          ) : null}
          {pendingBubble}
          {promptBubbles}
        </div>
        {stickyBtn}
      </div>
    ) : (
      <div className={styles.messageListWrap}>
        <div
          ref={this.containerRef}
          className={styles.container}
        >
          {visible.map((item, i) => {
            const isScrollTarget = i === targetIdx;
            const needsHighlight = i === highlightIdx;
            let el = item;
            if (needsHighlight) {
              el = React.cloneElement(el, { highlight: highlightFading ? 'fading' : 'active' });
            }
            return isScrollTarget
              ? <div key={item.key + '-anchor'} ref={this._scrollTargetRef}>{el}</div>
              : el;
          })}
          {pendingBubble}
          {promptBubbles}
        </div>
        {stickyBtn}
      </div>
    );

    if (!cliMode) {
      return messageList;
    }

    return (
      <div ref={this.splitContainerRef} className={styles.splitContainer}>
        <div className={styles.chatSection} style={terminalVisible ? { flex: splitRatio, minWidth: 0 } : { flex: 1, minWidth: 0 }}>
          {messageList}
          {!terminalVisible && (
            <div className={styles.chatInputBar}>
              <div className={styles.chatInputWrapper}>
                <div className={styles.chatTextareaWrap}>
                  <textarea
                    ref={this._inputRef}
                    className={styles.chatTextarea}
                    placeholder={this.state.inputSuggestion ? '' : t('ui.chatInput.placeholder')}
                    rows={1}
                    onKeyDown={this.handleInputKeyDown}
                    onInput={this.handleInputChange}
                  />
                  {this.state.inputSuggestion && this.state.inputEmpty && (
                    <div className={styles.ghostText}>{this.state.inputSuggestion}</div>
                  )}
                </div>
                <div className={styles.chatInputHint}>
                  {this.state.inputSuggestion && this.state.inputEmpty
                    ? t('ui.chatInput.hintTab')
                    : t('ui.chatInput.hintEnter')}
                </div>
              </div>
              <button
                className={styles.chatSendBtn}
                onClick={this.handleInputSend}
                disabled={this.state.inputEmpty}
                title={t('ui.chatInput.send')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          )}
          {terminalVisible && this.state.inputSuggestion && (
            <div className={styles.suggestionChip} onClick={this.handleSuggestionToTerminal}>
              <span className={styles.suggestionChipText}>{this.state.inputSuggestion}</span>
              <span className={styles.suggestionChipAction}>↵</span>
            </div>
          )}
        </div>
        {terminalVisible && (
          <>
            <div className={styles.vResizer} onMouseDown={this.handleSplitMouseDown} />
            <div style={{ flex: 1 - splitRatio, minWidth: 200, display: 'flex', flexDirection: 'column' }}>
              <TerminalPanel />
            </div>
          </>
        )}
      </div>
    );
  }
}

export default ChatView;
