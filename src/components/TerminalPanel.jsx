import React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { t } from '../i18n';
import styles from './TerminalPanel.module.css';

class TerminalPanel extends React.Component {
  constructor(props) {
    super(props);
    this.containerRef = React.createRef();
    this.terminal = null;
    this.fitAddon = null;
    this.ws = null;
    this.resizeObserver = null;
  }

  componentDidMount() {
    this.initTerminal();
    this.connectWebSocket();
    this.setupResizeObserver();
  }

  componentWillUnmount() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.terminal) {
      this.terminal.dispose();
    }
  }

  initTerminal() {
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0a0a0a',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
      },
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.containerRef.current);

    requestAnimationFrame(() => {
      this.fitAddon.fit();
    });

    this.terminal.onData((data) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data') {
          this.terminal.write(msg.data);
        } else if (msg.type === 'exit') {
          this.terminal.write(`\r\n\x1b[33m${t('ui.terminal.exited', { code: msg.exitCode ?? '?' })}\x1b[0m\r\n`);
        } else if (msg.type === 'state') {
          if (!msg.running && msg.exitCode !== null) {
            this.terminal.write(`\x1b[33m${t('ui.terminal.exited', { code: msg.exitCode })}\x1b[0m\r\n`);
          }
        }
      } catch {}
    };

    this.ws.onclose = () => {
      setTimeout(() => {
        if (this.containerRef.current) {
          this.connectWebSocket();
        }
      }, 2000);
    };

    this.ws.onopen = () => {
      this.sendResize();
    };
  }

  sendResize() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.terminal) {
      this.ws.send(JSON.stringify({
        type: 'resize',
        cols: this.terminal.cols,
        rows: this.terminal.rows,
      }));
    }
  }

  setupResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitAddon && this.containerRef.current) {
        try {
          this.fitAddon.fit();
          this.sendResize();
        } catch {}
      }
    });
    if (this.containerRef.current) {
      this.resizeObserver.observe(this.containerRef.current);
    }
  }

  render() {
    return (
      <div className={styles.terminalPanel}>
        <div ref={this.containerRef} className={styles.terminalContainer} />
      </div>
    );
  }
}

export default TerminalPanel;
