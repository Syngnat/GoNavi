import React from 'react';
import { message } from 'antd';
import { sessionAgentErrorText, type SessionAgentApi, type SessionAgentItem, type SessionMessageView, type SessionTurnView } from './sessionAgentApi';

// 详情读取与返回导航；请求序号避免慢响应覆盖新会话。
export const useSessionAgentDetail = (api: SessionAgentApi) => {
  const [selected, setSelected] = React.useState<SessionAgentItem | null>(null);
  const [messages, setMessages] = React.useState<SessionMessageView[]>([]);
  const [turns, setTurns] = React.useState<SessionTurnView[]>([]);
  const [loading, setLoading] = React.useState(false);
  const requestId = React.useRef(0);

  const clear = React.useCallback(() => {
    requestId.current += 1;
    setSelected(null);
    setMessages([]);
    setTurns([]);
    setLoading(false);
  }, []);

  const select = React.useCallback(async (item: SessionAgentItem) => {
    const currentRequest = ++requestId.current;
    setSelected(item);
    setLoading(true);
    setMessages([]);
    setTurns([]);
    try {
      const detail = await api.detail(item.providerId, item.sourcePath);
      if (currentRequest !== requestId.current) return;
      setMessages(detail?.messages ?? []);
      setTurns(detail?.turns ?? []);
    } catch (err) {
      if (currentRequest !== requestId.current) return;
      message.error(sessionAgentErrorText(err, 'session_agent.error.detail_failed'));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [api]);

  const reload = React.useCallback(() => {
    if (selected) void select(selected);
  }, [selected, select]);

  React.useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const wrap = document.querySelector('.ant-modal-wrap');
      if (wrap && wrap.getBoundingClientRect().height > 0) return;
      clear();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, clear]);

  return { selected, messages, turns, loading, select, reload, clear };
};
