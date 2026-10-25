import { createContext, useContext } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { api, type Project } from '../api';
import { Icon, type IconName } from '../components/icons';
import { ErrorState, IconButton, Loading, Segmented } from '../components/ui';
import { useResource } from '../hooks';
import { useSession } from '../session';

export interface Scope {
  project: Project;
  env: string;
  projects: Project[];
  /** Builds a link inside the current project and environment. */
  link: (path: string) => string;
}

const ScopeContext = createContext<Scope | null>(null);

export function useScope(): Scope {
  const s = useContext(ScopeContext);
  if (s === null) throw new Error('useScope outside Layout');
  return s;
}

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: 'flags', label: 'Flags', icon: 'flag' },
];

export function Layout() {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, signOut } = useSession();
  const projects = useResource(() => api.projects(), 'projects');

  const projectKey = params.project ?? '';
  const env = params.env ?? '';
  const base = `/p/${projectKey}/${env}`;
  const rest = location.pathname.slice(base.length) || '/flags';

  if (projects.error !== undefined) {
    return <ErrorState message={projects.error.message} onRetry={projects.reload} />;
  }
  if (projects.data === undefined) return <Loading rows={4} label="Loading projects" />;
  const project = projects.data.projects.find((p) => p.key === projectKey);
  if (project === undefined || !project.environments.some((e) => e.key === env)) {
    return (
      <main id="main">
        <ErrorState
          message={`There is no project "${projectKey}" with an environment "${env}".`}
          onRetry={() => {
            void navigate('/');
          }}
        />
      </main>
    );
  }

  // Switching keeps you on the same kind of page; a flag page stays on the same flag.
  const go = (p: string, e: string) => {
    void navigate(`/p/${p}/${e}${p === projectKey ? rest : '/flags'}${location.search}`);
  };
  const scope: Scope = {
    project,
    env,
    projects: projects.data.projects,
    link: (path) => `${base}/${path.replace(/^\//, '')}`,
  };

  return (
    <ScopeContext.Provider value={scope}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <header className="topbar">
          <NavLink to="/" className="brand" aria-label="flagship home">
            <span className="brand-mark">
              <Icon name="flag" size={18} />
            </span>
            <span>flagship</span>
          </NavLink>
          <div className="topbar-context">
            <label className="visually-hidden" htmlFor="project-select">
              Project
            </label>
            {projects.data.projects.length > 1 ? (
              <select
                id="project-select"
                value={projectKey}
                onChange={(e) => {
                  const p = projects.data?.projects.find((x) => x.key === e.target.value);
                  const target = p?.environments.find((x) => x.key === env) ?? p?.environments[0];
                  if (p !== undefined && target !== undefined) go(p.key, target.key);
                }}
              >
                {projects.data.projects.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{project.name}</strong>
            )}
            {project.environments.length <= 4 ? (
              <Segmented
                label="Environment"
                value={env}
                options={project.environments.map((e) => ({ value: e.key, label: e.name }))}
                onChange={(e) => {
                  go(projectKey, e);
                }}
              />
            ) : (
              <select
                aria-label="Environment"
                value={env}
                onChange={(e) => {
                  go(projectKey, e.target.value);
                }}
              >
                {project.environments.map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="topbar-end">
            <div className="who small">
              <div>{user?.name}</div>
              <div className="muted">{user?.role}</div>
            </div>
            <IconButton
              icon="logout"
              label="Sign out"
              onClick={() => {
                void signOut().then(() => navigate('/sign-in'));
              }}
            />
          </div>
        </header>
        <nav className="sidenav" aria-label="Sections">
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={`${base}/${n.to}`}>
                  <Icon name={n.icon} />
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </ScopeContext.Provider>
  );
}
