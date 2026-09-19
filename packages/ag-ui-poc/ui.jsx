import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { CopilotKit, CopilotChat, useInterrupt } from '@copilotkit/react-core/v2';

const genId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
const RUNTIME_URL = '/api/copilotkit';

function command(taskId, action, checkpoint) {
  return fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, action, requestId: genId(), checkpoint }) }).then(r => r.json());
}

function useFixtureSnapshot() {
  const [tasks, setTasks] = useState([]);
  const [epoch, setEpoch] = useState('');
  const [backendError, setBackendError] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/api/snapshot')
      .then(r => r.json())
      .then(d => { if (alive) { setTasks(d.snapshot.tasks); setEpoch(d.snapshot.epoch); } })
      .catch(() => alive && setBackendError('backend unreachable (snapshot)'));
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
      if (!alive) return;
      setBackendError('');
      try {
        const data = JSON.parse(msg.data);
        if (data.snapshot) { setTasks(data.snapshot.tasks); setEpoch(data.snapshot.epoch); }
        else if (data.value?.task) { const t = data.value.task; setTasks(prev => prev.map(x => x.taskId === t.taskId ? t : x)); }
      } catch { /* ignore */ }
    };
    es.onerror = () => alive && setBackendError('backend connection lost — retrying…');
    return () => { alive = false; es.close(); };
  }, []);
  return { tasks, epoch, backendError };
}

function GateInterrupt({ selectedTask }) {
  useInterrupt({
    render: ({ interrupt, resolve, cancel }) => {
      const gate = interrupt?.value?.gate || {};
      const taskId = interrupt?.value?.taskId || selectedTask;
      return React.createElement('div', { 'data-testid': 'gate-status', className: 'gate-status' },
        React.createElement('p', null, 'Human Gate Required — checkpoint: ' + (gate.checkpoint || interrupt?.id || '')),
        React.createElement('div', { className: 'gate-actions' },
          React.createElement('button', { 'data-testid': 'btn-approve', onClick: () => { command(taskId, 'approve', gate.checkpoint).then(() => resolve({ decision: 'approve', checkpoint: gate.checkpoint })); } }, 'Approve'),
          React.createElement('button', { 'data-testid': 'btn-reject', onClick: () => { command(taskId, 'reject', gate.checkpoint).then(() => cancel()); } }, 'Reject')
        )
      );
    },
  });
  return null;
}

function TaskDetail({ taskId }) {
  const { tasks } = useFixtureSnapshot();
  const detail = tasks.find(t => t.taskId === taskId);
  if (!detail) return null;
  return React.createElement('div', { 'data-testid': 'task-detail', className: 'task-detail' },
    React.createElement('h3', null, 'detail: ' + detail.taskId),
    React.createElement('div', { 'data-testid': 'detail-status' }, 'status: ' + detail.canonicalState),
    React.createElement('div', { 'data-testid': 'detail-step' }, 'step: ' + detail.currentStep + '/' + detail.totalSteps),
    React.createElement('div', { 'data-testid': 'detail-activity' }, 'last activity: ' + detail.lastActivity),
    detail.gate ? React.createElement('div', null,
      React.createElement('div', { 'data-testid': 'gate-checkpoint-' + detail.taskId }, 'checkpoint: ' + detail.gate.checkpoint),
      React.createElement('div', { 'data-testid': 'gate-state-' + detail.taskId }, detail.gate.resolved ? 'resolved: ' + detail.gate.decision : 'gate open')
    ) : null,
    React.createElement('ol', { 'data-testid': 'detail-timeline' },
      detail.timeline.map(e => React.createElement('li', { key: e.cursor }, e.cursor + ' ' + e.name + ' ' + e.detail))
    )
  );
}

function Dashboard() {
  const { tasks, epoch, backendError } = useFixtureSnapshot();
  const [selected, setSelected] = useState('fixture-alpha');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [gateResolved, setGateResolved] = useState(null);

  const postPing = useCallback(async () => {
    const d = await command('fixture-alpha', 'ping');
    setMessages(prev => [...prev, { role: 'assistant', content: d.result || '' }]);
  }, []);

  const approveSelected = useCallback(async () => {
    const task = tasks.find(t => t.taskId === selected);
    const cp = task?.gate?.checkpoint;
    if (!cp) return;
    await command(selected, 'approve', cp);
    setGateResolved('approve');
  }, [selected, tasks]);

  const rejectSelected = useCallback(async () => {
    const task = tasks.find(t => t.taskId === selected);
    const cp = task?.gate?.checkpoint;
    if (!cp) return;
    await command(selected, 'reject', cp);
    setGateResolved('reject');
  }, [selected, tasks]);

  const selectedTask = tasks.find(t => t.taskId === selected);
  const openGate = selectedTask?.gate && !selectedTask.gate.resolved;

  return React.createElement('div', { className: 'ag-ui-dashboard' },
    React.createElement('h1', null, 'Soc_brain AG-UI Dashboard ', React.createElement('span', { 'data-testid': 'fixture-badge' }, 'FIXTURE')),
    React.createElement('div', { className: 'main-layout' },
      React.createElement('div', { className: 'task-sidebar' },
        React.createElement('h2', null, 'Tasks'),
        React.createElement('div', { 'data-testid': 'epoch', className: 'epoch-display' }, 'epoch: ' + epoch),
        tasks.map(t =>
          React.createElement('div', {
            key: t.taskId,
            'data-testid': 'task-card-' + t.taskId,
            className: 'task-card' + (t.taskId === selected ? ' selected' : ''),
            onClick: () => { setSelected(t.taskId); setGateResolved(null); },
          },
            React.createElement('h3', null, t.taskId),
            React.createElement('div', { 'data-testid': 'status-' + t.taskId }, t.canonicalState),
            React.createElement('div', { 'data-testid': 'progress-' + t.taskId }, 'step ' + t.currentStep + '/' + t.totalSteps),
            React.createElement('div', { 'data-testid': 'activity-' + t.taskId }, t.lastActivity)
          )
        ),
        selected ? React.createElement(TaskDetail, { taskId: selected }) : null,
        openGate ? React.createElement('div', { 'data-testid': 'gate-status', className: 'gate-status' },
          React.createElement('p', null, 'Human Gate Required — checkpoint: ' + selectedTask.gate.checkpoint),
          React.createElement('div', { className: 'gate-actions' },
            React.createElement('button', { 'data-testid': 'btn-approve', onClick: (e) => { e.stopPropagation(); approveSelected(); } }, 'Approve'),
            React.createElement('button', { 'data-testid': 'btn-reject', onClick: (e) => { e.stopPropagation(); rejectSelected(); } }, 'Reject')
          )
        ) : null,
        gateResolved ? React.createElement('div', { 'data-testid': 'gate-resolved', className: 'gate-status' },
          React.createElement('p', null, 'Gate resolved: ' + gateResolved)
        ) : null,
        backendError ? React.createElement('div', { 'data-testid': 'backend-error' }, backendError) : null
      ),
      React.createElement('div', { className: 'chat-area' },
        React.createElement(GateInterrupt, { selectedTask: selected }),
        React.createElement(CopilotChat, { agentId: selected, className: 'copilot-chat-standard' }),
        React.createElement('div', { className: 'chat-panel' },
          React.createElement('div', { className: 'messages' },
            messages.map((m, i) =>
              React.createElement('div', { key: i, 'data-testid': 'msg-' + m.role, className: 'message ' + m.role }, m.content)
            )
          ),
          React.createElement('div', { className: 'chat-input-row' },
            React.createElement('input', { 'data-testid': 'chat-input', value: input, onChange: e => setInput(e.target.value), placeholder: 'Type a command...', onKeyDown: e => { if (e.key === 'Enter') { const text = input; setInput(''); setMessages(prev => [...prev, { role: 'user', content: text }]); command('fixture-alpha', 'ping').then(d => setMessages(prev => [...prev, { role: 'assistant', content: d.result || 'pong' }])); } } }),
            React.createElement('button', { 'data-testid': 'cmd-send', onClick: () => { const text = input; setInput(''); setMessages(prev => [...prev, { role: 'user', content: text }]); command('fixture-alpha', 'ping').then(d => setMessages(prev => [...prev, { role: 'assistant', content: d.result || 'pong' }])); } }, 'Send')
          ),
          React.createElement('div', { className: 'command-buttons' },
            React.createElement('button', { 'data-testid': 'cmd-ping', onClick: () => postPing() }, 'Ping'),
            React.createElement('button', { 'data-testid': 'cmd-gate', onClick: () => command('fixture-alpha', 'gate') }, 'Gate'),
            React.createElement('button', { 'data-testid': 'cmd-approve', onClick: () => approveSelected() }, 'Approve'),
            React.createElement('button', { 'data-testid': 'cmd-reject', onClick: () => rejectSelected() }, 'Reject'),
            React.createElement('button', { 'data-testid': 'cmd-stall', onClick: () => command('fixture-alpha', 'stall') }, 'Stall')
          )
        )
      )
    )
  );
}

function App() {
  return React.createElement(CopilotKit, { runtimeUrl: RUNTIME_URL, agent: 'fixture-alpha' },
    React.createElement(Dashboard)
  );
}

createRoot(document.getElementById('root')).render(React.createElement(App));
