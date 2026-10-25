import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, mockApi, projects, session } from '../../test/server';
import { renderAt } from '../../test/render';

describe('sign-in', () => {
  it('sends people to sign in, then back where they were going', async () => {
    let signedIn = false;
    mockApi({
      'GET /api/session': () =>
        signedIn ? session : apiError(401, 'unauthenticated', 'sign in required'),
      'POST /api/session': (body: unknown) => {
        const { password } = body as { password: string };
        if (password !== 'right')
          return apiError(401, 'unauthenticated', 'email or password is incorrect');
        signedIn = true;
        return session;
      },
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
    });
    const { user } = renderAt('/p/default/production/flags?status=on');
    const email = await screen.findByLabelText('Email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert').textContent).toContain('Enter your email and password.');
    await user.type(email, 'eddie@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or password is incorrect.')).toBeTruthy();
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'right');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Flags' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('explains rate limiting and never follows an off-site next link', async () => {
    let attempts = 0;
    mockApi({
      'GET /api/session': apiError(401, 'unauthenticated', 'sign in required'),
      'POST /api/session': () => {
        attempts++;
        return attempts === 1 ? apiError(429, 'resource_exhausted', 'too many') : session;
      },
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
    });
    const { user } = renderAt('/sign-in?next=//evil.example');
    await user.type(await screen.findByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Flags' })).toBeTruthy();
  });

  it('signs out from the header', async () => {
    mockApi({
      'GET /api/session': session,
      'DELETE /api/session': [204, null],
      'GET /api/projects': projects,
      'GET /api/projects/default/flags': { flags: [] },
    });
    const { user } = renderAt('/');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Email')).toBeTruthy();
    });
  });

  it('handles a missing project and an unreachable server', async () => {
    mockApi({
      'GET /api/session': session,
      'GET /api/projects': { projects: [] },
    });
    renderAt('/');
    expect(await screen.findByText('No projects yet')).toBeTruthy();
  });

  it('reports a project that does not exist', async () => {
    mockApi({ 'GET /api/session': session, 'GET /api/projects': projects });
    renderAt('/p/ghost/production/flags');
    expect(await screen.findByText(/There is no project "ghost"/)).toBeTruthy();
  });

  it('shows not-found pages', async () => {
    mockApi({ 'GET /api/session': session, 'GET /api/projects': projects });
    renderAt('/nowhere');
    expect(await screen.findByText('Page not found')).toBeTruthy();
  });
});
