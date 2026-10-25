import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../src/App';
import { ToastProvider } from '../src/components/toast';
import { SessionProvider } from '../src/session';

export function renderAt(path: string) {
  const user = userEvent.setup();
  const result = render(
    <SessionProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ToastProvider>
    </SessionProvider>,
  );
  return { user, ...result };
}
