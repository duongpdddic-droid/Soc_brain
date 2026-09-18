import React from 'react';
import { CopilotProvider } from '@copilotkit/react-core';

export default function UI({ onCommand, tasks }) {
  return React.createElement(CopilotProvider, null,
    React.createElement('div', { className: 'ag-ui-dashboard' },
      React.createElement('h1', null, 'Soc_brain AG-UI Dashboard'),
      React.createElement('div', { className: 'task-list' },
        (tasks || []).map(t =>
          React.createElement('div', { key: t.taskId, className: 'task-card' },
            React.createElement('h2', null, t.taskId),
            React.createElement('span', null, t.canonicalState),
            React.createElement('button', {
              onClick: () => onCommand && onCommand(t.taskId, 'ping'),
            }, 'ping'),
            React.createElement('button', {
              onClick: () => onCommand && onCommand(t.taskId, 'gate'),
            }, 'gate'),
            React.createElement('button', {
              onClick: () => onCommand && onCommand(t.taskId, 'approve'),
            }, 'approve'),
            React.createElement('button', {
              onClick: () => onCommand && onCommand(t.taskId, 'reject'),
            }, 'reject'),
            React.createElement('button', {
              onClick: () => onCommand && onCommand(t.taskId, 'stall'),
            }, 'stall'),
          )
        )
      )
    )
  );
}
